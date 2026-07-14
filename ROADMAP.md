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

### Feature 1 — Appointment booking (Google Calendar, request→confirm)  ·  Effort L  ·  ★★★
**Status: planned; blocked on Google Cloud setup + contact details.**

The flagship, and the first **write** tool — the honest completion of "give the AI
a live tool": now it can *act*, not just look up.

**Backend (chosen): Google Calendar API, request→staff-confirm.**
- Dedicated clinic Google Calendar. Bot **reads** free/busy to offer real slots,
  and **writes** each request as a **tentative** event staff confirm from their
  normal calendar app. Tentative events count as busy → act as a **soft hold** so
  two people can't request the same slot.
- **Auth (headless):** a Google Cloud **service account**; the clinic shares its
  calendar with the service-account email ("Make changes to events"). The
  function mints a short-lived token (JWT → Google token endpoint).
- **Dependency note:** introduces the project's first npm dependency
  (`google-auth-library` + `package.json`); Vercel installs it automatically.
  Zero-dep alternative: hand-roll RS256 JWT with Node `crypto`.

**Tools (server-side; demo mode degrades gracefully):**
- `get_availability({ service_id?, day_or_date?, from_date? })` *(read)* — Calendar
  **FreeBusy** minus clinic hours minus Sundays/Irish holidays (reuses
  `check_opening_hours`), stepped by the service's `duration_min`.
- `request_appointment({ service_id, date, time, pet_name, species, owner_name, contact })`
  *(write)* — inserts a **tentative** event (`REQUEST: <service> — <pet> (<owner>)`,
  contact + price in description, structured data in `extendedProperties.private`),
  re-checks free/busy just before insert, returns a **reference**.
- *(Later)* `cancel` / `reschedule` by event id.

**Customer flow:** find slots → slot chips → gather pet + owner details →
**explicit "shall I book it?" consent gate** → write tentative event →
*"Requested ✅ Ref MVC-4821 — slot held; the clinic will confirm by phone/text."*

**Security / privacy (EU/GDPR):** service-account creds + calendar id live only in
Vercel env; explicit confirm before any write; consent line; no personal data in
URLs; contact stored in the clinic's own calendar.

**Demo-mode degradation:** FreeBusy is server-only, so offline mode shows
**provisional** slots (hours+holidays only, clearly labelled) and can't submit a
request — it says "please call."

**One-time setup (user):** Google Cloud project → enable Calendar API → create
service account + key → share clinic calendar with it → set
`GOOGLE_SERVICE_ACCOUNT_JSON` + `CLINIC_CALENDAR_ID` in Vercel.

**Milestones:** M1 cloud setup + token + test insert · M2 `get_availability` +
slot-chip UI + demo degradation · M3 `request_appointment` + confirm gate +
summary card · M4 edge cases + consent + emergency interlock + e2e.

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
