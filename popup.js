// popup.js
// Main popup logic: text extraction (page or PDF), AI field extraction,
// dynamic form generation from JSON schema, and saving to either a Google
// Sheet or a local CSV file (chosen in Options).

import { getCsvHandle, csvEscape, rowToCsvLine, parseCsvHeaderLine } from "./csv-store.js";

const elStatus = document.getElementById("status");
const elForm = document.getElementById("jobForm");
const btnExtract = document.getElementById("btnExtractPage");
const inputPdf = document.getElementById("inputPdf");
const btnOptions = document.getElementById("btnOptions");

btnOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

// Destination (google_sheets | local_csv) — resolved before the form is built.
let currentDestination = "google_sheets";
const destinationPromise = chrome.storage.sync
  .get("destination")
  .then((r) => r.destination || "google_sheets");

function getSaveButtonLabel() {
  return currentDestination === "local_csv" ? "Save to CSV file" : "Save to Google Sheet";
}

function setStatus(text, type) {
  elStatus.textContent = text;
  elStatus.className = "status" + (type ? " " + type : "");
}

function setLoading(active, label) {
  btnExtract.disabled = active;
  inputPdf.disabled = active;
  if (active) setStatus(label || "Processing...", "loading");
}

// --- Text extraction from HTML page (injected into tab) ------------------

function pageExtractionFunction() {
  const clone = document.body.cloneNode(true);
  const selectors = ["script", "style", "noscript", "svg", "iframe", "nav", "footer", "header"];
  selectors.forEach((sel) => clone.querySelectorAll(sel).forEach((el) => el.remove()));
  let text = clone.innerText || clone.textContent || "";
  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  return { text: text.slice(0, 15000), title: document.title };
}

// --- Text extraction from PDF (pdf.js) -----------------------------------

let pdfjsLibPromise = null;
async function getPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(chrome.runtime.getURL("lib/pdf.min.mjs")).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.mjs");
      return lib;
    });
  }
  return pdfjsLibPromise;
}

async function extractTextFromPdf(arrayBuffer) {
  const lib = await getPdfJs();
  const pdf = await lib.getDocument({ data: arrayBuffer }).promise;
  const maxPages = Math.min(pdf.numPages, 15);
  let text = "";
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n";
  }
  return text.replace(/[ \t]+/g, " ").trim().slice(0, 15000);
}

// --- Main flow: extract from active tab ----------------------------------

async function extractFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab found.");

  const currentUrl = tab.url || "";
  const urlLower = currentUrl.toLowerCase();

  if (urlLower.includes(".pdf")) {
    setLoading(true, "Downloading and processing PDF...");
    const response = await fetch(currentUrl);
    if (!response.ok) throw new Error("Unable to download the PDF from the current page.");
    const buffer = await response.arrayBuffer();
    const text = await extractTextFromPdf(buffer);
    return { text, url: currentUrl, title: tab.title || "" };
  }

  setLoading(true, "Reading page content...");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: pageExtractionFunction
  });

  if (!result || !result.result) {
    throw new Error("Unable to read this page's content (may not be allowed on this type of tab).");
  }

  return { text: result.result.text, url: currentUrl, title: result.result.title };
}

async function extractFromPdfFile(file) {
  setLoading(true, "Processing uploaded PDF...");
  const buffer = await file.arrayBuffer();
  const text = await extractTextFromPdf(buffer);
  return { text, url: "", title: file.name };
}

// --- AI extraction job (owned by the service worker) ---------------------
// The popup only kicks the job off; the result is written by the background to
// chrome.storage.session.extractionJob. This way the LLM request survives the
// popup being closed mid-analysis — reopen it and you'll see "Analyzing..."
// until the job finishes, then the populated form.

async function startExtractionJob(data) {
  if (!data.text || data.text.trim().length < 20) {
    throw new Error("Extracted text is too short or empty.");
  }
  setLoading(true, "Analyzing the posting with AI...");
  const response = await chrome.runtime.sendMessage({
    type: "EXTRACT_FIELDS_LLM",
    payload: { text: data.text, url: data.url, pageTitle: data.title }
  });
  if (!response?.ok) throw new Error(response?.error || "Could not start AI extraction.");
}

async function applyExtractionResult({ fields, url, schema }) {
  window._currentSchema = schema;
  currentDestination = await destinationPromise;
  buildFormFromSchema(schema);
  populateForm(fields, url);
  _draftUrl = url || "";
  await saveDraft();
  setStatus("Fields extracted. Review and edit before saving.", "success");
  setLoading(false);
}

// --- Dynamic form generation from schema ---------------------------------

