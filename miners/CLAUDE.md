# Miners — CLI Reference & Routing Guide

## Quick Routing: Which Tool Do I Use?

| I want to... | Use |
|---|---|
| Ingest a URL/file into the graph | `verity-ingest.ts <url>` (simple) or `wi-cli.ts <url>` (rich) |
| Batch ingest from a file | `verity-ingest.ts --batch urls.txt` or `wi-cli.ts --batch urls.txt` |
| Review/approve staging proposals | `qc-sentinel.ts` (auto) or `verity-ingest.ts --review` (manual) |
| Process world signals into heat | `reactor.ts --process-pending` or `reactor.ts --watch` |
| Inject external signals (HN, arXiv, crypto) | `stimulus-intake.ts --source all` |
| Mine a specific node deeper | `dispatch.ts <addr>` |
| Find and fill knowledge gaps | `perpetual-swarm.ts` (auto) or `swarm-fill.ts --pyramid X` (targeted) |
| Detect cross-pyramid patterns | `archetype-miner.ts` |
| Find tensions/inferences | `dialectic-scanner.ts` |
| Synthesize edge tensions | `synthesizer.ts` |
| Consolidate/merge/prune nodes | `distiller.ts --execute` |
| Ingest a skill/repo/docs | `ingestor.ts --source skill --path <path>` |

## Ingest Naming: VI is Canonical, WI is Legacy/Admin

- **`verity-ingest.ts`** is the canonical ingest path. It owns the modern 5-stage pipeline: `RECEIVE -> ATOMIZE -> WEIGH -> SORT -> DELIVER`.
- **`wi-cli.ts`** remains useful for legacy/admin workflows, queue introspection, and compatibility surfaces, but it is no longer the architectural center of the ingest system.
- **World Ingestor (WI)** is now mostly a naming/compatibility surface around older tooling. The transient trend/orphan system rides on the current ingest + Reactor path, not on the old WI convergence sidecar alone.

Both still share the same adapter layer (web, youtube, arxiv, pdf, github, twitter, stackoverflow, hn, jupyter, substack, podcast, reddit, doi).

---

## All CLI Tools

### verity-ingest.ts — Universal Intake Engine
```bash
bun run miners/src/verity-ingest.ts <url>                    # ingest single source
bun run miners/src/verity-ingest.ts --dry-run <url>          # preview without DB writes
bun run miners/src/verity-ingest.ts --re-ingest <url>        # skip dedup check
bun run miners/src/verity-ingest.ts --force <url>            # skip budget gate
bun run miners/src/verity-ingest.ts --batch <file>           # process URLs from file
bun run miners/src/verity-ingest.ts --retry-pending          # retry failed Flash calls
bun run miners/src/verity-ingest.ts --review                 # show pending queue items
bun run miners/src/verity-ingest.ts --review --quick         # top 10 highest-scoring
bun run miners/src/verity-ingest.ts --promote <id>           # queue item → staging_nodes
bun run miners/src/verity-ingest.ts --demote <id>            # queue item → stimuli
bun run miners/src/verity-ingest.ts --conflicts              # show contradictions
bun run miners/src/verity-ingest.ts --rollback <batch_id>    # undo a batch
bun run miners/src/verity-ingest.ts --stats                  # full history
bun run miners/src/verity-ingest.ts --stats --today          # today only
bun run miners/src/verity-ingest.ts --stats --cost           # cost breakdown
bun run miners/src/verity-ingest.ts --stats --sources        # per-source quality
bun run miners/src/verity-ingest.ts --queue                  # queue depth/health
```

