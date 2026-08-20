#!/usr/bin/env node
/**
 * Audit install-time code execution.
 *
 * §15.2 HIGH — "third-party grammar and analyser supply chain. Tree-sitter grammars download on
 * demand, and analyser subprocesses are third-party code running against every repo. Pin by
 * digest, vendor into your own registry, and verify checksums — otherwise a compromised grammar
 * package executes inside your CI on every repo in the org."
 *
 * pnpm 10 blocks lifecycle scripts by default and runs only what `onlyBuiltDependencies` in
 * pnpm-workspace.yaml permits. That allowlist *is* the control; this script exists to make it
 * reviewable rather than to duplicate it:
 *
 *  - It fails when the allowlist contains an entry not justified in ALLOWLIST_REASONS, so
 *    nobody can widen it silently to make a build error go away.
 *  - It reports packages whose scripts are blocked, so the blast radius of ever loosening the
 *    setting is visible rather than theoretical.
 *
 * Reads the pnpm store layout directly: `pnpm list --json --depth Infinity` emits well over
 * 100MB of nested duplicates for a workspace this size, and the store already holds exactly one
 * directory per resolved package.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Every entry permitted to run install scripts needs a reason here. "It broke without it" is
 * not one — the question is what the script does and why that is acceptable.
 */
const ALLOWLIST_REASONS = {
  esbuild: 'Fetches the platform-specific binary for its own build. Version-pinned, widely audited.',
};

const LIFECYCLE = ['preinstall', 'install', 'postinstall'];

// ── The allowlist as configured ─────────────────────────────────────────────────────────────
const workspaceYaml = await readFile('pnpm-workspace.yaml', 'utf8').catch(() => '');
const allowlist = [...workspaceYaml.matchAll(/^\s*-\s*(\S+)\s*$/gm)]
  .map((m) => m[1])
  .filter((name) => !name.startsWith("'") && !name.includes('/*'))
  .filter((name) => workspaceYaml.indexOf(name) > workspaceYaml.indexOf('onlyBuiltDependencies'));

const unjustified = allowlist.filter((name) => !(name in ALLOWLIST_REASONS));

// ── What would run if the allowlist were widened ────────────────────────────────────────────
const storeDir = join(process.cwd(), 'node_modules', '.pnpm');

let entries;
try {
  entries = await readdir(storeDir, { withFileTypes: true });
} catch {
  console.error(`No pnpm store at ${storeDir}. Run \`pnpm install\` first.`);
  process.exit(1);
}

const withScripts = new Map();
let inspected = 0;

for (const entry of entries) {
  if (!entry.isDirectory() || entry.name === 'node_modules') continue;

  const packageRoot = join(storeDir, entry.name, 'node_modules');
  let packages;
  try {
    packages = await listPackages(packageRoot);
  } catch {
    continue;
  }

  for (const { name, path } of packages) {
    inspected++;
    if (withScripts.has(name)) continue;
    try {
      const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      const scripts = LIFECYCLE.filter((script) => pkg.scripts?.[script]);
      if (scripts.length > 0) {
        withScripts.set(name, { version: pkg.version ?? '?', scripts });
      }
    } catch {
      continue;
    }
  }
}

async function listPackages(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      const scope = join(root, entry.name);
      for (const scoped of await readdir(scope, { withFileTypes: true })) {
        if (scoped.isDirectory()) {
          found.push({ name: `${entry.name}/${scoped.name}`, path: join(scope, scoped.name) });
        }
      }
    } else {
      found.push({ name: entry.name, path: join(root, entry.name) });
    }
  }
  return found;
}

// ── Report ──────────────────────────────────────────────────────────────────────────────────
const blocked = [...withScripts.entries()]
  .filter(([name]) => !allowlist.includes(name))
  .sort(([a], [b]) => a.localeCompare(b));

console.log(`Inspected ${inspected} resolved package(s).\n`);

console.log(`Permitted to run install scripts (${allowlist.length}):`);
for (const name of allowlist) {
  console.log(`  ${name} — ${ALLOWLIST_REASONS[name] ?? '** NO STATED REASON **'}`);
}

console.log(`\nHave install scripts but are blocked by pnpm (${blocked.length}):`);
for (const [name, info] of blocked.slice(0, 20)) {
  console.log(`  ${name}@${info.version}  (${info.scripts.join(', ')})`);
}
if (blocked.length > 20) console.log(`  ...and ${blocked.length - 20} more`);

if (unjustified.length > 0) {
  console.error(`
${unjustified.length} allowlist entry/entries have no stated reason: ${unjustified.join(', ')}

Every package permitted to run install scripts executes arbitrary code on every developer
machine and every CI runner, including runners holding repository read access and a platform
publish token. Add a reason to ALLOWLIST_REASONS in this script, or remove the entry.
`);
  process.exit(1);
}

console.log('\nAllowlist is fully justified.');
