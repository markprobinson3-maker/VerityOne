// Open-core stub. The VO+ implementation ships separately.
/**
 * Local sync scheduler — open-core stub.
 *
 * In the open-core build there is no hosted mirror to sync to, so the
 * background sync loop is a no-op. The real scheduler (push loop, backoff,
 * escalation, persisted state) ships with VO+.
 *
 * The public surface is preserved so callers compile and boot unchanged:
 *   - `startSyncScheduler()` returns an inert handle whose `stop()` is safe.
 *   - `nudgeSyncScheduler()` is a fire-and-forget no-op.
 */

// ── Types (loose, leak-free shapes for compatibility) ────────────────

export interface SyncSchedulerHandle {
  stop: () => void;
}

export interface SchedulerMeta {
  scheduler_active: boolean;
  scheduler_running: boolean;
  next_attempt_at: string | null;
  consecutive_failures: number;
  sync_escalated: boolean;
  sync_escalation_note: string | null;
}

// ── Singleton nudge ──────────────────────────────────────────────────

/**
 * Nudge the sync scheduler to run soon. No-op in the open-core build —
 * there is no outbound sync loop to wake. Fire-and-forget.
 */
export function nudgeSyncScheduler(): void {
  /* no-op: no hosted sync in open-core */
}

// ── Main ─────────────────────────────────────────────────────────────

/**
 * Start the background sync scheduler. In the open-core build this is
 * disabled: it returns an inert handle immediately and never schedules
 * any work. The signature accepts (and ignores) the same arguments the
 * VO+ scheduler takes so call sites are unchanged.
 */
export function startSyncScheduler(
  _sql?: unknown,
  _hostedBaseUrl?: string,
): SyncSchedulerHandle {
  return {
    stop: () => {
      /* no-op: nothing was scheduled */
    },
  };
}
