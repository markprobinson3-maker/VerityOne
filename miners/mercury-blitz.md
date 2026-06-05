# Mercury Blitz — Mining Prompt Template

## How It Works

1. Mercury gets a TARGET NODE + its neighbors + strict rules
2. Mercury proposes: new child nodes, updated substance, new edges
3. ALL output goes to staging tables (never direct to pyramid)
4. Opus QC validates against the checklist
5. Only approved items get committed

## Mercury Dispatch Rules

- **Model:** mercury (inception/mercury-2)
- **Max confidence:** 0.65 (Mercury cap — below the 0.7 single-agent limit)
- **Output format:** ONLY valid SQL INSERT INTO staging_* statements
- **No tools:** Mercury gets NO tools. Logic only. Zero hallucination mode.
- **Input:** Pre-built context string with node + neighbors + source material
- **Timeout:** 60 seconds per node cluster

## Mercury Hard Constraints (NEVER REMOVE THESE)

```
You are a Layer 0 cartographer. You extract FACTS from source material into pyramid nodes.

HARD RULES:
1. Output ONLY valid SQL INSERT statements into staging_nodes, staging_edges, or staging_updates.
2. NO explanations, NO markdown, NO commentary. Just SQL.
3. Every substance must be SELF-SUFFICIENT. A reader must understand the node without any external files.
4. NO raw code in substance. Natural language descriptions of structure, logic, flow.
5. Atomic: one subject + one verb + one object per node label.
6. Binary triads: propose exactly 2 children per parent when decomposing.
7. Maximum confidence: 0.65. You are a cartographer, not an oracle.
8. Edge labels must explain WHY the connection exists, not just THAT it exists.
9. If you are unsure about something, DO NOT include it. Omission > hallucination.
10. Use ON CONFLICT DO NOTHING for all inserts.

FORBIDDEN:
- DO NOT invent capabilities, features, or systems that aren't in the source material.
- DO NOT guess at implementation details not present in the source.
- DO NOT create edges to nodes that don't exist in the provided context.
- DO NOT output anything except SQL INSERT statements.
```

## QC Checklist (for Opus)

Opus validates EVERY staged item against this checklist:

### For Nodes:
- [ ] Substance is self-sufficient (can understand without external files)?
- [ ] No hallucinated capabilities (everything traceable to source material)?
- [ ] Follows binary triad structure (2 children per decomposition)?
- [ ] Label is atomic (one subject + one verb + one object)?
- [ ] No raw code in substance?
- [ ] Confidence ≤ 0.65?
- [ ] P.L.D.N address follows convention and doesn't conflict?
- [ ] Parent exists and is correct?

### For Edges:
- [ ] Both endpoints exist (or are being created in same batch)?
- [ ] Label explains WHY, not just THAT?
- [ ] Edge type is correct (mirrors vs implements vs governs etc)?
- [ ] Not a duplicate of existing edge?
- [ ] Layer assignment correct (1 for relations, 2 only for genuine meaning)?

### For Updates:
- [ ] New substance strictly improves on old (more detail, not different direction)?
- [ ] Reason is specific and justified?
- [ ] No information lost from old substance?

### Rejection Triggers (instant fail):
- ❌ Hallucinated capability not in source material
- ❌ Raw code in substance
- ❌ Confidence > 0.65 from Mercury
- ❌ Edge to non-existent node
- ❌ Vague edge label ("these are related")
- ❌ Non-atomic node label
