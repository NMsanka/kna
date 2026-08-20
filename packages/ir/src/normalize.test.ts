import { describe, expect, it } from 'vitest';
import { normalizeDocText, normalizeSignature } from './normalize.js';

describe('normalizeSignature', () => {
  it('is invariant under reformatting of a multi-line parameter list', () => {
    const compact = 'function createInvoice(customerId: string, amount: number): Promise<Invoice>';
    const wrapped = `function createInvoice(
  customerId: string,
  amount: number,
): Promise<Invoice>`;
    expect(normalizeSignature(wrapped, 'typescript')).toBe(
      normalizeSignature(compact, 'typescript'),
    );
  });

  it('is invariant under a trailing comma', () => {
    const a = normalizeSignature('f(a: string, b: number)', 'typescript');
    const b = normalizeSignature('f(a: string, b: number,)', 'typescript');
    expect(a).toBe(b);
  });

  it('changes when a parameter type changes', () => {
    const a = normalizeSignature('f(a: string)', 'typescript');
    const b = normalizeSignature('f(a: number)', 'typescript');
    expect(a).not.toBe(b);
  });

  it('changes when a parameter is added', () => {
    const a = normalizeSignature('f(a: string)', 'typescript');
    const b = normalizeSignature('f(a: string, b?: number)', 'typescript');
    expect(a).not.toBe(b);
  });

  it('strips inline comments without touching string defaults', () => {
    const s = normalizeSignature(
      'function greet(name: string = "hello  world" /* two spaces on purpose */): void',
      'typescript',
    );
    expect(s).toContain('"hello  world"');
    expect(s).not.toContain('two spaces on purpose');
  });

  it('strips hash comments only for python', () => {
    expect(normalizeSignature('def f(a: str)  # trailing note', 'python')).toBe('def f(a: str)');
    expect(normalizeSignature('def f(a: str)  # trailing note', 'typescript')).toContain('#');
  });

  it('handles C# generic and nullable syntax', () => {
    const a = normalizeSignature(
      'public async Task< Invoice? > CreateAsync( Guid id , CancellationToken ct = default )',
      'csharp',
    );
    const b = normalizeSignature(
      'public async Task<Invoice?> CreateAsync(Guid id, CancellationToken ct = default)',
      'csharp',
    );
    expect(a).toBe(b);
  });

  it('drops a trailing brace or semicolon', () => {
    expect(normalizeSignature('function f(): void {', 'typescript')).toBe(
      normalizeSignature('function f(): void', 'typescript'),
    );
  });
});

describe('normalizeDocText', () => {
  it('strips comment markers across dialects', () => {
    expect(normalizeDocText('/**\n * Creates an invoice.\n */')).toBe('Creates an invoice.');
    expect(normalizeDocText('/// <summary>Creates an invoice.</summary>')).toBe(
      '<summary>Creates an invoice.</summary>',
    );
    expect(normalizeDocText('# Creates an invoice.')).toBe('Creates an invoice.');
  });

  it('is invariant under re-indentation', () => {
    const a = normalizeDocText('/**\n * Line one.\n *\n * Line two.\n */');
    const b = normalizeDocText('    /**\n     * Line one.\n     *\n     * Line two.\n     */');
    expect(a).toBe(b);
  });
});
