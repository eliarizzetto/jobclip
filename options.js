// options.js

const elProvider = document.getElementById("provider");
const elAnthropicFields = document.getElementById("anthropicFields");
const elOpenAIFields = document.getElementById("openaiCompatibleFields");
const elAnthropicApiKey = document.getElementById("anthropicApiKey");
const elAnthropicModel = document.getElementById("anthropicModel");
const elOaiEndpoint = document.getElementById("oaiEndpoint");
const elOaiApiKey = document.getElementById("oaiApiKey");
const elOaiModel = document.getElementById("oaiModel");
const elSpreadsheetId = document.getElementById("spreadsheetId");
const elSheetName = document.getElementById("sheetName");
const elFieldSchema = document.getElementById("fieldSchema");
const elStatus = document.getElementById("status");
const elForm = document.getElementById("optionsForm");
const btnResetSchema = document.getElementById("btnResetSchema");

// Provider switching
function switchProviderUI(provider) {
  if (provider === "anthropic") {
    elAnthropicFields.classList.add("active");
    elOpenAIFields.classList.remove("active");
  } else {
    elAnthropicFields.classList.remove("active");
    elOpenAIFields.classList.add("active");
  }
}

elProvider.addEventListener("change", () => switchProviderUI(elProvider.value));

// Load settings
async function load() {
  const cfg = await chrome.storage.sync.get([
    "provider",
    "apiKey",
    "apiEndpoint",
    "modelName",
    "anthropicApiKey",
    "anthropicModel",
    "spreadsheetId",
    "sheetName",
    "fieldSchema"
  ]);

  const provider = cfg.provider || "anthropic";
  elProvider.value = provider;
  switchProviderUI(provider);

  // Anthropic fields
  elAnthropicApiKey.value = cfg.anthropicApiKey || "";
  elAnthropicModel.value = cfg.anthropicModel || "claude-haiku-4-5-20251001";

  // OpenAI compatible fields
  elOaiEndpoint.value = cfg.apiEndpoint || "";
  elOaiApiKey.value = (provider === "openai_compatible" ? cfg.apiKey : "") || "";
  elOaiModel.value = (provider === "openai_compatible" ? cfg.modelName : "") || "";

  // Google Sheet fields
  elSpreadsheetId.value = cfg.spreadsheetId || "";
  elSheetName.value = cfg.sheetName || "Job Postings";

  // Field schema
  if (cfg.fieldSchema) {
    elFieldSchema.value = cfg.fieldSchema;
  } else {
    await loadDefaultSchema();
  }
}

async function loadDefaultSchema() {
  const response = await chrome.runtime.sendMessage({ type: "GET_DEFAULT_SCHEMA" });
  if (response?.schema) {
    elFieldSchema.value = JSON.stringify(response.schema, null, 2);
  }
}

btnResetSchema.addEventListener("click", async (e) => {
  e.preventDefault();
  await loadDefaultSchema();
});

// Save settings
elForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Validate JSON schema
  let schema;
  try {
    schema = JSON.parse(elFieldSchema.value);
  } catch {
    elStatus.textContent = "Invalid JSON in Field Schema. Please fix and try again.";
    elStatus.className = "status error";
    return;
  }

  if (!Array.isArray(schema) || schema.length === 0) {
    elStatus.textContent = "Field Schema must be a non-empty JSON array.";
    elStatus.className = "status error";
    return;
  }

  // Validate field entries
  for (const field of schema) {
    if (!field.name || !field.label || !field.type) {
      elStatus.textContent = `Field missing required properties (name, label, type): ${JSON.stringify(field).slice(0, 80)}`;
      elStatus.className = "status error";
      return;
    }
  }

  const provider = elProvider.value;
  const data = {
    provider: provider,
    spreadsheetId: elSpreadsheetId.value.trim(),
    sheetName: elSheetName.value.trim() || "Job Postings",
    fieldSchema: elFieldSchema.value
  };

  if (provider === "anthropic") {
    data.anthropicApiKey = elAnthropicApiKey.value.trim();
    data.anthropicModel = elAnthropicModel.value;
    data.apiKey = "";
    data.apiEndpoint = "";
    data.modelName = "";
  } else {
    data.apiKey = elOaiApiKey.value.trim();
    data.apiEndpoint = elOaiEndpoint.value.trim();
    data.modelName = elOaiModel.value.trim();
    data.anthropicApiKey = "";
    data.anthropicModel = "claude-haiku-4-5-20251001";
  }

  await chrome.storage.sync.set(data);
  elStatus.textContent = "Settings saved.";
  elStatus.className = "status success";
  setTimeout(() => {
    elStatus.textContent = "";
    elStatus.className = "status";
  }, 2500);
});

load();
