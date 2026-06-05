import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBED_DOCUMENT_TASK_TYPE, EMBED_MODEL } from "@verity-one/embed";

export const ARCHETYPE_DEDUP_CALIBRATION_SCHEMA_VERSION = 1;
export const ARCHETYPE_DEDUP_CALIBRATION_PATH = "docs/foundation/archetype-dedup-calibration.json";
export const ARCHETYPE_DEDUP_SOURCE_SCOPE = "current_database_pending_archetype_proposals";
export const ARCHETYPE_DEDUP_SAMPLING_STRATEGY = "top_n_by_cosine_then_bucket_stratified";
export const ARCHETYPE_DEDUP_MIN_SAMPLE_SIZE = 20;
export const ARCHETYPE_DEDUP_COSINE_VALIDATION_MIN = 0.5;
export const ARCHETYPE_DEDUP_COSINE_VALIDATION_MAX = 0.99;
export const ARCHETYPE_DEDUP_PYRAMID_JACCARD_VALIDATION_MIN = 0;
export const ARCHETYPE_DEDUP_PYRAMID_JACCARD_VALIDATION_MAX = 1;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const METHOD_VALUES = new Set(["f1_max"]);

export interface ArchetypeDedupCalibrationPair {
  pair_key: string;
  left_proposal_id: number;
  right_proposal_id: number;
  left_name: string;
  right_name: string;
  left_pyramids: string[];
  right_pyramids: string[];
  cosine_similarity: number;
  pyramid_jaccard: number;
  duplicate: boolean;
}

export interface ArchetypeDedupCalibrationMetrics {
  precision: number;
  recall: number;
  f1: number;
  true_positive?: number;
  false_positive?: number;
  false_negative?: number;
  true_negative?: number;
}

