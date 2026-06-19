// csv-store.js
// Shared ES module for the local-CSV destination.
// Persists the user's FileSystemFileHandle in IndexedDB (handles are not
// JSON-serializable so they cannot go in chrome.storage) and provides the
// small set of CSV helpers used by popup.js and options.js.

const DB_NAME = "job-tracker";
const STORE = "kv";
const HANDLE_KEY = "csvHandle";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open error"));
  });
}

// Run a request on the kv object store; resolves with the request result.
async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error || new Error("IndexedDB tx error")); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("IndexedDB tx aborted")); };
    const req = fn(store);
    req.onsuccess = () => { result = req.result; };
  });
}

export async function saveCsvHandle(handle) {
  await withStore("readwrite", (store) => store.put(handle, HANDLE_KEY));
}

export async function getCsvHandle() {
  return await withStore("readonly", (store) => store.get(HANDLE_KEY));
}

export async function clearCsvHandle() {
  await withStore("readwrite", (store) => store.delete(HANDLE_KEY));
}

// --- CSV helpers (RFC-4180-ish) -------------------------------------------

// Quote a single value if it contains a comma, quote, CR or LF.
export function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Build one CSV record line (terminated with CRLF for spreadsheet compatibility).
export function rowToCsvLine(columns, record) {
  return columns.map((c) => csvEscape(record[c] ?? "")).join(",") + "\r\n";
}

// Parse a single CSV line into fields, honouring quoted fields with embedded
// commas and doubled quotes.
export function parseCsvLine(line) {
  if (line == null) return null;
  const fields = [];
  let i = 0;
  const len = line.length;
  let field = "";
  let inQuotes = false;
  while (i < len) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += ch; i++; }
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  fields.push(field);
  return fields;
}

// Return the first CSV line of `text` as an array of fields, or null if the
// content is empty. A leading BOM is stripped.
export function parseCsvHeaderLine(text) {
  const t = (text || "").replace(/^\uFEFF/, "");
  if (t.trim() === "") return null;
  const firstLine = t.split(/\r\n|\n|\r/)[0] || "";
  return parseCsvLine(firstLine);
}
