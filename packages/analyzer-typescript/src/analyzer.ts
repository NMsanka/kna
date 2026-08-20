import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type ClassDeclaration,
  type EnumDeclaration,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  type JSDoc,
  type MethodDeclaration,
  type MethodSignature,
  type ParameterDeclaration,
  type PropertyDeclaration,
  type SourceFile,
  type Type,
  type TypeAliasDeclaration,
  type VariableDeclaration,
} from 'ts-morph';
import {
  sha256Hex,
  type Language,
  type Parameter,
  type RawSymbol,
  type SymbolKind,
  type TypeRef,
  type Visibility,
} from '@kna/ir';
import {
  parseDocComment,
  type Analyzer,
  type AnalyzerCapabilities,
  type AnalyzerRequest,
  type AnalyzerResponse,
} from '@kna/analyzer-core';

/**
 * Tier 1 TypeScript/JavaScript analyser (§5).
 *
 * What this adds over Tier 0: resolved and inferred types, a real call graph, JSDoc joined to
 * symbols, and re-export resolution. Everything it emits is `analysisDepth: 'semantic'` — and
 * the conformance suite checks that claim, so an analyser that silently fails to resolve types
 * cannot quietly keep the badge.
 *
 * Call edges are emitted as *qualified names*, not ids: assembly owns identity, and an
 * analyser that minted its own ids would break the moment two analysers disagreed about the
 * algorithm. See `assemble()` in @kna/ir.
 */

export const TS_ANALYZER_VERSION = '1.0.0';

export class TypeScriptAnalyzer implements Analyzer {
  readonly name = 'ts-morph';
  readonly version = TS_ANALYZER_VERSION;
  readonly languages: Language[] = ['typescript', 'javascript'];
  readonly capabilities: AnalyzerCapabilities = {
    depth: 'semantic',
    resolvesTypes: true,
    resolvesCallGraph: true,
  };

  /**
   * The toolchain here is in-process, so the probe is really "is there something to analyse
   * semantically" — a tsconfig. Without one, ts-morph falls back to inference from loose
   * files, which is materially weaker; better to report that honestly and stay at Tier 0.
   */
  async probe(repoRoot: string): Promise<string | null> {
    const candidates = ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json'];
    for (const candidate of candidates) {
      if (existsSync(join(repoRoot, candidate))) return `${ts.version} (${candidate})`;
    }
    return null;
  }

  async analyze(request: AnalyzerRequest): Promise<AnalyzerResponse> {
    const started = Date.now();
    const degradations: AnalyzerResponse['degradations'] = [];
    const diagnostics: AnalyzerResponse['diagnostics'] = [];

    const tsConfigPath = findTsConfig(request.repoRoot, request.module.path);
    const project = new Project({
      ...(tsConfigPath ? { tsConfigFilePath: tsConfigPath } : {}),
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: false,
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true,
        // Resolution has to work for cross-package type edges to resolve at all.
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ESNext,
      },
    });

    if (!tsConfigPath) {
      degradations.push({
        reason:
          'No tsconfig.json found for this module; types are inferred from loose files and cross-file resolution is incomplete',
        missing: 'tsconfig.json',
      });
    }

    const absolutePaths = request.files.map((f) => join(request.repoRoot, f.path));
    for (const path of absolutePaths) {
      try {
        project.addSourceFileAtPath(path);
      } catch (error) {
        diagnostics.push({
          level: 'warn',
          message: `Could not add source file: ${error instanceof Error ? error.message : String(error)}`,
          path,
        });
      }
    }
    project.resolveSourceFileDependencies();

    // ts-morph normalises every path to forward slashes regardless of platform, so the index
    // has to be built the same way or nothing matches on Windows.
    const generatedByPath = new Map(
      request.files.map((f) => [normalizeSlashes(join(request.repoRoot, f.path)), f.generated]),
    );
    const symbols: RawSymbol[] = [];
    const filesAnalyzed: string[] = [];

