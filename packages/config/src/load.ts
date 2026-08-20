import { cosmiconfig } from 'cosmiconfig';
import { type z } from 'zod';
import { defaultConfig, zRepoConfig, type RepoConfig } from './schema.js';

export interface LoadedConfig {
  config: RepoConfig;
  /** Absolute path of the file it came from, or null when defaults were synthesised. */
  filepath: string | null;
  /** True when no config file existed — the intended common case, not an error. */
  isDefault: boolean;
  warnings: string[];
}

const explorer = cosmiconfig('kna', {
  searchPlaces: [
    'kna.config.yaml',
    'kna.config.yml',
    'kna.config.json',
    'kna.config.js',
    'kna.config.mjs',
    '.knarc',
    '.knarc.json',
    '.knarc.yaml',
    'package.json',
  ],
});

export async function loadRepoConfig(cwd: string, orgFallback?: string): Promise<LoadedConfig> {
  const found = await explorer.search(cwd);
  if (!found || found.isEmpty) {
    return {
      config: defaultConfig(orgFallback ?? 'default'),
      filepath: null,
      isDefault: true,
      warnings: [],
    };
  }

  const parsed = zRepoConfig.safeParse(found.config);
  if (!parsed.success) {
    throw new ConfigError(found.filepath, parsed.error);
  }

  const warnings: string[] = [];
  if (parsed.data.security.uploadSource && !parsed.data.security.uploadSourceApprovedBy) {
    // Not fatal here — the CLI blocks the publish. But surface it as early as possible.
    warnings.push(
      'security.uploadSource is enabled without uploadSourceApprovedBy. Source upload is an explicit, attributable decision; publish will refuse until it is recorded.',
    );
  }

  return { config: parsed.data, filepath: found.filepath, isDefault: false, warnings };
}

export class ConfigError extends Error {
  constructor(
    readonly filepath: string,
    readonly zodError: z.ZodError,
  ) {
    const issues = zodError.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    super(`Invalid configuration in ${filepath}:\n${issues}`);
    this.name = 'ConfigError';
  }
}

/** Clear the cosmiconfig cache — needed in tests and in a long-lived worker process. */
export function clearConfigCache(): void {
  explorer.clearCaches();
}
