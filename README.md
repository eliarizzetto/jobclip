# Job Tracker - Job Posting Collector Extension

A Chrome extension (Manifest V3) that:

1. Reads the text of the open web page (or a PDF, either open in the browser or uploaded from your computer);
2. Sends it to an AI model (Anthropic Claude, Z.ai GLM, or any OpenAI-compatible API) asking it to extract the relevant job posting fields (company, title, salary, work mode, deadline, etc.) in structured format;
3. Shows the extracted fields in a small editable form before saving;
4. Saves the row to a Google Sheet that acts as a "database" of all collected postings.

No data is sent to third-party servers other than your chosen AI provider (for extraction) and Google (for saving): keys/credentials remain stored only locally in your browser (`chrome.storage.sync`).

---

## 1. Extension Installation (developer mode)

1. Open Chrome and go to `chrome://extensions`.
2. Enable "Developer mode" (toggle in the top right).
3. Click "Load unpacked" and select the `job-tracker-extension` folder (this folder).
4. The extension will appear in the list named "Job Tracker - Job Posting Collector". **Note the extension ID** (a 32-character string shown below the name): you'll need it in step 3.

At this point the extension is installed but not yet configured: you need to set the AI provider API key and the Google Sheets connection.

---

## 2. Configuring the AI Provider

The extension supports two provider types:

### Anthropic (Claude)

1. Go to <https://console.anthropic.com/settings/keys> and create an API key (an Anthropic account with credit/payment method is required; extracting one posting costs a fraction of a cent with the Haiku model).
2. Click the extension icon in the Chrome toolbar, then the gear icon in the top right of the popup (or right-click the extension icon -> "Options").
3. Select "Anthropic (Claude)" as provider and paste the API key. The default model (Claude Haiku 4.5) is recommended: fast and cheap. You can switch to Sonnet 4.6 if extraction is imprecise on complex postings.

### OpenAI Compatible (Z.ai, OpenAI, Groq, Together, etc.)

1. In the extension Options, select "OpenAI Compatible" as provider.
2. Enter the chat completions endpoint URL. Examples:
   - **Z.ai**: `https://open.bigmodel.cn/api/paas/v4/chat/completions` or `https://api.z.ai/api/coding/paas/v4/chat/completions` for the Coding Plan.
   - **OpenAI**: `https://api.openai.com/v1/chat/completions`
   - **Groq**: `https://api.groq.com/openai/v1/chat/completions`
3. Enter your API key and model name (e.g. `glm-5.1`, `gpt-4o`, `llama-3.3-70b`).

---

## 3. Configuring Google Sheets Access (OAuth)

This is the most "technical" step but only needs to be done once.

### 3.1 Create a Google Cloud project and enable APIs

1. Go to <https://console.cloud.google.com/> and create a new project (or use an existing one).
2. In the menu, go to **APIs & Services -> Library**, search for "Google Sheets API" and click **Enable**.

### 3.2 Configure the OAuth consent screen

1. Go to **APIs & Services -> OAuth consent screen**.
2. User type: **External** is fine for personal use.
3. Fill in the required fields (app name, support email, etc.) - you can use generic data, it's for personal use only.
4. In the **Scopes** section, add the scope `https://www.googleapis.com/auth/spreadsheets`.
5. In the **Test users** section, add your Gmail address (while the app is in "Testing" status, only listed test users can authorize it).

### 3.3 Create OAuth credentials for the extension

1. Go to **APIs & Services -> Credentials -> Create credentials -> OAuth client ID**.
2. As "Application type" choose **Chrome Extension**.
3. In "Item ID" enter the **extension ID** you noted in step 1 (32 characters).
4. Create the credentials: you'll get a **Client ID** like `1234567890-abcdefg.apps.googleusercontent.com`.

### 3.4 Insert the Client ID in the manifest

1. Open the `manifest.json` file of this extension with a text editor.
2. Replace the placeholder value:
   ```json
   "oauth2": {
     "client_id": "INSERT_YOUR_CLIENT_ID_HERE.apps.googleusercontent.com",
     ...
   }
   ```
   with the Client ID obtained in step 3.3.
3. Go back to `chrome://extensions` and click the reload icon of the extension to apply the change.

> Note: if you uninstall and reinstall the "unpacked" extension from a different folder in the future, the extension ID might change, in which case it must be updated in Google Cloud Console (step 3.3) and the authorization flow must be repeated.

---

## 4. Create the Destination Google Sheet

