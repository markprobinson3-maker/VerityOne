// Open-core stub: hosted Neon maintenance is a VO+ (hosted) feature. In the
// open-core build there is no hosted maintenance to run, so these are no-ops
// whose return shapes match what the hosted callers expect.
export async function readHostedMaintenanceDisabled(..._a: any[]): Promise<{ disabled: boolean; reason?: string }> {
  return { disabled: true, reason: "hosted maintenance is not available in the open-core build" };
}
export async function recordHostedMaintenanceRun(..._a: any[]): Promise<void> {}
export async function runHostedNeonMaintenance(..._a: any[]): Promise<{ ok: boolean; ran: string[]; skipped?: string }> {
  return { ok: false, ran: [], skipped: "disabled" };
}
export async function selectHostedMaintenanceStatus(..._a: any[]): Promise<Record<string, unknown>> {
  return {};
}
