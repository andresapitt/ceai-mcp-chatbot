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

## 3. Test

Open the page and ask *"What dog services do you offer?"*. The top-right badge
should read **AI connected**. If it says **Demo mode**, the page couldn't reach
the endpoint — check the function path, the `GEMINI_API_KEY` env var, and
(if cross-origin) the `chatEndpoint` URL. The browser console logs the reason.
