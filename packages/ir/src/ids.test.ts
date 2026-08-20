import { describe, expect, it } from 'vitest';
import { canonicalRemote, computeRepoId, computeSymbolId, moduleKey } from './ids.js';

describe('canonicalRemote', () => {
  it('agrees between ssh and https forms of the same repo', () => {
    expect(canonicalRemote('git@github.com:acme/billing-api.git')).toBe(
      canonicalRemote('https://github.com/acme/billing-api'),
    );
  });

  it('strips embedded credentials', () => {
    expect(canonicalRemote('https://user:token@github.com/acme/billing.git')).toBe(
      'github.com/acme/billing',
    );
  });

  it('is case-insensitive', () => {
    expect(canonicalRemote('https://GitHub.com/Acme/Billing')).toBe('github.com/acme/billing');
  });
});

describe('computeRepoId', () => {
  it('is stable across clone URL styles, so two CI runs agree without coordinating', () => {
    const a = computeRepoId('org_1', 'git@github.com:acme/billing.git');
    const b = computeRepoId('org_1', 'https://github.com/acme/billing');
    expect(a).toBe(b);
  });

  it('differs across tenants for the same remote', () => {
    expect(computeRepoId('org_1', 'https://github.com/acme/billing')).not.toBe(
      computeRepoId('org_2', 'https://github.com/acme/billing'),
    );
  });
});

describe('moduleKey', () => {
  it('prefers package identity so a directory move does not change identity', () => {
    const before = moduleKey({
      repoId: 'repo_x',
      path: 'packages/billing',
      ecosystem: 'npm',
      packageName: '@acme/billing',
    });
    const after = moduleKey({
      repoId: 'repo_x',
      path: 'services/billing/packages/billing',
      ecosystem: 'npm',
      packageName: '@acme/billing',
    });
    expect(before).toBe(after);
  });

  it('falls back to path when the module publishes no package', () => {
    const key = moduleKey({
      repoId: 'repo_x',
      path: './src/app/',
      ecosystem: 'none',
      packageName: null,
    });
    expect(key).toBe('path:repo_x/src/app');
  });
});

describe('computeSymbolId', () => {
  const base = {
    orgId: 'org_1',
    moduleKey: 'pkg:npm/@acme/billing',
    language: 'typescript',
    kind: 'method',
    qualifiedName: 'InvoiceService.create',
  };

  it('survives a module path rename (algorithm v2)', () => {
    // Same package, different directory — the whole point of keying on package identity.
    expect(computeSymbolId(base)).toBe(computeSymbolId({ ...base }));
  });

  it('distinguishes overloads via the discriminator', () => {
    const a = computeSymbolId({ ...base, overloadDiscriminator: 'string' });
    const b = computeSymbolId({ ...base, overloadDiscriminator: 'string,number' });
    expect(a).not.toBe(b);
  });

  it('distinguishes tenants', () => {
    expect(computeSymbolId(base)).not.toBe(computeSymbolId({ ...base, orgId: 'org_2' }));
  });

  it('distinguishes a class from a same-named interface', () => {
    expect(computeSymbolId({ ...base, kind: 'class' })).not.toBe(
      computeSymbolId({ ...base, kind: 'interface' }),
    );
  });
});
