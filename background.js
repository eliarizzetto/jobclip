// background.js
// Service worker: handles AI API calls (multi-provider) for field extraction
// and Google Sheets API calls for saving data.

// Default field schema lives in schema.json (loaded lazily and cached).
// Used as a fallback when no schema is stored in chrome.storage.
let _defaultSchemaCache = null;

async function loadDefaultSchema() {
  if (_defaultSchemaCache) return _defaultSchemaCache;
  const url = chrome.runtime.getURL("schema.json");
  const res = await fetch(url);
  _defaultSchemaCache = await res.json();
  return _defaultSchemaCache;
}

// Read the field schema from storage, falling back to the default.
async function getFieldSchema() {
  const result = await chrome.storage.sync.get("fieldSchema");
  if (result.fieldSchema) {
    try {
      return JSON.parse(result.fieldSchema);
    } catch {
      return await loadDefaultSchema();
    }
  }
  return await loadDefaultSchema();
}

// Build the column names array from the schema.
function getColumns(schema) {
  return schema.map((f) => f.name);
}

// Build the AI extraction prompt dynamically from the schema.
function buildSystemPrompt(schema) {
  const aiFields = schema.filter((f) => !f.auto);
  const fieldDescriptions = aiFields.map((f) => {
    let desc = `  "${f.name}": ${f.aiDescription}`;
    if (f.type === "select" && f.options) {
      const validValues = f.options.map((o) => o.value).join(", ");
      desc += ` (valid values: ${validValues})`;
    }
    return desc;
  }).join(",\n");

  const exampleObj = aiFields.map((f) => `  "${f.name}": ""`).join(",\n");

  return `You are an assistant that extracts structured information from job postings (in any language).
You receive the raw text of a web page or PDF containing a job offer (it may also contain navigation elements, menus, etc. to ignore).

Extract ONLY the following information and respond EXCLUSIVELY with a valid JSON object, without markdown, without backticks, without any additional text before or after.

Required fields (use empty string "" if the information is not present or not deducible, do not invent data):

{
${fieldDescriptions}
}

Example response format:
{
${exampleObj}
}`;
}

// Read configuration from storage.
async function readConfig() {
  const cfg = await chrome.storage.sync.get([
    "provider",
    "apiKey",
    "apiEndpoint",
    "modelName",
    "anthropicModel",
    "anthropicApiKey",
    "destination",
    "spreadsheetId",
    "sheetName"
  ]);
  return {
    provider: cfg.provider || "anthropic",
    apiKey: cfg.apiKey || cfg.anthropicApiKey || "",
    apiEndpoint: cfg.apiEndpoint || "",
    modelName: cfg.modelName || cfg.anthropicModel || "claude-haiku-4-5-20251001",
    destination: cfg.destination || "google_sheets",
    spreadsheetId: cfg.spreadsheetId || "",
    sheetName: cfg.sheetName || "Job Postings"
  };
}

// --- Anthropic API call ---------------------------------------------------

async function callAnthropic(apiKey, model, systemPrompt, userMessage) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const textBlocks = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return textBlocks;
}

// --- OpenAI-compatible API call (Z.ai, OpenAI, Groq, Together, etc.) ------

async function callOpenAICompatible(endpoint, apiKey, model, systemPrompt, userMessage) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1024*3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

// --- Generic LLM call dispatcher ------------------------------------------

async function callLLM(cfg, systemPrompt, userMessage) {
  if (!cfg.apiKey) {
    throw new Error("Missing API key. Configure it in the extension Options.");
  }

  let rawText;
  if (cfg.provider === "anthropic") {
    rawText = await callAnthropic(cfg.apiKey, cfg.modelName, systemPrompt, userMessage);
  } else {
    if (!cfg.apiEndpoint) {
      throw new Error("Missing API endpoint URL. Configure it in the extension Options.");
    }
    rawText = await callOpenAICompatible(cfg.apiEndpoint, cfg.apiKey, cfg.modelName, systemPrompt, userMessage);
  }

  // Parse JSON from the response, stripping any markdown fences.
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");

  let fields;
  try {
    fields = JSON.parse(cleaned);
  } catch {
    throw new Error("The model did not return valid JSON: " + cleaned.slice(0, 200));
  }

  return fields;
}