function buildFormFromSchema(schema) {
  elForm.innerHTML = "";

  for (const field of schema) {
    const wrapper = document.createElement("div");

    if (field.type === "select") {
      wrapper.className = "field";
      wrapper.innerHTML = `
        <label>${field.label}</label>
        <select name="${field.name}">
          ${(field.options || []).map((o) =>
            `<option value="${o.value}">${o.label}</option>`
          ).join("")}
        </select>
      `;
    } else if (field.type === "textarea") {
      wrapper.className = "field";
      wrapper.innerHTML = `
        <label>${field.label}</label>
        <textarea name="${field.name}" rows="2"></textarea>
      `;
    } else {
      wrapper.className = "field" + (field.readonly ? " field-readonly" : "");
      wrapper.innerHTML = `
        <label>${field.label}</label>
        <input type="${field.type || "text"}" name="${field.name}"
          ${field.placeholder ? `placeholder="${field.placeholder}"` : ""}
          ${field.readonly ? "readonly" : ""} />
      `;
    }

    elForm.appendChild(wrapper);
  }

  const btnWrapper = document.createElement("div");
  btnWrapper.className = "field form-actions";
  btnWrapper.innerHTML = `<button type="submit" id="btnSave" class="btn btn-primary">${getSaveButtonLabel()}</button>`;
  elForm.appendChild(btnWrapper);
}

function populateForm(fields, url, recomputeAutos = true) {
  const schema = window._currentSchema || [];
  for (const [name, value] of Object.entries(fields || {})) {
    const el = elForm.elements[name];
    if (el) el.value = value ?? "";
  }

  // Auto-fill fields (skipped when restoring a saved draft, so the original
  // values — e.g. save_date from extraction day — are preserved).
  if (recomputeAutos) {
    for (const field of schema) {
      if (!field.auto) continue;
      const el = elForm.elements[field.name];
      if (!el) continue;

      if (field.name === "save_date") {
        el.value = new Date().toISOString().slice(0, 10);
      } else if (field.name === "url") {
        el.value = url || "";
      } else if (field.name === "source") {
        try {
          el.value = url ? new URL(url).hostname.replace(/^www\./, "") : "";
        } catch {
          el.value = "";
        }
      }
    }
  }

  // Normalize select values against their options.
  for (const field of schema) {
    if (field.type !== "select") continue;
    const el = elForm.elements[field.name];
    if (!el) continue;
    const validValues = Array.from(el.options).map((o) => o.value);
    if (!validValues.includes(el.value)) el.value = validValues[0] || "";
  }

  elForm.classList.remove("hidden");
}

// --- Draft persistence (chrome.storage.session) --------------------------
// Safety net: the action popup closes on blur, but the extracted/edited values
// survive and are restored on next open — no need to re-run the LLM.

let _draftUrl = "";

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function readFormRecord(schema) {
  const record = {};
  for (const field of schema) {
    const el = elForm.elements[field.name];
    if (el) record[field.name] = el.value;
  }
  return record;
}

async function saveDraft() {
  const schema = window._currentSchema;
  if (!schema) return;
  await chrome.storage.session.set({
    draft: {
      record: readFormRecord(schema),
      url: _draftUrl,
      schema,
      destination: currentDestination
    }
  });
}

async function clearDraft() {
  _draftUrl = "";
  await chrome.storage.session.remove("draft");
}

async function handleExtraction(dataSource) {
  try {
    const data = await dataSource();
    await startExtractionJob(data);
    // The result arrives via the storage listener (or init, on reopen).
    // Loading stays on until the job finishes; keep the popup open or not —
    // the request keeps running in the service worker either way.
  } catch (err) {
    setStatus("Error: " + err.message, "error");
    setLoading(false);
  }
}

btnExtract.addEventListener("click", () => handleExtraction(extractFromActiveTab));

inputPdf.addEventListener("change", () => {
  const file = inputPdf.files?.[0];
  if (!file) return;
  handleExtraction(() => extractFromPdfFile(file));
  inputPdf.value = "";
});

// --- Save (Google Sheet or local CSV) -------------------------------------

