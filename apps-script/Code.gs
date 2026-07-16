/**
 * Meadow Vet Care — booking Web App (Google Apps Script)
 * ---------------------------------------------------------------------------
 * Receives appointment requests from the Vercel function (api/book.js) and
 * appends them to a "Bookings" tab in a DEDICATED bookings Google Sheet
 * (separate from the services-catalogue sheet in config.js / api/vet-chat.js).
 * Uses LockService + a conflict re-check so two people can't grab the same
 * slot.
 *
 * SETUP (one time)
 *  1. Open the dedicated bookings spreadsheet. It needs a tab named exactly
 *     "Bookings" (this script creates it and its header row if missing).
 *  2. In that spreadsheet: Extensions → Apps Script → paste this file.
 *  3. Set the two values below:
 *       SHEET_ID  — the id in the sheet URL (…/spreadsheets/d/THIS_PART/edit)
 *       SECRET    — any long random string; put the SAME value in Vercel as
 *                   APPSCRIPT_TOKEN.
 *     (Optional) NOTIFY_EMAIL — where new-request emails go.
 *  4. Deploy → New deployment → type "Web app":
 *       Execute as: Me
 *       Who has access: Anyone
 *     Copy the Web app URL → put it in Vercel as APPSCRIPT_URL.
 *  5. Re-deploy after any edit (Deploy → Manage deployments → edit → Deploy).
 * ---------------------------------------------------------------------------
 */

// ── Config ───────────────────────────────────────────────────────────────────
// The dedicated "vet chatbot bookings" spreadsheet — NOT the services sheet.
var SHEET_ID = "1QiWoLlOpiTjFHG9n9_MwP1x9Duj7lBZMb3A72TuD49w";
var SECRET = "CHANGE_ME_to_a_long_random_string";              // ← same as APPSCRIPT_TOKEN in Vercel
var NOTIFY_EMAIL = "";  // ← optional: e.g. "reception@meadowvet.ie" (blank = no email)
var TAB = "Bookings";
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
  var ss = SpreadsheetApp.openById(SHEET_ID);
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
