import type postgres from "postgres";
export type JournalMemoryOp = "upsert" | "tombstone";
export type JournalEntryOp = "upsert" | "tombstone";
export async function tryJournalMemoryInTx(..._a: any[]): Promise<void> {}
export async function tryJournalEdgeInTx(..._a: any[]): Promise<void> {}
export async function journalGovernance(..._a: any[]): Promise<void> {}
export async function journalProject(..._a: any[]): Promise<void> {}
export async function journalDayJournalEntry(..._a: any[]): Promise<void> {}
export function nudgeSyncScheduler(): void {}
void (0 as unknown as ReturnType<typeof postgres>);
