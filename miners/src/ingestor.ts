/**
 * Verity One Ingestor — Feed the fire with structured knowledge
 * 
 * Three-layer architecture:
 *   1. Source Adapters — fetch and normalize per source type
 *   2. Extraction — ONE Gemini Flash call → structured node candidates
 *   3. Graph Integration — dedup against existing graph → staging
 * 
 * Supported sources:
 *   - skill: OpenClaw skill directories (SKILL.md + references/)
 *   - github: GitHub repos (README + package.json + key files)
 *   - docs: Documentation sites/files (markdown, crawled pages)
 *   - file: Local files (markdown, code, any text)
 * 
 * Usage:
 *   bun run miners/src/ingestor.ts --source skill --path /opt/homebrew/lib/node_modules/openclaw/skills/discord
 *   bun run miners/src/ingestor.ts --source github --url https://github.com/honojs/hono
 *   bun run miners/src/ingestor.ts --source docs --path ~/Projects/verity-one/docs/
 *   bun run miners/src/ingestor.ts --source file --path ~/some/file.md
 *   bun run miners/src/ingestor.ts --scan-skills           # auto-scan all unmined skills
 *   bun run miners/src/ingestor.ts --scan-skills --dry-run  # preview only
 */

import { createDirectSql } from "@verity-one/db-pool";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, basename, resolve } from "path";
import { callFlash } from "./lib/llm";
import { canonicalizeEdgeType } from "@verity-one/graph-shape";
import { resolveDurableOntologyTarget, withAllocatedChildSlot } from "../../api/src/lib/ontology";

const sql = createDirectSql();

const DRY_RUN = process.argv.includes("--dry-run");
const MAX_CHARS_PER_SOURCE = 30_000;  // Don't send more than this to extraction

// ==========================================================
// LAYER 1: SOURCE ADAPTERS
// ==========================================================

interface NormalizedSource {
  type: "skill" | "github" | "docs" | "file";
  title: string;
  slug: string;
  content: string;           // cleaned, concatenated text
  metadata: {
    path?: string;
    url?: string;
    files_read: string[];
    total_chars: number;
  };
}

// --- Skill Adapter ---
function adaptSkill(skillPath: string): NormalizedSource {
  const dir = resolve(skillPath);
  const slug = basename(dir);
  const files: string[] = [];
  const parts: string[] = [];

  // SKILL.md is the primary source
  const skillMd = join(dir, "SKILL.md");
  if (existsSync(skillMd)) {
    parts.push(`# SKILL.md\n${readFileSync(skillMd, "utf-8")}`);
    files.push("SKILL.md");
  }

  // References directory
  const refsDir = join(dir, "references");
  if (existsSync(refsDir) && statSync(refsDir).isDirectory()) {
    for (const f of readdirSync(refsDir)) {
      if (f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".json")) {
        const content = readFileSync(join(refsDir, f), "utf-8");
        if (content.length < 10_000) {  // skip huge reference files
          parts.push(`\n# references/${f}\n${content}`);
          files.push(`references/${f}`);
        }
      }
    }
  }

  // Scripts directory — just list filenames and first comments
  const scriptsDir = join(dir, "scripts");
  if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
    for (const f of readdirSync(scriptsDir)) {
      const content = readFileSync(join(scriptsDir, f), "utf-8");
      const firstComment = content.split("\n").filter(l => l.startsWith("#") || l.startsWith("//")).slice(0, 5).join("\n");
      parts.push(`\n# scripts/${f} (first 5 comment lines)\n${firstComment}`);
      files.push(`scripts/${f}`);
    }
  }

  const content = parts.join("\n\n").slice(0, MAX_CHARS_PER_SOURCE);

  return {
    type: "skill",
    title: slug,
    slug,
    content,
    metadata: { path: dir, files_read: files, total_chars: content.length },
  };
}