async function saveToLocalCsv(record, schema) {
  const columns = schema.map((f) => f.name);
  const handle = await getCsvHandle();
  if (!handle) {
    throw new Error("No CSV file chosen — configure it in the extension Options.");
  }

  // Re-grant permission. This must run off the click gesture; keep it before
  // any long async work so the browser still sees user activation.
  if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted") {
    let perm;
    try {
      perm = await handle.requestPermission({ mode: "readwrite" });
    } catch (e) {
      throw new Error("File access was denied: " + (e?.message || e));
    }
    if (perm !== "granted") {
      throw new Error("File access was denied. Allow access to the CSV file to save.");
    }
  }

  let existingText = "";
  try {
    const file = await handle.getFile();
    existingText = await file.text();
  } catch {
    // Treat unreadable/missing as empty.
  }

  const headerLine = columns.map(csvEscape).join(",") + "\r\n";
  const dataLine = rowToCsvLine(columns, record);
  const existingHeader = parseCsvHeaderLine(existingText);

  let newText;
  if (!existingHeader) {
    // New/empty file: write the schema header plus the first data row.
    newText = headerLine + dataLine;
  } else if (
    existingHeader.length === columns.length &&
    existingHeader.every((h, i) => h === columns[i])
  ) {
    // Header matches the schema: append the row.
    newText = existingText.replace(/\s+$/, "") + "\r\n" + dataLine;
  } else {
    throw new Error(
      "The CSV file's header does not match the current field schema. " +
        "Choose a different file or align its columns in Options."
    );
  }

  try {
    const writable = await handle.createWritable();
    await writable.write(new Blob([newText], { type: "text/csv" }));
    await writable.close();
  } catch (e) {
    throw new Error(
      "Could not write the CSV file (it may be open in another program, e.g. Excel): " +
        (e?.message || e)
    );
  }

  return handle.name;
}

elForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btnSave = document.getElementById("btnSave");
  if (btnSave) btnSave.disabled = true;

  const formData = new FormData(elForm);
  const record = {};
  for (const [key, value] of formData.entries()) record[key] = value;

  // Ensure auto fields are included
  const schema = window._currentSchema || [];
  for (const field of schema) {
    if (field.auto && !record[field.name]) {
      const el = elForm.elements[field.name];
      if (el) record[field.name] = el.value;
    }
  }

  try {
    if (currentDestination === "local_csv") {
      setStatus("Saving to CSV file...", "loading");
      const name = await saveToLocalCsv(record, schema);
      setStatus("Saved to " + name + "!", "success");
    } else {
      setStatus("Saving to Google Sheet...", "loading");
      const response = await chrome.runtime.sendMessage({ type: "SAVE_TO_SHEET", payload: record });
      if (!response?.ok) throw new Error(response?.error || "Error during save.");
      setStatus("Saved successfully to Google Sheet!", "success");
    }
    await clearDraft();
    elForm.reset();
    elForm.classList.add("hidden");
  } catch (err) {
    setStatus("Error: " + err.message, "error");
  } finally {
    if (btnSave) btnSave.disabled = false;
  }
});

// --- React to the background extraction job ------------------------------
// The job state lives in chrome.storage.session.extractionJob. We render it
// both on popup open (init) and live while open (onChanged). A signature guard
// avoids applying the same state twice (e.g. init read + change event racing).

let _handledJobKey = null;
function jobKey(job) {
  return job ? job.status + ":" + (job.startedAt || 0) : null;
}

async function handleJobUpdate(job) {
  if (!job) return;
  if (_handledJobKey === jobKey(job)) return; // already applied this exact state
  _handledJobKey = jobKey(job);

  if (job.status === "running") {
    setLoading(true, "Analyzing the posting with AI...");
  } else if (job.status === "done") {
    await applyExtractionResult({ fields: job.fields, url: job.url, schema: job.schema });
    await chrome.storage.session.remove("extractionJob");
  } else if (job.status === "error") {
    setStatus("Error: " + (job.error || "Error during AI extraction."), "error");
    setLoading(false);
    await chrome.storage.session.remove("extractionJob");
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.extractionJob) return;
  handleJobUpdate(changes.extractionJob.newValue);
});

// --- Init: resume an in-flight job, else restore a pending draft ----------

async function init() {
  currentDestination = await destinationPromise;

  const { extractionJob } = await chrome.storage.session.get("extractionJob");
  if (extractionJob) {
    // A job is running or already finished — adopt it.
    await handleJobUpdate(extractionJob);
  } else {
    // No active job — restore an unsaved draft, if any.
    const { draft } = await chrome.storage.session.get("draft");
    if (draft?.schema && draft.record) {
      window._currentSchema = draft.schema;
      _draftUrl = draft.url || "";
      currentDestination = draft.destination || currentDestination;
      buildFormFromSchema(draft.schema);
      populateForm(draft.record, _draftUrl, /*recomputeAutos*/ false);
      setStatus("Draft restored. Review and save when ready.", "success");
    }
  }

  // Persist edits so they survive a popup close/reopen.
  elForm.addEventListener("input", debounce(saveDraft, 250));
}

init();
