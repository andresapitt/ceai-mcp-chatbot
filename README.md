# 🐾 Meadow Vet Care — Customer Chatbot

A customer chatbot for **Meadow Vet Care**, a modern Irish veterinary clinic
(dogs, cats, rabbits, small mammals, birds) with 90+ services. It answers real
questions — *"What dog services do you offer?"*, *"Any offers on microchipping?"*,
*"Do you have telehealth services?"* — from the clinic's **live data**.

---

## The MCP idea: giving the AI a live tool

The assistant doesn't answer from a frozen copy of the data. On **every
question**, the server reaches out to the clinic's Google Sheet, pulls the
**current** catalogue, and grounds the model on it. Edit the sheet, ask again,
and the answer changes. That's the Model Context Protocol idea in miniature: the
model reaches a live source through a tool instead of guessing from memory.

```
 User question
      │
      ▼
 ┌──────────────┐   POST /api/vet-chat   ┌────────────────────┐   fetch    ┌──────────────┐
 │  Chat UI     │ ─────────────────────► │  Vercel function   │ ─────────► │ Google Sheet │
 │ (static)     │ ◄───────────────────── │  (holds Gemini key)│ ◄───────── │  (live data) │
 └──────────────┘   natural-language     └─────────┬──────────┘            └──────────────┘
                                                   │ grounds on live catalogue
                                                   ▼
                                             Google Gemini
```

The **Gemini API key lives server-side** in the Vercel function's environment —
it is never shipped to the browser.

## Architecture

| Layer | File | How it works |
|---|---|---|
| **Front end** | `index.html`, `styles.css`, `app.js`, `config.js` | Chat page styled from `DESIGN.md` (Airbnb design system: white canvas, Rausch `#ff385c` accent, pill controls). Loads the sheet live for its "N services loaded" indicator. |
| **AI brain** | `api/vet-chat.js` | Vercel serverless function. Fetches the live sheet, grounds **Gemini** on the full current catalogue, returns a natural-language answer. |
| **Fallback** | `app.js` (demo responder) | If the brain endpoint isn't reachable (opened as a plain file, not deployed yet, offline), a built-in responder answers from the same live sheet — so the page always works. |

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
- **Brain endpoint** — defaults to same-origin `/api/vet-chat`. If you host the
  UI on GitHub Pages but the brain on Vercel, open the ⚙️ dialog and set the full
  Vercel URL, or edit `chatEndpoint` in `config.js`.

## Files

```
index.html      chat page (markup)
styles.css      design system from DESIGN.md
config.js       sheet + endpoint configuration
app.js          data loading · chat UI · brain call · demo fallback
api/vet-chat.js Vercel serverless function — the Gemini brain + live sheet
HOW-TO.md       adding the two files to an existing Vercel app (+ Next.js variants)
DESIGN.md       the design language this UI is built from
```