### wi-cli.ts — World Ingestor V2
```bash
# Ingestion
bun run miners/src/wi/wi-cli.ts <url>                        # ingest source
bun run miners/src/wi/wi-cli.ts --dry-run <url>              # preview
bun run miners/src/wi/wi-cli.ts --force <url>                # bypass dedup
bun run miners/src/wi/wi-cli.ts --refresh <days> <url>       # re-ingest if stale
bun run miners/src/wi/wi-cli.ts --batch <file> [--parallel N] # batch with parallelism
bun run miners/src/wi/wi-cli.ts --stats                      # run summary

# Queue Management
bun run miners/src/wi/wi-cli.ts --queue <url> [--priority 1-10]
bun run miners/src/wi/wi-cli.ts --queue-status
bun run miners/src/wi/wi-cli.ts --queue-cancel <id>
bun run miners/src/wi/wi-cli.ts --queue-flush

# Skills
bun run miners/src/wi/wi-cli.ts --review-skills [--status proposed]
bun run miners/src/wi/wi-cli.ts --approve <id>
bun run miners/src/wi/wi-cli.ts --reject <id> [--reason 'text']
bun run miners/src/wi/wi-cli.ts --retire <id> [--reason 'text']
bun run miners/src/wi/wi-cli.ts --skill-stats

# Convergence
bun run miners/src/wi/wi-cli.ts --convergence [--status detected]
bun run miners/src/wi/wi-cli.ts --convergence-scan
bun run miners/src/wi/wi-cli.ts --promote <id>
bun run miners/src/wi/wi-cli.ts --dismiss <id>

# Enrichment Pool
bun run miners/src/wi/wi-cli.ts --enrich-pool
bun run miners/src/wi/wi-cli.ts --pool-status
bun run miners/src/wi/wi-cli.ts --pool-clean

# Lifecycle & Ops
bun run miners/src/wi/wi-cli.ts --pin <addr>
bun run miners/src/wi/wi-cli.ts --unpin <addr>
bun run miners/src/wi/wi-cli.ts --health
bun run miners/src/wi/wi-cli.ts --rollback <run_id>
bun run miners/src/wi/wi-cli.ts --rollback-source <url>
```

### qc-sentinel.ts — Staging Gatekeeper (Gemini Pro)
```bash
bun run miners/src/qc-sentinel.ts                # run forever (production)
bun run miners/src/qc-sentinel.ts --once         # process one item
bun run miners/src/qc-sentinel.ts --batch <N>    # process up to N items
bun run miners/src/qc-sentinel.ts --dry-run      # validate without committing
```

### reactor.ts — Resonance Reactor
```bash
bun run miners/src/reactor.ts --process-pending [--dry-run]  # process all pending stimuli
bun run miners/src/reactor.ts --process-one <id> [--dry-run] # process specific stimulus
bun run miners/src/reactor.ts --refresh-heat                 # recompute heat cache + trend maintenance + lifecycle
bun run miners/src/reactor.ts --maintain                     # maintenance-only pass when no pending stimuli exist
bun run miners/src/reactor.ts --watch --interval-seconds 30  # autonomous reactor loop
bun run miners/src/reactor.ts --lifecycle                    # dormancy/absorption pass
bun run miners/src/reactor.ts --stats                        # statistics + hot nodes
bun run scripts/trend-doctor.ts --json                      # inspect orphan/trend runtime and trace batches
```

### stimulus-intake.ts — External Signal Injection
```bash
bun run miners/src/stimulus-intake.ts --source hackernews [--dry-run]
bun run miners/src/stimulus-intake.ts --source arxiv [--dry-run]
bun run miners/src/stimulus-intake.ts --source coingecko [--dry-run]
bun run miners/src/stimulus-intake.ts --source all [--dry-run]
```

### dispatch.ts — Mercury Mining Dispatch
```bash
bun run miners/src/dispatch.ts <addr>                   # mine target node
bun run miners/src/dispatch.ts <addr> --source file.md  # with extra source material
```

### perpetual-swarm.ts — Autonomous Gap Filling
```bash
bun run miners/src/perpetual-swarm.ts                   # single cycle (for cron)
bun run miners/src/perpetual-swarm.ts --continuous      # run forever
bun run miners/src/perpetual-swarm.ts --dry-run         # preview fuel without convening
bun run miners/src/perpetual-swarm.ts --budget 1.00     # override daily budget (default $0.50)
```
Fuel sources (priority order): query misses → contradictions → fresh approvals → stale high-value → low-confidence.

### swarm-fill.ts — Targeted Multi-Agent Gap Fill
```bash
bun run miners/src/swarm-fill.ts                        # auto-detect best gap
bun run miners/src/swarm-fill.ts --pyramid META         # target pyramid
bun run miners/src/swarm-fill.ts --addr META.0.1.7      # target node
bun run miners/src/swarm-fill.ts --agents 32            # scale agents (default 16)
bun run miners/src/swarm-fill.ts --dry-run              # preview
```

