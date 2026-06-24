// src/index.js
// shipd — Cloudflare Worker
// Serves the landing page AND runs the real generation engine.
//
// Your Claude API key lives ONLY in Cloudflare (Settings -> Variables and secrets).
// It is read here as env.ANTHROPIC_API_KEY and never touches the browser.
//
// Optional wallet protection (Bill Guard): if you later add a KV namespace
// bound as BILLGUARD, this Worker will rate-limit per visitor and cap daily
// spend automatically. Until then it runs fine without it.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The engine endpoint the webpage calls.
    if (request.method === "POST" && url.pathname === "/api/generate") {
      return handleGenerate(request, env);
    }

    // Everything else = the static site (index.html, etc.)
    return env.ASSETS.fetch(request);
  }
};

async function handleGenerate(request, env) {
  const API_KEY = env.ANTHROPIC_API_KEY;
  if (!API_KEY) return json(500, { error: "Server not configured (missing API key)." });

  // ---- config (safe defaults) ----
  const DAILY_CAP = parseInt(env.DAILY_GENERATION_CAP || "500", 10);
  const PER_VISITOR_CAP = parseInt(env.PER_VISITOR_DAILY_CAP || "5", 10);
  const ALERT_WEBHOOK = env.ALERT_WEBHOOK || "";

  // ---- parse input ----
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Bad request" }); }

  const content = (body.content || "").slice(0, 6000); // caps token cost
  const audience = (body.audience || "your audience").slice(0, 200);
  const format = body.format || "auto";
  const refine = (body.refine || "").slice(0, 400);
  const priorProduct = body.priorProduct || null;

  // ---- Bill Guard: cheap input sanity (no storage needed) ----
  if (content.length < 40) return json(400, { error: "Please add a bit more content." });
  const uniqueChars = new Set(content.replace(/\s/g, "")).size;
  if (uniqueChars < 8) return json(400, { error: "That doesn't look like real content." });

  // ---- Bill Guard: optional KV rate limiting (only if BILLGUARD is bound) ----
  if (env.BILLGUARD) {
    try {
      const ip = (request.headers.get("CF-Connecting-IP") || "unknown").trim();
      const today = new Date().toISOString().slice(0, 10);

      const visitorKey = `v:${today}:${ip}`;
      const visitorCount = parseInt((await env.BILLGUARD.get(visitorKey)) || "0", 10);
      if (visitorCount >= PER_VISITOR_CAP) {
        return json(429, { error: "You've hit today's free limit. Sign up to keep generating!", limit: true });
      }

      const dayKey = `total:${today}`;
      const dayCount = parseInt((await env.BILLGUARD.get(dayKey)) || "0", 10);
      if (dayCount >= DAILY_CAP) {
        await alert(ALERT_WEBHOOK, `shipd hit its DAILY CAP (${DAILY_CAP}). Paused for today.`);
        return json(429, { error: "shipd is at capacity for today — check back tomorrow!", capped: true });
      }

      // count BEFORE the call so a flood can't slip through (expire after 2 days)
      await env.BILLGUARD.put(visitorKey, String(visitorCount + 1), { expirationTtl: 172800 });
      await env.BILLGUARD.put(dayKey, String(dayCount + 1), { expirationTtl: 172800 });

      if (dayCount + 1 === Math.floor(DAILY_CAP * 0.8)) {
        await alert(ALERT_WEBHOOK, `shipd at 80% of daily cap (${dayCount + 1}/${DAILY_CAP}).`);
      }
    } catch (e) {
      // never let the guard break the app
    }
  }

  // ---- build the prompt ----
  const formatInstruction = format === "auto"
    ? "Choose the single best product format for this expertise."
    : "Prefer this product format: " + format + ".";

  const refineBlock = (refine && priorProduct)
    ? `\n\nThe creator already generated this product:\n${JSON.stringify(priorProduct)}\n\nThey want this change: "${refine}"\nReturn the SAME product with that change applied. Keep everything else that was working.`
    : "";

  const prompt = `You are a product strategist for creators. A creator has pasted their content below. Turn it into ONE concrete, sellable digital product they could launch this week.

CREATOR'S CONTENT:
"""${content}"""

THEIR AUDIENCE: ${audience}
${formatInstruction}${refineBlock}

Respond ONLY with valid JSON, no markdown, no backticks, in exactly this shape:
{
  "productName": "punchy, specific product title (not generic)",
  "productType": "e.g. Digital Playbook, Notion Template, Mini-Course",
  "price": "suggested price as a string like '$47' with a 1-sentence justification after a dash",
  "oneLiner": "one sentence describing the transformation the buyer gets",
  "whoFor": "one short sentence on exactly who should buy this",
  "modules": [{"title": "section name", "desc": "one line on what's inside"}],
  "salesCopy": "3-4 sentences of landing-page sales copy in a warm, direct, no-hype voice.",
  "whereToSell": ["2-3 specific channels with a short why for each"]
}

Make 4-6 modules. Be specific to THEIR actual expertise — never generic.`;

  // ---- call Claude ----
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await r.json();

    if (!r.ok) {
      await alert(ALERT_WEBHOOK, `shipd API error ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
      return json(500, { error: "Generation failed. Try again." });
    }

    let text = (data.content || [])
      .filter(b => b.type === "text").map(b => b.text).join("")
      .replace(/```json/g, "").replace(/```/g, "").trim();

    let product;
    try { product = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) product = JSON.parse(m[0]); else throw new Error("parse");
    }
    return json(200, product);
  } catch (err) {
    await alert(ALERT_WEBHOOK, `shipd generation error: ${err.message}`);
    return json(500, { error: "Generation failed. Try again." });
  }
}

// ---- helpers ----
function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
async function alert(webhook, message) {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message })
    });
  } catch { /* ignore */ }
}
