// ─────────────────────────────────────────────────────────────────────────────
// Meadow Vet Care — AI brain (Vercel serverless function)
//
// The "MCP idea": this function hands Gemini THREE live tools instead of a
// frozen knowledge base:
//   1. The live service catalogue (fetched from the clinic's Google Sheet and
//      inlined as grounding context on every request — small enough to always
//      include, so simple questions never need a round-trip).
//   2. check_opening_hours — checks real Irish public holidays (Nager.Date)
//      against the clinic's normal hours, live, for any day the customer asks
//      about.
//   3. check_dog_walk_weather — checks the live current weather at the
//      clinic's location (Open-Meteo) and gives a walk-safety verdict.
// Gemini decides when to call (2) and (3) via real function calling; the
// Gemini API key lives only here, server-side.
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
//   CLINIC_LAT / CLINIC_LON (optional) override the clinic's weather location
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1JhSODtviGHzXru6Eb5MhfXfVIF5vtJk3pclzzv7j2l4/gviz/tq?tqx=out:csv&gid=1277715587";

const CLINIC_NAME = "Meadow Vet Care";
const DUBLIN_TZ = "Europe/Dublin";
// Emergency contact — keep in sync with CONFIG.emergency in config.js.
// Override via env for a real deployment.
const EMERGENCY_PHONE = (process.env.EMERGENCY_PHONE || "(01) 555 0199").trim();
const CLINIC_LAT = (process.env.CLINIC_LAT || "53.3498").trim();
const CLINIC_LON = (process.env.CLINIC_LON || "-6.2603").trim();

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

// ═══════════════════════════════════════════════════════════════════════════
// LIVE TOOL 1 — the service catalogue (inlined as grounding, see systemPrompt)
// ═══════════════════════════════════════════════════════════════════════════

// Minimal CSV parser (handles quoted fields, commas, embedded newlines).
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

// ═══════════════════════════════════════════════════════════════════════════
// LIVE TOOL 2 — check_opening_hours (Irish public holidays via Nager.Date)
// ═══════════════════════════════════════════════════════════════════════════

const OPEN_DAYS_LABEL = "Monday–Saturday, 09:00–18:00";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function ymdUTC(y, m, d) { return new Date(Date.UTC(y, m - 1, d, 12)); } // noon anchor avoids DST drift
function addDays(date, n) { return new Date(date.getTime() + n * 86400000); }
function isoDate(date) { return date.toISOString().slice(0, 10); }
function weekdayIndex(date) { return date.getUTCDay(); } // safe: date is noon-UTC anchored
function weekdayName(date) { return WEEKDAYS[weekdayIndex(date)][0].toUpperCase() + WEEKDAYS[weekdayIndex(date)].slice(1); }

function dublinToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DUBLIN_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => +parts.find((p) => p.type === t).value;
  return ymdUTC(get("year"), get("month"), get("day"));
}

// Module-level cache — Vercel reuses warm instances, so this saves repeat calls.
const holidayCache = new Map(); // year -> { ts, data }
const HOLIDAY_TTL_MS = 12 * 60 * 60 * 1000;

