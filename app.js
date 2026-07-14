/* ───────────────────────────────────────────────────────────────────────────
   Meadow Vet Care chatbot — front end

   Flow:
     1. Live data  — fetch the clinic's Google Sheet as CSV in the browser (for
                     the "N services loaded" indicator and the offline demo brain).
     2. AI brain   — POST the conversation to the Vercel function at
                     CONFIG.chatEndpoint. That function fetches the live sheet
                     server-side and asks Gemini (its key stays server-side).
     3. Fallback   — if the endpoint isn't reachable (opened as a plain file,
                     not deployed yet, offline), a built-in demo responder answers
                     from the same live sheet so the page always works.
   ─────────────────────────────────────────────────────────────────────────── */

(() => {
  "use strict";
  const CFG = window.CONFIG;

  // ── State ─────────────────────────────────────────────────────────────────
  let services = [];          // parsed live catalogue (for the demo brain)
  let categories = [];
  let speciesList = [];
  let history = [];           // [{role:'user'|'assistant', content:string}]
  let busy = false;
  let brainOnline = null;     // null=unknown, true=Gemini reachable, false=demo

  // ── DOM ───────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const els = {
    messages: $("messages"), intro: $("intro"), suggestions: $("suggestions"),
    input: $("input"), send: $("send"),
    dataDot: $("dataDot"), dataLabel: $("dataLabel"), serviceCount: $("serviceCount"),
    refreshLink: $("refreshLink"),
    settingsBtn: $("settingsBtn"), scrim: $("scrim"), modeLabel: $("modeLabel"),
    endpoint: $("endpoint"), saveEndpoint: $("saveEndpoint"), resetEndpoint: $("resetEndpoint"),
  };

  const SUGGESTIONS = [
    "What dog services do you offer?",
    "Any offers on microchipping?",
    "Do you have telehealth services?",
    "How much is a dental cleaning for a cat?",
    "What can you do for rabbits?",
    "Are you open Monday?",
    "Is it too hot to walk my dog right now?",
  ];

  // Clinic constants shared with api/vet-chat.js (kept in sync manually —
  // separate runtimes, same values).
  const CLINIC_LAT = 53.3498, CLINIC_LON = -6.2603, DUBLIN_TZ = "Europe/Dublin";
  const OPEN_DAYS_LABEL = "Monday–Saturday, 09:00–18:00";

  function endpoint() {
    return (localStorage.getItem(CFG.endpointStorageKey) || CFG.chatEndpoint).trim();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. LIVE DATA
  // ═══════════════════════════════════════════════════════════════════════════
  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function toServices(rows) {
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim());
    return rows.slice(1)
      .filter((r) => r.some((c) => c && c.trim()))
      .map((r) => {
        const o = {};
        header.forEach((h, i) => { if (h) o[h] = (r[i] || "").trim(); });
        o.price_eur = Number(o.price_eur) || 0;
        o.duration_min = Number(o.duration_min) || 0;
        o.slots_this_week = Number(o.slots_this_week) || 0;
        return o;
      })
      .filter((o) => o.service_name);
  }

  async function loadData() {
    setStatus("loading", "Loading live data…");
    try {
      const res = await fetch(CFG.sheetCsvUrl, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      services = toServices(parseCsv(await res.text()));
      if (!services.length) throw new Error("No rows");
      categories = [...new Set(services.map((s) => s.category).filter(Boolean))].sort();
      speciesList = [...new Set(services.map((s) => s.species).filter(Boolean))].sort();
      setStatus("live", "Live data connected");
      els.serviceCount.textContent = services.length;
    } catch (err) {
      console.error("Live data load failed:", err);
      setStatus("error", "Live data unavailable");
      els.serviceCount.textContent = "0";
    }
  }

  function setStatus(kind, label) {
    els.dataDot.className = "dot " + kind;
    els.dataLabel.textContent = label;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. THE LIVE TOOL — search_services() (used by the demo brain)
  // ═══════════════════════════════════════════════════════════════════════════
  function searchServices({ species, category, keyword, special_offers_only } = {}) {
    const norm = (s) => (s || "").toString().toLowerCase().trim();
    const kw = norm(keyword);
    const out = services.filter((s) => {
      if (species && norm(s.species) !== norm(species)) {
        if (!norm(s.species).includes(norm(species).replace(/s$/, ""))) return false;
      }
      if (category && norm(s.category) !== norm(category)) return false;
      if (special_offers_only && !s.special_offer) return false;
      if (kw) {
        const hay = norm(s.service_name) + " " + norm(s.description) + " " +
                    norm(s.category) + " " + norm(s.special_offer);
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    return out.map((s) => ({
      service: s.service_name, category: s.category, species: s.species,
      price_eur: s.price_eur, duration_min: s.duration_min,
      requires_appointment: s.requires_appointment, availability: s.availability,
      slots_this_week: s.slots_this_week, special_offer: s.special_offer || null,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3a. BRAIN — Gemini via the Vercel endpoint
  // ═══════════════════════════════════════════════════════════════════════════
  async function askBrain(question) {
    history.push({ role: "user", content: question });
    const res = await fetch(endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    const reply = (data.reply || "").trim();
    if (!reply) throw new Error("Empty reply from brain.");
    history.push({ role: "assistant", content: reply });
    return reply;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3b. BRAIN — built-in demo responder (no server). Uses the SAME live tool.
  // ═══════════════════════════════════════════════════════════════════════════
  const CATEGORY_HINTS = [
    [/dental|teeth|tooth|clean(ing)?|scal|polish/, "Dental"],
    [/groom|nail|clip|bath|coat|de.?shed|fur/, "Grooming"],
    [/vaccin|jab|booster|shot|immun/, "Vaccination"],
    [/microchip|chip|id\b|identif/, "Microchip & ID"],
    [/surg|neuter|spay|castrat|operat|lump removal/, "Surgery"],
    [/emergenc|urgent|out.?of.?hours|a&e/, "Emergency"],
    [/diagnos|x.?ray|blood|scan|ultrasound|test|lab/, "Diagnostics"],
    [/nutrition|diet|weight|food|feeding/, "Nutrition"],
    [/behaviour|behavior|anxiety|training|aggress/, "Behaviour"],
    [/end.?of.?life|euthan|palliat|cremat/, "End-of-life"],
    [/preventive|prevention|worm|flea|parasite|check.?up|wellness|health check/, "Preventive"],
    [/consult|appointment|see (a|the) vet|advice/, "Consultation"],
  ];
  const SPECIES_HINTS = [
    [/\bdogs?\b|\bpupp/, "Dog"], [/\bcats?\b|\bkitten/, "Cat"],
    [/\brabbits?\b|\bbunn/, "Rabbit"], [/\bbirds?\b|\bparrot|\bbudgie/, "Bird"],
    [/small mammal|guinea|hamster|ferret|gerbil/, "Small mammal"],
  ];

  function interpret(q) {
    const t = q.toLowerCase();
    const args = {};
    for (const [re, sp] of SPECIES_HINTS) if (re.test(t)) { args.species = sp; break; }
    for (const [re, cat] of CATEGORY_HINTS) if (re.test(t)) { args.category = cat; break; }
    if (/\boffers\b|discount|\bdeals?\b|promo|\bsale\b|%\s?off|special offer|offer on|on offer|any offer/.test(t)) args.special_offers_only = true;
    if (/telehealth|video|online|remote|virtual/.test(t)) { args.keyword = "telehealth"; delete args.category; }
    return args;
  }

  function fmtPrice(n) { return "€" + Number(n).toLocaleString("en-IE"); }

  function demoAnswer(q) {
    const args = interpret(q);
    let results = searchServices(args);
    let relaxedToSpecies = false;
    if (!results.length && args.special_offers_only && args.category) {
      const relaxed = { ...args }; delete relaxed.category;
      results = searchServices(relaxed);
    }
    // Species matched but that category/keyword didn't — show what we do have.
    if (!results.length && args.species && (args.category || args.keyword)) {
      results = searchServices({ species: args.species });
      if (results.length) { relaxedToSpecies = true; delete args.category; delete args.keyword; delete args.special_offers_only; }
    }

    if (!results.length) {
      const hasFilter = args.species || args.category || args.keyword || args.special_offers_only;
      return hasFilter
        ? `I couldn't find anything matching that in our current catalogue. We do offer <strong>${categories.join(", ")}</strong> services — try asking about one of those, or ring the clinic and we'll be glad to help. 🐾`
        : `I can help with any of our ${services.length} services — pricing, availability and offers. Try asking, for example, “What dog services do you offer?” or “Any offers on microchipping?”`;
    }

    const byName = new Map();
    for (const r of results) {
      const key = r.service + "|" + (args.species ? "" : r.species);
      if (!byName.has(key)) byName.set(key, r);
    }
    const list = [...byName.values()].slice(0, 12);
    const offers = list.filter((r) => r.special_offer);

    let intro;
    if (relaxedToSpecies) intro = `I couldn’t find that exact service, but here’s what we offer for ${args.species.toLowerCase()}s:`;
    else if (args.special_offers_only) intro = `Yes! Here’s what currently has an offer${args.species ? ` for ${args.species.toLowerCase()}s` : ""}${args.keyword ? ` on ${args.keyword}` : ""}:`;
    else if (args.keyword === "telehealth") intro = `Yes — we offer telehealth video consultations. Here’s what’s available:`;
    else if (args.category && args.species) intro = `Here’s our ${args.category.toLowerCase()} care for ${args.species.toLowerCase()}s:`;
    else if (args.category) intro = `Here’s our ${args.category.toLowerCase()} range:`;
    else if (args.species) intro = `Here are services we offer for ${args.species.toLowerCase()}s:`;
    else intro = `Here’s what I found:`;

    const items = list.map((r) => {
      const bits = [`<strong>${r.service}</strong>`];
      if (!args.species) bits.push(`(${r.species})`);
      bits.push(`— ${fmtPrice(r.price_eur)}`);
      if (r.duration_min) bits.push(`· ${r.duration_min} min`);
      if (r.availability) bits.push(`· ${r.availability}`);
      if (r.special_offer) bits.push(`· <strong>🎉 ${r.special_offer}</strong>`);
      return `<li>${bits.join(" ")}</li>`;
    }).join("");

    let outro = "";
    if (!args.special_offers_only && offers.length) {
      outro = `<p>💡 ${offers.length} of these currently ${offers.length === 1 ? "has an offer" : "have offers"} on.</p>`;
    }
    const more = results.length > list.length
      ? `<p>…and more. Ask me to narrow it down by pet or type of care.</p>` : "";

    return `<p>${intro}</p><ul>${items}</ul>${outro}${more}` +
      `<p style="color:var(--muted);font-size:13px">Appointments and prices are pulled live from our catalogue. Want me to check availability or book you in?</p>`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3c. BRAIN — opening hours (live Irish public holidays) & weather (live)
  //     Demo-mode equivalents of the two tools Gemini calls server-side, so
  //     the page answers these the same way whether the AI brain is up or not.
  // ═══════════════════════════════════════════════════════════════════════════
  const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  function ymdUTC(y, m, d) { return new Date(Date.UTC(y, m - 1, d, 12)); } // noon anchor avoids DST drift
  function addDays(date, n) { return new Date(date.getTime() + n * 86400000); }
  function isoDate(date) { return date.toISOString().slice(0, 10); }
  function weekdayIndex(date) { return date.getUTCDay(); }
  function weekdayName(date) { const w = WEEKDAYS[weekdayIndex(date)]; return w[0].toUpperCase() + w.slice(1); }

  function dublinToday() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: DUBLIN_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const get = (t) => +parts.find((p) => p.type === t).value;
    return ymdUTC(get("year"), get("month"), get("day"));
  }

  const holidayCacheClient = new Map(); // year -> Promise<data>
  function fetchYearHolidaysClient(year) {
    if (!holidayCacheClient.has(year)) {
      holidayCacheClient.set(year, fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/IE`)
        .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }));
    }
    return holidayCacheClient.get(year);
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
    const iso = input.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return ymdUTC(+iso[1], +iso[2], +iso[3]);
    if (/\btomorrow\b/.test(input)) return addDays(today, 1);
    if (/\byesterday\b/.test(input)) return addDays(today, -1);
    if (/\btoday\b/.test(input)) return today;
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

  function isOpeningHoursQuery(t) {
    return /\b(open|opening|closed|closing|hours?)\b/.test(t);
  }

  async function openingHoursAnswer(q) {
    try {
      const today = dublinToday();
      const years = [today.getUTCFullYear(), today.getUTCFullYear() + 1];
      const holidays = (await Promise.all(years.map(fetchYearHolidaysClient))).flat();
      const date = resolveDate(q, holidays);
      const iso = isoDate(date);
      const wname = weekdayName(date);
      const isSunday = wname === "Sunday";
      const holiday = holidays.find((h) => h.date === iso && h.types && h.types.includes("Public"));
      const isOpen = !isSunday && !holiday;
      const nice = date.toLocaleDateString("en-IE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

      if (isOpen) return `<p>Yes — we're <strong>open</strong> on ${nice}, ${OPEN_DAYS_LABEL.split(", ")[1]}. 🐾</p>`;
      const reason = isSunday ? "we're closed on Sundays" : `it's <strong>${holiday.name}</strong>, an Irish public holiday`;
      return `<p>We're <strong>closed</strong> on ${nice} — ${reason}.</p>` +
        `<p style="color:var(--muted);font-size:13px">Normal hours: ${OPEN_DAYS_LABEL}.</p>`;
    } catch (err) {
      console.error("Opening-hours check failed:", err);
      return `<p>Sorry, I couldn't check the calendar just now. Our normal hours are ${OPEN_DAYS_LABEL}, closed Sundays and Irish public holidays.</p>`;
    }
  }

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
      advice: "Stick to early morning or late evening, keep it short, bring water, and press your hand on the pavement for 5 seconds — if it's too hot for you, it's too hot for paws.",
    };
    if (apparentC >= 23) return {
      verdict: "Caution — warm",
      advice: "A walk is fine but keep it shorter, stick to shade, bring water, and avoid roughly 11am–4pm.",
    };
    if (apparentC <= 2) return {
      verdict: "Cold",
      advice: "A normal walk is fine for most dogs, but small, short-coated, young or older dogs may appreciate a coat.",
    };
    return { verdict: "Good conditions for a walk", advice: "Nothing unusual — a normal walk should be comfortable." };
  }

  function isWeatherQuery(t) {
    return /\b(weather|too hot|too cold|walk (my|the|a) dog|safe to walk|temperature|feels like|is it hot|is it cold)\b/.test(t);
  }

  async function weatherAnswer() {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${CLINIC_LAT}&longitude=${CLINIC_LON}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code&timezone=Europe%2FDublin`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const cur = data.current || {};
      const { verdict, advice } = dogWalkVerdict(cur.apparent_temperature);
      const conditions = WEATHER_CODES[cur.weather_code] || "changeable conditions";
      return `<p>Right now it's <strong>${cur.temperature_2m}°C</strong> (feels like ${cur.apparent_temperature}°C), ${conditions}, ${cur.relative_humidity_2m}% humidity.</p>` +
        `<p><strong>${verdict}.</strong> ${advice}</p>`;
    } catch (err) {
      console.error("Weather check failed:", err);
      return `<p>Sorry, I couldn't reach the live weather data just now — please check a weather app before heading out. 🐾</p>`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. CHAT UI
  // ═══════════════════════════════════════════════════════════════════════════
  function addMessage(role, html) {
    if (els.intro) { els.intro.remove(); els.intro = null; }
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    const avatar = role === "assistant" ? "🐾" : "🧑";
    wrap.innerHTML = `<div class="avatar">${avatar}</div><div class="bubble">${html}</div>`;
    els.messages.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function showToolTrace(label) {
    const el = document.createElement("div");
    el.className = "tool-trace";
    el.innerHTML = `<span class="spark">⚡</span> ${label}`;
    els.messages.appendChild(el);
    scrollDown();
    return el;
  }

  function showTyping() {
    const el = document.createElement("div");
    el.className = "msg assistant"; el.id = "typing";
    el.innerHTML = `<div class="avatar">🐾</div><div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
    els.messages.appendChild(el);
    scrollDown();
  }
  function hideTyping() { const t = $("typing"); if (t) t.remove(); }
  function scrollDown() { els.messages.scrollTop = els.messages.scrollHeight; }

  // Light markdown → HTML for model replies (bold, bullets, paragraphs).
  function mdToHtml(md) {
    const esc = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const lines = esc.split("\n");
    let html = "", inList = false;
    for (let line of lines) {
      line = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
      if (/^\s*[-*•]\s+/.test(line)) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + line.replace(/^\s*[-*•]\s+/, "") + "</li>";
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        if (line.trim()) html += "<p>" + line + "</p>";
      }
    }
    if (inList) html += "</ul>";
    return html || "<p></p>";
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function setMode(online) {
    brainOnline = online;
    els.modeLabel.textContent = online ? "AI connected" : "Demo mode";
  }

  async function handleSend(text) {
    if (busy) return;
    const q = (text || els.input.value).trim();
    if (!q) return;
    if (!services.length) {
      addMessage("user", escapeHtml(q));
      addMessage("assistant", "One moment — I'm still connecting to the live catalogue. Please try again in a second. 🐾");
      return;
    }
    busy = true; els.send.disabled = true;
    els.input.value = ""; autosize();
    addMessage("user", escapeHtml(q));

    const trace = showToolTrace("Checking live data…");
    showTyping();

    try {
      // Try the real AI brain first; fall back to the demo responder.
      let answerHtml, online;
      try {
        const reply = await askBrain(q);
        answerHtml = mdToHtml(reply);
        online = true;
      } catch (err) {
        console.warn("Brain endpoint unavailable, using demo responder:", err.message);
        history.pop(); // drop the user turn we optimistically pushed
        await new Promise((r) => setTimeout(r, 250));
        const t = q.toLowerCase();
        if (isOpeningHoursQuery(t)) answerHtml = await openingHoursAnswer(q);
        else if (isWeatherQuery(t)) answerHtml = await weatherAnswer();
        else answerHtml = demoAnswer(q);
        online = false;
      }
      hideTyping();
      setMode(online);
      addMessage("assistant", answerHtml);
    } catch (err) {
      hideTyping();
      console.error(err);
      addMessage("assistant", `<p>Sorry — something went wrong: <code>${escapeHtml(err.message)}</code></p>`);
    } finally {
      if (trace) trace.remove();
      busy = false; els.send.disabled = false; els.input.focus();
    }
  }

  // ── Settings modal (optional endpoint override) ────────────────────────────
  function openSettings() { els.endpoint.value = endpoint(); els.scrim.classList.add("open"); }
  function closeSettings() { els.scrim.classList.remove("open"); }

  // ── Composer autosize ──────────────────────────────────────────────────────
  function autosize() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 140) + "px";
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. WIRE UP
  // ═══════════════════════════════════════════════════════════════════════════
  function init() {
    SUGGESTIONS.forEach((s) => {
      const b = document.createElement("button");
      b.className = "chip"; b.textContent = s;
      b.onclick = () => handleSend(s);
      els.suggestions.appendChild(b);
    });

    els.send.onclick = () => handleSend();
    els.input.addEventListener("input", autosize);
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });

    els.refreshLink.onclick = (e) => { e.preventDefault(); loadData(); };

    els.settingsBtn.onclick = openSettings;
    els.scrim.onclick = (e) => { if (e.target === els.scrim) closeSettings(); };
    els.saveEndpoint.onclick = () => {
      const v = els.endpoint.value.trim();
      if (v) localStorage.setItem(CFG.endpointStorageKey, v);
      else localStorage.removeItem(CFG.endpointStorageKey);
      history = [];
      closeSettings();
    };
    els.resetEndpoint.onclick = () => {
      localStorage.removeItem(CFG.endpointStorageKey);
      els.endpoint.value = CFG.chatEndpoint;
      history = [];
    };

    loadData();
    els.input.focus();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
