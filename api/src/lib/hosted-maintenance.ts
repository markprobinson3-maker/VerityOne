export async function readHostedMaintenanceDisabled(..._a: any[]): Promise<boolean> { return true; }
export async function recordHostedMaintenanceRun(..._a: any[]): Promise<void> {}
export async function runHostedNeonMaintenance(..._a: any[]): Promise<{ ok: boolean; ran: string[] }> { return { ok: false, ran: [] }; }
