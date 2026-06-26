export const HOSTED_PARITY_THRESHOLDS = {
  mirrorStaleAfterSeconds: 60 * 60,
  primaryStaleAfterSeconds: 24 * 60 * 60,
  primaryDangerouslyStaleAfterSeconds: 7 * 24 * 60 * 60,
  driveWorkerStaleAfterMs: 15 * 60 * 1000,
} as const;

export type HostedParityThresholdKey = keyof typeof HOSTED_PARITY_THRESHOLDS;