    for (const sourceFile of project.getSourceFiles()) {
      const absolute = normalizeSlashes(sourceFile.getFilePath());
      if (!generatedByPath.has(absolute)) continue; // Dependency pulled in for resolution only.

      const relPath = toRepoRelative(request.repoRoot, absolute);
      const ctx: FileContext = {
        sourceFile,
        relPath,
        commitSha: request.commitSha,
        includeSource: request.options.includeSource,
        generated: generatedByPath.get(absolute) ?? false,
      };

      try {
        symbols.push(...extractFromFile(ctx));
        filesAnalyzed.push(relPath);
      } catch (error) {
        // One malformed file must not lose the module. Tier 0 already covered it.
        diagnostics.push({
          level: 'warn',
          message: `Semantic extraction failed: ${error instanceof Error ? error.message : String(error)}`,
          path: relPath,
        });
      }
    }

    return {
      protocol: 'kna-analyzer/1',
      ok: true,
      analyzer: { name: this.name, version: this.version },
      symbols,
      filesAnalyzed,
      degradations,
      diagnostics,
      durationMs: Date.now() - started,
    };
  }
}

interface FileContext {
  sourceFile: SourceFile;
  relPath: string;
  commitSha: string;
  includeSource: boolean;
  generated: boolean;
}

function extractFromFile(ctx: FileContext): RawSymbol[] {
  const out: RawSymbol[] = [];

  for (const cls of ctx.sourceFile.getClasses()) out.push(...extractClass(ctx, cls));
  for (const iface of ctx.sourceFile.getInterfaces()) out.push(...extractInterface(ctx, iface));
  for (const fn of ctx.sourceFile.getFunctions()) {
    const symbol = extractFunction(ctx, fn);
    if (symbol) out.push(symbol);
  }
  for (const alias of ctx.sourceFile.getTypeAliases()) out.push(extractTypeAlias(ctx, alias));
  for (const enumDecl of ctx.sourceFile.getEnums()) out.push(...extractEnum(ctx, enumDecl));
  for (const statement of ctx.sourceFile.getVariableStatements()) {
    for (const decl of statement.getDeclarations()) {
      const symbol = extractVariable(ctx, decl);
      if (symbol) out.push(symbol);
    }
  }

  return out;
}

