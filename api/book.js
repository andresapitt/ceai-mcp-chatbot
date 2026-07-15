// ─────────────────────────────────────────────────────────────────────────────
// Meadow Vet Care — booking relay (Vercel serverless function)
//
// The booking form in the browser POSTs here. This function holds the Apps
// Script secret (so the browser never sees it), validates the payload, and
// forwards the request to the Apps Script Web App, which writes a "requested"
// row to the Bookings tab (with a conflict check) and returns a reference.
//
// Environment variables (Vercel → Project → Settings → Environment):
//   APPSCRIPT_URL    (required)  the deployed Apps Script Web App URL
//   APPSCRIPT_TOKEN  (required)  the shared secret (== SECRET in Code.gs)
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED = ["service_name", "date", "time", "pet_name", "owner_name", "contact"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST." });

  const url = (process.env.APPSCRIPT_URL || "").trim();
  const token = (process.env.APPSCRIPT_TOKEN || "").trim();
  if (!url || !token) {
    return res.status(500).json({
      ok: false,
      error: "Booking isn't configured yet. Set APPSCRIPT_URL and APPSCRIPT_TOKEN in Vercel.",
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    for (const f of REQUIRED) {
      if (!body[f] || !String(body[f]).trim()) {
        return res.status(400).json({ ok: false, error: "Missing " + f });
      }
    }

    // Basic contact sanity check (phone or email).
    const contact = String(body.contact).trim();
    const looksOk = /@/.test(contact) || /\d{7,}/.test(contact.replace(/\D/g, ""));
    if (!looksOk) return res.status(400).json({ ok: false, error: "Please give a valid phone or email." });

    const payload = {
      token,
      service_id: body.service_id || "",
      service_name: String(body.service_name).trim(),
      date: String(body.date).trim(),
      time: String(body.time).trim(),
      duration_min: body.duration_min || "",
      pet_name: String(body.pet_name).trim(),
      species: body.species || "",
      owner_name: String(body.owner_name).trim(),
      contact,
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow", // Apps Script Web Apps 302 to a script.googleusercontent.com host
    });
    const data = await r.json().catch(() => ({ ok: false, error: "Bad response from booking store." }));

    if (data.ok) return res.status(200).json({ ok: true, ref: data.ref });
    if (data.error === "slot_taken") {
      return res.status(409).json({ ok: false, error: "slot_taken" });
    }
    return res.status(502).json({ ok: false, error: data.error || "Booking failed." });
  } catch (err) {
    console.error("book error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
}