async function fetchYearHolidays(year) {
  const cached = holidayCache.get(year);
  if (cached && Date.now() - cached.ts < HOLIDAY_TTL_MS) return cached.data;
  const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/IE`);
  if (!res.ok) throw new Error("Public holiday API failed: HTTP " + res.status);
  const data = await res.json();
  holidayCache.set(year, { ts: Date.now(), data });
  return data;
}

async function fetchIrishHolidays(years) {
  const lists = await Promise.all(years.map(fetchYearHolidays));
  return lists.flat();
}

function matchHolidayFromText(text, holidays) {
  const t = text.toLowerCase().replace(/'/g, "").replace(/paddys/g, "patricks");
  for (const h of holidays) {
    for (const raw of [h.name, h.localName]) {
      if (!raw) continue;
      const words = raw.toLowerCase().replace(/'/g, "").replace(/\bday\b/g, "").trim()
        .split(/\s+/).filter((w) => w.length >= 4);
      if (words.length && words.every((w) => t.includes(w))) return h;
    }
  }
  return null;
}

function resolveDate(inputRaw, holidays) {
  const input = (inputRaw || "today").toLowerCase().trim();
  const today = dublinToday();
  const iso = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return ymdUTC(+iso[1], +iso[2], +iso[3]);
  if (/\btoday\b/.test(input)) return today;
  if (/\btomorrow\b/.test(input)) return addDays(today, 1);
  if (/\byesterday\b/.test(input)) return addDays(today, -1);
  const wd = WEEKDAYS.findIndex((w) => input.includes(w));
  if (wd !== -1) {
    let delta = (wd - weekdayIndex(today) + 7) % 7;
    if (/\bnext\b/.test(input) && delta === 0) delta = 7;
    return addDays(today, delta);
  }
  const h = matchHolidayFromText(input, holidays);
  if (h) { const [y, m, d] = h.date.split("-").map(Number); return ymdUTC(y, m, d); }
  return today;
}

async function checkOpeningHours(inputRaw) {
  const today = dublinToday();
  const years = [today.getUTCFullYear(), today.getUTCFullYear() + 1];
  const holidays = await fetchIrishHolidays(years);
  const date = resolveDate(inputRaw, holidays);
  const iso = isoDate(date);
  const wname = weekdayName(date);
  const isSunday = wname === "Sunday";
  const holiday = holidays.find((h) => h.date === iso && h.types && h.types.includes("Public"));
  const isOpen = !isSunday && !holiday;
  return {
    date: iso,
    weekday: wname,
    is_open: isOpen,
    normal_hours: OPEN_DAYS_LABEL,
    closed_reason: isSunday ? "Sundays are always closed" : holiday ? `${holiday.name} — Irish public holiday` : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE TOOL 3 — check_dog_walk_weather (Open-Meteo, no key required)
// ═══════════════════════════════════════════════════════════════════════════

const WEATHER_CODES = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "depositing rime fog",
  51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
  61: "slight rain", 63: "moderate rain", 65: "heavy rain",
  71: "slight snow", 73: "moderate snow", 75: "heavy snow",
  80: "rain showers", 81: "moderate rain showers", 82: "violent rain showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

function dogWalkVerdict(apparentC) {
  if (apparentC == null) return { verdict: "Unknown", advice: "Couldn't read the current temperature." };
  if (apparentC >= 28) return {
    verdict: "Too hot for a midday walk",
    advice: "Stick to early morning or late evening, keep it short, bring water, and press your hand on the pavement for 5 seconds — if it's too hot for you, it's too hot for paws. Watch for heavy panting or reluctance to walk.",
  };
  if (apparentC >= 23) return {
    verdict: "Caution — warm",
    advice: "A walk is fine but keep it shorter, stick to shade, bring water, and avoid roughly 11am–4pm.",
  };
  if (apparentC <= 2) return {
    verdict: "Cold",
    advice: "A normal walk is fine for most dogs, but small, short-coated, young or older dogs may appreciate a coat. Watch for shivering or paw sensitivity on gritted paths.",
  };
  return { verdict: "Good conditions for a walk", advice: "Nothing unusual — a normal walk should be comfortable." };
}

async function fetchDogWalkWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${CLINIC_LAT}&longitude=${CLINIC_LON}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code&timezone=Europe%2FDublin`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Weather API failed: HTTP " + res.status);
  const data = await res.json();
  const cur = data.current || {};
  const { verdict, advice } = dogWalkVerdict(cur.apparent_temperature);
  return {
    temperature_c: cur.temperature_2m,
    feels_like_c: cur.apparent_temperature,
    humidity_pct: cur.relative_humidity_2m,
    conditions: WEATHER_CODES[cur.weather_code] || "changeable conditions",
    observed_at: cur.time,
    verdict,
    advice,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool declarations + dispatch
// ═══════════════════════════════════════════════════════════════════════════

const TOOLS = [{
  functionDeclarations: [
    {
      name: "check_opening_hours",
      description:
        "Check whether Meadow Vet Care is open on a given day. Accounts for normal opening hours " +
        "(Monday-Saturday, 09:00-18:00, closed Sundays) and REAL Irish public holidays fetched live. " +
        "Call this for ANY question about whether the clinic is open, closed, or its hours on a specific " +
        "day, date, or holiday (e.g. 'are you open Monday?', 'are you open on Christmas Day?', " +
        "'are you closed tomorrow?'). Never guess — always call this tool.",
      parameters: {
        type: "object",
        properties: {
          day_or_date: {
            type: "string",
            description:
              "The day being asked about: a weekday name ('Monday'), a relative term " +
              "('today', 'tomorrow', 'next Friday'), an ISO date ('2026-12-25'), or a holiday name " +
              "('Christmas Day', 'Saint Patrick's Day'). Defaults to today if omitted.",
          },
        },
      },
    },
    {
      name: "check_dog_walk_weather",
      description:
        "Get the current live weather at the clinic's location in Ireland (temperature, feels-like " +
        "temperature, humidity, conditions) plus a dog-walking safety verdict and advice. Call this for " +
        "ANY question about current weather, heat, cold, or whether it's safe/comfortable to walk a pet " +
        "right now. Never guess the weather — always call this tool.",
      parameters: { type: "object", properties: {} },
    },
  ],
}];

async function dispatchTool(name, args) {
  if (name === "check_opening_hours") return checkOpeningHours(args && args.day_or_date);
  if (name === "check_dog_walk_weather") return fetchDogWalkWeather();
  return { error: "Unknown tool: " + name };
}

// ═══════════════════════════════════════════════════════════════════════════
// Gemini — system prompt, contents mapping, and the tool-use loop
// ═══════════════════════════════════════════════════════════════════════════

function systemPrompt(catalogueText, categories, species) {
  const today = dublinToday();
  return [
    `You are the friendly customer assistant for ${CLINIC_NAME}, a modern Irish veterinary clinic caring for dogs, cats, rabbits, small mammals and birds.`,
    ``,
    `Today's date in Ireland is ${isoDate(today)} (${weekdayName(today)}).`,
    ``,
    `*** SAFETY — EMERGENCIES COME FIRST ***`,
    `If the customer describes a possible emergency — e.g. poisoning (chocolate, grapes, xylitol, rat poison, antifreeze, lily for cats, human medicines), trauma (hit by car, heavy bleeding), difficulty breathing, choking, collapse, seizure, bloat / swollen hard belly, a cat unable to urinate, heatstroke, difficulty giving birth, or sudden severe swelling — then:`,
    `- Do NOT discuss prices, services or bookings.`,
    `- Lead immediately with: contact the clinic NOW on ${EMERGENCY_PHONE} (staffed 24/7). Tell them to call rather than wait for chat.`,
    `- Give only brief, universally safe guidance (keep the pet calm and warm; bring any packaging/sample; do not give food, water or medicine unless told to). Never give doses and never tell them to induce vomiting.`,
    `- Add that this is guidance, not a diagnosis.`,
    ``,
    `Answer non-emergency questions using ONLY live data:`,
    `- For services, prices, offers and availability: use ONLY the live service catalogue below. Never invent services, prices, offers, or availability.`,
    `- For whether the clinic is open/closed on any day, date, or holiday: ALWAYS call the check_opening_hours tool. Never guess — Irish public holidays change every year and this tool checks them live. Normal hours are ${OPEN_DAYS_LABEL_PLACEHOLDER}.`,
    `- For current weather, heat, cold, or whether it's safe to walk a pet right now: ALWAYS call the check_dog_walk_weather tool. Never guess the weather.`,
    ``,
    `Guidelines:`,
    `- Prices are in euro (€). Always mention price and, where useful, duration, weekly availability, and any current special offer.`,
    `- Be warm, concise and easy to scan: a short sentence, then a bullet list where helpful. Use **bold** for service names and key facts.`,
    `- If several species have the same service, focus on the pet the customer asked about.`,
    `- If something is not in the catalogue, say the clinic does not appear to offer it and suggest what they could ask instead.`,
    `- To book an appointment, tell the customer to say "book an appointment" (or tap the booking suggestion) — a short booking form opens. You do not take bookings yourself.`,
    `- For emergencies or specific medical advice, gently recommend booking an appointment or calling the clinic.`,
    ``,
    `Known categories: ${categories.join(", ")}.`,
    `Known species: ${species.join(", ")}.`,
    ``,
    `=== LIVE SERVICE CATALOGUE (fetched just now from the clinic's sheet) ===`,
    catalogueText,
    `=== END CATALOGUE ===`,
  ].join("\n").replace("OPEN_DAYS_LABEL_PLACEHOLDER", OPEN_DAYS_LABEL);
}

// Map the chat history from the browser to Gemini's contents format.
function toGeminiContents(messages) {
  const mapped = (messages || [])
    .filter((m) => m && m.content && (m.role === "user" || m.role === "assistant"))
    .slice(-12) // keep the last few turns
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content) }],
    }));
  // Gemini requires the conversation to begin with a user turn.
  while (mapped.length && mapped[0].role !== "user") mapped.shift();
  return mapped;
}