// --- Field extraction job (runs in the service worker) -------------------
// The extraction is a long-running job owned by the service worker, not the
// popup. Progress and the final result are written to chrome.storage.session
// under "extractionJob" so they survive the popup closing mid-request: the
// popup just kicks the job off and reads/subscribes to that key. A monotonic
// token guards against a stale job overwriting a newer one (e.g. the user
// clicks Extract again while the first call is still in flight).

let _jobToken = 0;

async function runExtractionJob({ text, url, pageTitle }) {
  const myToken = ++_jobToken;
  await chrome.storage.session.set({
    extractionJob: { status: "running", url, pageTitle, token: myToken, startedAt: Date.now() }
  });

  try {
    const cfg = await readConfig();
    const schema = await getFieldSchema();
    const systemPrompt = buildSystemPrompt(schema);
    const userMessage = `Page URL: ${url}
Page title: ${pageTitle}

Job posting text:
"""
${text}
"""`;
    const fields = await callLLM(cfg, systemPrompt, userMessage);

    if (myToken !== _jobToken) return; // superseded by a newer job — discard
    await chrome.storage.session.set({
      extractionJob: { status: "done", url, schema, fields, startedAt: Date.now() }
    });
  } catch (err) {
    if (myToken !== _jobToken) return;
    await chrome.storage.session.set({
      extractionJob: { status: "error", url, error: err.message, startedAt: Date.now() }
    });
  }
}

// --- Google Sheets helpers ------------------------------------------------

async function getGoogleToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "Google authentication failed."));
        return;
      }
      resolve(token);
    });
  });
}

async function sheetsApiCall(url, method, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Google Sheets API error (${res.status}): ${t.slice(0, 300)}`);
  }
  return res.json();
}

async function saveToGoogleSheet(record) {
  const cfg = await readConfig();
  if (!cfg.spreadsheetId) {
    throw new Error("Missing Google Sheet ID. Configure it in the extension Options.");
  }

  let token;
  try {
    token = await getGoogleToken(true);
  } catch (e) {
    throw new Error("Google access not authorized: " + e.message);
  }

  const schema = await getFieldSchema();
  const columns = getColumns(schema);
  const sheetName = cfg.sheetName;
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheetId}`;

  // Check if header row exists.
  let headerPresent = false;
  try {
    const read = await sheetsApiCall(
      `${baseUrl}/values/${encodeURIComponent(sheetName)}!A1:${String.fromCharCode(65 + columns.length - 1)}1`,
      "GET",
      token
    );
    if (read.values && read.values.length > 0 && read.values[0].length > 0) {
      headerPresent = true;
    }
  } catch (e) {
    if (String(e.message).includes("400") || String(e.message).includes("404")) {
      await sheetsApiCall(`${baseUrl}:batchUpdate`, "POST", token, {
        requests: [{ addSheet: { properties: { title: sheetName } } }]
      });
    } else {
      throw e;
    }
  }

  if (!headerPresent) {
    await sheetsApiCall(
      `${baseUrl}/values/${encodeURIComponent(sheetName)}!A1?valueInputOption=RAW`,
      "PUT",
      token,
      { range: `${sheetName}!A1`, majorDimension: "ROWS", values: [columns] }
    );
  }

  // Append the data row.
  const row = columns.map((c) => record[c] ?? "");
  await sheetsApiCall(
    `${baseUrl}/values/${encodeURIComponent(sheetName)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    "POST",
    token,
    { values: [row] }
  );

  return { ok: true };
}

// --- Get default schema (used by options.js) ------------------------------

async function getDefaultFieldSchema() {
  return await loadDefaultSchema();
}

// --- Message listener -----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "EXTRACT_FIELDS_LLM") {
    // Kick off the job; the result lands in chrome.storage.session.extractionJob,
    // so the popup doesn't need to stay open for the response.
    runExtractionJob(msg.payload).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === "SAVE_TO_SHEET") {
    saveToGoogleSheet(msg.payload)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg?.type === "GET_DEFAULT_SCHEMA") {
    getDefaultFieldSchema()
      .then((schema) => sendResponse({ ok: true, schema }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
