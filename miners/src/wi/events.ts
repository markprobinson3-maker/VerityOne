/**
 * World Ingestor V2 — Event system for SSE pipeline events.
 */

import { EventEmitter } from "events";

export interface WIEvent {
  type: "source_start" | "source_done" | "atom_extracted" | "atom_routed" | "run_complete" | "convergence" | "error" | "atom_pooled" | "atom_enriching" | "atom_enriched" | "atom_pool_dropped";
  run_id: string;
  timestamp: number;
  data: Record<string, any>;
}

const REPLAY_BUFFER_SIZE = 100;

class WIEventEmitter extends EventEmitter {
  private replayBuffer: WIEvent[] = [];

  emit(event: string | symbol, ...args: any[]): boolean {
    if (event === "wi" && args[0]) {
      const wiEvent = args[0] as WIEvent;
      this.replayBuffer.push(wiEvent);
      if (this.replayBuffer.length > REPLAY_BUFFER_SIZE) {
        this.replayBuffer.shift();
      }
    }
    return super.emit(event, ...args);
  }

  getReplayBuffer(): WIEvent[] {
    return [...this.replayBuffer];
  }
}

export const wiEvents = new WIEventEmitter();
wiEvents.setMaxListeners(20);

export function emitWI(type: WIEvent["type"], runId: string, data: Record<string, any>) {
  wiEvents.emit("wi", { type, run_id: runId, timestamp: Date.now(), data });
}
