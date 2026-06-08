# AGENTS.md — Verity One Knowledge Pyramid

> If you're an AI agent reading this, you just saved yourself 100K tokens of discovery.
> This file tells you what Verity One is, how to query it, and how to contribute.

## Agent Workflow (Read First)

For normal agent work, use the live VO API for recall before falling back to raw SQL or freehand assumptions.

Default workflow:

1. Query `/context?q=<task>&depth=deep` on the actual task.
2. Use `/search?q=<term>` when you need exact node lookup for a product, system, or topic term.
3. Use `/ground?goal=<task>` for action-oriented work when authenticated context is available.
4. If VO surfaces a candidate node, use `/run/:addr` and `/check/:addr` before inventing your own procedure.
5. Verify against code, runtime, and the repo when VO is stale, low-confidence, or conflicts with reality.

For durable memory, prefer VO over local notes:

- Save only durable `decision`, `preference`, `correction`, `context`, `pattern`, `vision`, `changelog`, or `digest` outcomes with `/remember`
- Keep project and tenant memories private by default
- Save one atomic fact per memory
- Save inline when the conclusion is discovered, not as a session dump
- Default max is 3 memories per session unless explicitly asked for more

Auto-save these without waiting to be asked:

- Decisions made about architecture, tooling, or strategy
- Non-obvious discoveries such as a bug root cause, a pattern across files, or a real dependency conflict
- User corrections to your approach
- Recommendations the user accepted

Do not save:

- Routine code changes
- Status updates
- Explanations of existing behavior
- Session summaries or activity logs
- Anything derivable from code, git history, or existing nodes
- Anything the user did not accept

Fallback only if VO is unavailable or tenant auth is missing:

- Append up to 3 JSONL entries to `.codex-conclusions.jsonl` at the repo root
- Treat that file as a temporary ingest queue, not the source of truth

Use raw `psql` first only when the task is schema work, migrations, direct data repair, or low-level database inspection that the VO API cannot express cleanly.

## What Is This?

Verity One is a **self-organizing knowledge pyramid** stored in PostgreSQL. It maps concepts, relationships, and meaning across multiple domains into a queryable graph structure.

- **Nodes** = blocks of knowledge (facts, concepts, systems, insights)
- **Edges** = relationships between nodes (mirrors, implements, governs, unifies, etc.)
- **Pyramids** = separate knowledge domains (META, OPENCLAW, CLAUDECODE, CODEX, etc.)
- **Layers** = depth of understanding: L0 (inert facts), L1 (relationships), L2 (meaning)

## Quick Start

### Connect
```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql -d verity
```

### API (if running)
```
GET http://localhost:3100/pyramids          — list all pyramids
GET http://localhost:3100/nodes/:addr       — single node + neighbors
GET http://localhost:3100/subgraph?pyramid=META&depth=0-3  — slice
GET http://localhost:3100/search?q=concept  — semantic search (needs embeddings)
GET http://localhost:3100/traverse?from=META.0.2.4&hops=2  — graph walk
WS  ws://localhost:3100/stream             — real-time changes
```

### Essential Queries

**See all pyramids:**
```sql
SELECT pyramid_id, label, node_count, edge_count, access_level FROM registry ORDER BY pyramid_id;
```

**Get a node and its edges:**
```sql
-- The node
SELECT addr, label, substance, confidence, depth, layer, visibility
FROM nodes WHERE addr = 'META.0.2.4';

-- Its relationships
SELECT e.from_addr, e.to_addr, e.edge_type, e.layer, e.label, e.confidence
FROM edges e
WHERE e.from_addr = 'META.0.2.4' OR e.to_addr = 'META.0.2.4'
ORDER BY e.layer DESC;
```

**Browse a pyramid by depth:**
```sql
SELECT addr, label, depth, confidence, visibility
FROM nodes
WHERE pyramid_id = 'META' AND depth <= 2
ORDER BY depth, position;
```

**Find nodes by keyword:**
```sql
SELECT addr, label, depth, pyramid_id
FROM nodes
WHERE label ILIKE '%dialectic%'
   OR substance::text ILIKE '%dialectic%';
```

**Semantic search (when embeddings are live):**
```sql
SELECT addr, label, 1 - (embedding <=> $query_embedding) as similarity
FROM nodes
WHERE embedding IS NOT NULL
ORDER BY embedding <=> $query_embedding
LIMIT 10;
```

**All Layer 2 meaning edges (the deep insights):**
```sql
SELECT from_addr, to_addr, edge_type, label, confidence
FROM edges WHERE layer = 2
ORDER BY confidence DESC;
```

**Cross-pyramid connections:**
```sql
SELECT e.*, n1.pyramid_id as from_pyramid, n2.pyramid_id as to_pyramid
FROM edges e
JOIN nodes n1 ON e.from_addr = n1.addr
JOIN nodes n2 ON e.to_addr = n2.addr
WHERE n1.pyramid_id != n2.pyramid_id;
```

## Addressing: P.L.D.N

Every node has an address: `PYRAMID.LAYER.DEPTH.NUMBER`

- `META.0.2.4` = META pyramid, Layer 0, Depth 2, Node 4
- `OC.0.1.3` = OPENCLAW pyramid, Layer 0, Depth 1, Node 3
- `META.1.3.1` = META pyramid, Layer 1 (emergent), Depth 3, Node 1

Addresses are **primary keys** — the identity IS the address.

## Schema