// --- GitHub Adapter ---
async function adaptGitHub(url: string): Promise<NormalizedSource> {
  // Extract owner/repo from URL
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) throw new Error(`Invalid GitHub URL: ${url}`);
  const [, owner, repo] = match;
  const slug = `${owner}-${repo}`.toLowerCase();
  
  const parts: string[] = [];
  const files: string[] = [];

  // Fetch README
  for (const name of ["README.md", "readme.md", "README"]) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/${name}`);
      if (res.ok) {
        parts.push(`# README\n${await res.text()}`);
        files.push(name);
        break;
      }
    } catch {}
  }

  // Fetch package.json / Cargo.toml / pyproject.toml
  for (const name of ["package.json", "Cargo.toml", "pyproject.toml", "setup.py"]) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/${name}`);
      if (res.ok) {
        parts.push(`\n# ${name}\n${await res.text()}`);
        files.push(name);
        break;
      }
    } catch {}
  }

  // Fetch AGENTS.md / CLAUDE.md if present
  for (const name of ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/main/${name}`);
      if (res.ok) {
        parts.push(`\n# ${name}\n${await res.text()}`);
        files.push(name);
      }
    } catch {}
  }

  // GitHub API metadata
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { "User-Agent": "verity-one-ingestor" },
    });
    if (res.ok) {
      const data = await res.json() as any;
      parts.unshift(`Repository: ${data.full_name}\nDescription: ${data.description}\nStars: ${data.stargazers_count}\nLanguage: ${data.language}\nLast push: ${data.pushed_at}\nTopics: ${(data.topics || []).join(", ")}`);
    }
  } catch {}

  const content = parts.join("\n\n").slice(0, MAX_CHARS_PER_SOURCE);

  return {
    type: "github",
    title: `${owner}/${repo}`,
    slug,
    content,
    metadata: { url, files_read: files, total_chars: content.length },
  };
}

// --- Docs Adapter ---
function adaptDocs(docsPath: string): NormalizedSource {
  const dir = resolve(docsPath);
  const slug = basename(dir);
  const parts: string[] = [];
  const files: string[] = [];

  function walkDir(d: string, depth: number) {
    if (depth > 3) return; // don't go too deep
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walkDir(full, depth + 1);
      } else if (entry.endsWith(".md") || entry.endsWith(".txt")) {
        const content = readFileSync(full, "utf-8");
        if (content.length < 15_000) {
          const rel = full.replace(dir + "/", "");
          parts.push(`\n# ${rel}\n${content}`);
          files.push(rel);
        }
      }
    }
  }

  walkDir(dir, 0);
  const content = parts.join("\n\n").slice(0, MAX_CHARS_PER_SOURCE);

  return {
    type: "docs",
    title: slug,
    slug,
    content,
    metadata: { path: dir, files_read: files, total_chars: content.length },
  };
}

// --- File Adapter ---
function adaptFile(filePath: string): NormalizedSource {
  const full = resolve(filePath);
  const content = readFileSync(full, "utf-8").slice(0, MAX_CHARS_PER_SOURCE);
  const slug = basename(full, ".md").toLowerCase().replace(/[^a-z0-9-]/g, "-");

  return {
    type: "file",
    title: basename(full),
    slug,
    content,
    metadata: { path: full, files_read: [basename(full)], total_chars: content.length },
  };
}

// ==========================================================
// LAYER 2: EXTRACTION PIPELINE
// ==========================================================

interface ExtractedNode {
  label: string;
  description: string;
  node_type: "tool" | "skill" | "workflow" | "concept" | "anti-pattern";
  provides: string[];
  quick_start?: { steps: string[] };
  readiness?: { checks: { name: string; cmd: string }[] };
  domains: string[];
  known_failures?: string[];
}

interface ExtractionResult {
  nodes: ExtractedNode[];
  edges: { from_label: string; to_label: string; edge_type: string; reason: string }[];
  summary: string;
}

