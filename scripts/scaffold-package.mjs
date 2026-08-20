#!/usr/bin/env node
/**
 * Scaffold a workspace package with the house tsconfig and package.json shape.
 *
 * Usage: node scripts/scaffold-package.mjs <dir> <name> <description> [dep,dep,...]
 * Keeps every package's build wiring identical, which matters more than it looks: TypeScript
 * project references only compose when rootDir/outDir/composite agree everywhere.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const [, , dir, name, description, depsCsv = '', extraCsv = ''] = process.argv;
if (!dir || !name) {
  console.error('usage: scaffold-package.mjs <dir> <name> <description> [workspaceDeps] [externalDeps]');
  process.exit(1);
}

const root = process.cwd();
const pkgDir = join(root, dir);
mkdirSync(join(pkgDir, 'src'), { recursive: true });

const workspaceDeps = depsCsv ? depsCsv.split(',').filter(Boolean) : [];
const externalDeps = extraCsv ? extraCsv.split(',').filter(Boolean) : [];

const dependencies = {};
for (const d of workspaceDeps) dependencies[d] = 'workspace:*';
for (const d of externalDeps) {
  const at = d.lastIndexOf('@');
  if (at > 0) dependencies[d.slice(0, at)] = d.slice(at + 1);
  else dependencies[d] = '*';
}

const pkgJsonPath = join(pkgDir, 'package.json');
if (!existsSync(pkgJsonPath)) {
  writeFileSync(
    pkgJsonPath,
    JSON.stringify(
      {
        name,
        version: '1.0.0',
        description,
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        files: ['dist'],
        scripts: {
          build: 'tsc -b',
          typecheck: 'tsc -b',
          clean: 'rimraf dist *.tsbuildinfo',
        },
        dependencies,
      },
      null,
      2,
    ) + '\n',
  );
}

const references = workspaceDeps
  .filter((d) => d.startsWith('@kna/'))
  .map((d) => ({ path: relative(pkgDir, join(root, 'packages', d.replace('@kna/', ''))).split('\\').join('/') }));

writeFileSync(
  join(pkgDir, 'tsconfig.json'),
  JSON.stringify(
    {
      extends: relative(pkgDir, join(root, 'tsconfig.base.json')).split('\\').join('/'),
      compilerOptions: {
        rootDir: 'src',
        outDir: 'dist',
        tsBuildInfoFile: 'dist/.tsbuildinfo',
      },
      include: ['src/**/*'],
      exclude: ['src/**/*.test.ts'],
      ...(references.length ? { references } : {}),
    },
    null,
    2,
  ) + '\n',
);

console.log(`scaffolded ${name} at ${dir}`);
