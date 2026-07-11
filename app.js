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
  ];

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

    const trace = showToolTrace("Checking the live catalogue…");
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
        answerHtml = demoAnswer(q);
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
