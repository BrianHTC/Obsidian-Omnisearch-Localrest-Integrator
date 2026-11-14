# Omnisearch MCP

Omnisearch MCP is an Obsidian plugin that lets an AI agent search your vault with [Omnisearch](https://github.com/scambier/obsidian-omnisearch) and open results inside Obsidian. It connects through the MCP server of [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api).

For PDFs it can:

- confirm the real viewer page of each match;
- open the PDF at that page;
- keep the matching passage highlighted in yellow until you remove it.

For Markdown notes it opens the note and selects the exact matching text.

- **Version:** 2.2.0
- **Author:** 黃鼎鈞
- **Desktop only**

---

## Requirements

| Component | Version |
|---|---|
| Obsidian | 1.0.0 or later (desktop). Persistent highlighting also needs the CSS Custom Highlight API, which recent Obsidian builds include. |
| [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) | 5.3.0 or later (extension API version 3) |
| [Omnisearch](https://github.com/scambier/obsidian-omnisearch) | Installed, enabled and indexed. To search inside PDFs, turn on PDF indexing in Omnisearch's settings. |

PDF text is read with the PDF.js library built into Obsidian, so no extra PDF package or worker file is needed.

---

## Installation

1. Copy these files into `<vault>/.obsidian/plugins/omnisearch-mcp/`:
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. In **Settings → Community plugins**, enable **Local REST API**, **Omnisearch** and **Omnisearch MCP**.
3. Connect your MCP client to Local REST API's MCP endpoint:
   - URL: `http://127.0.0.1:27123/mcp/` (HTTP port) or `https://127.0.0.1:27124/mcp/` (HTTPS port)
   - Header: `Authorization: Bearer <your API key>`
   - Transport: Streamable HTTP

The three tools below appear next to Local REST API's own tools.

---

## MCP tools

### `omnisearch_search`

Searches the vault and returns ranked files with match previews.

| Argument | Default | Range | Meaning |
|---|---|---|---|
| `query` | (required) | | Search text |
| `page` | `1` | ≥ 1 | Page of file results |
| `pageSize` | `10` | 1–10 | Files per page |
| `occurrencesPerFile` | `3` | 1–10 | Previews per file |
| `contextLength` | `120` | 40–500 | Characters of context around each match |
| `mapPdfPages` | `false` | | `true` also confirms the PDF viewer page of each PDF match (slower) |

With `mapPdfPages: false` (the fast default):

- PDFs are not opened; results come straight from the Omnisearch index.
- Each match is a **Preview** without a page number.
- The response includes a `searchSessionId` that stays valid for 10 minutes (`searchSessionExpiresInSeconds: 600`), so a preview can be opened later.

With `mapPdfPages: true`, PDF matches become verified **Occurrences** with confirmed `pageNumber` values.

### `omnisearch_file_occurrences`

Lists the matches in one file, page by page.

| Argument | Default | Range |
|---|---|---|
| `query` | (required) | |
| `path` | (required, the exact path from search results) | |
| `page` | `1` | ≥ 1 |
| `pageSize` | `10` | 1–10 |
| `contextLength` | `120` | 40–500 |

- **PDFs:** every match is verified against the PDF text, with its viewer page and the text position needed for highlighting.
- **Markdown:** matches include their character offset in the note.

### `omnisearch_open_occurrence`

Opens one match in Obsidian. It has two modes.

**Open a verified occurrence:**

```json
{ "mode": "verified-occurrence", "query": "Directive", "path": "Untitled/page.pdf", "occurrenceNumber": 10, "newLeaf": false }
```

**Open a preview from a fast search:**

```json
{ "mode": "search-preview", "searchSessionId": "<from omnisearch_search>", "fileNumber": 1, "previewNumber": 2, "newLeaf": false }
```

`newLeaf: true` opens the file in a new tab. The default, `false`, reuses the current tab.

> **Preview M is not Occurrence M.** Preview numbers follow the Omnisearch index, while occurrence numbers follow the verified PDF text. The plugin maps a preview to the right occurrence for you.

---

## How a PDF match is opened

1. The plugin opens the PDF at the verified page only (`file.pdf#page=N`).
2. It waits up to 10 seconds for the page's text to render.
3. It highlights the exact passage in yellow and scrolls it into view.
4. A **Remove highlight** button appears in the bottom-right corner of the PDF view.

Details:

- The highlight is redrawn automatically if PDF.js re-renders the page, for example after zooming or scrolling away and back.
- It stays until you click **Remove highlight** or open another match.
- The plugin never uses Obsidian's built-in PDF Find. That avoids the PDF.js `injectLinkAnnotations` rendering error.

### Opening a preview directly

In `search-preview` mode the plugin:

1. reads only the selected PDF;
2. compares the preview with every verified occurrence in that file;
3. opens the best match only when it is clearly better than the rest.

The scoring adds up to:

- +100 when the matched text is identical;
- up to +100 for similar surrounding text;
- up to +10 for a similar position in the file.

It opens the best match only when the score is at least 120 **and** leads the next candidate by at least 8. Otherwise the result is:

```json
{ "opened": false, "resolutionStatus": "ambiguous", "requiresVerifiedOccurrenceSelection": true }
```

In that case, list the file's occurrences with `omnisearch_file_occurrences` and open the chosen one.

### Reading the result

A PDF highlight succeeded when all three of these hold:

```json
{ "persistentOverlayApplied": true, "highlightType": "plugin-persistent-overlay", "jumpedToDestination": true }
```

If `persistentOverlayApplied` is `false`, the PDF may still be open at the right page. `persistentOverlayMessage` says why the highlight failed:

| `persistentOverlayMessage` | What to do |
|---|---|
| `The PDF view for the target file could not be found.` | Close duplicate tabs of the same PDF, press `Ctrl+R`, and try again. |
| `The page opened, but the target PDF text layer was unavailable.` | Same as above. Very large pages may also need longer to render. |
| `The matching text could not be located in the rendered text layer.` | The page is correct, but the passage could not be marked. |
| `The CSS Custom Highlight API is unavailable in this Obsidian build.` | Update Obsidian. |
| `A newer highlight request replaced this one.` | A later open request took over. No action needed. |

`openedInNewLeaf` only describes what happened. It is not part of the success check.

### Markdown

A Markdown match opens the note and selects the exact text. Success looks like:

```json
{ "targetType": "markdown-selection", "exactTextSelected": true, "jumpedToDestination": true }
```

### Other results

| Field | Meaning |
|---|---|
| `resolutionStatus: expired-search-session` with `requiresNewSearch: true` | The 10-minute preview session ended or Obsidian was reloaded. Search again. |
| `targetType: file` | The file opened, but no exact position was available. |

---

## How PDF matching works

- Matching ignores spaces, line breaks and letter case. A word split across lines, or Chinese/Japanese text extracted with spaces between characters (`司 法 院`), still matches (`司法院`).
- Because of this, the verified count can differ from Omnisearch's count. Searches with `mapPdfPages: true` show both, as `omnisearchMatchCount` and `pageMappedMatchCount`, with `matchCountStatus` set to `same` or `different`.
- Results are cached in memory while Obsidian runs:
  - **Page text:** up to 10 PDFs.
  - **Search results:** up to 30 query/file combinations.
- Caches are keyed by the file's path, modification time and size, so editing or replacing a PDF invalidates its entries automatically.
- Each PDF result reports a mapping `status`:

| `status` | Meaning |
|---|---|
| `mapped` | Text was read and searched. |
| `no-text-layer` | The PDF has no text (for example a scanned image). Run OCR first. |
| `encrypted` | The PDF is password-protected. |
| `worker-missing` | Obsidian's built-in PDF.js could not be loaded. |
| `parse-failed` | The PDF could not be read. `pageMappingMessage` has the details. |

---

## Using it with an AI agent

`SKILL.md` in this folder tells an agent how to use the tools. It covers:

- the fast-search defaults;
- how to label Previews and Occurrences;
- when to fall back to verified occurrences;
- how to report highlight results.

Recommended defaults for an ordinary search:

```json
{ "page": 1, "pageSize": 10, "occurrencesPerFile": 3, "contextLength": 120, "mapPdfPages": false }
```

When the user explicitly asks for verified PDF pages up front:

```json
{ "page": 1, "pageSize": 5, "occurrencesPerFile": 5, "contextLength": 120, "mapPdfPages": true }
```

Send one open request at a time. Rapid repeated opens of the same PDF can trigger PDF.js rendering errors.

### After changing the plugin

MCP clients cache tool definitions. After updating `main.js`:

1. Turn **Omnisearch MCP** and **Local REST API** off and on again, then press `Ctrl+R`.
2. In your agent platform (for example Copilot Studio), refresh or re-add the MCP connection, then save and publish.
3. Start a new chat.

If `omnisearch_open_occurrence` rejects `mode` or `searchSessionId`, the client is still using the old definitions.

---

## Building from source

```powershell
npm.cmd install          # first time only
npm.cmd run typecheck    # tsc -noEmit -skipLibCheck
npm.cmd run build        # type-check, then bundle src/main.ts into main.js
npm.cmd run dev          # rebuild main.js on every change
```

Obsidian does not reload a plugin when `main.js` changes. After a rebuild, toggle the plugin off and on or press `Ctrl+R`.

Tested with TypeScript 5.9.3, obsidian 1.13.1, esbuild 0.28.0, zod 3.25.76, obsidian-local-rest-api 5.3.0 and Node 26.12.1.

### Source layout

| File | Purpose |
|---|---|
| `src/main.ts` | Plugin entry point. Connects to Local REST API (`getAPI`, extension API version 3) and registers everything. |
| `src/context.ts` | Shared context: `app`, `pluginId`, `pluginDirectory`, `events`. |
| `src/mcp.ts` | The three MCP tools, their input schemas, preview scoring and the open logic. |
| `src/search-session.ts` | Stores previews for 10 minutes (up to 20 searches) so they can be opened later. |
| `src/pdf-util.ts` | Reads PDF text with Obsidian's PDF.js, finds and verifies matches, and caches the results. |
| `src/pdf-highlight.ts` | Draws the persistent highlight, redraws it after re-renders, and provides the Remove highlight button. |
| `styles.css` | Yellow highlight colour and Remove highlight button style. |
| `SKILL.md` | Instructions for AI agents. |

### Checking a build

These strings should all be present in `main.js`:

```powershell
$patterns = "omnisearch_search","omnisearch_file_occurrences","omnisearch_open_occurrence",
  "search-preview","searchSessionId","requiresVerifiedOccurrenceSelection",
  "createPdfQueryCacheKey","plugin-persistent-overlay","Remove highlight","markdown-selection"
foreach ($p in $patterns) { "{0} : {1}" -f $p, (Select-String -Path .\main.js -SimpleMatch -Pattern $p -Quiet) }
```

`styles.css` must contain exactly one `::highlight(omnisearch-mcp-pdf-target)` rule. Extra rules make the highlight colours mix.

---

## Template leftovers

This plugin started from the Local REST API sample extension, and `src/main.ts` still registers the sample's other features:

| Feature | Address | Source |
|---|---|---|
| Vault statistics (API key required) | `GET /sample-extension/stats/` | `src/routes.ts` |
| Ping (no API key) | `GET /sample-extension/ping/` | `src/routes.ts` |
| Per-note statistics | `GET /vault/<note>/stats/`, `GET /active/stats/` | `src/vaultSubresource.ts` |
| Event streams | `note-measured`, `css-change` | `src/events.ts` |
| OpenAPI docs for the routes above | `/openapi.yaml` | `src/openapi.ts` |

They do not affect searching. To remove them, delete the matching `register…` calls in `src/main.ts` and rebuild.

The sample's Jest tests (`npm test`, `src/*.test.ts`) were written for the sample and do not cover the Omnisearch tools.

---

## Known issues

- The description of `omnisearch_open_occurrence` still says it falls back to Obsidian's built-in PDF search. It does not; that fallback is disabled on purpose.
- `src/mcp.ts` contains two unused helpers left over from that fallback: `startPersistentPdfSearch` and `waitForPdfView`.
- If the same PDF is open in several tabs, the plugin highlights the most recently used tab if it shows that PDF, and otherwise a visible tab of that PDF. Close duplicate tabs if the highlight lands in the wrong one.

---

## Security

- Every MCP tool goes through Local REST API's normal authentication. This plugin adds no unauthenticated access to vault content.
- The template's `/sample-extension/ping/` route is public, but it returns no vault data.
- Never put your Local REST API key in prompts, notes or logs.
- The tools only read, open and highlight files. They never change vault content.

---

## Changelog

### 2.2.0

- Fast search by default: Omnisearch previews with a 10-minute `searchSessionId`; PDFs are not opened.
- New `search-preview` mode for `omnisearch_open_occurrence`, which maps a preview to a verified occurrence and refuses to guess when the match is unclear.
- Verified PDF pages and text positions, using Obsidian's built-in PDF.js.
- Caching of PDF page text and search results.
- Persistent yellow highlight with automatic redraw and a **Remove highlight** button.
- PDFs open at the page only; built-in PDF Find is no longer used.
- `newLeaf` is respected for every open; nothing forces a new tab.
- Exact text selection for Markdown matches.

### 1.1.0

- Earlier release: search, occurrences and opening results, without previews, verified-page caching or persistent highlighting.

---

## Credits

- [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) and its sample API extension, by Adam Coddington (MIT).
- [Omnisearch](https://github.com/scambier/obsidian-omnisearch) by scambier.
- [PDF.js](https://mozilla.github.io/pdf.js/) by Mozilla, as bundled with Obsidian.

`LICENSE` is the MIT licence inherited from the sample extension (Copyright (c) 2023, Adam Coddington).
