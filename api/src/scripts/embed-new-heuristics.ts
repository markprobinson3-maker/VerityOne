import { embedTextForInsert, embeddingTextForNode } from "../lib/embed";
import postgres from "postgres";

const sql = postgres("postgres://localhost:5432/verity");
const addrs = ["HE.0.2.42","HE.0.2.43","HE.0.2.44","HE.0.2.45","HE.0.2.46","HE.0.2.47"];

for (const addr of addrs) {
  const [n] = await sql`SELECT label, substance FROM nodes WHERE addr = ${addr}`;
  if (!n) { console.log(`${addr}: not found`); continue; }
  const embed = await embedTextForInsert(embeddingTextForNode(n.label, n.substance));
  await sql`
    UPDATE nodes SET
      embedding_hv = ${embed.vecStr}::halfvec(3072),
      embedding_at = ${embed.embeddedAt},
      embedding_model = ${embed.model},
      embedding_task_type = ${embed.taskType}
    WHERE addr = ${addr}`;
  console.log("✅", addr, "—", n.label.slice(0, 60));
}

await sql.end();
process.exit(0);
