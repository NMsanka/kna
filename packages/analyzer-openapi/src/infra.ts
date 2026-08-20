import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { globby } from 'globby';
import { parse as parseYaml } from 'yaml';
import type { IrBundlePayload } from '@kna/ir';

type ServiceManifest = IrBundlePayload['services'][number];

/**
 * Tier 2, second half — deployment topology (§5).
 *
 * "Also harvest at this tier: database migration files (schema evolution), IaC
 * (Terraform/Bicep — deployment topology), `docker-compose` and Helm charts (service
 * dependencies), and CI configs (build and release process). These make architecture
 * documentation *actually* accurate instead of inferred."
 *
 * That last clause is the point. An architecture diagram derived from imports describes what
 * the code references; one derived from compose files and Helm charts describes what actually
 * runs and what it talks to. The two disagree more often than anyone expects.
 */

export interface ExtractServicesInput {
  repoRoot: string;
}

export async function extractServices(input: ExtractServicesInput): Promise<ServiceManifest[]> {
  const services: ServiceManifest[] = [];

  const files = await globby(
    [
      '**/docker-compose*.{yml,yaml}',
      '**/compose*.{yml,yaml}',
      '**/Chart.{yml,yaml}',
      '**/values*.{yml,yaml}',
      '**/*.tf',
      '**/*.bicep',
    ],
    {
      cwd: input.repoRoot,
      ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**'],
      onlyFiles: true,
      followSymbolicLinks: false,
    },
  );

  for (const relPath of files) {
    try {
      const raw = await readFile(join(input.repoRoot, relPath), 'utf8');
      if (/compose/i.test(relPath)) {
        services.push(...parseCompose(raw, relPath));
      } else if (relPath.endsWith('.tf')) {
        services.push(...parseTerraform(raw, relPath));
      } else if (relPath.endsWith('.bicep')) {
        services.push(...parseBicep(raw, relPath));
      } else if (/Chart\.(yml|yaml)$/.test(relPath)) {
        services.push(...parseHelmChart(raw, relPath));
      }
    } catch {
      // Infrastructure files are frequently templated and not valid YAML on their own. A
      // parse failure degrades the architecture view; it never fails the run (§5).
      continue;
    }
  }

  return dedupe(services);
}

interface ComposeFile {
  services?: Record<
    string,
    {
      image?: string;
      build?: unknown;
      depends_on?: string[] | Record<string, unknown>;
      ports?: Array<string | number>;
      links?: string[];
    }
  >;
}

function parseCompose(raw: string, sourcePath: string): ServiceManifest[] {
  const doc = parseYaml(raw) as ComposeFile | null;
  if (!doc?.services) return [];

  return Object.entries(doc.services).map(([name, service]) => {
    const dependsOn = Array.isArray(service.depends_on)
      ? service.depends_on
      : Object.keys(service.depends_on ?? {});

    return {
      name,
      kind: inferKind(name, service.image ?? null),
      moduleId: null,
      image: service.image ?? null,
      dependsOn: [...dependsOn, ...(service.links ?? [])],
      ports: (service.ports ?? [])
        .map((p) => Number(String(p).split(':').pop()))
        .filter((p) => Number.isFinite(p)),
      source: sourcePath,
    };
  });
}

/**
 * Terraform without a full HCL parser. Resource blocks are regular enough that a targeted
 * regex recovers the topology, and pulling in an HCL parser for this is not proportionate —
 * the value here is "these things exist and reference each other", not full fidelity.
 */
function parseTerraform(raw: string, sourcePath: string): ServiceManifest[] {
  const services: ServiceManifest[] = [];
  const resourcePattern = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;

  for (const match of raw.matchAll(resourcePattern)) {
    const [, type, name] = match;
    if (!type || !name) continue;
    if (!/service|container|function|app|database|db|queue|topic|cache|redis|sql/i.test(type)) {
      continue;
    }

    const blockStart = match.index + match[0].length;
    const block = raw.slice(blockStart, blockStart + 2000);
    // Cross-resource references are the edges: `aws_ecs_service.web` depends on whatever it
    // interpolates.
    const references = [...block.matchAll(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\.[a-z_]+/g)]
      .map((m) => m[2]!)
      .filter((r) => r !== name);

    services.push({
      name,
      kind: inferKind(name, type),
      moduleId: null,
      image: null,
      dependsOn: [...new Set(references)],
      ports: [],
      source: sourcePath,
    });
  }

  return services;
}

function parseBicep(raw: string, sourcePath: string): ServiceManifest[] {
  const services: ServiceManifest[] = [];
  for (const match of raw.matchAll(/resource\s+(\w+)\s+'([^'@]+)@?[^']*'\s*=/g)) {
    const [, name, type] = match;
    if (!name || !type) continue;
    services.push({
      name,
      kind: inferKind(name, type),
      moduleId: null,
      image: null,
      dependsOn: [],
      ports: [],
      source: sourcePath,
    });
  }
  return services;
}

function parseHelmChart(raw: string, sourcePath: string): ServiceManifest[] {
  const doc = parseYaml(raw) as { name?: string; dependencies?: Array<{ name?: string }> } | null;
  if (!doc?.name) return [];
  return [
    {
      name: doc.name,
      kind: 'service',
      moduleId: null,
      image: null,
      dependsOn: (doc.dependencies ?? []).map((d) => d.name ?? '').filter(Boolean),
      ports: [],
      source: sourcePath,
    },
  ];
}

function inferKind(name: string, hint: string | null): ServiceManifest['kind'] {
  const subject = `${name} ${hint ?? ''}`.toLowerCase();
  if (/postgres|mysql|mariadb|mssql|sqlserver|mongo|cosmos|dynamo|\bdb\b|database/.test(subject)) {
    return 'database';
  }
  if (/redis|memcached|cache/.test(subject)) return 'cache';
  if (/rabbit|kafka|sqs|servicebus|queue|topic|pubsub|nats/.test(subject)) return 'queue';
  if (/job|cron|worker|scheduler/.test(subject)) return 'job';
  if (/external|third.?party|vendor/.test(subject)) return 'external';
  return 'service';
}

function dedupe(services: ServiceManifest[]): ServiceManifest[] {
  const byName = new Map<string, ServiceManifest>();
  for (const service of services) {
    const existing = byName.get(service.name);
    if (!existing) {
      byName.set(service.name, service);
      continue;
    }
    // Merge rather than overwrite: a service can legitimately appear in compose and in Helm,
    // and each file knows something the other does not.
    existing.dependsOn = [...new Set([...existing.dependsOn, ...service.dependsOn])];
    existing.ports = [...new Set([...existing.ports, ...service.ports])];
    existing.image = existing.image ?? service.image;
  }
  return [...byName.values()];
}
