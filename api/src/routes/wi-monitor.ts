/**
 * World Ingestor V2 — SSE endpoint + HTML dashboard.
 *
 * GET /wi/events  — SSE stream (max 5 clients, 100-event replay)
 * GET /wi/monitor — self-contained HTML dashboard
 */

import { Hono } from "hono";
import { wiEvents, type WIEvent } from "../../../miners/src/wi/events";
import { errorJson, ApiError } from "../lib/error-envelope";

const app = new Hono();

// ============================================================
// SSE — GET /events
// ============================================================

const MAX_SSE_CLIENTS = 5;
let activeClients = 0;

// Test-only observability into the slot counter. The accounting is module-
// private so production code can't poke it; tests need to assert reclamation.
export function __getActiveSSEClients(): number {
  return activeClients;
}
export function __resetActiveSSEClientsForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetActiveSSEClientsForTests is test-only");
  }
  activeClients = 0;
}

app.get("/events", (c) => {
  if (activeClients >= MAX_SSE_CLIENTS) {
    return errorJson(c, "rate_limited", { message: "Too many SSE clients (max 5)" });
  }

  activeClients++;
  let alive = true;
  // The slot is released exactly once, no matter HOW the client goes away: a
  // clean abort, a failed enqueue (client vanished mid-write), the consumer
  // cancelling the stream, or a signal already aborted at start. Previously
  // only the abort path decremented, so an enqueue-failure or a missing signal
  // leaked the slot, the wiEvents listener, AND the 30s keepalive interval —
  // after MAX_SSE_CLIENTS such deaths /events refused every future client.
  let released = false;
  let handler: ((event: WIEvent) => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const release = () => {
    if (released) return;
    released = true;
    alive = false;
    activeClients--;
    if (handler) wiEvents.off("wi", handler);
    if (keepalive) clearInterval(keepalive);
  };

  const replayRequested = c.req.query("replay") !== "0";
  const since = parseInt(c.req.query("since") || "0", 10);

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: string) => {
        if (!alive) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Client vanished mid-write — release the slot, not just on abort.
          release();
        }
      };

      // Optional replay buffer
      if (replayRequested) {
        for (const event of wiEvents.getReplayBuffer()) {
          if (Number.isFinite(since) && since > 0 && event.timestamp < since) continue;
          send(`data: ${JSON.stringify(event)}\n\n`);
        }
      }

      // Live events
      handler = (event: WIEvent) => {
        send(`data: ${JSON.stringify(event)}\n\n`);
      };
      wiEvents.on("wi", handler);

      // Keepalive every 30s
      keepalive = setInterval(() => {
        send(": keepalive\n\n");
      }, 30_000);

      // Detect client disconnect via abort signal (handle already-aborted too).
      const signal = c.req.raw.signal;
      if (signal) {
        if (signal.aborted) release();
        else signal.addEventListener("abort", release);
      }
    },
    cancel() {
      // Consumer cancelled the stream (the common Bun/Hono disconnect path).
      release();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// ============================================================
// HTML DASHBOARD — GET /monitor
// ============================================================

app.get("/monitor", (c) => {
  return c.html(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>World Ingestor — Monitor</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0a0a0f; color: #c8c8d0; min-height: 100vh; }

  .header { padding: 12px 20px; background: #12121a; border-bottom: 1px solid #2a2a3a; display: flex; align-items: center; gap: 16px; }
  .header h1 { font-size: 14px; color: #8888ff; font-weight: 600; }
  .header .status { font-size: 11px; color: #666; }
  .header .status.connected { color: #4a4; }

  .input-bar { padding: 12px 20px; background: #15151f; border-bottom: 1px solid #2a2a3a; display: flex; gap: 10px; align-items: center; }
  .input-bar input[type="text"] { flex: 1; background: #1a1a28; border: 1px solid #333; color: #ddd; padding: 8px 12px; border-radius: 6px; font-family: inherit; font-size: 13px; outline: none; }
  .input-bar input[type="text"]:focus { border-color: #6666cc; }
  .input-bar button { background: #4444aa; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 600; }
  .input-bar button:hover { background: #5555bb; }
  .input-bar button:disabled { opacity: 0.5; cursor: not-allowed; }
  .input-bar label { font-size: 12px; color: #888; display: flex; align-items: center; gap: 4px; }

  .pipeline { display: flex; gap: 0; padding: 16px 20px; overflow-x: auto; min-height: 200px; }
  .stage { flex: 1; min-width: 200px; background: #12121a; border: 1px solid #2a2a3a; border-radius: 8px; margin: 0 4px; }
  .stage-header { padding: 8px 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #2a2a3a; }
  .stage-source .stage-header { color: #aa88ff; }
  .stage-extract .stage-header { color: #44aaff; }
  .stage-route .stage-header { color: #ffaa44; }
  .stage-dest .stage-header { color: #44ff88; }
  .stage-body { padding: 8px; max-height: 300px; overflow-y: auto; }

  .atom-card { background: #1a1a28; border: 1px solid #333; border-radius: 6px; padding: 8px; margin-bottom: 6px; font-size: 11px; animation: fadeIn 0.3s ease; }
  .atom-card .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; margin-right: 4px; }
  .badge-knowledge { background: #2a2a5a; color: #8888ff; }
  .badge-skill { background: #2a4a2a; color: #44ff88; }
  .atom-card .content { margin-top: 4px; color: #aaa; line-height: 1.4; }
  .atom-card .meta { margin-top: 4px; color: #666; font-size: 10px; }

  .route-card { background: #1a1a28; border-left: 3px solid #666; border-radius: 0 6px 6px 0; padding: 6px 8px; margin-bottom: 4px; font-size: 11px; animation: slideIn 0.3s ease; }
  .route-card.new-node { border-color: #44ff88; }
  .route-card.heat { border-color: #ffaa44; }
  .route-card.skill { border-color: #44aaff; }
  .route-card.drop { border-color: #444; opacity: 0.5; }

  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 0 20px 8px; }
  .panel { background: #12121a; border: 1px solid #2a2a3a; border-radius: 8px; padding: 12px; }
  .panel h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 8px; }

  .run-row { display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: 11px; border-bottom: 1px solid #1a1a28; }
  .run-row .icon { width: 16px; text-align: center; }
  .run-row .type { color: #888; min-width: 70px; }
  .run-row .title { flex: 1; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .run-row .atoms { color: #666; min-width: 60px; text-align: right; }
  .run-row .time { color: #555; min-width: 50px; text-align: right; }
  .run-row .rollback-btn { background: #3a2020; color: #c66; border: 1px solid #533; border-radius: 3px; padding: 1px 6px; font-size: 10px; cursor: pointer; font-family: inherit; }
  .run-row .rollback-btn:hover { background: #4a2020; }

  .skill-card { background: #1a1a28; border: 1px solid #333; border-radius: 6px; padding: 8px; margin-bottom: 6px; font-size: 11px; }
  .skill-card .skill-status { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; }
  .skill-status-proposed { background: #2a2a4a; color: #88f; }
  .skill-status-needs_human { background: #4a4a2a; color: #ff8; }
  .skill-status-active { background: #2a4a2a; color: #4f8; }
  .skill-status-rejected { background: #4a2a2a; color: #f88; }
  .skill-card .actions { margin-top: 6px; display: flex; gap: 6px; }
  .skill-card .actions button { padding: 2px 8px; border-radius: 3px; font-size: 10px; cursor: pointer; font-family: inherit; border: 1px solid #444; }
  .btn-approve { background: #2a4a2a; color: #4f8; }
  .btn-approve:hover { background: #3a5a3a; }
  .btn-reject { background: #4a2a2a; color: #f88; }
  .btn-reject:hover { background: #5a3a3a; }

  .stats-bar { display: flex; gap: 20px; padding: 10px 20px; background: #12121a; border-top: 1px solid #2a2a3a; font-size: 12px; }
  .stat { display: flex; gap: 4px; }
  .stat-label { color: #666; }
  .stat-value { color: #aaa; font-weight: 600; }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes slideIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  .processing { animation: pulse 1.5s ease infinite; }

  .drop-zone { border: 2px dashed transparent; transition: border-color 0.2s; }
  .drop-zone.active { border-color: #6666cc; background: rgba(100, 100, 200, 0.05); }

  .convergence-card { background: #1a1a28; border: 1px solid #333; border-radius: 6px; padding: 10px; margin-bottom: 8px; font-size: 11px; }
  .convergence-card .label { font-size: 13px; font-weight: 700; color: #88ccff; }
  .convergence-card .desc { color: #999; margin-top: 2px; }
  .convergence-card .meta-row { display: flex; gap: 12px; margin-top: 6px; color: #777; font-size: 10px; }
  .convergence-card .energy-bar { height: 4px; background: #2a2a3a; border-radius: 2px; margin-top: 4px; }
  .convergence-card .energy-fill { height: 100%; border-radius: 2px; background: linear-gradient(90deg, #44aaff, #ff6644); }
  .convergence-card .source-badge { display: inline-block; padding: 1px 5px; margin-right: 3px; border-radius: 3px; font-size: 9px; font-weight: 600; background: #2a2a4a; color: #88f; }
  .convergence-card .sample { color: #777; font-size: 10px; margin-top: 4px; font-style: italic; }
  .convergence-card .actions { margin-top: 6px; display: flex; gap: 6px; }
  .convergence-card .status-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; }
  .status-detected { background: #2a2a4a; color: #88f; }
  .status-promoted { background: #2a4a2a; color: #4f8; }
  .status-dismissed { background: #4a4a2a; color: #aa8; }
  .status-decayed { background: #3a3a3a; color: #777; }
  .btn-promote { background: #2a4a2a; color: #4f8; border: 1px solid #3a5a3a; padding: 2px 8px; border-radius: 3px; font-size: 10px; cursor: pointer; font-family: inherit; }
  .btn-promote:hover { background: #3a5a3a; }
  .btn-dismiss { background: #4a3a2a; color: #da8; border: 1px solid #5a4a3a; padding: 2px 8px; border-radius: 3px; font-size: 10px; cursor: pointer; font-family: inherit; }
  .btn-dismiss:hover { background: #5a4a3a; }
</style>
</head>
<body class="drop-zone">

<div class="header">
  <h1>WORLD INGESTOR</h1>
  <span class="status" id="sse-status">disconnected</span>
</div>

<div class="input-bar">
  <input type="text" id="url-input" placeholder="Paste URL here..." autocomplete="off">
  <label><input type="checkbox" id="dry-run"> Dry run</label>
  <button id="ingest-btn" onclick="ingest()">INGEST</button>
</div>

<div class="pipeline">
  <div class="stage stage-source">
    <div class="stage-header">SOURCE</div>
    <div class="stage-body" id="source-panel"></div>
  </div>
  <div class="stage stage-extract">
    <div class="stage-header">EXTRACT</div>
    <div class="stage-body" id="extract-panel"></div>
  </div>
  <div class="stage stage-route">
    <div class="stage-header">ROUTE</div>
    <div class="stage-body" id="route-panel"></div>
  </div>
  <div class="stage stage-dest">
    <div class="stage-header">DESTINATIONS</div>
    <div class="stage-body" id="dest-panel"></div>
  </div>
</div>

<div class="panels">
  <div class="panel">
    <h3>Recent Runs</h3>
    <div id="runs-panel">Loading...</div>
  </div>
  <div class="panel">
    <h3>Skill Proposals</h3>
    <div id="skills-panel">—</div>
  </div>
</div>

<div style="padding: 0 20px 8px;">
  <div class="panel">
    <h3>🌊 Convergence Events</h3>
    <div id="convergence-panel">—</div>
  </div>
</div>

<div class="stats-bar" id="stats-bar">
  <div class="stat"><span class="stat-label">Sources today:</span> <span class="stat-value" id="stat-sources">—</span></div>
  <div class="stat"><span class="stat-label">Atoms:</span> <span class="stat-value" id="stat-atoms">—</span></div>
  <div class="stat"><span class="stat-label">Skills:</span> <span class="stat-value" id="stat-skills">—</span></div>
  <div class="stat"><span class="stat-label">Cost:</span> <span class="stat-value" id="stat-cost">—</span></div>
</div>

<script>
const API_BASE = window.location.origin;
let evtSource;

// SSE connection
function connectSSE() {
  evtSource = new EventSource(API_BASE + '/wi/events');
  const statusEl = document.getElementById('sse-status');

  evtSource.onopen = () => {
    statusEl.textContent = 'connected';
    statusEl.className = 'status connected';
  };

  evtSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      handleEvent(event);
    } catch {}
  };

  evtSource.onerror = () => {
    statusEl.textContent = 'disconnected';
    statusEl.className = 'status';
    evtSource.close();
    setTimeout(connectSSE, 3000);
  };
}

function handleEvent(event) {
  const { type, run_id, data } = event;

  switch (type) {
    case 'source_start': {
      const el = document.getElementById('source-panel');
      el.innerHTML = '<div class="atom-card processing">' +
        '<div><strong>' + esc(data.source_type) + '</strong></div>' +
        '<div class="content">' + esc(data.url) + '</div>' +
        '<div class="meta">' + esc(data.title || '') + '</div>' +
        '</div>' + el.innerHTML;
      break;
    }

    case 'atom_extracted': {
      const el = document.getElementById('extract-panel');
      const badge = data.type === 'SKILL' ? 'badge-skill' : 'badge-knowledge';
      const tempColor = data.temporality === 'EPHEMERAL' ? '#f66' : data.temporality === 'CURRENT' ? '#fa4' : '#4f8';
      el.innerHTML = '<div class="atom-card">' +
        '<span class="badge ' + badge + '">' + esc(data.type) + '</span>' +
        '<span class="badge" style="background:' + tempColor + '22;color:' + tempColor + '">' + esc(data.temporality || 'DURABLE') + '</span>' +
        '<span class="meta">imp=' + data.importance + ' act=' + data.actionability + '</span>' +
        '<div class="content">' + esc((data.content || '').slice(0, 120)) + '</div>' +
        '</div>' + el.innerHTML;
      break;
    }

    case 'atom_routed': {
      const el = document.getElementById('route-panel');
      const cls = (data.route || '').toLowerCase().replace('_', '-');
      el.innerHTML = '<div class="route-card ' + cls + '">' +
        '<strong>' + esc(data.route) + '</strong>' +
        (data.target_node ? ' → ' + esc(data.target_node) : '') +
        '<div class="meta">' + esc(data.reason || '') + '</div>' +
        '</div>' + el.innerHTML;

      // Destination panel
      const dest = document.getElementById('dest-panel');
      if (data.route === 'NEW_NODE') {
        dest.innerHTML = '<div class="route-card new-node">+ New node</div>' + dest.innerHTML;
      } else if (data.route === 'HEAT') {
        dest.innerHTML = '<div class="route-card heat">🔥 ' + esc(data.target_node || '') + '</div>' + dest.innerHTML;
      } else if (data.route === 'SKILL_PROPOSAL') {
        dest.innerHTML = '<div class="route-card skill">⚡ Skill proposed</div>' + dest.innerHTML;
      }
      break;
    }

    case 'run_complete': {
      loadRuns();
      loadStats();
      break;
    }

    case 'convergence': {
      loadConvergence();
      break;
    }

    case 'error': {
      const el = document.getElementById('source-panel');
      el.innerHTML = '<div class="atom-card" style="border-color:#a44">' +
        '<strong style="color:#f66">ERROR</strong> ' + esc(data.message || '') +
        '</div>' + el.innerHTML;
      break;
    }
  }
}

// Ingest
async function ingest() {
  const url = document.getElementById('url-input').value.trim();
  if (!url) return;

  const dryRun = document.getElementById('dry-run').checked;
  const btn = document.getElementById('ingest-btn');
  btn.disabled = true;
  btn.textContent = 'INGESTING...';

  try {
    const res = await fetch(API_BASE + '/wi/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, dry_run: dryRun }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert('Error: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Network error: ' + err.message);
  }

  btn.disabled = false;
  btn.textContent = 'INGEST';
  document.getElementById('url-input').value = '';
}

// Enter key
document.getElementById('url-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ingest();
});

// Drag and drop
document.body.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('active');
});
document.body.addEventListener('dragleave', () => {
  document.body.classList.remove('active');
});
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('active');
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (url && url.startsWith('http')) {
    document.getElementById('url-input').value = url;
    ingest();
  }
});

// Load recent runs
async function loadRuns() {
  try {
    const res = await fetch(API_BASE + '/wi/runs?limit=10');
    const data = await res.json();
    const el = document.getElementById('runs-panel');
    if (!data.runs || data.runs.length === 0) {
      el.innerHTML = '<div style="color:#555;font-size:11px">No runs yet</div>';
      return;
    }
    el.innerHTML = data.runs.map(r => {
      const icon = r.status === 'done' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'rolled_back' ? '↩️' : '🔄';
      const rollbackBtn = r.status === 'done' ? '<button class="rollback-btn" onclick="rollbackRun(\\'' + esc(r.run_id) + '\\')">rollback</button>' : '';
      return '<div class="run-row">' +
        '<span class="icon">' + icon + '</span>' +
        '<span class="type">' + esc(r.source_type) + '</span>' +
        '<span class="title">' + esc((r.title || '').slice(0, 40)) + '</span>' +
        '<span class="atoms">' + r.atoms_extracted + ' atoms</span>' +
        '<span class="time">' + (r.elapsed_ms || 0) + 'ms</span>' +
        rollbackBtn +
        '</div>';
    }).join('');
  } catch {}
}

// Load stats
async function loadStats() {
  try {
    const res = await fetch(API_BASE + '/wi/runs?limit=100');
    const data = await res.json();
    if (!data.runs) return;
    const today = data.runs.filter(r => {
      const d = new Date(r.created_at);
      const now = new Date();
      return d.toDateString() === now.toDateString();
    });
    document.getElementById('stat-sources').textContent = today.length;
    document.getElementById('stat-atoms').textContent = today.reduce((s, r) => s + (r.atoms_extracted || 0), 0);
    document.getElementById('stat-skills').textContent = today.reduce((s, r) => s + (r.atoms_skill || 0), 0);
    document.getElementById('stat-cost').textContent = '$' + today.reduce((s, r) => s + parseFloat(r.cost_usd || 0), 0).toFixed(4);
  } catch {}
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Rollback
async function rollbackRun(runId) {
  if (!confirm('Rollback run ' + runId + '? This will delete all staging nodes, stimuli, and skill proposals from this run.')) return;
  try {
    const res = await fetch(API_BASE + '/wi/runs/' + runId, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      alert('Rolled back: ' + data.staging_nodes_deleted + ' nodes, ' + data.stimuli_deleted + ' stimuli deleted');
      loadRuns();
    } else {
      alert('Error: ' + (data.error || 'Unknown'));
    }
  } catch (err) { alert('Error: ' + err.message); }
}

// Skills
async function loadSkills() {
  try {
    const res = await fetch(API_BASE + '/wi/skills?limit=20');
    const data = await res.json();
    const el = document.getElementById('skills-panel');
    if (!data.skills || data.skills.length === 0) {
      el.innerHTML = '<div style="color:#555;font-size:11px">No skill proposals</div>';
      return;
    }
    el.innerHTML = data.skills.map(s => {
      const statusCls = 'skill-status-' + s.status;
      const actions = (s.status === 'needs_human' || s.status === 'proposed')
        ? '<div class="actions">' +
          '<button class="btn-approve" onclick="approveSkill(' + s.id + ')">Approve</button>' +
          '<button class="btn-reject" onclick="rejectSkill(' + s.id + ')">Reject</button>' +
          '</div>'
        : '';
      return '<div class="skill-card">' +
        '<span class="skill-status ' + statusCls + '">' + esc(s.status) + '</span> ' +
        '<span style="color:#888">' + esc(s.skill_type || '') + '</span>' +
        '<div class="content" style="margin-top:4px;color:#aaa">' + esc((s.content || '').slice(0, 100)) + '</div>' +
        actions +
        '</div>';
    }).join('');
  } catch {}
}

async function approveSkill(id) {
  try {
    const res = await fetch(API_BASE + '/wi/skills/' + id + '/approve', { method: 'POST' });
    const data = await res.json();
    if (res.ok) { loadSkills(); }
    else { alert('Error: ' + (data.error || 'Unknown')); }
  } catch (err) { alert('Error: ' + err.message); }
}

async function rejectSkill(id) {
  const reason = prompt('Rejection reason:');
  if (!reason) return;
  try {
    const res = await fetch(API_BASE + '/wi/skills/' + id + '/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    const data = await res.json();
    if (res.ok) { loadSkills(); }
    else { alert('Error: ' + (data.error || 'Unknown')); }
  } catch (err) { alert('Error: ' + err.message); }
}

// Convergence
async function loadConvergence() {
  try {
    const res = await fetch(API_BASE + '/wi/convergence?limit=20');
    const data = await res.json();
    const el = document.getElementById('convergence-panel');
    if (!data.events || data.events.length === 0) {
      el.innerHTML = '<div style="color:#555;font-size:11px">No convergence events</div>';
      return;
    }
    el.innerHTML = data.events.map(e => {
      const statusCls = 'status-' + e.status;
      const energyPct = Math.min(100, (e.total_energy / 10.0) * 100);
      const sources = (e.source_types || []).map(s => '<span class="source-badge">' + esc(s) + '</span>').join('');
      const samples = (e.sample_content || []).slice(0, 2).map(s => esc(s.slice(0, 80))).join(' | ');
      const actions = e.status === 'detected'
        ? '<div class="actions">' +
          '<button class="btn-promote" onclick="promoteConvergence(' + e.id + ')">Promote</button>' +
          '<button class="btn-dismiss" onclick="dismissConvergence(' + e.id + ')">Dismiss</button>' +
          '</div>'
        : (e.status === 'promoted' && e.promoted_node_addr
          ? '<div style="margin-top:4px;font-size:10px;color:#4f8">→ ' + esc(e.promoted_node_addr) + '</div>'
          : '');
      return '<div class="convergence-card">' +
        '<span class="status-badge ' + statusCls + '">' + esc(e.status) + '</span> ' +
        '<span class="label">' + esc(e.proposed_label || '?') + '</span>' +
        '<div class="desc">' + esc(e.proposed_description || '') + '</div>' +
        '<div class="meta-row"><span>' + e.orphan_count + ' orphans</span><span>energy: ' + (e.total_energy || 0).toFixed(1) + '</span><span>' + sources + '</span></div>' +
        '<div class="energy-bar"><div class="energy-fill" style="width:' + energyPct + '%"></div></div>' +
        (samples ? '<div class="sample">' + samples + '</div>' : '') +
        actions +
        '</div>';
    }).join('');
  } catch {}
}

async function promoteConvergence(id) {
  if (!confirm('Promote convergence event #' + id + ' to a new graph node?')) return;
  try {
    const res = await fetch(API_BASE + '/wi/convergence/' + id + '/promote', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      alert('Promoted to node: ' + (data.node_addr || '?'));
      loadConvergence();
    } else {
      alert('Error: ' + (data.error || 'Unknown'));
    }
  } catch (err) { alert('Error: ' + err.message); }
}

async function dismissConvergence(id) {
  if (!confirm('Dismiss convergence event #' + id + '?')) return;
  try {
    const res = await fetch(API_BASE + '/wi/convergence/' + id + '/dismiss', { method: 'POST' });
    const data = await res.json();
    if (res.ok) { loadConvergence(); }
    else { alert('Error: ' + (data.error || 'Unknown')); }
  } catch (err) { alert('Error: ' + err.message); }
}

// Init
connectSSE();
loadRuns();
loadStats();
loadSkills();
loadConvergence();
setInterval(loadRuns, 30000);
setInterval(loadStats, 30000);
setInterval(loadSkills, 30000);
setInterval(loadConvergence, 30000);
</script>
</body>
</html>`;

export default app;
