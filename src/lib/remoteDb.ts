// Disposable mirror database used by player sessions. Existing read code works
// unchanged against it; the host database stays the source of truth.
import { Dump, SerializedJournal, applyDelta, applySnapshot, clearAll, configureStorage } from './db';

export const MIRROR_DB_NAME = 'banker_mirror_db';

/** Switches the storage layer to the client mirror. Call before any read. */
export function configureMirrorStorage(): void {
  configureStorage({ dbName: MIRROR_DB_NAME });
}

/** Replaces the mirror with the host snapshot (also clears stale rows). */
export function applyMirrorSnapshot(dump: Partial<Dump>): Promise<void> {
  return applySnapshot(dump);
}

/** Applies one committed host delta to the mirror. Idempotent. */
export function applyMirrorDelta(journal: Partial<SerializedJournal>): Promise<void> {
  return applyDelta(journal);
}

export function resetMirror(): Promise<void> {
  return clearAll();
}
