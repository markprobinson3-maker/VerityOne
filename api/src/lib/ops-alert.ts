/**
 * Push alerting for /ops/runtime — the missing consumer.
 *
 * /ops/runtime builds a rich critical/warn signal set (worker_missing,
 * dangling_graph_edges, supercron_failed_runs, ...) but until now NOTHING
 * consumed it proactively: a single-operator outage was invisible until the
 * operator manually checked. This poller self-fetches the operator surface
 * on an interval and POSTs to a configurable webhook when overall status is
 * critical (and once more on recovery).
 *
 * Deliberately boring and additive:
 *  - env ALERT_WEBHOOK_URL unset -> fully inert (OSS installs + CI silent).
 *  - Self-fetch over loopback with the node's own first operator token —
 *    exercises the real gated surface; zero refactoring of the drift-pinned
 *    ops.ts route internals.
 *  - In-memory dedupe: an unchanged critical signal-set re-fires only every
 *    REFIRE_INTERVAL_MS; recovery (critical -> ok/warn) fires once.
 *  - Long-lived profile only (started next to startMaintenanceCron); a
 *    poll/post failure logs and never crashes the api process.
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const STARTUP_DELAY_MS = 30_000; // let workers write first heartbeats
const REFIRE_INTERVAL_MS = 6 * 60 * 60 * 1000; // unchanged critical re-fires every 6h
const FETCH_TIMEOUT_MS = 20_000;

export interface OpsAlertDecision {
  fire: boolean;
  kind: "critical" | "recovery" | null;
}

export interface OpsAlertState {
  lastFingerprint: string | null;
  lastFiredAtMs: number;
  wasCritical: boolean;
}

export function initialOpsAlertState(): OpsAlertState {
  return { lastFingerprint: null, lastFiredAtMs: 0, wasCritical: false };
}

/** Pure decision core — unit-tested without timers or network. */
export function decideOpsAlert(
  state: OpsAlertState,
  status: string,
  criticalSignalKeys: string[],
  nowMs: number,
): OpsAlertDecision {
  if (status === "critical") {
    const fingerprint = criticalSignalKeys.slice().sort().join("|");
    const changed = fingerprint !== state.lastFingerprint;
    const stale = nowMs - state.lastFiredAtMs >= REFIRE_INTERVAL_MS;
    if (changed || stale) {
      state.lastFingerprint = fingerprint;
      state.lastFiredAtMs = nowMs;
      state.wasCritical = true;
      return { fire: true, kind: "critical" };
    }
    state.wasCritical = true;
    return { fire: false, kind: null };
  }
  if (state.wasCritical) {
    state.wasCritical = false;
    state.lastFingerprint = null;
    state.lastFiredAtMs = nowMs;
    return { fire: true, kind: "recovery" };
  }
  return { fire: false, kind: null };
}

function firstOperatorToken(): string | null {
  const raw = process.env.VERITY_OPERATOR_TOKENS || "";
  const first = raw.split(",").map((t) => t.trim()).filter(Boolean)[0];
  return first || null;
}

export interface OpsAlertHandle {
  stop(): void;
}

export function startOpsAlertPoller(opts: { port: number }): OpsAlertHandle | null {
  const webhookUrl = (process.env.ALERT_WEBHOOK_URL || "").trim();
  if (!webhookUrl) return null; // inert without explicit opt-in

  const token = firstOperatorToken();
  if (!token) {
    console.error("[ops-alert] ALERT_WEBHOOK_URL set but no VERITY_OPERATOR_TOKENS available — alerting disabled");
    return null;
  }

  const state = initialOpsAlertState();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    try {
      const resp = await fetch(`http://127.0.0.1:${opts.port}/ops/runtime`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`/ops/runtime HTTP ${resp.status}`);
      const body = await resp.json() as {
        status?: string;
        signals?: Array<{ severity?: string; key?: string; title?: string; detail?: string }>;
      };
      const status = body.status || "unknown";
      const criticals = (body.signals || []).filter((s) => s.severity === "critical");
      const decision = decideOpsAlert(
        state,
        status,
        criticals.map((s) => s.key || s.title || "unknown"),
        Date.now(),
      );
      if (decision.fire) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          body: JSON.stringify({
            source: "verity-one/ops-alert",
            kind: decision.kind,
            status,
            critical_signals: criticals.map((s) => ({
              key: s.key, title: s.title, detail: (s.detail || "").slice(0, 300),
            })),
            at: new Date().toISOString(),
          }),
        });
        console.error(`[ops-alert] webhook fired: ${decision.kind} (${criticals.length} critical signals)`);
      }
    } catch (e) {
      // Never crash the api process from the alert path.
      console.error("[ops-alert] tick failed:", (e as Error).message);
    } finally {
      if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  }

  timer = setTimeout(tick, STARTUP_DELAY_MS);
  console.error(`[ops-alert] armed: polling /ops/runtime every ${POLL_INTERVAL_MS / 60000}min -> webhook`);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