async function extractNodes(source: NormalizedSource): Promise<ExtractionResult> {
  const prompt = `You are the Verity One knowledge extraction engine. Given this source material, extract ACTIONABLE knowledge nodes.

SOURCE: ${source.title} (type: ${source.type})
${source.content}

Extract nodes in this JSON format (no markdown fences):
{
  "nodes": [
    {
      "label": "Short, specific name (e.g. 'Hono Request Routing' not 'Framework')",
      "description": "2-4 sentence self-sufficient description. A reader should understand this WITHOUT the source material.",
      "node_type": "tool|skill|workflow|concept|anti-pattern",
      "provides": ["capability-slug-1", "capability-slug-2"],
      "quick_start": {"steps": ["Step 1: ...", "Step 2: ..."]},
      "readiness": {"checks": [{"name": "check name", "cmd": "shell command to verify readiness"}]},
      "domains": ["domain-1", "domain-2"],
      "known_failures": ["Failure pattern 1"]
    }
  ],
  "edges": [
    {"from_label": "Node A", "to_label": "Node B", "edge_type": "requires|uses|conflicts_with|related_to", "reason": "WHY they connect"}
  ],
  "summary": "One sentence describing what was extracted"
}

RULES:
- Extract 2-8 nodes maximum. Quality over quantity.
- Each node must be SELF-SUFFICIENT — description stands alone without the source.
- provides[] must be specific capabilities, not vague categories.
- quick_start steps must be concrete commands or actions.
- readiness checks must be runnable shell commands.
- If something is an anti-pattern or gotcha, extract it as type "anti-pattern".
- Skip anything that's generic knowledge (e.g., "JavaScript is a programming language").
- Only extract what's genuinely useful for an AI agent operating this system.
- Edges should only connect nodes you're extracting, using label matches.`;

  const raw = await callFlash(prompt, { temperature: 0.2, maxTokens: 8192, jsonMode: true });
  // Strip markdown fences if present
  let cleaned = raw.trim()
    .replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  
  try {
    return JSON.parse(cleaned);
  } catch {
    // Find the outermost { ... } block
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try { return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)); } catch {}
    }
    console.error("  Extraction parse failed. First 300 chars:", cleaned.slice(0, 300));
    return { nodes: [], edges: [], summary: "Extraction failed" };
  }
}

// ==========================================================
// LAYER 3: GRAPH INTEGRATION (dedup + staging)
// ==========================================================

async function dedup(node: ExtractedNode): Promise<{ isDuplicate: boolean; existingAddr?: string; similarity?: number }> {
  // Semantic search for similar existing nodes
  // Use label + description as search text
  const searchText = `${node.label} ${node.description}`;
  
  const results = await sql`
    SELECT addr, label, 
      ts_rank(search_vector, plainto_tsquery('english', ${searchText})) AS rank
    FROM nodes
    WHERE visibility = 'public'
      AND search_vector @@ plainto_tsquery('english', ${node.label})
    ORDER BY rank DESC
    LIMIT 3`;

  for (const r of results) {
    // Exact or near-exact label match = duplicate
    if (r.label.toLowerCase() === node.label.toLowerCase()) {
      return { isDuplicate: true, existingAddr: r.addr, similarity: 1.0 };
    }
    // High text similarity = likely duplicate
    if (parseFloat(r.rank) > 0.5) {
      return { isDuplicate: true, existingAddr: r.addr, similarity: parseFloat(r.rank) };
    }
  }

  return { isDuplicate: false };
}