function extractClass(ctx: FileContext, cls: ClassDeclaration): RawSymbol[] {
  const name = cls.getName();
  if (!name) return [];

  const heritage = {
    extends: cls.getExtends() ? [cls.getExtends()!.getExpression().getText()] : [],
    implements: cls.getImplements().map((i) => i.getExpression().getText()),
  };

  const symbols: RawSymbol[] = [
    base(ctx, {
      name,
      qualifiedName: name,
      kind: 'class',
      signature: renderClassSignature(cls),
      visibility: cls.isExported() ? 'public' : 'internal',
      modifiers: collectModifiers(cls.getModifiers().map((m) => m.getText())),
      decorators: cls.getDecorators().map((d) => d.getText()),
      doc: joinJsDoc(cls.getJsDocs()),
      node: cls,
      edges: { calls: [], references: [], ...heritage },
      parentQualifiedName: null,
    }),
  ];

  for (const method of cls.getMethods()) {
    symbols.push(methodSymbol(ctx, name, method));
  }
  for (const ctor of cls.getConstructors()) {
    symbols.push(
      base(ctx, {
        name: 'constructor',
        qualifiedName: `${name}.constructor`,
        kind: 'method',
        signature: `constructor(${ctor
          .getParameters()
          .map((p) => p.getText())
          .join(', ')})`,
        visibility: mapVisibility(ctor.getScope()),
        modifiers: [],
        decorators: [],
        doc: joinJsDoc(ctor.getJsDocs()),
        node: ctor,
        parameters: ctor.getParameters().map((p) => mapParameter(p)),
        edges: { calls: collectCalls(ctor), references: [], extends: [], implements: [] },
        parentQualifiedName: name,
      }),
    );
  }
  for (const prop of cls.getProperties()) {
    symbols.push(propertySymbol(ctx, name, prop));
  }
  for (const accessor of [...cls.getGetAccessors(), ...cls.getSetAccessors()]) {
    const accessorName = accessor.getName();
    symbols.push(
      base(ctx, {
        name: accessorName,
        qualifiedName: `${name}.${accessorName}`,
        kind: 'property',
        signature: accessor
          .getText()
          .split('\n')[0]!
          .replace(/\s*\{.*$/, ''),
        visibility: mapVisibility(accessor.getScope()),
        modifiers: accessor.isStatic() ? ['static'] : [],
        decorators: accessor.getDecorators().map((d) => d.getText()),
        doc: joinJsDoc(accessor.getJsDocs()),
        node: accessor,
        returnType: typeRefOf(accessor.getReturnType()),
        edges: { calls: collectCalls(accessor), references: [], extends: [], implements: [] },
        parentQualifiedName: name,
      }),
    );
  }

  return symbols;
}

function extractInterface(ctx: FileContext, iface: InterfaceDeclaration): RawSymbol[] {
  const name = iface.getName();
  const symbols: RawSymbol[] = [
    base(ctx, {
      name,
      qualifiedName: name,
      kind: 'interface',
      signature: `interface ${name}${renderTypeParams(iface.getTypeParameters().map((t) => t.getText()))}`,
      visibility: iface.isExported() ? 'public' : 'internal',
      modifiers: [],
      decorators: [],
      doc: joinJsDoc(iface.getJsDocs()),
      node: iface,
      typeParameters: iface.getTypeParameters().map((t) => t.getText()),
      edges: {
        calls: [],
        references: [],
        extends: iface.getExtends().map((e) => e.getExpression().getText()),
        implements: [],
      },
      parentQualifiedName: null,
    }),
  ];

  for (const method of iface.getMethods()) {
    symbols.push(interfaceMethodSymbol(ctx, name, method));
  }
  for (const prop of iface.getProperties()) {
    symbols.push(
      base(ctx, {
        name: prop.getName(),
        qualifiedName: `${name}.${prop.getName()}`,
        kind: 'property',
        signature: prop.getText().replace(/;$/, ''),
        visibility: 'public',
        modifiers: prop.hasQuestionToken() ? ['optional'] : [],
        decorators: [],
        doc: joinJsDoc(prop.getJsDocs()),
        node: prop,
        returnType: typeRefOf(prop.getType()),
        edges: { calls: [], references: [], extends: [], implements: [] },
        parentQualifiedName: name,
      }),
    );
  }

  return symbols;
}

function extractFunction(ctx: FileContext, fn: FunctionDeclaration): RawSymbol | null {
  const name = fn.getName();
  if (!name) return null;
  return base(ctx, {
    name,
    qualifiedName: name,
    kind: 'function',
    signature: renderCallableSignature(name, fn),
    visibility: fn.isExported() ? 'public' : 'internal',
    modifiers: collectModifiers(fn.getModifiers().map((m) => m.getText())),
    decorators: [],
    doc: joinJsDoc(fn.getJsDocs()),
    node: fn,
    parameters: fn.getParameters().map((p) => mapParameter(p)),
    returnType: typeRefOf(fn.getReturnType()),
    typeParameters: fn.getTypeParameters().map((t) => t.getText()),
    edges: { calls: collectCalls(fn), references: [], extends: [], implements: [] },
    parentQualifiedName: null,
  });
}

function extractTypeAlias(ctx: FileContext, alias: TypeAliasDeclaration): RawSymbol {
  const name = alias.getName();
  return base(ctx, {
    name,
    qualifiedName: name,
    kind: 'type',
    signature: `type ${name}${renderTypeParams(
      alias.getTypeParameters().map((t) => t.getText()),
    )} = ${truncate(alias.getTypeNode()?.getText() ?? alias.getType().getText(), 400)}`,
    visibility: alias.isExported() ? 'public' : 'internal',
    modifiers: [],
    decorators: [],
    doc: joinJsDoc(alias.getJsDocs()),
    node: alias,
    typeParameters: alias.getTypeParameters().map((t) => t.getText()),
    edges: { calls: [], references: [], extends: [], implements: [] },
    parentQualifiedName: null,
  });
}

function extractEnum(ctx: FileContext, enumDecl: EnumDeclaration): RawSymbol[] {
  const name = enumDecl.getName();
  const symbols = [
    base(ctx, {
      name,
      qualifiedName: name,
      kind: 'enum',
      signature: `enum ${name}`,
      visibility: enumDecl.isExported() ? 'public' : 'internal',
      modifiers: [],
      decorators: [],
      doc: joinJsDoc(enumDecl.getJsDocs()),
      node: enumDecl,
      edges: { calls: [], references: [], extends: [], implements: [] },
      parentQualifiedName: null,
    }),
  ];

  for (const member of enumDecl.getMembers()) {
    symbols.push(
      base(ctx, {
        name: member.getName(),
        qualifiedName: `${name}.${member.getName()}`,
        kind: 'enumMember',
        signature: member.getText(),
        visibility: 'public',
        modifiers: [],
        decorators: [],
        doc: joinJsDoc(member.getJsDocs()),
        node: member,
        edges: { calls: [], references: [], extends: [], implements: [] },
        parentQualifiedName: name,
      }),
    );
  }

  return symbols;
}

function extractVariable(ctx: FileContext, decl: VariableDeclaration): RawSymbol | null {
  const name = decl.getName();
  const initializer = decl.getInitializer();
  const isCallable =
    initializer !== undefined &&
    (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer));

  const statement = decl.getVariableStatement();
  const exported = statement?.isExported() ?? false;

  // A non-exported, non-callable constant is index noise. Exported ones are API surface.
  if (!isCallable && !exported) return null;

  const type = decl.getType();
  return base(ctx, {
    name,
    qualifiedName: name,
    kind: isCallable ? 'function' : 'constant',
    signature: isCallable
      ? `const ${name}: ${truncate(type.getText(decl), 300)}`
      : `const ${name}: ${truncate(type.getText(decl), 300)}`,
    visibility: exported ? 'public' : 'internal',
    modifiers: [],
    decorators: [],
    doc: joinJsDoc(statement?.getJsDocs() ?? []),
    node: decl,
    parameters:
      isCallable && Node.isArrowFunction(initializer)
        ? initializer.getParameters().map((p) => mapParameter(p))
        : [],
    returnType: isCallable
      ? typeRefOf(decl.getType().getCallSignatures()[0]?.getReturnType())
      : typeRefOf(type),
    edges: {
      calls: initializer ? collectCalls(initializer) : [],
      references: [],
      extends: [],
      implements: [],
    },
    parentQualifiedName: null,
  });
}

