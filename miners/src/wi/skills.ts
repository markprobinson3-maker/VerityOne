/**
 * World Ingestor V2 — Skill Lifecycle.
 * States: proposed → auto_review → auto_approved/needs_human/rejected → approved → active → retired
 *
 * Functions:
 * - autoReviewSkills() — cron (every 30 min)
 * - installSkill(id) — write SKILL.md, move from staging
 * - rejectSkill(id, reason) — reject + embed into wi_rejected_patterns
 * - retireSkill(id, reason) — move to _retired/
 * - reapSkills() — daily: retire unused/broken skills
 * - cleanRejectedPatterns() — monthly: expire non-permanent patterns
 */

import { sql, loadParams } from "./config";
import { callFlashLite } from "../lib/llm";
import { embedQuery, embedBatch, toVectorStr } from "@verity-one/embed";
import { existsSync, mkdirSync, renameSync, rmSync } from "fs";
import { join, dirname } from "path";

const SKILLS_DIR = join(process.env.HOME || "", ".config/verity/skills");
const STAGING_DIR = join(SKILLS_DIR, "_staging");
const RETIRED_DIR = join(SKILLS_DIR, "_retired");
const ROLLED_BACK_DIR = join(SKILLS_DIR, "_rolled_back");

// ============================================================
// DISCORD WEBHOOK
// ============================================================

