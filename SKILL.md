---
name: obsidian-omnisearch-mcp
version: 1.0.0
description: Search the user's live Obsidian vault through Omnisearch MCP, paginate file and occurrence results, retrieve verified PDF viewer pages on demand, open exact PDF or Markdown occurrences, and keep read and write operations strictly separated.
---

# Obsidian Omnisearch MCP

Use this skill for requests to search, find, locate, inspect, list, open, summarize, or compare current content in the user's Obsidian vault.

The skill optimizes response time by using a two-stage workflow:

1. Return fast Omnisearch-ranked files and indexed previews.
2. Perform expensive PDF page mapping only for a selected PDF or when the user explicitly requests verified PDF pages.

## Authoritative data source

For live vault content, MCP tool output is authoritative for:

- file paths;
- ranked files;
- occurrences and contexts;
- PDF viewer pages;
- PDF text selections;
- Markdown positions;
- open-operation results;
- verified write results.

Do not use agent Knowledge instead of MCP for current vault content. Knowledge may be used only for extension installation, configuration, tool documentation, troubleshooting, security, and distribution.

Do not call both Knowledge and Omnisearch MCP for the same vault search unless the user explicitly requests a comparison between documentation and live vault content.

## Available MCP tools

### `omnisearch_search`

Use for the initial vault-wide search and additional file-result pages.

### `omnisearch_file_occurrences`

Use to retrieve an occurrence page for one exact file path returned by `omnisearch_search`.

### `omnisearch_open_occurrence`

Use to open one selected occurrence. The server resolves page, offset, native-selection metadata, and highlighting behavior from the original query, exact path, and occurrence number.

Never invent or pass a PDF page, character offset, selection index, or destination.

## Trigger conditions

Invoke this skill when the user asks to:

- search, find, locate, or look up vault content;
- show matching files or occurrences;
- retrieve more files or more occurrences;
- open a selected file occurrence;
- inspect or summarize content found in the vault;
- compare live content from vault files;
- find current PDF or Markdown content in Obsidian.

Do not invoke this skill for:

- generic questions unrelated to the vault;
- extension setup or troubleshooting questions that can be answered from approved Knowledge;
- requests that refer only to content already supplied in the conversation;
- write operations unless the user explicitly asks to write, append, save, record, log, add, or update.

## Fast initial search

For a normal initial vault search, call `omnisearch_search` immediately with:

```json
{
  "query": "<exact user query>",
  "page": 1,
  "pageSize": 10,
  "occurrencesPerFile": 3,
  "contextLength": 120,
  "mapPdfPages": false
}
```

Rules:

- Do not explain the search plan before calling the tool.
- Do not call a file-listing tool first unless the user explicitly asks to browse folders.
- Do not retrieve complete files merely to display search results.
- Normally make one initial search call.
- Make one targeted follow-up search only if the first result is empty, clearly incomplete, or the query is ambiguous.
- Treat initial PDF previews as indexed previews. Do not infer or display PDF pages when `mapPdfPages` is false.

## Initial search with verified PDF pages

If the user explicitly asks for verified PDF viewer pages in the initial result, call `omnisearch_search` with a smaller workload:

```json
{
  "query": "<exact user query>",
  "page": 1,
  "pageSize": 5,
  "occurrencesPerFile": 5,
  "contextLength": 120,
  "mapPdfPages": true
}
```

Do not silently enable verified page mapping for every ordinary search.

## Presenting search results

Begin with:

```text
Search target: `<exact user search target>`
```

Use inline-code styling as reverse type for:

- the visible search target;
- exact matched text in occurrence contexts;
- suggested user inputs.

This formatting is for chat display only. Never add backticks to MCP arguments or search queries.

For each file, use:

```text
File <fileNumber>: <displaySummary>
Path: <exact vault-relative path>
```

For a verified PDF occurrence, use:

```text
Occurrence <occurrenceNumber> - PDF viewer page <pageNumber>:
<context with the exact match in `reverse type`>
```

For Markdown or an unverified preview, use:

```text
Occurrence <occurrenceNumber>:
<context with the exact match in `reverse type`>
```

Display every returned file and every returned occurrence separately. If the tool returns 10 occurrences, display all 10. Do not merge occurrences into a summary. Do not output raw JSON unless requested.

If the context already contains inline code, use bold for the exact match. Do not use HTML, CSS, ANSI escapes, or Unicode inversion characters.

## PDF page rules

Show a PDF page only when:

- `pageNumberVerified` is `true`; and
- `pageNumber` is present.

Describe it as `PDF viewer page N`. The viewer page may differ from a page number printed inside the document.

Never infer a PDF page from:

- `characterOffset`;
- `pageCharacterOffset`;
- `occurrenceNumber`;
- `fileNumber`;
- match counts;
- ranking;
- `fileResultPage`;
- `occurrencePage`.

If verification is unavailable, omit the page field. Do not display `Unknown`, `N/A`, `null`, `undefined`, or an empty page value.

Interpret the following fields accurately:

- `pageNumberSource: pdfjs-page-text` means page-level PDF mapping.
- `exactSelectionAvailable: true` means the extension mapped an exact PDF text selection.
- `selectionSource: pdfjs-text-items` means the selection came from PDF.js text items.
- `nativeDestination` is metadata and may contain an exact `&selection=` destination.
- `omnisearchMatchCount` is reported by Omnisearch.
- `pageMappedMatchCount` is reported by the PDF page-mapping layer.