async function stageNode(
  node: ExtractedNode,
  source: NormalizedSource,
  runId: string
): Promise<string | null> {
  const ontologyTarget = await resolveDurableOntologyTarget(sql, {
    content: `${node.label}\n${node.description}`,
    sourceType: source.type,
    sourceTitle: source.title,
    sourceId: source.metadata.url || source.metadata.path || null,
    nodeType: node.node_type,
    domains: node.domains,
    actionability: node.quick_start ? 4 : 2,
  });
  // Build substance
  const substance: any = {
    description: node.description,
    node_type: node.node_type,
    provides: node.provides || [],
    domains: node.domains || [],
    slug: node.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-"),
  };
  if (node.quick_start) substance.quick_start = node.quick_start;
  if (node.readiness) substance.readiness = node.readiness;
  if (node.known_failures) substance.known_failures = node.known_failures;

  // Build source_refs
  const sourceRef: any = { type: source.type };
  if (source.metadata.path) sourceRef.path = source.metadata.path;
  if (source.metadata.url) sourceRef.url = source.metadata.url;
  sourceRef.files = source.metadata.files_read;
  const sourceContext = {
    source_refs: [sourceRef],
    source_title: source.title,
    source_type: source.type,
  };

  // F6: allocate slot + INSERT under the same advisory lock with
  // 3-attempt retry on PK collision. Errors after retries surface up.
  try {
    return await withAllocatedChildSlot(
      sql,
      ontologyTarget.pyramidId,
      ontologyTarget.parentAddr,
      async (tx, slot) => {
        await tx`INSERT INTO staging_nodes (
          run_id, addr, pyramid_id, layer, depth, position, label,
          substance, confidence, parent_addr, visibility, qc_status, qc_agent, qc_notes, source_context
        ) VALUES (
          ${runId}, ${slot.addr}, ${ontologyTarget.pyramidId}, 0, ${slot.depth}, ${slot.position},
          ${node.label}, ${tx.json(substance)},
          0.55, ${ontologyTarget.parentAddr}, 'public', 'pending', 'ingestor',
          ${`Source: ${source.title} (${source.type}) | Refs: ${JSON.stringify([sourceRef])}`},
          ${tx.json(sourceContext)}
        )`;
        return slot.addr;
      },
    );
  } catch (e: any) {
    console.error(`  Stage failed for "${node.label}": ${e?.message?.slice(0, 80) || e}`);
    return null;
  }
}

async function stageEdge(
  from_addr: string,
  to_addr: string,
  edge_type: string,
  reason: string,
  runId: string
): Promise<boolean> {
  if (from_addr === to_addr) return false;
  const canonicalEdgeType = canonicalizeEdgeType(edge_type) || edge_type.trim().toLowerCase().replace(/[\s-]+/g, "_");
  try {
    await sql`INSERT INTO staging_edges (run_id, from_addr, to_addr, edge_type, layer, label, confidence, qc_status)
      VALUES (${runId}, ${from_addr}, ${to_addr}, ${canonicalEdgeType}, 1, ${reason}, 0.55, 'pending')`;
    return true;
  } catch { return false; }
}

// ==========================================================
// SKILL SCANNER — Auto-discover unmined skills
// ==========================================================

async function findUnminedSkills(): Promise<string[]> {
  const skillDir = "/opt/homebrew/lib/node_modules/openclaw/skills";
  const allSkills = readdirSync(skillDir).filter(d => {
    const full = join(skillDir, d);
    return statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"));
  });

  // Check which slugs already have nodes with source_refs pointing to them
  const mined = await sql`
    SELECT DISTINCT 
      regexp_replace(source_refs::text, '.*skills/([^/]+)/.*', '\\1') AS slug
    FROM nodes 
    WHERE source_refs::text LIKE '%skills/%'
      AND source_refs IS NOT NULL 
      AND source_refs != '[]'::jsonb`;

  const minedSlugs = new Set(mined.map((m: any) => m.slug));

  // Return skills that aren't yet in the graph with proper source_refs
  return allSkills.filter(s => !minedSlugs.has(s)).map(s => join(skillDir, s));
}

// ==========================================================
// MAIN
// ==========================================================