function methodSymbol(ctx: FileContext, ownerName: string, method: MethodDeclaration): RawSymbol {
  const name = method.getName();
  return base(ctx, {
    name,
    qualifiedName: `${ownerName}.${name}`,
    kind: 'method',
    signature: renderCallableSignature(name, method),
    visibility: mapVisibility(method.getScope()),
    modifiers: collectModifiers(method.getModifiers().map((m) => m.getText())),
    decorators: method.getDecorators().map((d) => d.getText()),
    doc: joinJsDoc(method.getJsDocs()),
    node: method,
    parameters: method.getParameters().map((p) => mapParameter(p)),
    returnType: typeRefOf(method.getReturnType()),
    typeParameters: method.getTypeParameters().map((t) => t.getText()),
    edges: { calls: collectCalls(method), references: [], extends: [], implements: [] },
    parentQualifiedName: ownerName,
  });
}

function interfaceMethodSymbol(
  ctx: FileContext,
  ownerName: string,
  method: MethodSignature,
): RawSymbol {
  const name = method.getName();
  return base(ctx, {
    name,
    qualifiedName: `${ownerName}.${name}`,
    kind: 'method',
    signature: method.getText().replace(/;$/, ''),
    visibility: 'public',
    modifiers: [],
    decorators: [],
    doc: joinJsDoc(method.getJsDocs()),
    node: method,
    parameters: method.getParameters().map((p) => mapParameter(p)),
    returnType: typeRefOf(method.getReturnType()),
    edges: { calls: [], references: [], extends: [], implements: [] },
    parentQualifiedName: ownerName,
  });
}

function propertySymbol(ctx: FileContext, ownerName: string, prop: PropertyDeclaration): RawSymbol {
  const name = prop.getName();
  return base(ctx, {
    name,
    qualifiedName: `${ownerName}.${name}`,
    kind: 'property',
    signature: `${name}: ${truncate(prop.getType().getText(prop), 200)}`,
    visibility: mapVisibility(prop.getScope()),
    modifiers: collectModifiers(prop.getModifiers().map((m) => m.getText())),
    decorators: prop.getDecorators().map((d) => d.getText()),
    doc: joinJsDoc(prop.getJsDocs()),
    node: prop,
    returnType: typeRefOf(prop.getType()),
    edges: { calls: [], references: [], extends: [], implements: [] },
    parentQualifiedName: ownerName,
  });
}

