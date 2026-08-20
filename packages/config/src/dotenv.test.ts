import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDotEnv, parseDotEnv } from './dotenv.js';

describe('parseDotEnv', () => {
  it('parses plain assignments', () => {
    expect(parseDotEnv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comments and blank lines', () => {
    expect(parseDotEnv('# a comment\n\nFOO=bar\n   \n# another')).toEqual({ FOO: 'bar' });
  });

  it('accepts an export prefix, so the file can be sourced by a shell too', () => {
    expect(parseDotEnv('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('strips an inline comment from an unquoted value', () => {
    expect(parseDotEnv('FOO=bar # trailing note')).toEqual({ FOO: 'bar' });
  });

  it('keeps a hash inside a quoted value', () => {
    // A password containing `#` is common, and losing everything after it would be a very
    // confusing authentication failure.
    expect(parseDotEnv('PASSWORD="p#ssw0rd"')).toEqual({ PASSWORD: 'p#ssw0rd' });
  });

  it('preserves whitespace and specials inside quotes', () => {
    expect(parseDotEnv('A="  spaced  "')).toEqual({ A: '  spaced  ' });
    expect(parseDotEnv("B='raw \\n stays'")).toEqual({ B: 'raw \\n stays' });
  });

  it('expands escapes in double quotes only, matching shell semantics', () => {
    expect(parseDotEnv('A="line\\nbreak"')).toEqual({ A: 'line\nbreak' });
    expect(parseDotEnv("B='line\\nbreak'")).toEqual({ B: 'line\\nbreak' });
  });

  it('does not interpolate variables', () => {
    // A file that silently expands makes a missing variable look like an empty string, which
    // then fails validation somewhere unrelated.
    expect(parseDotEnv('A=${OTHER}/suffix')).toEqual({ A: '${OTHER}/suffix' });
  });

  it('handles values containing an equals sign', () => {
    expect(parseDotEnv('URL=postgres://u:p@h:5432/db?opt=1')).toEqual({
      URL: 'postgres://u:p@h:5432/db?opt=1',
    });
  });

  it('skips malformed lines rather than throwing', () => {
    expect(parseDotEnv('not a valid line\nFOO=bar')).toEqual({ FOO: 'bar' });
  });
});

describe('loadDotEnv', () => {
  function fixture(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'kna-dotenv-'));
    writeFileSync(join(dir, '.env'), contents, 'utf8');
    return dir;
  }

  it('applies values that are not already set', () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadDotEnv({ cwd: fixture('FOO=bar'), env });

    expect(env.FOO).toBe('bar');
    expect(result.applied).toEqual(['FOO']);
  });

  it('never overrides the real environment', () => {
    // The property that makes this safe in CI and in a container: whatever the orchestrator
    // set wins over a file that happened to be present.
    const env: NodeJS.ProcessEnv = { FOO: 'from-real-env' };
    const result = loadDotEnv({ cwd: fixture('FOO=from-file'), env });

    expect(env.FOO).toBe('from-real-env');
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['FOO']);
  });

  it('refuses to read a file in production', () => {
    // §15.7 — no key material in environment variables or images. A .env on disk in production
    // is exactly what that prohibits.
    const env: NodeJS.ProcessEnv = { KNA_ENV: 'production' };
    const result = loadDotEnv({ cwd: fixture('SECRET=leaked'), env });

    expect(env.SECRET).toBeUndefined();
    expect(result.path).toBeNull();
  });

  it('can be disabled explicitly', () => {
    const env: NodeJS.ProcessEnv = { KNA_DISABLE_DOTENV: '1' };
    loadDotEnv({ cwd: fixture('FOO=bar'), env });
    expect(env.FOO).toBeUndefined();
  });

  it('searches upwards, so running from a package finds the repo-root file', () => {
    const root = fixture('FOO=from-root');
    const nested = join(root, 'packages', 'thing');
    mkdirSync(nested, { recursive: true });

    const env: NodeJS.ProcessEnv = {};
    const result = loadDotEnv({ cwd: nested, env });

    expect(env.FOO).toBe('from-root');
    expect(result.path).toContain('.env');
  });

  it('is a no-op when there is no file', () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadDotEnv({ cwd: mkdtempSync(join(tmpdir(), 'kna-empty-')), env, maxDepth: 0 });

    expect(result.path).toBeNull();
    expect(result.applied).toEqual([]);
  });
});