async function ingestOne(source: NormalizedSource): Promise<{ nodes: number; edges: number; dupes: number }> {
  console.log(`\n📄 Extracting from: ${source.title} (${source.type})`);
  console.log(`   Files: ${source.metadata.files_read.length} | Chars: ${source.metadata.total_chars}`);

  // Extract
  const extraction = await extractNodes(source);
  console.log(`   Extracted: ${extraction.nodes.length} nodes, ${extraction.edges.length} edges`);
  console.log(`   Summary: ${extraction.summary}`);

  if (DRY_RUN) {
    for (const n of extraction.nodes) {
      const d = await dedup(n);
      console.log(`   ${d.isDuplicate ? "🔁 DUPE" : "✅ NEW"}: ${n.label} (${n.node_type}) [${(n.provides || []).join(", ")}]`);
    }
    return { nodes: extraction.nodes.length, edges: extraction.edges.length, dupes: 0 };
  }

  const runId = `ingest:${source.slug}:${Date.now()}`;
  let staged = 0, dupes = 0;
  const labelToAddr = new Map<string, string>();

  // Stage nodes (dedup first)
  for (const node of extraction.nodes) {
    const d = await dedup(node);
    if (d.isDuplicate) {
      console.log(`   🔁 Skip (dupe of ${d.existingAddr}): ${node.label}`);
      if (d.existingAddr) labelToAddr.set(node.label, d.existingAddr);
      dupes++;
      continue;
    }

    const addr = await stageNode(node, source, runId);
    if (addr) {
      console.log(`   📝 Staged: ${addr} "${node.label}"`);
      labelToAddr.set(node.label, addr);
      staged++;
    }
  }

  // Stage edges (resolve labels to addresses)
  let edgesStaged = 0;
  for (const edge of extraction.edges) {
    const fromAddr = labelToAddr.get(edge.from_label);
    const toAddr = labelToAddr.get(edge.to_label);
    if (fromAddr && toAddr) {
      if (await stageEdge(fromAddr, toAddr, edge.edge_type, edge.reason, runId)) {
        edgesStaged++;
      }
    }
  }

  console.log(`   ✅ Staged: ${staged} nodes + ${edgesStaged} edges (${dupes} dupes skipped)`);
  return { nodes: staged, edges: edgesStaged, dupes };
}

async function main() {
  const args = process.argv.slice(2);
  const sourceType = args.includes("--source") ? args[args.indexOf("--source") + 1] : null;
  const path = args.includes("--path") ? args[args.indexOf("--path") + 1] : null;
  const url = args.includes("--url") ? args[args.indexOf("--url") + 1] : null;
  const scanSkills = args.includes("--scan-skills");

  console.log("📥 Verity One Ingestor");

  if (args.includes("--scan-clis")) {
    await scanCLIs();
  } else if (args.includes("--scan-github")) {
    const repos = args.includes("--repos") ? args[args.indexOf("--repos") + 1].split(",") : undefined;
    await scanGitHub(repos);
  } else if (scanSkills) {
    // Auto-scan all unmined skills
    const unmined = await findUnminedSkills();
    console.log(`Found ${unmined.length} unmined skills`);
    
    let totalNodes = 0, totalEdges = 0, totalDupes = 0;
    for (const skillPath of unmined) {
      const source = adaptSkill(skillPath);
      const result = await ingestOne(source);
      totalNodes += result.nodes;
      totalEdges += result.edges;
      totalDupes += result.dupes;
    }

    console.log(`\n🏁 Scan complete: ${totalNodes} nodes + ${totalEdges} edges staged (${totalDupes} dupes), ${unmined.length} skills processed`);
  } else if (sourceType && (path || url)) {
    let source: NormalizedSource;

    switch (sourceType) {
      case "skill":
        source = adaptSkill(path!);
        break;
      case "github":
        source = await adaptGitHub(url!);
        break;
      case "docs":
        source = adaptDocs(path!);
        break;
      case "file":
        source = adaptFile(path!);
        break;
      default:
        console.error(`Unknown source type: ${sourceType}`);
        process.exit(1);
    }

    await ingestOne(source);
  } else {
    console.log("Usage:");
    console.log("  --source skill --path /path/to/skill/dir");
    console.log("  --source github --url https://github.com/owner/repo");
    console.log("  --source docs --path /path/to/docs/dir");
    console.log("  --source file --path /path/to/file.md");
    console.log("  --scan-skills              # auto-find and ingest unmined skills");
    console.log("  --scan-skills --dry-run    # preview without staging");
  }

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });

// ==========================================================
// GITHUB SCAN — Ingest a curated list of repos
// ==========================================================

// Repos that matter to this stack
const CURATED_REPOS = [
  "honojs/hono",
  "oven-sh/bun",
  "neondatabase/neon",
  "openclaw/openclaw",
  "anthropics/anthropic-sdk-node",
  "google-gemini/generative-ai-js",
  "inceptionlabs/mercury",
];

