import type { DayJournalRoutineDefinition } from "./routine-registry";
import { canonicalizeJournalRequest } from "./validate";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateJsonSchemaSubset(value: unknown, schema: Record<string, unknown>, path: string): void {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type) {
    const valid =
      (type === "object" && isJsonObject(value))
      || (type === "array" && Array.isArray(value))
      || (type === "string" && typeof value === "string")
      || (type === "boolean" && typeof value === "boolean")
      || (type === "number" && typeof value === "number" && Number.isFinite(value))
      || (type === "integer" && typeof value === "number" && Number.isInteger(value));
    if (!valid) throw new TypeError(`${path} must be ${type}.`);
  }

  if (!isJsonObject(value)) return;
  const properties = isJsonObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && !(key in value)) throw new TypeError(`${path}.${key} is required.`);
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new TypeError(`${path} contains unsupported key: ${key}`);
    }
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (key in value && isJsonObject(childSchema)) {
      validateJsonSchemaSubset(value[key], childSchema, `${path}.${key}`);
    }
  }
}

export function validateConfigForRoutine(
  def: Pick<DayJournalRoutineDefinition, "configSchema">,
  value: unknown,
): Record<string, unknown> {
  const config = value === undefined ? {} : value;
  if (!isJsonObject(config)) throw new TypeError("config must be a JSON object.");
  const canonical = canonicalizeJournalRequest(config);
  const normalizedConfig = JSON.parse(canonical) as Record<string, unknown>;
  validateJsonSchemaSubset(normalizedConfig, def.configSchema as Record<string, unknown>, "config");
  return normalizedConfig;
}
