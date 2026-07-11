// ─────────────────────────────────────────────────────────────────────────────
// Meadow Vet Care — AI brain (Vercel serverless function)
//
// The "MCP idea": on EVERY request this function reaches out to the clinic's
// live Google Sheet, pulls the current catalogue, and hands it to Gemini as
// grounding. Edit the sheet and the answers change — the model is never guessing
// from a frozen copy. The Gemini API key lives here, server-side, so it is never
// exposed to the browser.
//
// Works unchanged as:
//   • a root  /api/vet-chat.js          (any Vercel project, incl. Next.js)
//   • Next.js Pages Router  pages/api/vet-chat.js
// For the Next.js App Router variant, see HOW-TO.md.
//
// Environment variables (set in Vercel → Project → Settings → Environment):
//   GEMINI_API_KEY   (required)  your Google AI Studio / Gemini key
//                    also accepts GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
//   GEMINI_MODEL     (optional)  defaults to "gemini-2.5-flash"
//   SHEET_CSV_URL    (optional)  overrides the default live sheet
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1JhSODtviGHzXru6Eb5MhfXfVIF5vtJk3pclzzv7j2l4/gviz/tq?tqx=out:csv&gid=1277715587";

const CLINIC_NAME = "Meadow Vet Care";

function getApiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.API_KEY ||
    ""
  ).trim();
}
function getModel() {
  return (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
}
function getSheetUrl() {
  return (process.env.SHEET_CSV_URL || DEFAULT_SHEET_CSV_URL).trim();
}

// ── Minimal CSV parser (handles quoted fields, commas, embedded newlines) ────
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchCatalogue() {
  const res = await fetch(getSheetUrl(), { cache: "no-store" });
  if (!res.ok) throw new Error("Sheet fetch failed: HTTP " + res.status);
  const rows = parseCsv(await res.text());
  if (!rows.length) return { services: [], text: "" };
  const header = rows[0].map((h) => h.trim());
  const services = rows.slice(1)
    .filter((r) => r.some((c) => c && c.trim()))
    .map((r) => {
      const o = {};
      header.forEach((h, i) => { if (h) o[h] = (r[i] || "").trim(); });
      return o;
    })
    .filter((o) => o.service_name);

  // Compact one-line-per-service grounding text.
  const text = services.map((s) => {
    const bits = [
      s.service_name,
      s.category,
      s.species,
      "€" + (s.price_eur || "?"),
      (s.duration_min || "?") + "min",
      "appointment:" + (s.requires_appointment || "?"),
      s.availability || "",
      "slots_this_week:" + (s.slots_this_week ?? "?"),
    ];
    if (s.special_offer) bits.push("OFFER:" + s.special_offer);
    return "- " + bits.filter(Boolean).join(" | ");
  }).join("\n");

  return { services, text };
}

function systemPrompt(catalogueText, categories, species) {
  return [
    `You are the friendly customer assistant for ${CLINIC_NAME}, a modern Irish veterinary clinic caring for dogs, cats, rabbits, small mammals and birds.`,
    ``,
    `Answer customer questions using ONLY the live service catalogue below. Never invent services, prices, offers, or availability. If something is not in the catalogue, say the clinic does not appear to offer it and suggest what they could ask instead.`,
    ``,
    `Guidelines:`,
    `- Prices are in euro (€). Always mention price and, where useful, duration, weekly availability, and any current special offer.`,
    `- Be warm, concise and easy to scan: a short sentence, then a bullet list. Use **bold** for service names.`,
    `- If several species have the same service, focus on the pet the customer asked about.`,
    `- For emergencies or specific medical advice, gently recommend booking an appointment or calling the clinic.`,
    ``,
    `Known categories: ${categories.join(", ")}.`,
    `Known species: ${species.join(", ")}.`,
    ``,
    `=== LIVE SERVICE CATALOGUE (fetched just now from the clinic's sheet) ===`,
    catalogueText,
    `=== END CATALOGUE ===`,
  ].join("\n");
}

// Map the chat history from the browser to Gemini's contents format.
function toGeminiContents(messages) {
  return (messages || [])
    .filter((m) => m && m.content && (m.role === "user" || m.role === "assistant"))
    .slice(-12) // keep the last few turns
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content) }],
    }));
}

async function callGemini(contents, system) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${getModel()}:generateContent` +
    `?key=${encodeURIComponent(getApiKey())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error("Gemini API: " + msg);
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no text (possibly blocked or empty).");
  return text;
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS — allow the chat UI to call this from anywhere (read-only FAQ).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  try {
    if (!getApiKey()) {
      return res.status(500).json({
        error: "No Gemini API key configured. Set GEMINI_API_KEY in the Vercel project settings.",
      });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return res.status(400).json({ error: "No messages provided." });

    const { services, text } = await fetchCatalogue();
    if (!services.length) throw new Error("The live catalogue came back empty.");

    const categories = [...new Set(services.map((s) => s.category).filter(Boolean))].sort();
    const species = [...new Set(services.map((s) => s.species).filter(Boolean))].sort();

    const reply = await callGemini(
      toGeminiContents(messages),
      systemPrompt(text, categories, species)
    );

    return res.status(200).json({ reply, serviceCount: services.length });
  } catch (err) {
    console.error("vet-chat error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
