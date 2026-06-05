// Open-core stub. The VO+ implementation ships separately.
//
// In the open-core build, the Google Drive vault mirror worker is a VO+
// (hosted/sync/crypto) capability and is intentionally not shipped. This module
// exposes the same public surface the core node imports, but every operation is
// a safe no-op so the node compiles, boots, and degrades gracefully when the
// Drive mirror is absent.

/** Handle returned by {@link startDriveMirrorWorker}. */
export interface DriveMirrorWorkerHandle {
  stop: () => void;
}

/**
 * Run a single Drive mirror tick. Disabled in open-core: resolves immediately
 * without contacting Drive, hosted sync, or the database.
 */
export async function runDriveMirrorTick(): Promise<void> {
  // No-op: the Drive mirror is a VO+ capability and is not present in open-core.
}

/**
 * Start the background Drive mirror worker. Disabled in open-core: starts no
 * timer and returns a handle whose stop() is a no-op, matching the real
 * implementation's contract so the caller's shutdown wiring stays valid.
 */
export function startDriveMirrorWorker(): DriveMirrorWorkerHandle {
  return {
    stop() {
      /* no-op: nothing to stop in open-core */
    },
  };
}

/**
 * Nudge the worker to run a tick out of band (e.g. right after a Drive connect).
 * Disabled in open-core: does nothing.
 */
export function nudgeDriveMirrorWorker(): void {
  // No-op: the Drive mirror is a VO+ capability and is not present in open-core.
}
