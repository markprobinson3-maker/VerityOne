import { createHash } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256HexNullable(value: string | null): string | null {
  return value === null ? null : sha256Hex(value);
}
