import { z } from 'zod';
import { IR_SCHEMA_VERSION, isWithinSupportWindow, parseVersion } from './version.js';
import { zIrBundle, type IrBundle } from './schema/bundle.js';

/**
 * §15.3 BLOCKER — "CLI version skew across the org is unmanaged".
 *
 * The CLI ships via `npx` to hundreds of independently owned CI pipelines nobody can
 * force-upgrade. The contract is therefore: the server accepts anything inside the N-2 MAJOR
 * window and upcasts it at ingest; outside the window it rejects with an actionable message
 * and a deprecation date measured in months, not days.
 *
 * Register one upcast per MAJOR boundary. Each takes the previous shape and returns the next.
 */
export type Upcast = (input: unknown) => unknown;

const UPCASTS = new Map<number, Upcast>();

/** Example of the shape a real upcast takes; registered when 2.0.0 lands. */
export function registerUpcast(fromMajor: number, fn: Upcast): void {
  UPCASTS.set(fromMajor, fn);
}

export class IrVersionError extends Error {
  constructor(
    message: string,
    readonly received: string,
    readonly minimum: string,
    readonly current: string,
  ) {
    super(message);
    this.name = 'IrVersionError';
  }
}

export interface UpcastResult {
  bundle: IrBundle;
  /** True when the bundle needed migrating — worth a warn-level log and a producer metric. */
  upcasted: boolean;
  fromVersion: string;
  /** Non-fatal warnings to echo back to the CLI so developers see the deprecation clock. */
  warnings: string[];
}

export function upcastBundle(input: unknown): UpcastResult {
  const versionProbe = z
    .object({ envelope: z.object({ irSchemaVersion: z.string() }) })
    .safeParse(input);

  if (!versionProbe.success) {
    throw new IrVersionError(
      'Bundle envelope is unreadable: no irSchemaVersion present.',
      'unknown',
      IR_SCHEMA_VERSION,
      IR_SCHEMA_VERSION,
    );
  }

  const received = versionProbe.data.envelope.irSchemaVersion;
  if (!isWithinSupportWindow(received)) {
    throw new IrVersionError(
      `IR schema ${received} is outside the supported N-2 window (current ${IR_SCHEMA_VERSION}). Upgrade docs-cli: npm i -g @kna/docs-cli@latest`,
      received,
      IR_SCHEMA_VERSION,
      IR_SCHEMA_VERSION,
    );
  }

  const warnings: string[] = [];
  let current: unknown = input;
  let [major] = parseVersion(received);
  const [targetMajor] = parseVersion(IR_SCHEMA_VERSION);
  let upcasted = false;

  while (major < targetMajor) {
    const fn = UPCASTS.get(major);
    if (!fn) {
      throw new IrVersionError(
        `No upcast registered from IR schema major ${major}.`,
        received,
        IR_SCHEMA_VERSION,
        IR_SCHEMA_VERSION,
      );
    }
    current = fn(current);
    major += 1;
    upcasted = true;
  }

  if (upcasted) {
    warnings.push(
      `Bundle was produced by IR schema ${received} and upcasted to ${IR_SCHEMA_VERSION}. Upgrade docs-cli to remove this step.`,
    );
  }

  return { bundle: zIrBundle.parse(current), upcasted, fromVersion: received, warnings };
}
