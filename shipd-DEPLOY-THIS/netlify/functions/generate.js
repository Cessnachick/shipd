// netlify/functions/generate.js
// shipd generation endpoint WITH AGENT S2 (Bill Guard) built in.
// Protects your wallet: rate limits per visitor, blocks abuse, caps daily spend.
//
// Your API key lives ONLY in Netlify environment variables — never in the browser.
// Set these in Netlify -> Site settings -> Environment variables:
//   ANTHROPIC_API_KEY = your key
//   DAILY_GENERATION_CAP = 500      (max generations per day across everyone)
//   PER_VISITOR_DAILY_CAP = 5       (max per single visitor per day)
//   ALERT_WEBHOOK = (optional) a Make.com/Slack webhook URL for alerts

const { getStore } = require("@netlify/blobs"); // Netlify's built-in key-value store (free)

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return resp(405, { error: "Method not allowed" });
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return resp(500, { error: "Server not configured" });

  // ---- config (with safe defaults) ----
  const DAILY_CAP = parseInt(process.env.DAILY_GENERATION_CAP || "500", 10);
  const PER_VISITOR_CAP = parseInt(process.env.PER_VISITOR_DAILY_CAP || "5", 10);
  const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || "";

  // ---- parse input ----
  let body;
  try { body = JSON.parse(event.body); } catch { return resp(400, { error: "Bad request" }); }

  const content = (body.content || "").slice(0, 6000); // hard cap input size = caps token cost
  const audience = (body.audience || "your audience").slice(0, 200);
  const format = body.format || "auto";
  const refine = (body.refine || "").slice(0, 400);        // optional: "make it cheaper", "punchier title"
  const priorProduct = body.priorProduct || null;          // the last product, for refine context

  // ---- AGENT S2 - BILL GUARD ----

  // 1. Input sanity (block garbage/abuse that wastes tokens)
  if (content.length < 40) return resp(400, { error: "Please add a bit more content." });
  const uniqueChars = new Set(content.replace(/\s/g, "")).size;
  if (uniqueChars < 8) return resp(400, { error: "That doesn't look like real content." });

  // 2. Identify the visitor (IP-based, privacy-light - just for rate limiting)
  const ip = (event.headers["x-nf-client-connection-ip"] ||
              event.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let store;
  try { store = getStore("billguard"); } catch { store = null; }

  if (store) {
    try {
      // 3. Per-visitor daily cap
      const visitorKey = `v:${today}:${ip}`;
      const visitorCount = parseInt((await store.get(visitorKey)) || "0", 10);
      if (visitorCount >= PER_VISITOR_CAP) {
        return resp(429, { error: "You've hit today's free limit. Sign up to keep generating!", limit: true });
      }

      // 4. Global daily spend cap (protects your wallet)
      const dayKey = `total:${today}`;
      const dayCount = parseInt((await store.get(dayKey)) || "0", 10);
      if (dayCount >= DAILY_CAP) {
        await alert(ALERT_WEBHOOK, `shipd hit its DAILY CAP (${DAILY_CAP}). New generations paused for today. If this is real demand, raise DAILY_GENERATION_CAP.`);
        return resp(429, { error: "shipd is at capacity for today - check back tomorrow!", capped: true });
      }

      // 5. Increment counters BEFORE the call (so a flood can't slip through)
      await store.set(visitorKey, String(visitorCount + 1));
      await store.set(dayKey, String(dayCount + 1));

      // 6. Early-warning: ping you at 80% of daily cap
      if (dayCount + 1 === Math.floor(DAILY_CAP * 0.8)) {
        await alert(ALERT_WEBHOOK, `shipd at 80% of daily cap (${dayCount + 1}/${DAILY_CAP}). Healthy demand - watch your API spend.`);
      }
    } catch (e) {
      console.log("BillGuard store error:", e.message);
    }
  }

  // ---- generate ----
  const formatInstruction = format === "auto"
    ? "Choose the single best product format for this expertise."
    : "Prefer this product format: " + format + ".";

  // Multi-turn: if the user is refining a previous product, give the model that context.
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

Make 4-6 modules. Be specific to THEIR actual expertise - never generic.`;

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
    let text = (data.content || [])
      .filter(b => b.type === "text").map(b => b.text).join("")
      .replace(/```json/g, "").replace(/```/g, "").trim();

    let product;
    try { product = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) product = JSON.parse(m[0]); else throw new Error("parse");
    }
    return resp(200, product);
  } catch (err) {
    await alert(ALERT_WEBHOOK, `shipd generation error: ${err.message}. If this repeats, check the Anthropic API status / your key.`);
    return resp(500, { error: "Generation failed. Try again." });
  }
};

// ---- helpers ----
function resp(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
async function alert(webhook, message) {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message })
    });
  } catch { /* never let an alert failure break the app */ }
}
