import { describe, expect, it } from 'vitest';
import { IrVersionError, upcastBundle } from './upcast.js';
import { isWithinSupportWindow } from './version.js';

describe('IR schema support window', () => {
  it('accepts the current and older supported versions', () => {
    expect(isWithinSupportWindow('3.2.1', '3.2.1')).toBe(true);
    expect(isWithinSupportWindow('3.1.9', '3.2.1')).toBe(true);
    expect(isWithinSupportWindow('2.9.0', '3.2.1')).toBe(true);
    expect(isWithinSupportWindow('1.0.0', '3.2.1')).toBe(true);
  });

  it('rejects versions that are too old or newer than the runtime', () => {
    expect(isWithinSupportWindow('0.9.0', '3.2.1')).toBe(false);
    expect(isWithinSupportWindow('3.2.2', '3.2.1')).toBe(false);
    expect(isWithinSupportWindow('3.3.0', '3.2.1')).toBe(false);
    expect(isWithinSupportWindow('4.0.0', '3.2.1')).toBe(false);
  });

  it('reports a newer producer before parsing the unknown payload shape', () => {
    try {
      upcastBundle({ envelope: { irSchemaVersion: '1.2.0' } });
      throw new Error('Expected a version error');
    } catch (error) {
      expect(error).toBeInstanceOf(IrVersionError);
      expect((error as IrVersionError).producerIsNewer).toBe(true);
      expect((error as Error).message).toContain('Rebuild and restart the platform');
    }
  });
});
