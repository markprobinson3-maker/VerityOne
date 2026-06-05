import { listenSql } from "./db";
import { getDeploymentProfile } from "./lib/db-config";

type WSClient = {
  send: (data: string) => void;
  readyState: number;
};

const clients = new Set<WSClient>();

export function addClient(ws: WSClient) {
  clients.add(ws);
  console.log(`🔌 WebSocket client connected (total: ${clients.size})`);
}

export function removeClient(ws: WSClient) {
  clients.delete(ws);
  console.log(`🔌 WebSocket client disconnected (total: ${clients.size})`);
}

function broadcast(data: string) {
  for (const client of clients) {
    try {
      if (client.readyState === 1) {
        client.send(data);
      } else {
        clients.delete(client);
      }
    } catch {
      clients.delete(client);
    }
  }
}

// Subscribe to Postgres LISTEN/NOTIFY.
//
// F3: gated to the long-lived deployment profile. Neon's serverless
// connection pooler does not support session-scoped LISTEN, and
// Vercel functions cannot hold a persistent socket. Serverless
// callers should poll the `change_stream` table on demand.
export async function startChangeStream() {
  if (getDeploymentProfile() !== "long-lived") {
    console.log(
      "[change-stream] serverless profile — LISTEN/NOTIFY disabled",
    );
    return;
  }
  if (!listenSql) {
    console.log(
      "[change-stream] listenSql unavailable — LISTEN/NOTIFY disabled",
    );
    return;
  }
  try {
    await listenSql.listen("verity_changes", (payload) => {
      console.log(`📡 Change event: ${payload.substring(0, 80)}...`);
      broadcast(payload);
    });
    console.log("✅ Change stream listening on 'verity_changes'");
  } catch (err: any) {
    console.error("❌ Change stream failed:", err.message);
  }
}
