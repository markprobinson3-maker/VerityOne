import { embedTextForInsert, embeddingTextForNode } from "../lib/embed";
import { createDirectSql } from "../lib/db-config";

const sql = createDirectSql();

// All unembedded public nodes — run this after gap-fill operations
const rows = await sql`
  SELECT addr FROM nodes
  WHERE embedding_hv IS NULL AND visibility = 'public' AND node_type NOT IN ('structure')
  ORDER BY addr`;
const addrs = rows.map((r: any) => r.addr);
console.log(`Found ${addrs.length} nodes needing embeddings`);

for (const addr of addrs) {
  const [node] = await sql`SELECT label, substance FROM nodes WHERE addr = ${addr}`;
  if (!node) { console.log(`${addr}: not found`); continue; }

  try {
    const embed = await embedTextForInsert(embeddingTextForNode(node.label, node.substance));
    await sql`
      UPDATE nodes SET
        embedding_hv = ${embed.vecStr}::halfvec(3072),
        embedding_at = ${embed.embeddedAt},
        embedding_model = ${embed.model},
        embedding_task_type = ${embed.taskType}
      WHERE addr = ${addr}`;
    console.log(`OK ${addr} -- ${node.label}`);
  } catch (e: any) {
    console.log(`FAIL ${addr}: ${e.message?.slice(0, 120)}`);
  }
}

await sql.end();
process.exit(0);
