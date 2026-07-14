// ─────────────────────────────────────────────────────────────────────────────
// Meadow Vet Care — chatbot configuration
// ─────────────────────────────────────────────────────────────────────────────
// The "live tool" the assistant is given (the MCP idea): a public Google Sheet
// that the clinic keeps up to date. Editing the sheet changes what the bot says.
//
// The AI brain runs server-side in the Vercel function at chatEndpoint, which
// holds the Gemini key. If that endpoint isn't reachable (e.g. opening the page
// as a plain file, or before deploy), the page falls back to a built-in
// demo responder so it always works.
// ─────────────────────────────────────────────────────────────────────────────

window.CONFIG = {
  clinicName: "Meadow Vet Care",

  // ── Emergency contact ─────────────────────────────────────────────────────
  // ⚠️ PLACEHOLDERS — replace with the clinic's real details. These power the
  // emergency-escalation card (Feature 2). "Meadow Vet Care" is a demo clinic,
  // so these are illustrative Irish values.
  emergency: {
    phoneDisplay: "(01) 555 0199",        // shown to the user
    phoneDial: "+35315550199",            // used in the tel: link (no spaces)
    // The live sheet lists 24/7 "Emergency stabilisation", so out-of-hours is
    // the same in-house line. Change if the clinic uses a partner OOH service.
    outOfHours: "Our emergency line is staffed 24/7 — call any time.",
    address: "Meadow Vet Care, 12 Meadow Lane, Dublin 2",
    // Directions link (Google Maps search by the address above).
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Meadow+Vet+Care+Dublin",
  },

  // Google Sheet holding the live service catalogue.
  sheet: {
    id: "1JhSODtviGHzXru6Eb5MhfXfVIF5vtJk3pclzzv7j2l4",
    gid: "1277715587",
  },

  // Where the AI brain lives. Set to the deployed Vercel URL so the page
  // always reaches the live brain, regardless of where the page itself is
  // opened from (Vercel, GitHub Pages, or a local file). Demo mode is then
  // only ever a true fallback (endpoint unreachable), not the default.
  // You can also override it at runtime from the ⚙️ settings dialog.
  chatEndpoint: "https://ceai-mcp-chatbot.vercel.app/api/vet-chat",

  // localStorage key for a runtime endpoint override.
  endpointStorageKey: "mvc_chat_endpoint",
};

// Convenience: the CORS-friendly CSV endpoint for the configured sheet.
window.CONFIG.sheetCsvUrl =
  `https://docs.google.com/spreadsheets/d/${window.CONFIG.sheet.id}` +
  `/gviz/tq?tqx=out:csv&gid=${window.CONFIG.sheet.gid}`;

window.CONFIG.sheetViewUrl =
  `https://docs.google.com/spreadsheets/d/${window.CONFIG.sheet.id}` +
  `/edit?gid=${window.CONFIG.sheet.gid}`;