async function postDiscord(message: string): Promise<void> {
  try {
    const [row] = await sql`SELECT value FROM graph_state WHERE key = 'wi_discord_webhook'`;
    if (!row?.value) return;
    await fetch(row.value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch {
    // Non-fatal
  }
}

// ============================================================
// AUTO-REVIEW — called by cron every 30 min
// ============================================================

export async function autoReviewSkills(): Promise<{ reviewed: number; approved: number; rejected: number; needsHuman: number }> {
  let reviewed = 0, approved = 0, rejected = 0, needsHuman = 0;

  // Pick PROPOSED skills
  const proposals = await sql`
    SELECT id, content, draft_md, source_url
    FROM wi_skill_proposals
    WHERE status = 'proposed'
    ORDER BY created_at DESC LIMIT 10
  `;

  if (proposals.length === 0) return { reviewed, approved, rejected, needsHuman };

  for (const proposal of proposals) {
    reviewed++;

    // Mark as auto_review
    await sql`UPDATE wi_skill_proposals SET status = 'auto_review' WHERE id = ${proposal.id}`;

    // 1. Check rejected patterns first (cosine > 0.85 → auto-reject)
    const proposalEmbedding = await embedQuery(proposal.content);
    const vecStr = toVectorStr(proposalEmbedding);

    const [rejectedMatch] = await sql`
      SELECT rejection_reason FROM wi_rejected_patterns
      WHERE 1 - (content_embedding <=> ${vecStr}::halfvec) > 0.85
      ORDER BY 1 - (content_embedding <=> ${vecStr}::halfvec) DESC
      LIMIT 1
    `;

    if (rejectedMatch) {
      await sql`
        UPDATE wi_skill_proposals SET
          status = 'rejected',
          rejection_reason = ${"Auto-rejected: similar to previously rejected skill — " + rejectedMatch.rejection_reason},
          reviewed_by = 'auto-reviewer',
          reviewed_at = now()
        WHERE id = ${proposal.id}
      `;
      rejected++;
      continue;
    }

    // 2. Find top-3 similar existing skills (F1: full SKILL.md content)
    const existingSkills = await sql`
      SELECT id, content, draft_md, skill_path
      FROM wi_skill_proposals
      WHERE status IN ('active', 'approved')
      ORDER BY created_at DESC LIMIT 50
    `;

    let existingContext = "None";
    if (existingSkills.length > 0) {
      // Embed all existing to find top-3 similar
      const existingTexts = existingSkills.map(s => s.content);
      const existingEmbeddings = await embedBatch(existingTexts);

      const similarities = existingEmbeddings.map((emb, i) => ({
        skill: existingSkills[i],
        similarity: cosine(proposalEmbedding, emb),
      }));

      similarities.sort((a, b) => b.similarity - a.similarity);
      const top3 = similarities.slice(0, 3);

      if (top3.length > 0) {
        existingContext = top3.map(s =>
          `- "${s.skill.content.slice(0, 100)}" (similarity: ${s.similarity.toFixed(3)})\n  Full content: ${(s.skill.draft_md || s.skill.content).slice(0, 500)}`
        ).join("\n");
      }
    }

    // 3. Quality gate via Flash Lite
    const reviewPrompt = `Review this proposed skill for an AI agent system.

EXISTING SKILLS:
${existingContext}

PROPOSED SKILL:
${proposal.draft_md || proposal.content}

Score 1-5 on: clarity, actionability, uniqueness (not duplicate of existing), safety.
If ALL scores >= 4: verdict = AUTO_APPROVE
If ANY score <= 2: verdict = AUTO_REJECT with reason
Otherwise: verdict = NEEDS_HUMAN

Return JSON: { clarity, actionability, uniqueness, safety, verdict, reason }`;

    try {
      const raw = await callFlashLite(reviewPrompt, { jsonMode: true, temperature: 0.1 });
      const scores = JSON.parse(raw.trim());

      const clarity = Math.round(Math.max(1, Math.min(5, Number(scores.clarity) || 3)));
      const actionability = Math.round(Math.max(1, Math.min(5, Number(scores.actionability) || 3)));
      const uniqueness = Math.round(Math.max(1, Math.min(5, Number(scores.uniqueness) || 3)));
      const safety = Math.round(Math.max(1, Math.min(5, Number(scores.safety) || 3)));
      const verdict = scores.verdict || "NEEDS_HUMAN";
      const reason = scores.reason || "";

      const qualityScores = { clarity, actionability, uniqueness, safety, verdict, reason };

      if (verdict === "AUTO_APPROVE" || (clarity >= 4 && actionability >= 4 && uniqueness >= 4 && safety >= 4)) {
        await sql`
          UPDATE wi_skill_proposals SET
            status = 'auto_approved',
            quality_scores = ${sql.json(qualityScores)},
            reviewed_by = 'auto-reviewer',
            reviewed_at = now()
          WHERE id = ${proposal.id}
        `;
        approved++;
        await postDiscord(`🔵 New skill auto-approved: "${proposal.content.slice(0, 80)}"`);

        // Auto-install
        try {
          await installSkill(proposal.id);
        } catch (err: any) {
          console.warn(`[WI] Auto-install failed for skill ${proposal.id}: ${err.message}`);
        }
      } else if (verdict === "AUTO_REJECT" || safety <= 2 || clarity <= 2) {
        await sql`
          UPDATE wi_skill_proposals SET
            status = 'rejected',
            quality_scores = ${sql.json(qualityScores)},
            rejection_reason = ${reason},
            reviewed_by = 'auto-reviewer',
            reviewed_at = now()
          WHERE id = ${proposal.id}
        `;
        rejected++;

        // Write rejection pattern
        await rejectSkillPattern(proposal.id, proposalEmbedding, reason, safety <= 2);
      } else {
        await sql`
          UPDATE wi_skill_proposals SET
            status = 'needs_human',
            quality_scores = ${sql.json(qualityScores)},
            reviewed_by = 'auto-reviewer',
            reviewed_at = now()
          WHERE id = ${proposal.id}
        `;
        needsHuman++;
        await postDiscord(`🟡 Skill needs review: "${proposal.content.slice(0, 80)}" — scores: C=${clarity} A=${actionability} U=${uniqueness} S=${safety}`);
      }
    } catch (err: any) {
      console.error(`[WI] Auto-review failed for skill ${proposal.id}: ${err.message}`);
      // Leave as auto_review, will be retried next cycle
      await sql`UPDATE wi_skill_proposals SET status = 'proposed' WHERE id = ${proposal.id}`;
    }
  }

  return { reviewed, approved, rejected, needsHuman };
}

// ============================================================
// INSTALL SKILL — write SKILL.md to disk
// ============================================================

export async function installSkill(id: number): Promise<string> {
  const [skill] = await sql`
    SELECT id, content, draft_md, skill_path
    FROM wi_skill_proposals
    WHERE id = ${id} AND status IN ('auto_approved', 'approved', 'needs_human')
  `;

  if (!skill) throw new Error(`Skill ${id} not found or not in installable state`);

  const draftMd = skill.draft_md;
  if (!draftMd) throw new Error(`Skill ${id} has no draft_md`);

  // Generate skill name from content
  const name = skill.content
    .slice(0, 40)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+$/, "");

  const skillDir = join(SKILLS_DIR, name);
  const skillPath = join(skillDir, "SKILL.md");

  // Check for existing (F3)
  if (existsSync(skillPath)) {
    throw new Error(`Skill already exists at ${skillPath}`);
  }

  // Write to staging first, then move atomically
  const stagingSkillDir = join(STAGING_DIR, name);
  const stagingSKILLPath = join(stagingSkillDir, "SKILL.md");

  mkdirSync(stagingSkillDir, { recursive: true });
  await Bun.write(stagingSKILLPath, draftMd);

  // Atomic move
  mkdirSync(dirname(skillPath), { recursive: true });
  renameSync(stagingSkillDir, skillDir);

  // Update DB
  await sql`
    UPDATE wi_skill_proposals SET
      status = 'active',
      skill_path = ${`skills/${name}/SKILL.md`}
    WHERE id = ${id}
  `;

  return skillPath;
}

// ============================================================
// REJECT SKILL
// ============================================================

export async function rejectSkill(id: number, reason: string): Promise<void> {
  const [skill] = await sql`
    SELECT id, content FROM wi_skill_proposals WHERE id = ${id}
  `;
  if (!skill) throw new Error(`Skill ${id} not found`);

  // Embed for pattern matching
  const embedding = await embedQuery(skill.content);

  await sql`
    UPDATE wi_skill_proposals SET
      status = 'rejected',
      rejection_reason = ${reason},
      reviewed_by = 'human',
      reviewed_at = now()
    WHERE id = ${id}
  `;

  // Write rejected pattern (permanent for safety/duplicate, expiring for quality — F5)
  const permanent = reason.toLowerCase().includes("safety") || reason.toLowerCase().includes("duplicate");
  await rejectSkillPattern(id, embedding, reason, permanent);
}

async function rejectSkillPattern(proposalId: number, embedding: number[], reason: string, permanent: boolean): Promise<void> {
  const vecStr = toVectorStr(embedding);
  await sql`
    INSERT INTO wi_rejected_patterns (content_embedding, rejection_reason, permanent, original_proposal_id)
    VALUES (${vecStr}::halfvec, ${reason}, ${permanent}, ${proposalId})
  `;
}

// ============================================================
// RETIRE SKILL
// ============================================================

export async function retireSkill(id: number, reason: string): Promise<void> {
  const [skill] = await sql`
    SELECT id, skill_path, content FROM wi_skill_proposals WHERE id = ${id} AND status = 'active'
  `;
  if (!skill) throw new Error(`Active skill ${id} not found`);

  // Move SKILL.md to _retired/
  if (skill.skill_path) {
    const fullPath = join(SKILLS_DIR, "..", skill.skill_path);
    const name = skill.skill_path.split("/")[1] || `skill-${id}`;
    const retiredPath = join(RETIRED_DIR, name);

    if (existsSync(fullPath)) {
      mkdirSync(RETIRED_DIR, { recursive: true });
      try {
        renameSync(dirname(fullPath), retiredPath);
      } catch {
        // Move failed — not fatal, just update DB
      }
    }
  }

  await sql`
    UPDATE wi_skill_proposals SET
      status = 'retired',
      retired_at = now(),
      retired_reason = ${reason}
    WHERE id = ${id}
  `;

  await postDiscord(`⚫ Skill retired (${reason}): "${skill.content.slice(0, 80)}"`);
}

// ============================================================
// REAP SKILLS — daily check
// ============================================================

export async function reapSkills(): Promise<{ retired: number; skipped: number }> {
  const params = await loadParams();
  let retired = 0, skipped = 0;

  // Skip entirely if tracking is disabled (F2)
  if (!params.trackingEnabled) {
    return { retired: 0, skipped: 0 };
  }

  const activeSkills = await sql`
    SELECT id, content, invocation_count, error_count, last_invoked_at, created_at
    FROM wi_skill_proposals
    WHERE status = 'active'
  `;

  for (const skill of activeSkills) {
    // Grace period: skip skills < 7 days old (F6)
    const ageDays = (Date.now() - new Date(skill.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < 7) {
      skipped++;
      continue;
    }

    // High-usage guard: invocation_count > 10 cannot be auto-retired
    if (skill.invocation_count > 10) {
      skipped++;
      continue;
    }

    // Never used: invocation_count=0 after 90 days
    if (skill.invocation_count === 0 && ageDays > 90) {
      await retireSkill(skill.id, "unused for 90+ days");
      retired++;
      continue;
    }

    // Broken: error_count > 5 AND success_rate < 50%
    if (skill.error_count > 5) {
      const totalAttempts = skill.invocation_count + skill.error_count;
      const successRate = totalAttempts > 0 ? skill.invocation_count / totalAttempts : 0;
      if (successRate < 0.5) {
        await retireSkill(skill.id, "too many failures");
        await postDiscord(`⚠️ Skill retired (too many failures): "${skill.content.slice(0, 80)}"`);
        retired++;
        continue;
      }
    }

    skipped++;
  }

  return { retired, skipped };
}

// ============================================================
// CLEAN REJECTED PATTERNS — monthly
// ============================================================

export async function cleanRejectedPatterns(): Promise<number> {
  const result = await sql`
    DELETE FROM wi_rejected_patterns
    WHERE permanent = false AND created_at < now() - interval '90 days'
  `;
  return result.count;
}

// ============================================================
// HELPERS
// ============================================================

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Ensure dirs exist
for (const dir of [STAGING_DIR, RETIRED_DIR, ROLLED_BACK_DIR]) {
  mkdirSync(dir, { recursive: true });
}
