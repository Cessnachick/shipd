// netlify/functions/watchdog.js
// AGENT S1 — THE WATCHDOG
// Runs on a schedule. Checks shipd is alive + reports daily usage.
// Sends you ONE summary a day, and an immediate alert only if something is wrong.
//
// Set in Netlify environment variables:
//   SITE_URL = https://yourshipd.netlify.app   (your live site)
//   ALERT_WEBHOOK = your Make.com/Slack webhook (where you get pinged)
//   DAILY_GENERATION_CAP = 500  (same value as in generate.js)
//
// Schedule it in netlify.toml (already configured) to run once a day.

const { getStore } = require("@netlify/blobs");

exports.handler = async () => {
  const SITE_URL = process.env.SITE_URL || "";
  const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || "";
  const DAILY_CAP = parseInt(process.env.DAILY_GENERATION_CAP || "500", 10);

  let healthy = true;
  const notes = [];

  // 1. Is the site up?
  if (SITE_URL) {
    try {
      const res = await fetch(SITE_URL, { method: "GET" });
      if (res.ok) {
        notes.push(`Site: UP (${res.status})`);
      } else {
        healthy = false;
        notes.push(`Site: PROBLEM (status ${res.status})`);
      }
    } catch (e) {
      healthy = false;
      notes.push(`Site: DOWN (${e.message})`);
    }
  }

  // 2. How many generations today + yesterday?
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let todayCount = 0, yCount = 0;
  try {
    const store = getStore("billguard");
    todayCount = parseInt((await store.get(`total:${today}`)) || "0", 10);
    yCount = parseInt((await store.get(`total:${yesterday}`)) || "0", 10);
    notes.push(`Generations today: ${todayCount}/${DAILY_CAP}`);
    notes.push(`Yesterday: ${yCount}`);

    // flag if we're near the cap
    if (todayCount >= DAILY_CAP) {
      healthy = false;
      notes.push(`AT DAILY CAP — generations paused. Raise the cap if demand is real.`);
    } else if (todayCount >= DAILY_CAP * 0.8) {
      notes.push(`Near cap (80%+) — watch spend.`);
    }
  } catch (e) {
    notes.push(`Usage data unavailable: ${e.message}`);
  }

  // 3. Build the message
  const header = healthy ? "shipd daily check: ALL HEALTHY" : "shipd daily check: NEEDS ATTENTION";
  const message = `${header}\n` + notes.map(n => `- ${n}`).join("\n");

  // 4. Send it
  await alert(ALERT_WEBHOOK, message);

  return { statusCode: 200, body: JSON.stringify({ healthy, notes }) };
};

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
