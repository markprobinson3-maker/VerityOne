# Mercury-Opus Mining Pipeline

## The Flow

```
Source Material + Target Node
        ↓
   [dispatch.ts]
   Build context prompt
        ↓
   [Mercury Subagent]
   Extract facts → SQL INSERTs into staging_*
        ↓
   [psql staging_* tables]
   Raw proposals stored
        ↓
   [qc-check.ts]
   Build QC prompt from staging
        ↓
   [Opus Subagent]
   Validate every item → SQL UPDATEs (approve/reject/revise)
        ↓
   [psql staging_* tables]
   Items now have qc_status
        ↓
   [commit.ts]
   Only approved/revised items → real pyramid
        ↓
   [generate-embeddings.ts]
   Embed new nodes
```

## Running from OpenClaw Main Agent

### Single Node Mining
```
1. bun run miners/src/dispatch.ts META.0.2.14 --source memory/crypto-trader.md
   → writes /tmp/verity-mercury-<run_id>.txt
   
2. sessions_spawn model=mercury task=<prompt contents>
   → Mercury returns SQL
   
3. Save Mercury output, run SQL against verity DB (staging tables)

4. bun run miners/src/qc-check.ts <run_id>
   → writes /tmp/verity-qc-<run_id>.txt
   
5. sessions_spawn model=opus task=<qc prompt contents>
   → Opus returns SQL UPDATEs
   
6. Run Opus SQL against verity DB (updates staging qc_status)

7. bun run miners/src/commit.ts <run_id>
   → approved items → real pyramid
```

### Batch Mining (Blitz Mode)
For mining many nodes:
1. Query all thin nodes (no children, low substance)
2. For each: dispatch Mercury, collect output
3. Batch all staging items
4. Single Opus QC pass on the full batch
5. Commit all approved

```sql
-- Find thin nodes needing mining
SELECT addr, label, depth,
  length(substance::text) as substance_size,
  (SELECT COUNT(*) FROM nodes c WHERE c.parent_addr = n.addr) as child_count
FROM nodes n
WHERE pyramid_id = 'META'
  AND depth <= 4
  AND (SELECT COUNT(*) FROM nodes c WHERE c.parent_addr = n.addr) = 0
  AND length(substance::text) < 200
ORDER BY depth, addr;
```

## Safety Invariants

1. Mercury NEVER writes to nodes/edges directly
2. Every staging item gets QC before commit
3. Rejected items stay in staging for audit
4. Commit refuses if any items are still 'pending'
5. Mercury confidence capped at 0.65
6. Opus is the ONLY gate between staging and production
7. Run IDs link everything for full audit trail