async function callGeminiRaw(contents, system) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${getModel()}:generateContent` +
    `?key=${encodeURIComponent(getApiKey())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      tools: TOOLS,
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error("Gemini API: " + msg);
  }
  return data;
}

// Runs the tool-use loop until Gemini returns a final text answer.
async function runConversation(initialContents, system) {
  const working = initialContents.slice();
  for (let step = 0; step < 4; step++) {
    const data = await callGeminiRaw(working, system);
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);

    if (!calls.length) {
      const text = parts.map((p) => p.text || "").join("").trim();
      if (!text) throw new Error("Gemini returned no text (possibly blocked or empty).");
      return text;
    }

    working.push({ role: "model", parts });
    const responses = [];
    for (const part of calls) {
      const { name, args, id } = part.functionCall;
      let response;
      try {
        response = await dispatchTool(name, args || {});
      } catch (err) {
        response = { error: err.message };
      }
      const fr = { name, response };
      if (id) fr.id = id;
      responses.push({ functionResponse: fr });
    }
    working.push({ role: "function", parts: responses });
  }
  throw new Error("That took too many steps to answer — could you rephrase your question?");
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

    const reply = await runConversation(
      toGeminiContents(messages),
      systemPrompt(text, categories, species)
    );

    return res.status(200).json({ reply, serviceCount: services.length });
  } catch (err) {
    console.error("vet-chat error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
