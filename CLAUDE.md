# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome extension (Manifest V3) that extracts structured job-posting fields from the current tab or an uploaded PDF using an AI model, then appends the row to a Google Sheet. No build step, bundler, package manager, tests, or linter — plain HTML/CSS/JS loaded via `chrome://extensions` → "Load unpacked".

To pick up code changes: reload the extension in `chrome://extensions` (no compile step).

## Architecture

Three JS entry points communicate through `chrome.runtime.sendMessage`:

- **`background.js`** (service worker) — owns all network calls. Handles AI extraction (`EXTRACT_FIELDS_LLM`), Google Sheets append (`SAVE_TO_SHEET`), and serves the default schema (`GET_DEFAULT_SCHEMA`). It builds the AI prompt dynamically from the schema and dispatches to either `callAnthropic` or `callOpenAICompatible` based on the configured provider.
- **`popup.js`** — the action popup. Extracts text from the active tab (via `chrome.scripting.executeScript` with an injected function) or a PDF (via vendored `lib/pdf.min.mjs` + worker, max 15 pages, text truncated to 15 000 chars), then renders an editable form from the schema and submits the record to the background for saving.
- **`options.js`** — settings UI for provider config, Google Sheet ID/tab, and the field schema editor.

### Schema-driven design (the central concept)

`schema.json` is the single source of truth and drives three things in sync:
1. The AI extraction prompt — `buildSystemPrompt` in `background.js` emits a JSON template listing only non-`auto` fields (plus valid values for `select` fields).
2. The popup form — `buildFormFromSchema` in `popup.js` renders one input per field (`text`, `textarea`, `select`, `date`).
3. Google Sheets columns — `getColumns` maps `field.name` to column order; the header row is written on first save.

Editing the schema in Options (stored as a raw JSON string under `chrome.storage.sync.fieldSchema`) changes all three without touching code. `auto: true` fields (`save_date`, `source`, `url`) are filled client-side in `popup.js:populateForm` rather than by the AI — adding new auto fields requires adding the corresponding logic there. Field validation rules live in `options.js` (must have `name`, `label`, `type`; must be a non-empty array).

The default schema is fetched from `background.js` via `chrome.runtime.getURL("schema.json")` and cached in `_defaultSchemaCache` across messages within the service worker's lifetime.

### Storage model

All config lives in `chrome.storage.sync`. Provider-related keys are namespaced by provider: when switching, `options.js` clears the other provider's keys. The background's `readConfig` falls back across key names (e.g. `apiKey || anthropicApiKey`) so legacy values keep working.

### Provider abstraction

`callLLM` in `background.js` branches on `cfg.provider` (`"anthropic"` or `"openai_compatible"`). The Anthropic path uses the Messages API with `anthropic-dangerous-direct-browser-access: true`; the OpenAI-compatible path works with any `/chat/completions` endpoint (Z.ai, OpenAI, Groq, etc.). Both expect the model to return raw JSON (markdown fences are stripped before `JSON.parse`). Default Anthropic model: `claude-haiku-4-5-20251001`.

### Google Sheets flow

`saveToGoogleSheet` uses `chrome.identity.getAuthToken` (interactive) for OAuth, scoped to `https://www.googleapis.com/auth/spreadsheets` (declared in `manifest.json.oauth2`). On save it: checks for the header row, creates the tab via `:batchUpdate` if missing, writes the header if absent, then appends via `values/.../append` with `insertDataOption=INSERT_ROWS`. Existing user-added columns in the sheet are preserved — only schema columns are written.

## Setup gotcha

`manifest.json` ships with `oauth2.client_id` set to `INSERT_YOUR_CLIENT_ID_HERE.apps.googleusercontent.com`. The Google Sheets save flow will not work until this is replaced with a real OAuth client ID (Chrome Extension type) from Google Cloud Console, with the extension's 32-char ID as the item ID. See `README.md` §3.
