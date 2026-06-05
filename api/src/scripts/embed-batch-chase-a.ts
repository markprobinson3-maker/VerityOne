import { embedTextForInsert, embeddingTextForNode } from "../lib/embed";
import { createDirectSql } from "../lib/db-config";

const sql = createDirectSql();

const addrs = Array.from({length: 24}, (_, i) => `CC.0.3.${346 + i}`);

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
    console.log(`✅ ${addr} — ${node.label}`);
  } catch (e: any) {
    console.log(`❌ ${addr}: ${e.message?.slice(0, 80)}`);
  }
}

await sql.end();
process.exit(0);
