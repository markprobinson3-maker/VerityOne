/**
 * Memory expiry engine — transition active memories past their expires_at.
 *
 * Scans tenant-local memories where expires_at < now() and dormant_at IS NULL,
 * then atomically transitions each to status=expired with dormant_at set.
 * Node mutation + registry update + expired event are atomic (sql.begin).
 * Sync journal is best-effort outside the transaction.
 *
 * Called by a background loop in index.ts. Safe to call concurrently —
 * the WHERE clause naturally excludes already-expired rows.
 */

import type postgres from "postgres";

type SqlTag = ReturnType<typeof postgres>;

export interface ExpiryResult {
  scanned: number;
  expired: number;
  errors: number;
}

/**
 * Expire all eligible memories across all tenants.
 *
 * Eligible: node_type='memory', dormant_at IS NULL, substance.expires_at is
 * a valid past timestamp. Each memory is transitioned individually with its
 * own atomic transaction.
 */
export async function expireMemories(
  sql: SqlTag,
  now: Date = new Date(),
): Promise<ExpiryResult> {
  // Find all eligible memories: active, with a past expires_at
  const eligible = await sql`
    SELECT n.addr, n.space_id, n.substance->>'project_addr' as project_addr
    FROM nodes n
    WHERE n.node_type = 'memory'
      AND n.dormant_at IS NULL
      AND n.substance->>'expires_at' IS NOT NULL
      AND (n.substance->>'expires_at')::timestamptz < ${now.toISOString()}::timestamptz
      AND n.space_id LIKE 'tenant:%'
      AND n.visibility <> 'deleted'
  `;

  const result: ExpiryResult = { scanned: eligible.length, expired: 0, errors: 0 };

  const { logEvent } = await import("./memory-lifecycle");

  for (const row of eligible) {
    const tenantId = row.space_id.replace("tenant:", "");
    try {
      // Atomic: node update + registry update + expired event.
      // The node UPDATE gates on dormant_at IS NULL. If a concurrent sweep
      // already expired this memory, the UPDATE matches 0 rows and we skip
      // the rest — no duplicate registry write or audit event.
      let transitioned = false;
      await sql.begin(async (tx: any) => {
        const updated = await tx`
          UPDATE nodes SET
            substance = substance || ${tx.json({
              status: "expired",
              expired_at: now.toISOString(),
            })}::jsonb,
            dormant_at = ${now.toISOString()}::timestamptz,
            updated_at = now()
          WHERE addr = ${row.addr} AND space_id = ${row.space_id}
            AND dormant_at IS NULL
            AND visibility <> 'deleted'
        `;

        // If another sweep already expired this memory, skip side effects
        if (updated.count === 0) return;

        // Registry update (0 affected rows OK — pre-registry memories)
        await tx`
          UPDATE memory_registry SET
            status = 'expired',
            updated_at = now()
          WHERE addr = ${row.addr} AND tenant_id = ${tenantId}
        `;

        // Audit event — must succeed for the transaction to commit
        await logEvent(tx, row.addr, tenantId, "expired", "expiry-engine", {
          reason: "Memory past its expires_at date.",
        });

        // F11: sync journal tombstone inside the transaction. Best-effort.
        const { tryJournalMemoryInTx } = await import("./sync-journal-port");
        await tryJournalMemoryInTx(tx as any, "tombstone", row.addr, row.space_id, row.project_addr, "[memory-expiry]");

        transitioned = true;
      });

      if (!transitioned) continue; // already expired by concurrent sweep

      result.expired++;
    } catch (e) {
      // Per-memory failure — log and continue with the next
      console.error(`[expiry-engine] failed to expire ${row.addr}:`, (e as Error).message);
      result.errors++;
    }
  }

  return result;
}

// ── Background loop ─────────────────────────────────────────────────

const EXPIRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const EXPIRY_STARTUP_DELAY_MS = 45 * 1000; // 45 seconds after boot

export interface ExpiryHandle {
  stop(): void;
}

export function startExpiryLoop(sql: SqlTag): ExpiryHandle {
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    try {
      const result = await expireMemories(sql);
      if (result.expired > 0 || result.errors > 0) {
        console.error(
          `[expiry-engine] tick: scanned=${result.scanned} expired=${result.expired} errors=${result.errors}`,
        );
      }
    } catch (e) {
      console.error("[expiry-engine] tick failed:", (e as Error).message);
    }
  };

  // Delayed start + periodic
  setTimeout(() => {
    tick(); // immediate first sweep after delay
    timer = setInterval(tick, EXPIRY_INTERVAL_MS);
  }, EXPIRY_STARTUP_DELAY_MS);

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