async function scanGitHub(repos: string[] = CURATED_REPOS): Promise<void> {
  console.log(`📦 GitHub Scan: ${repos.length} repos`);
  let total = { nodes: 0, edges: 0, dupes: 0 };

  for (const repo of repos) {
    try {
      const source = await adaptGitHub(`https://github.com/${repo}`);
      const result = await ingestOne(source);
      total.nodes += result.nodes;
      total.edges += result.edges;
      total.dupes += result.dupes;
      // Brief pause to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    } catch (e: any) {
      console.error(`  Failed ${repo}: ${e.message}`);
    }
  }

  console.log(`\n🏁 GitHub scan: ${total.nodes} nodes + ${total.edges} edges (${total.dupes} dupes)`);
}

// ==========================================================
// CLI ADAPTER — Mine installed CLIs via --help
// ==========================================================

import { execSync } from "child_process";

interface CLISource {
  name: string;
  path: string;
  helpText: string;
  version?: string;
  subcommands?: string[];
}

function discoverCLIs(): CLISource[] {
  // Curated list of CLIs we know are valuable for agents
  const clis = [
    // OpenClaw ecosystem
    "openclaw", "memo", "remindctl", "imsg", "clawhub",
    // Development
    "claude", "codex", "gh", "bun", "node", "vercel", "psql",
    // Media
    "ffmpeg", "sips",
    // Utilities  
    "jq", "trash", "curl",
  ];

  const results: CLISource[] = [];
  
  for (const cmd of clis) {
    try {
      const path = execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" }).trim();
      if (!path) continue;
      
      let helpText = "";
      try {
        helpText = execSync(`${cmd} --help 2>&1`, { encoding: "utf-8", timeout: 5000 }).slice(0, 5000);
      } catch (e: any) {
        helpText = e.stdout?.slice(0, 5000) || e.stderr?.slice(0, 5000) || "";
      }
      
      let version: string | undefined;
      try {
        version = execSync(`${cmd} --version 2>&1`, { encoding: "utf-8", timeout: 3000 }).trim().split("\n")[0];
      } catch {}

      // Try to discover subcommands from help text
      const subcommands = helpText.match(/^\s{2,}(\w[\w-]+)\s/gm)
        ?.map(s => s.trim().split(/\s/)[0])
        .filter(s => s.length > 1 && s.length < 30) || [];

      results.push({ name: cmd, path, helpText, version, subcommands: subcommands.slice(0, 20) });
    } catch {}
  }
  
  return results;
}

function adaptCLI(cli: CLISource): NormalizedSource {
  const content = [
    `# CLI: ${cli.name}`,
    cli.version ? `Version: ${cli.version}` : "",
    `Path: ${cli.path}`,
    cli.subcommands?.length ? `Subcommands: ${cli.subcommands.join(", ")}` : "",
    "",
    "## Help Output",
    cli.helpText,
  ].filter(Boolean).join("\n").slice(0, MAX_CHARS_PER_SOURCE);

  return {
    type: "file" as const,
    title: `CLI: ${cli.name}`,
    slug: `cli-${cli.name}`,
    content,
    metadata: {
      path: cli.path,
      files_read: [`${cli.name} --help`],
      total_chars: content.length,
    },
  };
}

async function scanCLIs(): Promise<void> {
  console.log("🔧 CLI Scan: discovering installed CLIs...");
  const clis = discoverCLIs();
  console.log(`  Found ${clis.length} CLIs`);

  let total = { nodes: 0, edges: 0, dupes: 0 };

  for (const cli of clis) {
    console.log(`\n  ${cli.name} (${cli.version || "unknown version"}) — ${cli.subcommands?.length || 0} subcommands`);
    const source = adaptCLI(cli);
    const result = await ingestOne(source);
    total.nodes += result.nodes;
    total.edges += result.edges;
    total.dupes += result.dupes;
  }

  console.log(`\n🏁 CLI scan: ${total.nodes} nodes + ${total.edges} edges staged (${total.dupes} dupes)`);
}
