import { describe, expect, it } from 'vitest';
import { normaliseTypeText as n } from './type-text.js';

/** The property that matters: two printings of one type must normalise to the same string. */
function agree(a: string, b: string): void {
  expect(n(a)).toBe(n(b));
}

describe('normaliseTypeText', () => {
  describe('the failure it exists for', () => {
    it('agrees on a union however the compiler ordered it', () => {
      agree(
        '"development" | "test" | "staging" | "production"',
        '"production" | "development" | "test" | "staging"',
      );
    });

    it('agrees on the exact signature that failed CI', () => {
      const here =
        '{ KNA_ENV: "development" | "test" | "staging" | "production"; KNA_REGION: string; ' +
        'LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error" | "fatal" }';
      const there =
        '{ KNA_ENV: "production" | "development" | "test" | "staging"; KNA_REGION: string; ' +
        'LOG_LEVEL: "fatal" | "trace" | "debug" | "info" | "warn" | "error" }';
      agree(here, there);
    });
  });

  // Every one of these was broken by a first attempt that split on `|` at depth zero.
  describe('separators that bind looser than a union', () => {
    it('does not treat an object body as one union', () => {
      expect(n('{ a: "b" | "a"; b: number }')).toBe('{ a: "a" | "b"; b: number }');
    });

    it('does not treat a function type as a union with its return', () => {
      expect(n('(x: number) => "b" | "a"')).toBe('(x: number) => "a" | "b"');
    });

    it('keeps a labelled member with its label', () => {
      expect(n('value: "c" | "a"')).toBe('value: "a" | "c"');
    });

    it('normalises each parameter without merging them', () => {
      expect(n('(a: "b" | "a", b: "d" | "c")')).toBe('(a: "a" | "b", b: "c" | "d")');
    });

    it('reaches a union in a parameter list left of the return type', () => {
      // The whole parameter list sits to the left of the return type's colon, so a branch that
      // copies the left side verbatim never normalises anything in it.
      agree(
        'f(env: { KNA_ENV: "a" | "b" }): Promise<T>',
        'f(env: { KNA_ENV: "b" | "a" }): Promise<T>',
      );
    });

    it('does not let one nested union absorb another', () => {
      expect(n('{ x: "b" | "a" } | { y: "d" | "c" }')).toBe('{ x: "a" | "b" } | { y: "c" | "d" }');
    });
  });

  describe('leaves alone what it should', () => {
    it('a type with no union', () => {
      expect(n('Promise<Array<string>>')).toBe('Promise<Array<string>>');
    });

    it('a pipe inside a string literal type', () => {
      expect(n('"a|b"')).toBe('"a|b"');
    });

    it('the order of an intersection', () => {
      expect(n('B & A')).toBe('B & A');
    });

    it('but still normalises inside one', () => {
      expect(n('B & { x: "b" | "a" }')).toBe('B & { x: "a" | "b" }');
    });

    it('an optional member, which is not a conditional type', () => {
      expect(n('name?: "b" | "a"')).toBe('name?: "a" | "b"');
    });

    it('an index signature, whose inner colon is not the member colon', () => {
      expect(n('{ [key: string]: "b" | "a" }')).toBe('{ [key: string]: "a" | "b" }');
    });
  });

  describe('preserves how it was written', () => {
    it('keeps semicolons and spacing', () => {
      expect(n('{ a: number; b: string }')).toBe('{ a: number; b: string }');
    });

    it('keeps a compact object exactly as compact', () => {
      expect(n('{a: number;b: string}')).toBe('{a: number;b: string}');
    });

    it('keeps a trailing separator', () => {
      expect(n('{ a: number; }')).toBe('{ a: number; }');
    });

    it('keeps commas in a generic argument list', () => {
      expect(n('Map<string, "b" | "a">')).toBe('Map<string, "a" | "b">');
    });
  });

  describe('nesting', () => {
    it('reaches a union several levels down', () => {
      agree(
        'Promise<{ items: Array<{ kind: "b" | "a" }> }>',
        'Promise<{ items: Array<{ kind: "a" | "b" }> }>',
      );
    });

    it('handles a function inside an object inside a union', () => {
      agree(
        '{ run: (x: number) => "b" | "a" } | string',
        'string | { run: (x: number) => "a" | "b" }',
      );
    });

    it('handles a conditional type', () => {
      expect(n('T extends U ? "b" | "a" : "d" | "c"')).toBe('T extends U ? "a" | "b" : "c" | "d"');
    });
  });

  describe('is safe to apply twice', () => {
    it('is idempotent on a union', () => {
      const once = n('"c" | "a" | "b"');
      expect(n(once)).toBe(once);
    });

    it('is idempotent on the CI signature', () => {
      const once = n('{ KNA_ENV: "production" | "development"; f: (a: "z" | "y") => void }');
      expect(n(once)).toBe(once);
    });

    it('leaves an empty or whitespace-only string alone', () => {
      expect(n('')).toBe('');
      expect(n('   ')).toBe('   ');
    });
  });

  // Real output from this repository, truncated by the printer. It must survive unbalanced
  // brackets rather than throwing or losing the tail.
  describe('malformed input', () => {
    it('does not throw on a truncated type', () => {
      expect(() => n('{ a: "b" | "a"; b: Partial<{ c: numb')).not.toThrow();
    });

    it('does not throw on an unterminated string', () => {
      expect(() => n('"unterminated | thing')).not.toThrow();
    });
  });
});
