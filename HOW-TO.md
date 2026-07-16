# Adding the chatbot to an existing Vercel app

If you already have a Vercel app with your Gemini key configured, you can drop
the chatbot into it instead of deploying this repo on its own. You need **two
things**: the AI endpoint (a serverless function) and the chat page.

---

## 1. The AI endpoint — `api/vet-chat.js`

Copy [`api/vet-chat.js`](api/vet-chat.js) into your app. Where it goes depends on
your framework — check your repo root:

| Your repo has… | Framework | Put the file at | Change needed |
|---|---|---|---|
| an `app/` folder | **Next.js App Router** | `app/api/vet-chat/route.js` | use the App Router wrapper below |
| a `pages/` folder | **Next.js Pages Router** | `pages/api/vet-chat.js` | **none** — works as-is |
| neither (Vite/CRA/static) | **plain** | `api/vet-chat.js` (repo root) | **none** — works as-is |

The function reads your key from the environment. It accepts any of these names,
so it likely already matches what your app uses:

```
GEMINI_API_KEY   ·   GOOGLE_API_KEY   ·   GOOGLE_GENERATIVE_AI_API_KEY   ·   API_KEY
```

Optional env vars: `GEMINI_MODEL` (default `gemini-2.5-flash`), `SHEET_CSV_URL`.

### Next.js **App Router** wrapper

The provided file uses the classic `(req, res)` signature. For the App Router,
create `app/api/vet-chat/route.js` that reuses the same logic — the simplest path
is to keep `api/vet-chat.js`'s helper functions and export a `POST` handler.
Minimal adapter (paste the helper functions from `api/vet-chat.js` above it, or
`import` them):

```js
// app/api/vet-chat/route.js
export const runtime = "nodejs";

// ↓ paste getApiKey / getModel / getSheetUrl / parseCsv / fetchCatalogue /
//   systemPrompt / toGeminiContents / callGemini from api/vet-chat.js here,
//   or move them to a shared module and import them.

export async function POST(req) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  try {
    if (!getApiKey()) return Response.json({ error: "No Gemini API key configured." }, { status: 500, headers: cors });
    const body = await req.json().catch(() => ({}));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return Response.json({ error: "No messages provided." }, { status: 400, headers: cors });

    const { services, text } = await fetchCatalogue();
    const categories = [...new Set(services.map((s) => s.category).filter(Boolean))].sort();
    const species = [...new Set(services.map((s) => s.species).filter(Boolean))].sort();
    const reply = await callGemini(toGeminiContents(messages), systemPrompt(text, categories, species));
    return Response.json({ reply, serviceCount: services.length }, { headers: cors });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: cors });
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }});
}
```

---

## 2. The chat page

Copy `index.html`, `styles.css`, `app.js`, and `config.js` into a folder your app
serves as static files:

- **Next.js:** put them under `public/vet/` → served at `/vet/index.html`.
- **Static/Vite:** put them under `public/` (or wherever your static root is).

If the page and the function are on the **same origin**, the default
`chatEndpoint: "/api/vet-chat"` in `config.js` just works. If the page lives
somewhere else (e.g. GitHub Pages), set `chatEndpoint` to the full Vercel URL,
e.g. `https://your-app.vercel.app/api/vet-chat` — the function already sends
permissive CORS headers.

---

## 3. Test the chat

Open the page and ask *"What dog services do you offer?"*. The top-right badge
should read **AI connected**. If it says **Demo mode**, the page couldn't reach
the endpoint — check the function path, the `GEMINI_API_KEY` env var, and
(if cross-origin) the `chatEndpoint` URL. The browser console logs the reason.

---

## 4. (Optional) Enable appointment booking (Feature 1)

Until this is set up, the booking form still works but submissions are
**simulated** and clearly labelled "demo — not sent". Bookings write to a
**dedicated bookings spreadsheet** — kept separate from the services-catalogue
sheet so real customer data never mixes with demo catalogue data.

1. **Use (or create) the dedicated bookings spreadsheet.** It needs a tab
   named exactly `Bookings` (the script also creates it + a header row if
   missing). This project's demo uses `vet chatbot bookings`
   (id `1QiWoLlOpiTjFHG9n9_MwP1x9Duj7lBZMb3A72TuD49w`) — swap in your own.
2. **Add the Apps Script.** In that spreadsheet: **Extensions → Apps Script**.
   Paste [`apps-script/Code.gs`](apps-script/Code.gs). At the top, set:
   - `SHEET_ID` — the id from the *bookings* sheet's URL (`…/spreadsheets/d/THIS/edit`) — **not** the services sheet,
   - `SECRET` — a long random string,
   - `NOTIFY_EMAIL` — optional, where new-request emails go.
3. **Deploy.** **Deploy → New deployment → Web app**, *Execute as: Me*,
   *Who has access: Anyone*. Copy the **Web app URL**.
   *(Re-deploy after any edit: Deploy → Manage deployments → edit → Deploy.)*
4. **Wire it to Vercel.** Add two env vars to the project:
   - `APPSCRIPT_URL` = the Web app URL from step 3,
   - `APPSCRIPT_TOKEN` = the same string you used for `SECRET`.
5. **Point the form at it.** `bookEndpoint` in `config.js` defaults to the Vercel
   `/api/book` URL — set it to your app's URL if different.

**Test:** say *"book an appointment"*, fill the form, submit. A real request
appends a `requested` row to the Bookings tab and returns a reference; the
confirmation card no longer shows the "demo" note. `LockService` in the script
prevents two people booking the same slot (the second gets "slot just taken").