### archetype-miner.ts — Cross-Pyramid Pattern Detection
```bash
bun run miners/src/archetype-miner.ts                   # full: detect + synthesize + stage
bun run miners/src/archetype-miner.ts --dry-run         # detect without staging
bun run miners/src/archetype-miner.ts --report          # stats only
```

### dialectic-scanner.ts — Tension & Inference Detection
```bash
bun run miners/src/dialectic-scanner.ts                 # full scan (all passes)
bun run miners/src/dialectic-scanner.ts --tensions      # tension detection only
bun run miners/src/dialectic-scanner.ts --inferences    # transitive inference only
bun run miners/src/dialectic-scanner.ts --dry-run       # detect without DB writes
```

### synthesizer.ts — Edge Tension Synthesis
```bash
bun run miners/src/synthesizer.ts                       # synthesize all unsynthesized
bun run miners/src/synthesizer.ts --batch 10            # max 10 tensions
bun run miners/src/synthesizer.ts --dry-run             # preview
```

### distiller.ts — Post-Ingest Consolidation
```bash
bun run miners/src/distiller.ts                         # full analysis (dry-run default)
bun run miners/src/distiller.ts --execute               # apply changes
bun run miners/src/distiller.ts --pass merge            # specific pass only
bun run miners/src/distiller.ts --pass absorb
bun run miners/src/distiller.ts --pass orphan
bun run miners/src/distiller.ts --pass promote
bun run miners/src/distiller.ts --pass stale
bun run miners/src/distiller.ts --threshold 0.90        # custom merge similarity
bun run miners/src/distiller.ts --min-age 48            # min hours for orphan check
bun run miners/src/distiller.ts --report                # stats only
```

### ingestor.ts — Structured Source Intake
```bash
bun run miners/src/ingestor.ts --source skill --path <skill_dir>
bun run miners/src/ingestor.ts --source github --url <repo_url>
bun run miners/src/ingestor.ts --source docs --path <docs_dir>
bun run miners/src/ingestor.ts --source file --path <file_path>
bun run miners/src/ingestor.ts --scan-skills [--dry-run]
```

---

## Common Workflows

### Ingest a batch of URLs and review results
```bash
bun run miners/src/verity-ingest.ts --batch sources.txt
bun run miners/src/verity-ingest.ts --stats --today
bun run miners/src/verity-ingest.ts --review --quick
bun run miners/src/verity-ingest.ts --promote <id>      # for good items
```

### Full maintenance cycle
```bash
bun run miners/src/reactor.ts --process-pending          # process world signals
bun run miners/src/reactor.ts --lifecycle                # dormancy/absorption
bun run miners/src/distiller.ts --execute                # consolidate
bun run miners/src/dialectic-scanner.ts                  # find tensions
bun run miners/src/synthesizer.ts                        # synthesize tensions
```

### Continuous background processes (production)
```bash
bun run miners/src/qc-sentinel.ts &                     # staging gatekeeper
bun run miners/src/perpetual-swarm.ts --continuous &     # autonomous gap filling
```

---

## Source Types & Adapters

Supported: `web`, `youtube`, `pdf`, `github`, `twitter`, `stackoverflow`, `hn`, `jupyter`, `substack`, `podcast`, `reddit`, `arxiv`, `doi`

Academic URL pre-normalization (automatic):
- `alphaxiv.org/abs/XXXX.XXXXX` → `arxiv.org/pdf/XXXX.XXXXX`
- `huggingface.co/papers/XXXX.XXXXX` → `arxiv.org/pdf/XXXX.XXXXX`
- `arxiv.org/abs/XXXX.XXXXX` → `arxiv.org/pdf/XXXX.XXXXX`
- `openreview.net/forum?id=XXX` → `openreview.net/pdf?id=XXX`
- `biorxiv.org/content/...` → `biorxiv.org/content/....full.pdf`
- `aclanthology.org/XXX` → `aclanthology.org/XXX.pdf`
- `doi.org/10.XXXX/...` → resolved via redirect to correct adapter

## Key Config (graph_state)

Params loaded from `graph_state` table at startup. Key knobs:
- `wi_max_chars` — Max content length (default: 160000)
- `wi_max_atoms` — Max atoms per source (default: 10)
- `wi_stale_days` — Dedup window (default: 30)
- `vi_taste_boost_factor` — Taste multiplier strength (default: 0.30)
- `vi_taste_min_feedback` — Min feedback rows to activate taste (default: 20)