1. Create a new Google Sheet (it can be empty, column headers are created automatically on first save).
2. Copy the sheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/`**`ID_HERE`**`/edit`
3. In the extension Options (gear icon), paste the ID in the "Google Sheet ID" field and optionally customize the tab name (default "Job Postings").
4. Save settings.

The first time you save a posting, Chrome will ask you to authorize the extension to access Google Sheets with your account: accept (you may see an "unverified app" warning because the app is in test mode - this is normal for personal projects, click "Advanced" -> "Go to... (unsafe)" to proceed, since you are the app creator).

---

## 5. Configuring the Field Schema

The extension uses a JSON schema to define which fields are extracted and saved. You can fully customize it from the Options page.

### Schema format

The schema is a JSON array of field objects:

```json
[
  {
    "name": "company",
    "label": "Company / Organization",
    "type": "text",
    "placeholder": "e.g. Acme Corp",
    "aiDescription": "name of the company or organization posting the job",
    "readonly": false,
    "auto": false
  },
  {
    "name": "experience_level",
    "label": "Experience Level",
    "type": "select",
    "options": [
      { "value": "not_specified", "label": "Not specified" },
      { "value": "junior", "label": "Junior" },
      { "value": "mid", "label": "Mid" },
      { "value": "senior", "label": "Senior" }
    ],
    "aiDescription": "one of: junior, mid, senior, not_specified",
    "readonly": false,
    "auto": false
  }
]
```

### Field properties

| Property | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Internal identifier. Used as column header in Google Sheets and form field name. |
| `label` | Yes | Display label shown in the popup form. |
| `type` | Yes | Input type: `text`, `textarea`, `select`, or `date`. |
| `options` | For `select` | Array of `{value, label}` objects defining the dropdown options. |
| `placeholder` | No | Placeholder text for the input field. |
| `aiDescription` | No | Description included in the AI extraction prompt. Fields without this won't be extracted by AI. |
| `readonly` | No | If `true`, the field is read-only in the form. |
| `auto` | No | If `true`, the value is auto-generated (not sent to AI for extraction). |

### Auto-generated fields

The default schema includes three auto-generated fields:
- **save_date** - set to the current date when saving
- **source** - hostname extracted from the posting URL
- **url** - the full page URL

You can remove or modify these, or add new auto fields. Custom auto fields will be left empty unless you also modify the popup logic.

### How to edit

1. Open the extension Options page.
2. Scroll to the "Field Schema" section.
3. Edit the JSON in the textarea.
4. Click "Save settings". The schema is validated before saving.
5. Use "Reset to default" to restore the original schema.

---

## 6. Usage

### From a web page (LinkedIn, Glassdoor, company website...)

1. Open the job posting in the active tab.
2. Click the extension icon -> "Extract from current page".
3. Wait a few seconds (page reading + AI call).
4. Review/edit the pre-filled fields in the form.
5. Click "Save to Google Sheet".

### From a PDF open in the browser

If the PDF is open as a browser tab (e.g. you clicked a PDF link), it works the same way: click "Extract from current page" and the extension will download and process the PDF.

### From a PDF saved on your computer

Click "Upload a PDF from your computer" and select the file: text is extracted locally (no file upload, only the extracted text is sent to the AI model for structuring).

---

## 7. Data Structure

Each row in the Google Sheet contains columns defined by your field schema. The default schema includes:

| Column | Description |
|--------|-------------|
| save_date | Date you saved the posting |
| company | Company/organization name |
| job_title | Position title |
| experience_level | junior / mid / senior / lead_manager / not_specified |
| contract_type | e.g. permanent, fixed-term, internship... |
| work_mode | remote / hybrid / onsite / not_specified |
| location | City/country |
| salary_min | Minimum annual salary (number) |
| salary_max | Maximum annual salary (number) |
| currency | EUR, USD, etc. |
| salary_notes | Notes on compensation/benefits |
| publish_date | Posting publish date |
| deadline | Application deadline |
| skills | List of skills/technologies |
| summary | Brief position summary |
| notes | Other relevant information |
| source | Website domain (e.g. linkedin.com) |
| url | Full posting URL |

You can add custom columns by editing the field schema. You can also manually add columns directly in the Google Sheet (e.g. "application_status", "cv_sent_date", "priority") without the extension overwriting them: the append only adds the schema-defined columns in order.

---

## 8. Known Limitations

- AI extraction can make mistakes, especially on poorly structured or very long postings: always review fields before saving.
- Pages protected by complex login (e.g. some LinkedIn sections behind paywall) may show only a preview of the text: extraction works on the actually visible text.
- Very long PDFs are read only in the first 15 pages (usually sufficient for a job posting).
- The extension doesn't work on `chrome://` pages, the Web Store, or other browser "protected" pages (Chrome security limitation).
- For PDFs opened from local files (`file:///...pdf`), Chrome requires manually enabling "Allow access to file URLs" in the extension details (`chrome://extensions` -> Job Tracker -> Details).
