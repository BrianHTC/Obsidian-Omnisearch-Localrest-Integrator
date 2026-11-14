---
name: obsidian-omnisearch-mcp
version: 2.2.0
description: Search a live Obsidian vault through Omnisearch MCP using fast indexed previews, optional verified PDF mapping, direct preview opening, persistent PDF highlighting, and exact Markdown selection.
---

# Obsidian Omnisearch MCP

Use this skill for searching, inspecting, and opening current content in the user's Obsidian vault.

## Authority and routing

Use Obsidian MCP for current vault content, including current files, paths, matches, PDF pages, PDF selections, Markdown positions, and open results.

Use agent Knowledge only for extension installation, configuration, documentation, troubleshooting, security, and distribution. Do not query Knowledge during a live vault search unless the user explicitly asks to compare documentation with current vault content.

## Available tools

- `omnisearch_search`: ranked files and initial indexed previews.
- `omnisearch_file_occurrences`: verified occurrences for one exact path.
- `omnisearch_open_occurrence`: opens a verified occurrence or a fast-search preview.

## Fast initial search

For an ordinary search, call `omnisearch_search` immediately with:

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

Do not explain the plan first. Do not list the vault first. Do not retrieve full files merely to present search results.

If the user explicitly requests verified PDF viewer pages in the initial response, use:

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

## Presenting initial results

Begin with:

```text
Search target: `<exact user target>`
```

For a fast PDF result:

```text
File N: <summary>
Path: <exact path>

Preview M:
<context with exact match in `reverse type`>
```

For a verified PDF result:

```text
File N: <summary>
Path: <exact path>

Occurrence M - PDF viewer page P:
<context with exact match in `reverse type`>
```

For Markdown:

```text
Occurrence M:
<context with exact match in `reverse type`>
```

Display every returned item separately. Do not merge returned previews or occurrences. Do not output raw JSON unless requested.

A preview is an Omnisearch-indexed match. An occurrence is PDF.js-verified or Markdown-resolved. Never assume `Preview M = Occurrence M`.

### Indexed and verified counts

Verified PDF matching ignores whitespace and letter case, so it also finds matches split across PDF line breaks or extracted with spaces between CJK characters. The verified count can therefore differ from the indexed count.

If `matchCountStatus` is `different`, state both `omnisearchMatchCount` (indexed) and `pageMappedMatchCount` (verified). Neither count is an error.

## Requested item beyond the count

Before making another tool call, inspect the selected file's returned previews and counts.

If requested Preview M exists in `previewPreviews`, open it directly.

If Preview M was not returned but `omnisearchMatchCount` is at least M, retrieve more previews or verified occurrences as needed.

If `omnisearchMatchCount` is less than M, do not call `omnisearch_file_occurrences` merely to reconfirm absence. State that the indexed search returned fewer than M matches and offer the available range.

Call `omnisearch_file_occurrences` despite the indexed count only when:

- the user explicitly asks for verified or exhaustive PDF occurrences;
- the user explicitly asks to validate the indexed count against PDF.js;
- the indexed count is missing or unreliable;
- direct preview resolution returns `requiresVerifiedOccurrenceSelection: true`.

## Actions after a fast PDF result

Offer both:

```text
Open directly:
Enter `open file N preview M`

View verified occurrences:
Enter `verified occurrences for file N`
```

Offer direct opening only when `directPreviewOpenAvailable` is true. Files returned with `mapPdfPages: true` carry verified occurrences and no previews, so open them in verified-occurrence mode.

### Direct preview open

Call `omnisearch_open_occurrence` with:

```json
{
  "mode": "search-preview",
  "searchSessionId": "<returned session id>",
  "fileNumber": 1,
  "previewNumber": 2,
  "newLeaf": false
}
```

Do not send an invented path, PDF page, offset, occurrence number, selection, or destination.

The extension resolves a PDF preview server-side. It maps only the selected PDF, scores its verified occurrences against the preview, and uses the supplied `newLeaf` value. The normal value is false so Obsidian reuses the active workspace leaf.

On success the result includes `resolvedOccurrenceNumber`. Report it, so the user can see which verified occurrence the preview matched.

Treat `openedInNewLeaf` as descriptive output only. Do not require it to be true for successful preview resolution or persistent highlighting.

A Markdown preview that has a character offset resolves directly to an exact Markdown selection. Without an offset, the file opens without a selection.

### Ambiguous preview

If the tool returns `requiresVerifiedOccurrenceSelection: true` (`resolutionStatus` is `ambiguous` or `not-found`), call `omnisearch_file_occurrences` using the returned query and exact path. Display verified occurrences and ask the user to choose. Do not claim the preview opened.

### Expired preview

If the result contains `requiresNewSearch: true` or `resolutionStatus: expired-search-session`, repeat the original search. Search sessions expire after ten minutes and do not survive an Obsidian reload.

The statuses `file-not-found` and `omnisearch-result-not-found` also set `requiresNewSearch: true`. The file was moved or deleted, or the index changed.

## Verified occurrence list

Call `omnisearch_file_occurrences` with:

```json
{
  "query": "<original query>",
  "path": "<exact returned path>",
  "page": 1,
  "pageSize": 10,
  "contextLength": 120
}
```

Preserve returned numbering. Do not repeat earlier occurrences.

## Open a verified occurrence

Call:

```json
{
  "mode": "verified-occurrence",
  "query": "<original query>",
  "path": "<exact returned path>",
  "occurrenceNumber": 3,
  "newLeaf": false
}
```

Never pass an inferred page, offset, selection, or destination.

### One open at a time

Each open replaces the previous highlight. Call `omnisearch_open_occurrence` once per user request:

- never call it in parallel;
- never call it for several items in a row;
- never retry immediately after a highlight failure unless the user asks.

Rapid repeated opens of the same PDF can trigger a PDF.js rendering race.

## PDF page rules

Show `PDF viewer page N` only when `pageNumberVerified` is true and `pageNumber` is present.

Never infer a page from preview number, occurrence number, offset, match count, ranking, or file number.

If mapping status is `no-text-layer`, say:

```text
This PDF has no extractable text layer. Verified page mapping requires page-level OCR.
```

For `encrypted`, `worker-missing`, or `parse-failed`, report the returned mapping message without guessing. `worker-missing` means Obsidian's built-in PDF.js could not be loaded.

## Successful PDF open

Persistent highlighting is confirmed only when:

```json
{
  "persistentOverlayApplied": true,
  "highlightType": "plugin-persistent-overlay",
  "jumpedToDestination": true
}
```

Do not require `openedInNewLeaf` for successful highlighting.

Then report:

```text
Opened <path> at PDF viewer page <pageNumber> and persistently highlighted the exact matching passage. Use the Remove highlight button in the PDF view to clear it.
```

The highlight is designed to survive zooming and scrolling. It stays until the user clicks **Remove highlight** or another occurrence is opened.

## PDF open without a highlight

If the overlay fields are not confirmed, the PDF may still have opened at the verified page (`highlightType: page-only`). Report `openStatus` and `persistentOverlayMessage` exactly. Do not claim that the passage was highlighted.

Use the message to suggest the next step:

| `persistentOverlayMessage` | Suggest |
|---|---|
| `The PDF view for the target file could not be found.` | Close duplicate tabs of the same PDF, press `Ctrl+R`, then retry once. |
| `The page opened, but the target PDF text layer was unavailable.` | Close duplicate tabs of the same PDF, press `Ctrl+R`, then retry once. |
| `The matching text could not be located in the rendered text layer.` | The page is correct, but the passage could not be marked. Quote the verified context so the user can find it. |
| `The CSS Custom Highlight API is unavailable in this Obsidian build.` | Update Obsidian. |
| `A newer highlight request replaced this one.` | A later open superseded this one. No action needed. |

## Other open results

If `targetType` is `file` and `jumpedToDestination` is false, the file opened without exact navigation. Report `openStatus` and do not claim a page or position.

## Successful Markdown open

Exact Markdown selection is confirmed only when `targetType` is `markdown-selection`, `exactTextSelected` is true, and `jumpedToDestination` is true.

Then report:

```text
Opened <path> and selected the exact matching text.
```

## Pagination

If `showMoreFilesAvailable` is true, offer `more files` and call `omnisearch_search` with the original query, returned `nextFilePage`, and the same settings.

If `remainingOccurrenceCount` is greater than zero, offer `more occurrences for file N` and call `omnisearch_file_occurrences` with the exact path, returned next page, page size 10, and context length 120.

## Numeric replies

- After a file list, `1` means file 1.
- After previews for one file, `2` means preview 2.
- After verified occurrences, `3` means occurrence 3.
- If multiple meanings are plausible, ask which item the user means.

## MCP availability

Use only tools available in the current session. Do not test localhost, `127.0.0.1`, local ports, or `curl` from the cloud agent.

If tools are unavailable, say:

```text
The Obsidian MCP tools are not loaded in this session. Reconnect the Obsidian MCP tool and start a new session.
```

If `omnisearch_open_occurrence` rejects `mode`, `searchSessionId`, `fileNumber`, or `previewNumber`, the agent has a cached old tool schema. Ask the user to refresh or re-add the MCP connection, publish the agent, and start a new chat.

## Read and write separation

Search, read, summarize, compare, inspect, and open are read operations and must never trigger a write.

Write only when the user explicitly asks to append, add, save, record, log, write, or update a note. Preserve existing content and never claim success without a confirmed write result.

## Security and accuracy

Never request, display, repeat, store, log, or expose a Local REST API key or Authorization header.

Use MCP output as authoritative. Never invent files, paths, previews, occurrences, pages, selections, destinations, positions, open results, highlights, or writes.

## Performance policy

1. Use `mapPdfPages: false` for ordinary initial searches.
2. Return three initial previews per file.
3. Use context length 120.
4. Map only a selected PDF or an explicit verified-page request.
5. Reuse the returned search-session ID for direct preview opening.
6. Avoid repeated searches when the first result is sufficient.
7. Do not retrieve full files unless required by the task.
8. Repeated verified lookups on the same PDF are served from the plugin's cache, so moving between occurrence pages is cheap.
