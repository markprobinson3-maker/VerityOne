/**
 * WI Adapter — Stack Overflow / Stack Exchange.
 * Uses SE API v2.3. Fetches question + top 3 answers by score. Strips HTML.
 * Optional API key via STACKEXCHANGE_KEY env var.
 */

const SE_API = "https://api.stackexchange.com/2.3";
const SE_KEY = process.env.STACKEXCHANGE_KEY || "";

function stripHtml(html: string): string {
  return html
    .replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => "\n```\n" + decodeEntities(code) + "\n```\n")
    .replace(/<code>([\s\S]*?)<\/code>/gi, (_, code) => "`" + decodeEntities(code) + "`")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractQuestionId(url: string): string {
  // stackoverflow.com/questions/12345/title-slug
  const match = url.match(/questions\/(\d+)/);
  if (!match) throw new Error(`Cannot extract question ID from URL: ${url}`);
  return match[1];
}

function extractSite(url: string): string {
  const u = new URL(url);
  const host = u.hostname;
  if (host.includes("stackoverflow.com")) return "stackoverflow";
  // serverfault.com, superuser.com, *.stackexchange.com
  const match = host.match(/^([^.]+)\.stackexchange\.com$/);
  if (match) return match[1];
  if (host.includes("serverfault.com")) return "serverfault";
  if (host.includes("superuser.com")) return "superuser";
  return "stackoverflow";
}

export async function extract(url: string): Promise<{ text: string; title: string }> {
  const questionId = extractQuestionId(url);
  const site = extractSite(url);

  const params = new URLSearchParams({
    site,
    filter: "withbody",
    order: "desc",
    sort: "votes",
  });
  if (SE_KEY) params.set("key", SE_KEY);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    // Fetch question
    const qRes = await fetch(`${SE_API}/questions/${questionId}?${params}`, {
      signal: controller.signal,
      headers: { "Accept-Encoding": "gzip" },
    });
    if (!qRes.ok) throw new Error(`SE API error ${qRes.status}`);
    const qData = await qRes.json();
    const question = qData.items?.[0];
    if (!question) throw new Error("Question not found");

    let text = `# ${question.title}\n\n`;
    text += `**Tags:** ${(question.tags || []).join(", ")}\n`;
    text += `**Score:** ${question.score} | **Views:** ${question.view_count}\n\n`;
    text += `## Question\n\n${stripHtml(question.body || "")}\n\n`;

    // Fetch top 3 answers
    const aRes = await fetch(`${SE_API}/questions/${questionId}/answers?${params}&pagesize=3`, {
      signal: controller.signal,
      headers: { "Accept-Encoding": "gzip" },
    });
    if (aRes.ok) {
      const aData = await aRes.json();
      const answers = aData.items || [];
      for (let i = 0; i < answers.length; i++) {
        const a = answers[i];
        const accepted = a.is_accepted ? " ✓ Accepted" : "";
        text += `## Answer ${i + 1} (Score: ${a.score}${accepted})\n\n`;
        text += stripHtml(a.body || "") + "\n\n";
      }
    }

    if (text.length < 50) throw new Error("Extracted text too short");

    return { text, title: question.title };
  } finally {
    clearTimeout(timer);
  }
}
