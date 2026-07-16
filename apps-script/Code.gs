/**
 * Meadow Vet Care — booking Web App (Google Apps Script)
 * ---------------------------------------------------------------------------
 * Receives appointment requests from the Vercel function (api/book.js) and
 * appends them to a "Bookings" tab in a DEDICATED bookings Google Sheet
 * (separate from the services-catalogue sheet in config.js / api/vet-chat.js).
 * Uses LockService + a conflict re-check so two people can't grab the same
 * slot.
 *
 * This is a CONTAINER-BOUND script (created via Extensions → Apps Script from
 * inside the bookings spreadsheet), so it uses getActiveSpreadsheet() rather
 * than SpreadsheetApp.openById(). That keeps the OAuth scope narrow — access
 * to just this one sheet — instead of the broad "see all your Sheets" scope,
 * which is what triggers Google's "This app is blocked" hard-stop (as opposed
 * to the milder "unverified app" warning you can click through).
 *
 * SETUP (one time)
 *  1. Open the dedicated bookings spreadsheet. It needs a tab named exactly
 *     "Bookings" (this script creates it and its header row if missing).
 *  2. In that spreadsheet: Extensions → Apps Script → paste this file.
 *  3. Set SECRET below — any long random string; put the SAME value in
 *     Vercel as APPSCRIPT_TOKEN. (Optional) NOTIFY_EMAIL — where new-request
 *     emails go; leave blank to skip email entirely (fewer permissions asked).
 *  4. Deploy → New deployment → type "Web app":
 *       Execute as: Me
 *       Who has access: Anyone
 *     Copy the Web app URL → put it in Vercel as APPSCRIPT_URL.
 *  5. Re-deploy after any edit (Deploy → Manage deployments → edit → Deploy).
 *
 * "This app is blocked" instead of the usual "unverified" warning?
 *  - Make sure this script was created FROM INSIDE the bookings spreadsheet
 *    (Extensions → Apps Script), not as a separate standalone script — a
 *    standalone script can't use getActiveSpreadsheet() and falls back to
 *    the broad SHEET_ID_FALLBACK path below, which re-triggers the block.
 *  - If your Google account is a Workspace/organization account (a work or
 *    school domain, not @gmail.com), an admin policy may hard-block ALL
 *    unverified apps regardless of scope. Fix: use a personal @gmail.com
 *    account for this spreadsheet + script, or ask your admin to allow it.
 *  - Leave NOTIFY_EMAIL blank at first — the email scope is a second,
 *    separate permission request; adding it back later re-prompts consent
 *    just for that piece.
 * ---------------------------------------------------------------------------
 */

// ── Config ───────────────────────────────────────────────────────────────────
var SECRET = "CHANGE_ME_to_a_long_random_string";              // ← same as APPSCRIPT_TOKEN in Vercel
var NOTIFY_EMAIL = "";  // ← optional: e.g. "reception@meadowvet.ie" (blank = no email, fewer permissions asked)
var TAB = "Bookings";
// Only used if this script is somehow NOT container-bound (getActiveSpreadsheet()
// returns null). Normally unused — leave as-is.
var SHEET_ID_FALLBACK = "1QiWoLlOpiTjFHG9n9_MwP1x9Duj7lBZMb3A72TuD49w";
var HEADER = [
  "booking_ref", "created_at", "service_id", "service_name", "date", "time",
  "duration_min", "pet_name", "species", "owner_name", "contact", "status", "notes",
];

// ── Entry points ─────────────────────────────────────────────────────────────
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // serialize writes → no double-booking
  } catch (err) {
    return json({ ok: false, error: "busy, please retry" });
  }
  try {
    var body = {};
    try { body = JSON.parse(e.postData.contents); } catch (err) {
      return json({ ok: false, error: "bad request" });
    }
    if (body.token !== SECRET) return json({ ok: false, error: "unauthorized" });

    var required = ["service_name", "date", "time", "pet_name", "owner_name", "contact"];
    for (var i = 0; i < required.length; i++) {
      if (!body[required[i]]) return json({ ok: false, error: "missing " + required[i] });
    }

    var sheet = getSheet_();
    if (slotTaken_(sheet, body.date, body.time)) {
      return json({ ok: false, error: "slot_taken" });
    }

    var ref = makeRef_();
    sheet.appendRow([
      ref, new Date(), body.service_id || "", body.service_name, body.date, body.time,
      body.duration_min || "", body.pet_name, body.species || "", body.owner_name,
      body.contact, "requested", "",
    ]);

    notify_(ref, body);
    return json({ ok: true, ref: ref });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  // Health check only — never returns booking data.
  return json({ ok: true, service: "meadow-vet-booking" });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getSheet_() {
  // Prefer the bound spreadsheet (narrow scope, no "This app is blocked").
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) ss = SpreadsheetApp.openById(SHEET_ID_FALLBACK); // only if not container-bound
  var sheet = ss.getSheetByName(TAB);
  if (!sheet) {
    sheet = ss.insertSheet(TAB);
    sheet.appendRow(HEADER);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
  }
  return sheet;
}

function slotTaken_(sheet, date, time) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  // columns: date=5, time=6, status=12 (1-indexed)
  var values = sheet.getRange(2, 5, last - 1, 8).getValues(); // date..status
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var rDate = formatDate_(row[0]);
    var rTime = String(row[1]).slice(0, 5);
    var rStatus = String(row[7]).toLowerCase();
    if (rDate === date && rTime === String(time).slice(0, 5) && rStatus !== "cancelled") {
      return true;
    }
  }
  return false;
}

function formatDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(v).slice(0, 10);
}

function makeRef_() {
  var n = Math.floor(1000 + Math.random() * 9000);
  return "MVC-" + n;
}

function notify_(ref, body) {
  if (!NOTIFY_EMAIL) return;
  try {
    MailApp.sendEmail(
      NOTIFY_EMAIL,
      "New appointment request " + ref,
      [
        "Ref: " + ref,
        "Service: " + body.service_name,
        "When: " + body.date + " " + body.time,
        "Pet: " + body.pet_name + " (" + (body.species || "") + ")",
        "Owner: " + body.owner_name,
        "Contact: " + body.contact,
        "",
        "Status: requested — please confirm with the customer.",
      ].join("\n")
    );
  } catch (err) {
    // Non-fatal: booking is already stored.
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
