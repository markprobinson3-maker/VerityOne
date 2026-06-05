import { createHash } from "node:crypto";

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256HexNullable(value) {
  return value === null ? null : sha256Hex(value);
}
