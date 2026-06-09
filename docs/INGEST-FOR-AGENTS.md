# Ingest your existing content into Verity One

Paste this whole file into your coding agent (Claude Code, Codex, Cursor, etc.) and it will turn your Markdown files, journals, and project notes into VO nodes — either as **project memories** (durable knowledge tied to a project) or **day memories** (timestamped journal entries).

The agent does all the classification and writing. You answer one question: which directory to point it at.

---

## Prerequisites

You ran `scripts/bootstrap-local.sh` and the local API is running on `http://localhost:3100`. Verify:

```bash
curl -s http://localhost:3100/health | grep '"ok":true'
```

If that fails, fix the bootstrap before continuing. Nothing in this doc works without a live local API.

Your tenant bearer token lives at `~/.vo/agent-token`. The agent will need it.

---

## What the agent should do

### Step 1 — discover

Recursively list Markdown files under the target directory the user specifies. Skip `node_modules`, `.git`, `dist`, `build`, `.next`, `.vercel`, and anything matching `.gitignore`.

For each file, capture: full path, mtime, file size, first 200 chars.

### Step 2 — classify

Every file is one of:

| Classification | Signals |
|---|---|
| **project memory** | Lives under a recognizable project root (a directory with `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.git`, `README.md`, etc.). Content describes decisions, architecture, patterns, or knowledge that's stable across time. |
| **day memory** | Filename or path contains a date (`2026-03-15.md`, `journal/2026/03/15.md`, `daily/march-15.md`). Or content opens with a date header. Content is timestamped reflection, not durable knowledge. |
| **mixed / unsure** | Anything else. Default to project memory and add `unsure: true` to the metadata so the user can review later. |

### Step 3 — atomize

A single Markdown file usually contains multiple atomic memories. Split on:

- Top-level headers (`##`, `###`) inside a single file
- Bullet lists where each item is a self-contained thought
- Code-fenced sections describing a decision or pattern

Aim for **one VO node per atomic memory**, not one per file. A 50-line README might become 5–8 memories; a 3-line scratchpad note becomes 1.

Each atomic memory needs:

- `description` (the memory itself, prose; the agent paraphrases or quotes — short is fine)
- `memory_type` — pick from: `decision`, `preference`, `correction`, `context`, `pattern`, `vision`, `changelog`
- `label` (≤ 80 chars, descriptive title)

For **day memories**, also include `day_addr` derived from the date (e.g. `DAY.2026-03-15`).

### Step 4 — write

For each atomic memory, POST to `/remember`:

```bash
TOKEN=$(cat ~/.vo/agent-token)

curl -s -X POST http://localhost:3100/remember \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "<the atomic memory>",
    "memory_type": "<one of: decision|preference|correction|context|pattern|vision|changelog>",
    "label": "<≤80-char title>"
  }'
```

A successful response returns `{"ok": true, "addr": "PJ.0.3.NNNN", ...}`. Capture the `addr` to report back.

> **`/remember` is lossy by design — choose the right write surface.** It maps to
> a tenant-scoped memory and **drops source references** (there is no field for a
> source path) and cannot scope to a project. So:
> - For quick, free-floating notes where provenance/scope don't matter, `/remember`
>   is fine.
> - For any memory that must carry its **source path** or land in a **project**,
>   POST to **`/memory/write`** instead (it accepts `source_refs` and
>   `project_addr`). Do **not** rely on `/remember` to preserve a source path — it
>   is silently discarded.

`/remember` also **deduplicates tenant-wide**: a write that is ≥0.85 similar to an
existing *unscoped* tenant memory returns `{"ok": true, "deduplicated": true}`
**without inserting**. That is the intended behavior, but it means a bulk run of
distinct-but-similar notes can silently collapse — another reason to send
memories that must each persist (with provenance) through `/memory/write`.

### Step 5 — report

After ingesting one directory, print a summary:

- Files scanned
- Files classified as project / day / unsure
- Atomic memories written (count)
- Memories rejected by the quality gate (count + first 3 reasons)
- Any I/O or network errors

---