// ── Shared construction ────────────────────────────────────────────────────────────────────

interface BaseArgs {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  signature: string;
  visibility: Visibility;
  modifiers: string[];
  decorators: string[];
  doc: string | null;
  node: Node;
  parameters?: Parameter[];
  returnType?: TypeRef | null;
  typeParameters?: string[];
  edges: { calls: string[]; references: string[]; extends: string[]; implements: string[] };
  parentQualifiedName: string | null;
}

function base(ctx: FileContext, args: BaseArgs): RawSymbol {
  const start = args.node.getStartLineNumber();
  const end = args.node.getEndLineNumber();
  const parsedDoc = args.doc ? parseDocComment(args.doc, 'typescript') : null;
  const parameters = args.parameters ?? [];

  // JSDoc descriptions are joined onto resolved parameters here rather than left as two
  // parallel lists, so downstream prose generation sees one coherent parameter record.
  if (parsedDoc) {
    for (const param of parameters) {
      const documented = parsedDoc.params.find((p) => p.name === param.name);
      if (documented) param.description = documented.description || null;
    }
  }

  const bodyText = args.node.getText();

  return {
    previousIds: [],
    qualifiedName: args.qualifiedName,
    name: args.name,
    kind: args.kind,
    language:
      ctx.relPath.endsWith('.js') || ctx.relPath.endsWith('.jsx') ? 'javascript' : 'typescript',
    visibility: args.visibility,
    signature: args.signature,
    parameters,
    returnType: args.returnType ?? null,
    typeParameters: args.typeParameters ?? [],
    typeRefs: collectTypeRefs(parameters, args.returnType ?? null),
    docComment: parsedDoc,
    deprecated: parsedDoc?.tags.deprecated
      ? { since: null, reason: parsedDoc.tags.deprecated, replacement: null }
      : null,
    modifiers: args.modifiers,
    decorators: args.decorators,
    edges: {
      calls: [...new Set(args.edges.calls)],
      implements: [...new Set(args.edges.implements)],
      extends: [...new Set(args.edges.extends)],
      references: [...new Set(args.edges.references)],
    },
    unresolved: [],
    httpBinding: null,
    sourceRef: { path: ctx.relPath, startLine: start, endLine: end, commitSha: ctx.commitSha },
    analysisDepth: 'semantic',
    // §10 Layer 1 — source only travels when the repo opted in, in writing.
    sourceText: ctx.includeSource ? truncate(bodyText, 20_000) : null,
    bodyHash: sha256Hex(bodyText),
    generated: ctx.generated,
    overloadDiscriminator: parameters.map((p) => p.type?.text ?? 'unknown').join(','),
    parentQualifiedName: args.parentQualifiedName,
  };
}

function mapParameter(param: ParameterDeclaration): Parameter {
  const type = param.getType();
  return {
    name: param.getName(),
    type: typeRefOf(type),
    optional: param.isOptional(),
    defaultValue: param.getInitializer()?.getText() ?? null,
    rest: param.isRestParameter(),
    description: null,
  };
}

function typeRefOf(type: Type | undefined): TypeRef | null {
  if (!type) return null;
  const text = truncate(type.getText(undefined, ts.TypeFormatFlags.NoTruncation), 300);
  return {
    text,
    // Resolution to a symbol id happens in assembly, which owns identity; the analyser only
    // reports what it saw. A `null` here is honest, not a gap.
    symbolId: null,
    package: packageOf(type),
    nullable: type.isNullable() || /\|\s*(null|undefined)\b/.test(text),
    isArray: type.isArray() || /\[\]$/.test(text) || /^(Array|ReadonlyArray)</.test(text),
    typeArguments: type.getTypeArguments().map((t) => truncate(t.getText(), 120)),
  };
}

/** Which package a type came from — the raw material for cross-repo package edges (§4.3). */
function packageOf(type: Type): string | null {
  const declaration = type.getSymbol()?.getDeclarations()?.[0];
  if (!declaration) return null;
  const filePath = declaration.getSourceFile().getFilePath();
  const match = /node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)/.exec(filePath);
  return match ? match[1]!.replace(/\\/g, '/') : null;
}

