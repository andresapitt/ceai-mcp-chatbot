# 🐾 Meadow Vet Care — Customer Chatbot

A customer chatbot for **Meadow Vet Care**, a modern Irish veterinary clinic
(dogs, cats, rabbits, small mammals, birds) with 90+ services. It answers real
questions — *"What dog services do you offer?"*, *"Any offers on microchipping?"*,
*"Are you open Monday?"*, *"Is it too hot to walk my dog right now?"* — from
**live data**, not a frozen script.

---

## The MCP idea: giving the AI live tools

The assistant doesn't answer from a frozen copy of anything. Gemini has **three
live tools** and decides for itself when to reach for each one:

| Tool | Live source | Answers questions like |
|---|---|---|
| Service catalogue (inlined context, refreshed every request) | The clinic's Google Sheet | "What dog services do you offer?", "Any offers on microchipping?" |
| `check_opening_hours` | [Nager.Date](https://date.nager.at) — real Irish public holidays | "Are you open Monday?", "Are you open on Christmas Day?" |
| `check_dog_walk_weather` | [Open-Meteo](https://open-meteo.com) — live weather, no key needed | "Is it too hot to walk my dog right now?" |

Edit the sheet, or ask on a different day or in different weather, and the
answer changes — the model reaches live sources through tools instead of
guessing from memory. That's the Model Context Protocol idea in miniature.

Beyond the read-only tools, two more capabilities round out the assistant:

- **Emergency escalation** — if a customer describes an emergency (poisoning,
  trauma, seizure, bloat, a cat that can't urinate…), a deterministic detector
  shows a **call-us-now** card *instantly*, before any model call, so the phone
  number never sits behind a slow reply.
- **Appointment booking** *(the first **write** path)* — a booking form-in-chat
  writes a `requested` row to a **Bookings** tab in the same Google Sheet via a
  Google Apps Script Web App (relayed through `/api/book`, which holds the
  secret). Staff confirm from the sheet. See [`HOW-TO.md`](HOW-TO.md) to enable.

```
 User question
      │
      ▼
 ┌──────────────┐  POST /api/vet-chat  ┌─────────────────────┐
 │  Chat UI     │ ────────────────────►│   Vercel function    │
 │ (static)     │◄──────────────────── │  (holds Gemini key)  │
 └──────────────┘   natural-language   └──────────┬───────────┘
                                                   │ Gemini calls tools as needed
                        ┌──────────────────────────┼───────────────────────────┐
                        ▼                          ▼                           ▼
                 Google Sheet              date.nager.at/…/IE           api.open-meteo.com
               (service catalogue)         (Irish public holidays)      (live weather)
```

The **Gemini API key lives server-side** in the Vercel function's environment —
it is never shipped to the browser.

## Architecture

| Layer | File | How it works |
|---|---|---|
| **Front end** | `index.html`, `styles.css`, `app.js`, `config.js` | Chat page styled from `DESIGN.md` (Airbnb design system: white canvas, Rausch `#ff385c` accent, pill controls). Loads the sheet live for its "N services loaded" indicator. |
| **AI brain** | `api/vet-chat.js` | Vercel serverless function. Runs a real Gemini function-calling loop over the three tools above and returns a natural-language answer. |
| **Fallback** | `app.js` (demo responder) | If the brain endpoint isn't reachable (opened as a plain file, not deployed yet, offline), a built-in responder answers all three kinds of question from the same live sources — so the page always works. |

The badge in the top-right reads **AI connected** when Gemini is answering, or
**Demo mode** when the fallback is in use.

## Deploy to Vercel (recommended)

1. Push this repo to GitHub (see below).
2. In [Vercel](https://vercel.com/new), **Import** the `ceai-mcp-chatbot` repo.
   No framework, no build command — it's static files + one function.
3. Add an **Environment Variable**:
   - `GEMINI_API_KEY` = your Google AI Studio / Gemini key
     *(get one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey))*
   - *(optional)* `GEMINI_MODEL` = `gemini-2.5-flash` (default) — or
     `gemini-2.0-flash`, etc.
4. **Deploy.** The chat page is served at the project URL and the brain lives at
   `/api/vet-chat` on the same origin.

> Already have a Vercel app that holds your Gemini key? You can instead drop the
> two files into it — see [`HOW-TO.md`](HOW-TO.md).

## Push to GitHub

```bash
git init
git add -A
git commit -m "Meadow Vet Care chatbot"
git branch -M main
git remote add origin https://github.com/andresapitt/ceai-mcp-chatbot.git
git push -u origin main
```

## Run locally

Static files — no build step. Serve over HTTP so `fetch` works:

```bash
python -m http.server 8000   # or: npx serve .
```

Open <http://localhost:8000>. The AI endpoint isn't running locally, so the page
uses **Demo mode** (still answering from the live sheet). To exercise the real
Gemini brain locally, run `vercel dev` with `GEMINI_API_KEY` set.

## Configuration

- **Sheet / model** — `config.js` (front end) and env vars (`api/vet-chat.js`).
- **Brain endpoint** — defaults to the deployed Vercel URL in `config.js`
  (`chatEndpoint`), so it works regardless of where the page itself is opened
  from. Override at runtime via the ⚙️ dialog if needed.
- **Clinic location for weather** — defaults to Dublin (53.3498, -6.2603).
  Override with `CLINIC_LAT` / `CLINIC_LON` env vars in Vercel (and update the
  matching constants in `app.js` for the demo fallback to stay in sync).
- **Opening hours** — hardcoded as Monday–Saturday, 09:00–18:00, closed
  Sundays and Irish public holidays (`OPEN_DAYS_LABEL` in `api/vet-chat.js`,
  `OPEN_DAYS_LABEL` in `app.js`). Change both if the clinic's hours differ.

## Files

```
index.html         chat page (markup)
styles.css         design system from DESIGN.md
config.js          sheet · endpoints · emergency contact
app.js             data loading · chat UI · brain call · emergency · booking · demo fallback
api/vet-chat.js    Vercel function — Gemini brain + live tools (catalogue, hours, weather)
api/book.js        Vercel function — booking relay to the Apps Script Web App
apps-script/Code.gs Apps Script Web App — writes bookings to the Sheet (LockService)
ROADMAP.md         feature roadmap from the user-panel study
HOW-TO.md          add to an existing Vercel app · enable booking (+ Next.js variants)
DESIGN.md          the design language this UI is built from
```
