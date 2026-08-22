#!/usr/bin/env node
/**
 * Cross-platform launcher for `scripts/dev.sh`.
 *
 * `"dev": "bash scripts/dev.sh"` looks like it would work and does not. On Windows, `bash` on the
 * PATH is usually **WSL's** bash, which cannot see the Windows filesystem the way this script
 * expects, so `pnpm dev` fails with an execvpe error from a Linux subsystem nobody asked for.
 * Git Bash is the shell that works, and it is not on the PATH as `bash`.
 *
 * So: find the right shell rather than hoping the PATH holds it. Everywhere other than Windows
 * this is just `bash`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'dev.sh');

/** Git for Windows ships the bash this script needs; WSL's bash is a different thing entirely. */
function findShell() {
  if (process.platform !== 'win32') return 'bash';

  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];

  const found = candidates.find((p) => p && existsSync(p));
  if (found) return found;

  console.error(
    '\nCould not find Git Bash, which this script needs.\n\n' +
      'Install Git for Windows, or run the script directly from a Git Bash terminal:\n' +
      '  ./scripts/dev.sh ' +
      (process.argv.slice(2).join(' ') || 'help') +
      '\n',
  );
  process.exit(1);
}

const child = spawn(findShell(), [script, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
});

child.on('exit', (code, signal) => {
  // Preserve the child's exit code so a failing step still fails the caller — a launcher that
  // always exits 0 turns every error into a silent one.
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