/**
 * Call edges by qualified name. Resolving through the type checker to a declaration gives a
 * far better name than the call expression text — `service.create()` becomes
 * `InvoiceService.create` — which is what makes cross-file graph expansion work at all.
 */
function collectCalls(node: Node): string[] {
  const calls: string[] = [];
  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    const resolved = resolveCallTarget(expression);
    if (resolved) calls.push(resolved);
  }
  return calls;
}

function resolveCallTarget(expression: Node): string | null {
  const symbol = expression.getSymbol() ?? expression.getType().getSymbol();
  const declaration = symbol?.getDeclarations()?.[0];

  if (declaration) {
    // Skip anything from node_modules or lib.d.ts: the graph should describe this org's code.
    const filePath = declaration.getSourceFile().getFilePath();
    if (filePath.includes('node_modules') || declaration.getSourceFile().isDeclarationFile()) {
      return null;
    }
    const owner = declaration.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)?.getName();
    const name = symbol!.getName();
    if (name === '__type' || name === 'unknown') return null;
    return owner ? `${owner}.${name}` : name;
  }

  // Unresolved property access still carries a usable name for lexical matching.
  if (Node.isPropertyAccessExpression(expression)) return expression.getName();
  if (Node.isIdentifier(expression)) return expression.getText();
  return null;
}

function collectTypeRefs(parameters: Parameter[], returnType: TypeRef | null): TypeRef[] {
  const refs = parameters.map((p) => p.type).filter((t): t is TypeRef => t !== null);
  if (returnType) refs.push(returnType);
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.text) ? false : (seen.add(r.text), true)));
}

function renderCallableSignature(
  name: string,
  node: {
    getParameters(): ParameterDeclaration[];
    getReturnType(): Type;
    getTypeParameters?(): unknown[];
  },
): string {
  const params = node
    .getParameters()
    .map((p) => {
      const optional = p.isOptional() && !p.getInitializer() ? '?' : '';
      const rest = p.isRestParameter() ? '...' : '';
      return `${rest}${p.getName()}${optional}: ${truncate(p.getType().getText(p), 160)}`;
    })
    .join(', ');
  return `${name}(${params}): ${truncate(node.getReturnType().getText(undefined, ts.TypeFormatFlags.NoTruncation), 200)}`;
}

function renderClassSignature(cls: ClassDeclaration): string {
  const parts = [`class ${cls.getName()}`];
  const typeParams = cls.getTypeParameters().map((t) => t.getText());
  if (typeParams.length) parts.push(renderTypeParams(typeParams));
  const ext = cls.getExtends();
  if (ext) parts.push(` extends ${ext.getText()}`);
  const impl = cls.getImplements();
  if (impl.length) parts.push(` implements ${impl.map((i) => i.getText()).join(', ')}`);
  return parts.join('');
}

function renderTypeParams(params: string[]): string {
  return params.length ? `<${params.join(', ')}>` : '';
}

function collectModifiers(modifiers: string[]): string[] {
  return modifiers.filter((m) => m !== 'export' && m !== 'default' && m !== 'declare');
}

function mapVisibility(scope: string | undefined): Visibility {
  switch (scope) {
    case 'private':
      return 'private';
    case 'protected':
      return 'protected';
    default:
      return 'public';
  }
}

function joinJsDoc(docs: JSDoc[]): string | null {
  if (docs.length === 0) return null;
  return docs.map((d) => d.getInnerText()).join('\n\n');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function normalizeSlashes(path: string): string {
  return path.split('\\').join('/');
}

function toRepoRelative(repoRoot: string, absolute: string): string {
  const normalizedRoot = normalizeSlashes(repoRoot).replace(/\/+$/, '');
  const normalized = normalizeSlashes(absolute);
  return normalized.startsWith(`${normalizedRoot}/`)
    ? normalized.slice(normalizedRoot.length + 1)
    : normalized;
}

function findTsConfig(repoRoot: string, modulePath: string): string | undefined {
  const candidates = [
    join(repoRoot, modulePath, 'tsconfig.json'),
    join(repoRoot, modulePath, 'jsconfig.json'),
    join(repoRoot, 'tsconfig.json'),
    join(repoRoot, 'jsconfig.json'),
  ];
  return candidates.find((c) => existsSync(c));
}