### nodes
| Column | Type | Description |
|--------|------|-------------|
| addr | text PK | P.L.D.N address (identity) |
| pyramid_id | text FK | Which pyramid this belongs to |
| layer | int | 0=fact, 1=emergent relation, 2=meaning |
| depth | int | Distance from apex (0=root) |
| position | int | Sibling order at this depth |
| label | text | Human-readable name |
| substance | jsonb | **ALL knowledge lives here.** Must be self-sufficient — no external dependencies. Contains description, details, specifications, everything needed to understand AND reconstruct what this node represents. |
| confidence | float | 0.0–1.0. Single agent max 0.7. 0.9+ needs 2+ agent tiers. 0.95+ needs human. |
| embedding | vector(768) | Google text-embedding-004. For semantic search. |
| hash | text | Merkle hash (pending until computed) |
| provenance | jsonb | Audit trail: who created it, from what source, when |
| parent_addr | text FK | Parent node (tree structure) |
| visibility | text | 'public' (DAO-eligible) or 'private' (never public) |
| token_weight | float | Reward weight for contributors |
| category | text | Color grouping for visualization |

### edges
| Column | Type | Description |
|--------|------|-------------|
| from_addr | text FK | Source node |
| to_addr | text FK | Target node |
| edge_type | text | mirrors, implements, governs, integrates, precursor-to, self-references, unifies, generates, applies, refines, executes, depends-on |
| layer | int | 1=relationship, 2=meaning |
| label | text | WHY this connection exists (must be specific and concrete) |
| confidence | float | Same rules as nodes |
| UNIQUE | | (from_addr, to_addr, edge_type) |

### Edge Types Explained
- **mirrors** — Same pattern, different domain (most common)
- **implements** — Abstract concept made concrete
- **governs** — Rules/constraints that control behavior
- **integrates** — Two things that work together
- **precursor-to** — A led to B historically or logically
- **unifies** — Deep equivalence (Layer 2 only, rare)
- **generates** — A produces B as output
- **self-references** — Recursive/self-describing relationship
- **applies** — A uses B as a method
- **executes** — A runs/performs B
- **depends-on** — A requires B to function

## How to Contribute

### Adding Nodes
```sql
INSERT INTO nodes (addr, pyramid_id, layer, depth, position, label, substance, confidence, hash, provenance, parent_addr, visibility)
VALUES (
  'META.0.3.XX',           -- Next available address at this depth
  'META',                   -- Pyramid
  0,                        -- Layer (0 for facts)
  3,                        -- Depth
  XX,                       -- Position (next available)
  'Node Label',
  '{"description": "COMPLETE description. Must be self-sufficient."}'::jsonb,
  0.65,                     -- Your confidence (max 0.7 for single agent)
  'pending',
  '{"agent": "your-name", "source": "what-you-scanned"}'::jsonb,
  'META.0.2.XX',            -- Parent node address
  'public'                  -- or 'private'
);
```

### Adding Edges
```sql
INSERT INTO edges (from_addr, to_addr, edge_type, layer, label, confidence, hash, provenance)
VALUES (
  'META.0.2.4', 'OC.0.2.21',
  'mirrors', 1,
  'Specific description of WHY these are connected. Be concrete.',
  0.85, 'pending',
  '{"agent": "your-name", "source": "relationship-scan"}'::jsonb
);
```

### Rules
1. **Substance must be self-sufficient.** If someone can't understand the node without reading external files, the ingestion is incomplete. The pyramid IS the documentation.
2. **Binary triads.** Every internal node should have exactly 2 children (INV-1).
3. **No raw code in nodes.** Natural language descriptions only (INV-5). Code structure, not code text.
4. **Atomic blocks.** One subject + one verb + one object per node (INV-4).
5. **Confidence caps.** Single agent: max 0.7. Two+ agent tiers agreeing: up to 0.9. Human confirmation: up to 1.0.
6. **Layer 2 is rare.** Only for genuine unifying insights. Most edges are Layer 1.
7. **Provenance required.** Always say who you are and what you scanned.
8. **ON CONFLICT DO NOTHING.** Use `ON CONFLICT (from_addr, to_addr, edge_type) DO NOTHING` for edges to prevent duplicates.

### Contribution Protocol
1. **Scan** — Read existing nodes in the area you're working on
2. **Propose** — Add nodes/edges with confidence ≤ 0.7
3. **Justify** — Every edge label must explain WHY, not just THAT
4. **Don't duplicate** — Check existing nodes and edges before adding
5. **Refresh counts** — After bulk inserts: `SELECT refresh_registry_counts('PYRAMID_ID');`

## Current State

As of 2026-03-14:
- **4 pyramids:** META (173 nodes), OPENCLAW (104), CLAUDECODE (21), CODEX (11)
- **309 total nodes**, 173 edges (157 L1, 16 L2)
- **197 public** / 112 private nodes
- Depths 0–9 in META, 0–3 in others
- Embeddings: **LIVE** — all 309 nodes embedded, IVFFlat index active, semantic search working

## Architecture

- **Database:** PostgreSQL 17 + pgvector 0.8.2, localhost:5432, database `verity`
- **API:** Bun + Hono on port 3100 (bound 0.0.0.0)
- **Visualization:** Verity Scope (Three.js 3D) on port 3101
- **Real-time:** pg_notify → WebSocket → Scope
- **Embeddings:** Google gemini-embedding-001 (768 dimensions, outputDimensionality=768)

## Philosophy

The pyramid has three layers of knowledge:
- **Layer 0** — Inert facts. What exists. AI domain.
- **Layer 1** — Relations. What connects. The connective tissue.
- **Layer 2** — Meaning. What it means. Human domain.

The system is governed by the **Harmony Protocol (HOP):**
- Order is the only order
- Do no harm
- Stay in harmony
- AI cannot change HOP
- Questions > Answers

Knowledge flows upward: L0 facts → L1 relations → L2 meaning.
Confidence flows upward: evidence accumulates, corrections are permanent.
The pyramid builds itself through iterative diffusion passes.