export interface ArchetypeDedupCalibrationArtifact {
  schema_version: 1;
  calibration_status: "operator_labeled";
  calibrated_at: string;
  calibrated_by: string;
  source_scope: typeof ARCHETYPE_DEDUP_SOURCE_SCOPE;
  scope_note: string;
  embedding_model: string;
  embedding_task_type: string;
  sample_seed: string;
  sample_size: number;
  pair_count: number;
  positive_count: number;
  negative_count: number;
  sampling_strategy: typeof ARCHETYPE_DEDUP_SAMPLING_STRATEGY;
  method: "f1_max";
  chosen_cosine_threshold: number;
  chosen_pyramid_jaccard_min: number;
  metrics: ArchetypeDedupCalibrationMetrics;
  /**
   * Count of pyramid mentions across both sides of every labeled pair. A pair
   * with FUNCTION on the left and FUNCTION+PROJECTS on the right contributes
   * FUNCTION += 2 and PROJECTS += 1.
   */
  pyramid_distribution: Record<string, number>;
  warnings: string[];
  labeled_pairs: ArchetypeDedupCalibrationPair[];
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid_archetype_dedup_calibration:${key}: expected non-empty string`);
  }
  return value;
}

function requiredStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`invalid_archetype_dedup_calibration:${key}: expected string array`);
  }
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string, min: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`invalid_archetype_dedup_calibration:${key}: expected integer >= ${min}`);
  }
  return value;
}

function requiredFiniteNumber(record: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`invalid_archetype_dedup_calibration:${key}: expected finite number in [${min}, ${max}]`);
  }
  return value;
}

function validateIsoTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("invalid_archetype_dedup_calibration:calibrated_at: expected Date.toISOString() UTC timestamp");
  }
}

function validateMetrics(value: unknown): ArchetypeDedupCalibrationMetrics {
  const record = assertRecord(value, "invalid_archetype_dedup_calibration:metrics");
  const metrics: ArchetypeDedupCalibrationMetrics = {
    precision: requiredFiniteNumber(record, "precision", 0, 1),
    recall: requiredFiniteNumber(record, "recall", 0, 1),
    f1: requiredFiniteNumber(record, "f1", 0, 1),
  };
  for (const key of ["true_positive", "false_positive", "false_negative", "true_negative"] as const) {
    if (record[key] != null) metrics[key] = requiredInteger(record, key, 0);
  }
  return metrics;
}

function validatePyramidDistribution(value: unknown): Record<string, number> {
  const record = assertRecord(value, "invalid_archetype_dedup_calibration:pyramid_distribution");
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(record)) {
    if (!key || typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new Error("invalid_archetype_dedup_calibration:pyramid_distribution: expected non-negative integer counts");
    }
    result[key] = count;
  }
  return result;
}

function validateLabeledPair(value: unknown): ArchetypeDedupCalibrationPair {
  const record = assertRecord(value, "invalid_archetype_dedup_calibration:labeled_pairs[]");
  return {
    pair_key: requiredString(record, "pair_key"),
    left_proposal_id: requiredInteger(record, "left_proposal_id", 1),
    right_proposal_id: requiredInteger(record, "right_proposal_id", 1),
    left_name: requiredString(record, "left_name"),
    right_name: requiredString(record, "right_name"),
    left_pyramids: requiredStringArray(record.left_pyramids, "left_pyramids"),
    right_pyramids: requiredStringArray(record.right_pyramids, "right_pyramids"),
    cosine_similarity: requiredFiniteNumber(record, "cosine_similarity", 0, 1),
    pyramid_jaccard: requiredFiniteNumber(record, "pyramid_jaccard", 0, 1),
    duplicate: (() => {
      if (typeof record.duplicate !== "boolean") {
        throw new Error("invalid_archetype_dedup_calibration:duplicate: expected boolean");
      }
      return record.duplicate;
    })(),
  };
}

export function validateArchetypeDedupCalibrationArtifact(value: unknown): ArchetypeDedupCalibrationArtifact {
  const record = assertRecord(value, "invalid_archetype_dedup_calibration");
  if (record.schema_version !== ARCHETYPE_DEDUP_CALIBRATION_SCHEMA_VERSION) {
    throw new Error(`invalid_archetype_dedup_calibration:schema_version: expected ${ARCHETYPE_DEDUP_CALIBRATION_SCHEMA_VERSION}`);
  }
  const calibrationStatus = requiredString(record, "calibration_status");
  if (calibrationStatus !== "operator_labeled") {
    throw new Error("invalid_archetype_dedup_calibration:bootstrap_artifact_requires_operator_labeled");
  }

  const calibratedAt = requiredString(record, "calibrated_at");
  validateIsoTimestamp(calibratedAt);
  const calibratedBy = requiredString(record, "calibrated_by");
  if (calibratedBy === "codex-bootstrap") {
    throw new Error("invalid_archetype_dedup_calibration:bootstrap_artifact_calibrated_by_codex_bootstrap");
  }

  const embeddingModel = requiredString(record, "embedding_model");
  if (embeddingModel !== EMBED_MODEL) {
    throw new Error(`invalid_archetype_dedup_calibration:embedding_model:${embeddingModel}: expected ${EMBED_MODEL}`);
  }
  const embeddingTaskType = requiredString(record, "embedding_task_type");
  if (embeddingTaskType !== EMBED_DOCUMENT_TASK_TYPE) {
    throw new Error(`invalid_archetype_dedup_calibration:embedding_task_type:${embeddingTaskType}: expected ${EMBED_DOCUMENT_TASK_TYPE}`);
  }

  const method = requiredString(record, "method");
  if (!METHOD_VALUES.has(method)) {
    throw new Error(`invalid_archetype_dedup_calibration:method:${method}`);
  }

  const sampleSize = requiredInteger(record, "sample_size", ARCHETYPE_DEDUP_MIN_SAMPLE_SIZE);
  const pairCount = requiredInteger(record, "pair_count", ARCHETYPE_DEDUP_MIN_SAMPLE_SIZE);
  const positiveCount = requiredInteger(record, "positive_count", 0);
  const negativeCount = requiredInteger(record, "negative_count", 0);
  if (positiveCount + negativeCount !== pairCount) {
    throw new Error("invalid_archetype_dedup_calibration:class_counts_do_not_match_pair_count");
  }
  if (pairCount !== sampleSize) {
    throw new Error("invalid_archetype_dedup_calibration:pair_count_must_equal_sample_size");
  }
  if (positiveCount === 0 || negativeCount === 0) {
    throw new Error("invalid_archetype_dedup_calibration:operator_labeled_artifact_requires_positive_and_negative_labels");
  }
  if (record.labeled_pairs == null) {
    throw new Error("invalid_archetype_dedup_calibration:operator_labeled_artifact_requires_labeled_pairs");
  }

  if (!Array.isArray(record.labeled_pairs)) {
    throw new Error("invalid_archetype_dedup_calibration:labeled_pairs: expected array");
  }
  const labeledPairs = record.labeled_pairs.map(validateLabeledPair);
  if (labeledPairs.length !== sampleSize) {
    throw new Error("invalid_archetype_dedup_calibration:labeled_pairs_length_mismatch");
  }
  const labeledPositive = labeledPairs.filter((pair) => pair.duplicate).length;
  if (labeledPositive !== positiveCount || labeledPairs.length - labeledPositive !== negativeCount) {
    throw new Error("invalid_archetype_dedup_calibration:labeled_pair_counts_mismatch");
  }
  const warnings = requiredStringArray(record.warnings, "warnings");
  if (warnings.some((warning) => warning.startsWith("bootstrap_artifact:"))) {
    throw new Error("invalid_archetype_dedup_calibration:bootstrap_artifact_warning_forbidden");
  }
  const sourceScope = requiredString(record, "source_scope");
  if (sourceScope !== ARCHETYPE_DEDUP_SOURCE_SCOPE) {
    throw new Error(`invalid_archetype_dedup_calibration:source_scope:${sourceScope}: expected ${ARCHETYPE_DEDUP_SOURCE_SCOPE}`);
  }
  const samplingStrategy = requiredString(record, "sampling_strategy");
  if (samplingStrategy !== ARCHETYPE_DEDUP_SAMPLING_STRATEGY) {
    throw new Error(`invalid_archetype_dedup_calibration:sampling_strategy:${samplingStrategy}: expected ${ARCHETYPE_DEDUP_SAMPLING_STRATEGY}`);
  }

  return {
    schema_version: ARCHETYPE_DEDUP_CALIBRATION_SCHEMA_VERSION,
    calibration_status: "operator_labeled",
    calibrated_at: calibratedAt,
    calibrated_by: calibratedBy,
    source_scope: ARCHETYPE_DEDUP_SOURCE_SCOPE,
    scope_note: requiredString(record, "scope_note"),
    embedding_model: embeddingModel,
    embedding_task_type: embeddingTaskType,
    sample_seed: requiredString(record, "sample_seed"),
    sample_size: sampleSize,
    pair_count: pairCount,
    positive_count: positiveCount,
    negative_count: negativeCount,
    sampling_strategy: ARCHETYPE_DEDUP_SAMPLING_STRATEGY,
    method: "f1_max",
    chosen_cosine_threshold: requiredFiniteNumber(
      record,
      "chosen_cosine_threshold",
      ARCHETYPE_DEDUP_COSINE_VALIDATION_MIN,
      ARCHETYPE_DEDUP_COSINE_VALIDATION_MAX,
    ),
    chosen_pyramid_jaccard_min: requiredFiniteNumber(
      record,
      "chosen_pyramid_jaccard_min",
      ARCHETYPE_DEDUP_PYRAMID_JACCARD_VALIDATION_MIN,
      ARCHETYPE_DEDUP_PYRAMID_JACCARD_VALIDATION_MAX,
    ),
    metrics: validateMetrics(record.metrics),
    pyramid_distribution: validatePyramidDistribution(record.pyramid_distribution),
    warnings,
    labeled_pairs: labeledPairs,
  };
}

export function parseArchetypeDedupCalibrationJson(jsonText: string): ArchetypeDedupCalibrationArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err: any) {
    throw new Error(`malformed_archetype_dedup_calibration_json:${err?.message || String(err)}`);
  }
  return validateArchetypeDedupCalibrationArtifact(parsed);
}

export function loadArchetypeDedupCalibration(
  artifactPath = resolve(REPO_ROOT, ARCHETYPE_DEDUP_CALIBRATION_PATH),
): ArchetypeDedupCalibrationArtifact {
  return parseArchetypeDedupCalibrationJson(readFileSync(artifactPath, "utf8"));
}
