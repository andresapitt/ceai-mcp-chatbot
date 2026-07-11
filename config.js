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