The two counts may differ because text normalization differs. Do not conceal the difference or treat either count as a page number.

If `pdfPageMappingStatus` is `no-text-layer`, state:

```text
This PDF has no extractable text layer. Verified page mapping requires page-level OCR.
```

For `encrypted`, `worker-missing`, or `parse-failed`, report `pageMappingMessage` without guessing a page or selection.

## More files

If `showMoreFilesAvailable` is `true`, offer:

```text
More files:
Enter `more files`
```

When requested, call `omnisearch_search` with:

- the original query;
- `page: nextFilePage`;
- the same `pageSize`;
- the same `occurrencesPerFile`;
- the same `contextLength`;
- the same `mapPdfPages` mode.

Do not repeat previously displayed files.

## More occurrences

If `remainingOccurrenceCount` is greater than zero, offer:

```text
More occurrences:
Enter `more occurrences for file N`
```

When requested, call `omnisearch_file_occurrences` with:

```json
{
  "query": "<original query>",
  "path": "<exact returned vault-relative path>",
  "page": "<nextOccurrencePage>",
  "pageSize": 10,
  "contextLength": 120
}
```

This is the preferred point to perform PDF page mapping for one selected PDF.

Preserve returned occurrence numbering. Do not restart page 2 at occurrence 1 and do not repeat earlier occurrences.

## Opening a result

After presenting occurrences, offer:

```text
Open a destination:
Enter `open file N occurrence M`
```

When requested, call `omnisearch_open_occurrence` with:

```json
{
  "query": "<original query>",
  "path": "<exact vault-relative path>",
  "occurrenceNumber": "<selected occurrence number>",
  "newLeaf": false
}
```

Do not pass an invented page, offset, selection, or destination.

### Successful PDF open

Persistent PDF highlighting is confirmed only when:

- `persistentOverlayApplied` is `true`; and
- `highlightType` is `plugin-persistent-overlay`; and
- `jumpedToDestination` is `true`.

Then report:

```text
Opened <path> at PDF viewer page <pageNumber> and persistently highlighted the exact matching passage.
```

The extension opens only the verified page during viewer initialization, applies a plugin-owned persistent yellow highlight after rendering, and displays a floating **Remove highlight** button. The automatic built-in PDF Find fallback is disabled in the stable version.

Do not claim persistent highlighting from `nativeDestination`, `exactSelectionAvailable`, `nativeSelectionApplied`, `highlightedMatches`, or `pageNumberVerified` alone. Treat `openStatus` as authoritative.

### Successful Markdown open

Exact Markdown selection is confirmed only when:

- `targetType` is `markdown-selection`;
- `exactTextSelected` is `true`; and
- `jumpedToDestination` is `true`.

Then report:

```text
Opened <path> and selected the exact matching text.
```

Report line and column only when returned. Otherwise, state accurately that the file opened but exact selection was unavailable.

## Numeric replies

Interpret a short numeric reply from immediate context:

- After a file list, `1` means file 1.
- After occurrences for one file, `3` means occurrence 3.
- If file and occurrence meanings are both plausible, ask which one the number refers to.

Do not guess when ambiguous.

## MCP availability

Use only tools available in the current session.

Do not test:

- `localhost`;
- `127.0.0.1`;
- ports `27123` or `27124`;
- local `curl` commands from the cloud agent environment.

If the tools are unavailable, state:

```text
The Obsidian MCP tools are not loaded in this session. Reconnect the Obsidian MCP tool and start a new session.
```

Do not claim that a connection test was performed unless a tool returned that result. Do not provide speculative troubleshooting unless asked.

## Read and write separation

Searching, reading, summarizing, comparing, inspecting, and opening are read operations. They must never trigger a write.

Write only when the user explicitly asks to append, add, save, record, log, write, or update a note.

For an explicit write request:

1. Identify the exact content and exact vault-relative destination path.
2. Use an exact path supplied by the user.
3. If only a title is supplied, search only as needed to resolve the path.
4. If multiple paths remain plausible, ask the user to choose.
5. Preserve existing content.
6. Add only the requested content and necessary line breaks.
7. Add no headings, timestamps, labels, or commentary unless requested.
8. Never append search snippets unless requested.
9. Never expose credentials.
10. Never claim success unless the write tool confirms success.

After verified success, report:

```text
Status: appended successfully
Note: <exact vault-relative path>
Added: <concise description>
```

## Security

Never request, display, repeat, store, log, or expose a Local REST API key or Authorization header.

Never place credentials in:

- tool arguments;
- search queries;
- responses;
- source code;
- URLs;
- file paths;
- notes;
- logs.

## Accuracy

Use actual MCP output as authoritative. Never invent files, paths, occurrences, excerpts, pages, selections, destinations, line numbers, tool calls, opens, highlights, or successful writes.

## Performance policy

Optimize for low latency without sacrificing truthful output:

1. Use `mapPdfPages: false` for ordinary initial searches.
2. Return at most three initial occurrence previews per file.
3. Use `contextLength: 120` for initial and follow-up results.
4. Map PDF pages only for a selected PDF or an explicit verified-page request.
5. Reuse the original query and exact returned path.
6. Avoid repeated searches when the first result is sufficient.
7. Do not call Knowledge during a live vault search.
8. Do not retrieve full files unless the user's task requires full-file content.
