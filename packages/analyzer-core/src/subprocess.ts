import { spawn } from 'node:child_process';
import { zAnalyzerResponse, type AnalyzerRequest, type AnalyzerResponse } from './registry.js';

/**
 * Subprocess transport for out-of-process analysers (Griffe, Roslyn).
 *
 * §15.2 is emphatic that this boundary is a security boundary, not plumbing: "the CI analyser
 * is remote code execution by design... any contributor who can land a `.csproj`,
 * `package.json` or `nuget.config` change gets code execution on a runner holding repo read
 * access, network egress, and the platform publish token."
 *
 * What this module enforces:
 *  - A hard timeout with SIGKILL escalation. A hung Roslyn run must not hang the pipeline.
 *  - Output size caps. A pathological analyser must not exhaust the coordinator's memory.
 *  - `env` is constructed explicitly, never inherited wholesale — the publish token is never
 *    visible to analyser processes.
 *  - `NO_NETWORK` is set as a signal, but the *real* egress denial belongs in the sandbox that
 *    runs the workflow (see .github/workflows/index.yml). This module cannot enforce it and
 *    does not pretend to.
 */

export interface SubprocessOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  /** Extra environment entries. The parent environment is NOT inherited by default. */
  env?: Record<string, string>;
  /** Inherit PATH and platform essentials only. */
  inheritPath?: boolean;
}

export class AnalyzerSubprocessError extends Error {
  constructor(
    message: string,
    readonly code:
      'timeout' | 'spawn-failed' | 'nonzero-exit' | 'bad-protocol' | 'output-too-large',
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'AnalyzerSubprocessError';
  }
}

const DEFAULT_MAX_OUTPUT = 512 * 1024 * 1024;

export async function runAnalyzerSubprocess(
  options: SubprocessOptions,
  request: AnalyzerRequest,
): Promise<AnalyzerResponse> {
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const env = buildEnv(options);

  return new Promise<AnalyzerResponse>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      fn();
    };

    // Escalate: SIGTERM first so the analyser can flush diagnostics, SIGKILL shortly after.
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      finish(() =>
        reject(
          new AnalyzerSubprocessError(
            `Analyser ${options.command} exceeded ${options.timeoutMs}ms and was terminated.`,
            'timeout',
            Buffer.concat(stderr).toString('utf8').slice(-4000),
          ),
        ),
      );
    }, options.timeoutMs);
    let killTimer: NodeJS.Timeout = setTimeout(() => undefined, 0);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) {
        child.kill('SIGKILL');
        finish(() =>
          reject(
            new AnalyzerSubprocessError(
              `Analyser ${options.command} produced more than ${maxOutput} bytes.`,
              'output-too-large',
            ),
          ),
        );
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded: a chatty analyser must not become a memory leak.
      if (stderr.length < 512) stderr.push(chunk);
    });

    child.on('error', (error) => {
      finish(() =>
        reject(
          new AnalyzerSubprocessError(
            `Failed to spawn ${options.command}: ${error.message}`,
            'spawn-failed',
          ),
        ),
      );
    });

    child.on('close', (code) => {
      finish(() => {
        const errText = Buffer.concat(stderr).toString('utf8').slice(-4000);
        if (code !== 0) {
          reject(
            new AnalyzerSubprocessError(
              `Analyser ${options.command} exited with code ${code}.`,
              'nonzero-exit',
              errText,
            ),
          );
          return;
        }

        try {
          const parsed = zAnalyzerResponse.parse(
            JSON.parse(Buffer.concat(stdout).toString('utf8')),
          );
          resolve(parsed);
        } catch (error) {
          reject(
            new AnalyzerSubprocessError(
              `Analyser ${options.command} produced output that does not conform to kna-analyzer/1: ${
                error instanceof Error ? error.message : String(error)
              }`,
              'bad-protocol',
              errText,
            ),
          );
        }
      });
    });

    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
}

/**
 * Explicit environment. The publish token, cloud credentials, and anything else in the CI
 * runner's environment are deliberately absent — an analyser that reads a `.csproj` is running
 * contributor-controlled build logic and must never see them.
 */
function buildEnv(options: SubprocessOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    KNA_ANALYZER: '1',
    KNA_NO_NETWORK: '1',
    ...options.env,
  };

  if (options.inheritPath !== false) {
    for (const key of [
      'PATH',
      'Path',
      'SystemRoot',
      'windir',
      'TEMP',
      'TMP',
      'HOME',
      'USERPROFILE',
      'LANG',
    ]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    // Toolchain roots the analysers legitimately need.
    for (const key of [
      'DOTNET_ROOT',
      'DOTNET_CLI_TELEMETRY_OPTOUT',
      'PYTHONPATH',
      'VIRTUAL_ENV',
      'UV_CACHE_DIR',
    ]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  }

  return env;
}

/** Probe a command's version without giving it stdin or a working repo. */
export async function probeCommand(
  command: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: false,
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8').trim() : null);
    });
  });
}
