type SqlTag = any;

export interface OnboardingRateLimitHit {
  allowed: boolean;
  retry_after_seconds: number;
  count: number;
  reset_at: string;
}

export interface OnboardingRateLimitInput {
  bucketKey: string;
  max: number;
  windowMs: number;
}

export interface OnboardingRateLimitBatchHit {
  allowed: boolean;
  retry_after_seconds: number;
  hits: OnboardingRateLimitHit[];
}

const ONBOARDING_RATE_LIMIT_DENIED = "onboarding_rate_limited";

class OnboardingRateLimitDenied extends Error {
  readonly code = ONBOARDING_RATE_LIMIT_DENIED;

  constructor(readonly hits: OnboardingRateLimitHit[]) {
    super(ONBOARDING_RATE_LIMIT_DENIED);
    this.name = "OnboardingRateLimitDenied";
  }
}

function isOnboardingRateLimitDenied(err: unknown): err is OnboardingRateLimitDenied {
  return (
    err instanceof OnboardingRateLimitDenied ||
    (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === ONBOARDING_RATE_LIMIT_DENIED &&
      Array.isArray((err as { hits?: unknown }).hits)
    )
  );
}

function assertUniqueBucketKeys(inputs: OnboardingRateLimitInput[]): void {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.bucketKey)) {
      throw new Error(`duplicate_onboarding_rate_limit_bucket:${input.bucketKey}`);
    }
    seen.add(input.bucketKey);
  }
}

export async function recordOnboardingRateLimitHit(
  sql: SqlTag,
  input: OnboardingRateLimitInput,
): Promise<OnboardingRateLimitHit> {
  const windowSeconds = Math.max(1, Math.ceil(input.windowMs / 1000));
  const [row] = await sql`
    INSERT INTO hosted_rate_limit_buckets (bucket_key, count, reset_at)
    VALUES (
      ${input.bucketKey},
      1,
      now() + (${windowSeconds}::int * interval '1 second')
    )
    ON CONFLICT (bucket_key) DO UPDATE SET
      count = CASE
        WHEN hosted_rate_limit_buckets.reset_at <= now() THEN 1
        ELSE hosted_rate_limit_buckets.count + 1
      END,
      reset_at = CASE
        WHEN hosted_rate_limit_buckets.reset_at <= now()
          THEN now() + (${windowSeconds}::int * interval '1 second')
        ELSE hosted_rate_limit_buckets.reset_at
      END,
      updated_at = now()
    RETURNING
      count,
      reset_at,
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM (reset_at - now()))))::int AS retry_after_seconds
  `;
  const count = Number(row?.count ?? 0);
  return {
    allowed: count <= input.max,
    retry_after_seconds: Number(row?.retry_after_seconds ?? windowSeconds),
    count,
    reset_at: String(row?.reset_at ?? ""),
  };
}

export async function recordOnboardingRateLimitHits(
  sql: SqlTag,
  inputs: OnboardingRateLimitInput[],
): Promise<OnboardingRateLimitBatchHit> {
  if (inputs.length === 0) {
    return { allowed: true, retry_after_seconds: 1, hits: [] };
  }
  assertUniqueBucketKeys(inputs);

  let hits: OnboardingRateLimitHit[] = [];
  try {
    await sql.begin(async (tx: SqlTag) => {
      const sorted = inputs
        .map((input, index) => ({ input, index }))
        .sort((a, b) => a.input.bucketKey.localeCompare(b.input.bucketKey));
      const hitsByInputIndex: OnboardingRateLimitHit[] = [];

      for (const { input, index } of sorted) {
        hitsByInputIndex[index] = await recordOnboardingRateLimitHit(tx, input);
      }

      hits = hitsByInputIndex;
      if (hits.some((hit) => !hit.allowed)) {
        throw new OnboardingRateLimitDenied(hits);
      }
    });
  } catch (err) {
    if (isOnboardingRateLimitDenied(err)) {
      const retryAfter = Math.max(
        1,
        ...err.hits
          .filter((hit) => !hit.allowed)
          .map((hit) => hit.retry_after_seconds),
      );
      return { allowed: false, retry_after_seconds: retryAfter, hits: err.hits };
    }
    throw err;
  }

  return { allowed: true, retry_after_seconds: 1, hits };
}
