# 🐾 Meadow Vet Care chatbot — Roadmap

Feature plan derived from a virtual user panel (busy professional, anxious
elderly owner, first-time puppy owner, exotic-pet owner, budget family,
emergency caller, rural client, and the clinic owner). Two features are
committed and specced below; the wider backlog follows.

**Legend:** Impact 🔥 high · Effort S/M/L · Theme-fit ★ = how well it extends the
"give the AI a live tool" (MCP) idea.

---

## ✅ Committed

### Feature 2 — Emergency detection & escalation  ·  Effort S  ·  ★★
**Status: building first (no external setup required).**

When a user describes an emergency, the bot leads with *"call/come in now"* + the
phone number, never prices or booking, and works even if the LLM is slow or the
brain endpoint is down.

**Design — two layers:**
1. **Client-side instant fast-path** (`app.js`): a deterministic detector runs the
   moment a message is sent. On a match it renders an **emergency card
   immediately** — no LLM round-trip — so the phone number appears instantly and
   *even offline / in demo mode*. This is the safety backstop.
2. **Server-side prompt reinforcement** (`api/vet-chat.js`): the system prompt
   gains an emergency rule + contact details, so Gemini escalates for the long
   tail of phrasings the client detector misses.

**Emergency taxonomy (high-precision):** poisoning (chocolate, grapes, xylitol,
rat poison, antifreeze, lily/cats, ibuprofen/paracetamol — requires an ingestion
verb to avoid "chocolate labrador" false positives), trauma (hit by car,
bleeding badly), airway (can't breathe, choking, blue gums), neuro (seizure,
collapse, unconscious), bloat/GDV, urinary blockage, heatstroke, whelping
difficulty, acute allergic swelling.

**False-positive guard:** pricing/booking phrasings ("how much is emergency
stabilisation", "book an emergency appointment") do **not** trigger the card.

**Emergency card (UI):** distinct alert block — ⚠️ header, tap-to-call `tel:`
button, out-of-hours line, directions link, 2–3 *universally safe* holding steps
only (no dosing / "induce vomiting"), and a "not a diagnosis" disclaimer.

**Config (placeholders in `config.js` → replace with the clinic's real values):**
`emergencyPhone`, out-of-hours arrangement, `address` / maps link.

**Milestones:** M1 config + card + styling · M2 detector + `handleSend`
short-circuit · M3 server prompt rule + false-positive tuning.

---

### Feature 1 — Appointment booking (Google Apps Script + Sheet, request→confirm)  ·  Effort L  ·  ★★★
**Status: built; goes live once the Apps Script Web App is deployed + wired.**

The flagship, and the first **write** path — the honest completion of "give the AI
a live tool": now it can *act*, not just look up. Bookings land in a **Bookings tab
in the same Google Sheet**, so staff manage them beside the service catalogue.

**Backend (chosen): Google Apps Script + Sheet, request→staff-confirm.**
- A **booking form-in-chat** (deterministic, works online *and* offline) collects
  service, pet, date → time slot, and contact.
- The form POSTs to a small Vercel function **`api/book.js`**, which holds the
  Apps Script secret and forwards the request. The browser never sees the token.
- A deployed **Apps Script Web App** appends a `requested` row to the Bookings tab,
  using **`LockService` + a conflict re-check** to prevent double-booking, and
  emails the clinic (and optionally the owner). Staff confirm from the sheet.

**Why no separate availability read:** the client shows candidate slots computed
from **clinic hours + Irish public holidays** (reuses the Feature-2/weather holiday
logic); the Apps Script is the source of truth and **rejects a clash on write**.
This avoids exposing a personal-data read endpoint.

**Customer flow:** booking intent → **booking form card** (service prefilled if
detected; pet name/species; date → time-slot chips; owner name + contact; consent
line) → submit → `api/book` → Apps Script append (conflict-checked) →
**confirmation card**: *"Requested ✅ Ref MVC-4821 — slot held; the clinic will
confirm by phone/text."*

**Security / privacy (EU/GDPR):** Apps Script URL + secret live only in Vercel env;
explicit submit action (no silent write); consent line; no personal data in URLs;
details stored only in the clinic's own sheet.

**Demo-mode degradation:** offline / no server → the form still works and shows
candidate slots, but submit is **simulated** with an honest "this is a demo — please
call to confirm" note (no write). Live mode writes for real.

**One-time setup (user):** add a **Bookings** tab → open **Extensions → Apps Script**,
paste `apps-script/Code.gs`, set a secret + sheet id → **Deploy → Web app** (execute
as you, access "Anyone") → copy the URL → set `APPSCRIPT_URL` + `APPSCRIPT_TOKEN` in
Vercel. (Full steps in `HOW-TO.md`.)

**Milestones (done):** M1 Apps Script + `api/book.js` · M2 booking form + slot
computation + demo simulate · M3 confirmation card + consent + emergency/booking
interlock. **Remaining (user):** deploy the Apps Script + set the two env vars.

---

## 🔭 Backlog (not yet committed)

| Feature | Panel voice | Impact | Effort | Theme |
|---|---|---|---|---|
| Pet profile + memory (name/species/age) | first-time owner | 🔥 | S | ★ |
| Cost estimator / package builder | puppy owner, budget family | 🔥 | M | ★★ |
| Proactive seasonal engagement (heat/flea/pollen nudges) | owner | 🔥 | M | ★★★ |
| Air-quality / pollen / tick-risk tool | (extends weather) | ◐ | S | ★★★ |
| Symptom triage (should-I-come-in, not diagnosis) | anxious owner | 🔥 | M | ★ |
| Directions & live travel time | rural client | ◐ | M | ★★★ |
| Multilingual (Polish, Gaeilge) | Polish family | ◐ | S | ★ |
| Lead / callback capture | clinic owner | 🔥(biz) | M | ★ |
| Repeat prescription request | elderly owner | ◐ | M | ★★ |
| Team / vet bios & trust content | exotic-pet owner | ◐ | S | ☆ |
| Question analytics | clinic owner | ◐(biz) | M | ★ |
| Data-quality guardrails (catch the €27M price bug) | clinic owner | ◐ | S | ★ |
| Quiet-slot / off-peak promotion | clinic owner | ◐ | S | ★★ |

---

## Inputs needed before shipping the committed features

**Feature 2:** clinic phone number · out-of-hours arrangement (in-house 24/7 vs
partner + hours) · address for the directions link.
*(Placeholders are in `config.js` in the meantime.)*

**Feature 1:** the 4 Google setup values (service-account JSON + calendar id) ·
confirm `google-auth-library` dependency is acceptable.