## Project ingestion — for repo-scale content

For an entire repository (code + docs) on a **source / OSS install**, drive the
per-file loop from Steps 1–5 above over the repo: create one project node, then
`POST /memory/write` per file with the provenance in the canonical
**`source_refs`** array (NOT a bare `source_path`/`source_ref` — the contract strips
unknown fields, so those are silently dropped). Each entry is
`{ "type": "...", "path": "..." }` (use `"url"` instead of `"path"` for web sources),
and `project_addr` for scope:

```json
{
  "kind": "context",
  "assertion": "<what this file/chunk establishes>",
  "source": "observed",
  "project_addr": "PJ.0.1.X",
  "source_refs": [{ "type": "doc", "path": "src/lib/foo.ts" }]
}
```

The agent walking the tree *is* the bulk ingester — no extra tooling, only the
public HTTP contract this node serves, and every chunk keeps queryable receipts.

> **Operator CLI only.** The full operator CLI ships a `vo ingest` command that
> wraps this loop (path normalization, code-vs-prose detection, batched embeddings),
> but it lives in the private `agent-lab/` tree and is **not part of the OSS source
> install** — OSS users use the HTTP loop above. For operators on a full/private
> checkout:
>
> ```bash
> vo ingest --repo /path/to/repo --project-addr PJ.0.1.X   # operator-only
> ```
>
> Omit `--project-addr` and `vo ingest` scaffolds a new one. It writes through the
> same canonical `/memory/write` contract as the loop above.

---

## Day-memory shortcut — for journal directories

If your journal is laid out as `<dir>/<YYYY>/<MM>/<DD>.md` or `<dir>/<YYYY-MM-DD>.md`, the agent should:

1. For each daily file, derive the date from the path or filename
2. Create one parent day node first (so multiple atomic memories share it)
3. Then POST each atomic memory with the day node as context

If the parent day node doesn't exist yet, VO will create it lazily on first memory write.

---

## Worked example — what good output looks like

User said: *"ingest my notes under `~/Documents/notes/`"*

Agent should print:

```
Scanning ~/Documents/notes/
  43 markdown files found
  8 classified as day memories (journal/2026/)
  31 classified as project memories
  4 classified as unsure
Atomizing...
  127 atomic memories extracted

Writing to http://localhost:3100/remember as tenant=<your-tenant>
  ✓ 119 written (PJ.0.3.4501 .. PJ.0.3.4619)
  ✗ 6 rejected by quality gate:
      - "TODO" (too short)
      - "x" (too short)
      - "see notes" (no actionable content)
  ✗ 2 network errors (retried 3x each, gave up)

Mapping written to /tmp/vo-ingest-2026-05-21-153400.json
  (addr → source file, for later reference)
```

---

## Recovery

- A network error mid-ingest is safe to retry. VO's dedup catches accidental duplicates.
- If you misclassified a memory, retract it: `curl -X POST http://localhost:3100/memory/retract -H "Authorization: Bearer $TOKEN" -d '{"addr":"PJ.0.3.NNNN"}'`
- If you ingested junk and want to start over: drop the `verity` database and re-run `scripts/bootstrap-local.sh`. (Or use a different tenant_id and ingest there as a sandbox.)

---

## After local ingestion — sync to VO+ (web), manual beta

VO+ hosted sync is **optional and currently a manual beta**. Pairing the local
node to a verityone.app account is **not yet wrapped by the `vo` CLI**: there is
no `vo sync pair` command yet, and `vo sync claim-token` run *before* the node
is paired fails with `node_not_found`. The pairing is done through the dashboard
UI flow (it calls `/account/connect/redeem`). See `docs/CONNECT.md` step 3b for
the minimum-viable manual pairing path.

Once paired (manually), the outbound push is enabled by setting
`"hosted_sync": "outbound"` in `~/.vo/config.json` and restarting the API; the
scheduler then pushes a delta periodically. On a phone agent app, add the exact
`https://verityone.app/mcp` URL as a custom MCP connector, with no trailing
slash — see `docs/CONNECT.md`.
