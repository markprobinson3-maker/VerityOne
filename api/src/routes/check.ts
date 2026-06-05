/**
 * /check/:addr — Live readiness check for a skill/tool node
 * 
 * Runs the node's readiness checks against this machine in real-time.
 * Returns pass/fail for each check with the fix command if it fails.
 * 
 * Security: only runs commands from the node's own readiness.checks —
 * these are curated test commands (command -v, env checks, curl health),
 * not arbitrary execution. Timeout enforced per check.
 * 
 * GET /check/OC.0.2.58 → runs the node's readiness checks, returns status
 */

import { Hono } from "hono";
import { sql } from "../db";
import { errorJson } from "../lib/error-envelope";
import { getAccessContext, isOperator } from "../lib/access";
import { isNodeReadableForScope } from "../lib/public-graph";
import { getDeploymentProfile } from "../lib/db-config";

const check = new Hono();

const CHECK_TIMEOUT_MS = 5000; // 5 seconds per check max

interface CheckResult {
  type: string;
  test: string;
  tier: string;
  passed: boolean;
  fix?: string;
  obtain?: string;
  error?: string;
}

async function runCommandCheck(test: string): Promise<{ passed: boolean; error?: string }> {
  try {
    const proc = Bun.spawn(["bash", "-c", test], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const timeout = setTimeout(() => proc.kill(), CHECK_TIMEOUT_MS);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    return { passed: exitCode === 0 };
  } catch (e) {
    console.error("[check] readiness check failed:", e);
    return { passed: false, error: "execution failed" };
  }
}

function checkEnvVar(varName: string): { passed: boolean } {
  return { passed: !!process.env[varName] && process.env[varName]!.length > 0 };
}

function checkPlatform(requires: string[]): { passed: boolean; error?: string } {
  const platform = process.platform; // "darwin", "linux", "win32"
  for (const req of requires) {
    if (req === "darwin" && platform !== "darwin") {
      return { passed: false, error: `Requires macOS, running on ${platform}` };
    }
    if (req === "linux" && platform !== "linux") {
      return { passed: false, error: `Requires Linux, running on ${platform}` };
    }
  }
  return { passed: true };
}

function declarativeChecks(readiness: any): CheckResult[] {
  return (readiness?.checks || []).map((chk: any) => ({
    type: chk.type || "unknown",
    test: chk.test || chk.var || `platform:${(chk.requires || []).join(",")}`,
    tier: chk.tier || "yellow",
    passed: null as any,
    fix: chk.fix,
    obtain: chk.obtain,
    error:
      "Live verification requires operator access on the long-lived deployment profile",
  }));
}

check.get("/:addr", async (c) => {
  const addr = c.req.param("addr");
  const startMs = Date.now();
  const access = getAccessContext(c);
  // F3: live `Bun.spawn(...)` only runs from the long-lived launcher.
  // Serverless operators still see declarative checks in the response
  // payload, just without executing host commands.
  const liveChecksAllowed = isOperator(c) && getDeploymentProfile() === "long-lived";

  // Fetch node
  const [node] = await sql`
    SELECT n.addr, n.label, n.node_type, n.visibility, n.source_context, r.access_level,
      n.substance->'readiness' as readiness,
      n.substance->'quick_start' as quick_start, n.substance->>'slug' as slug,
      n.substance->>'description' as description
    FROM nodes n
    JOIN registry r ON r.pyramid_id = n.pyramid_id
    WHERE n.addr = ${addr}
      AND n.visibility <> 'deleted'
  `;

  if (!node) return errorJson(c, "node_not_found");
  if (!isNodeReadableForScope(access, node)) {
    return errorJson(c, "node_not_found");
  }

  const readiness = node.readiness as any;
  if (!readiness?.checks?.length) {
    return c.json({
      addr,
      label: node.label,
      status: "no-checks",
      message: "This node has no readiness checks defined. Cannot verify readiness without checks.",
      ready: false,
      verification_mode: "declarative",
      reason: "absent-verification",
      ms: Date.now() - startMs,
    });
  }

  if (!liveChecksAllowed) {
    return c.json({
      addr,
      label: node.label,
      slug: node.slug,
      description: node.description,
      status: "verification-required",
      ready: null,
      verification_mode: "declarative",
      checks: declarativeChecks(readiness),
      quick_start: node.quick_start || undefined,
      note: "Live machine checks are restricted to operator mode. This response is guidance only.",
      ms: Date.now() - startMs,
    });
  }

  const results: CheckResult[] = [];
  let allPassed = true;
  let worstTier = "green";

  for (const chk of readiness.checks) {
    let result: CheckResult;

    switch (chk.type) {
      case "command": {
        const { passed, error } = await runCommandCheck(chk.test);
        result = {
          type: "command",
          test: chk.test,
          tier: chk.tier,
          passed,
          fix: passed ? undefined : chk.fix,
          error,
        };
        break;
      }
      case "env": {
        const { passed } = checkEnvVar(chk.var);
        result = {
          type: "env",
          test: `env:${chk.var}`,
          tier: chk.tier,
          passed,
          fix: passed ? undefined : `Set ${chk.var}`,
          obtain: passed ? undefined : chk.obtain,
        };
        break;
      }
      case "platform": {
        const { passed, error } = checkPlatform(chk.requires || []);
        result = {
          type: "platform",
          test: `platform:${(chk.requires || []).join(",")}`,
          tier: chk.tier,
          passed,
          error,
        };
        break;
      }
      case "service": {
        const { passed, error } = await runCommandCheck(chk.test);
        result = {
          type: "service",
          test: chk.test,
          tier: chk.tier,
          passed,
          fix: passed ? undefined : chk.fix,
          error,
        };
        break;
      }
      default: {
        result = {
          type: chk.type || "unknown",
          test: chk.test || chk.var || "unknown",
          tier: chk.tier || "yellow",
          passed: false,
          error: `Unknown check type: ${chk.type}`,
        };
      }
    }

    if (!result.passed) {
      allPassed = false;
      if (chk.tier === "red") worstTier = "red";
      else if (chk.tier === "yellow" && worstTier !== "red") worstTier = "yellow";
    }

    results.push(result);
  }

  // Determine overall status
  const status = allPassed ? "ready" : worstTier === "red" ? "blocked" : "fixable";

  const response: any = {
    addr,
    label: node.label,
    slug: node.slug,
    status,
    ready: allPassed,
    checks: results,
    ms: Date.now() - startMs,
  };

  // If ready, include quick_start so agent can act immediately
  if (allPassed && node.quick_start) {
    response.quick_start = node.quick_start;
  }

  // If not ready, include a fix_sequence — ordered list of what to do
  if (!allPassed) {
    response.fix_sequence = results
      .filter(r => !r.passed)
      .map(r => ({
        action: r.fix || r.obtain || r.error,
        tier: r.tier,
        can_agent_fix: r.tier !== "red",
      }));
  }

  // Record that this check was run (usage signal)
  await sql`SELECT increment_query_hits(${[addr]}::text[])`;

  return c.json(response);
});

export { check };
