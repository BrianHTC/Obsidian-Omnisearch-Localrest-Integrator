import { MarkdownView, TFile, normalizePath } from "obsidian";
import type { LocalRestApiPublicApi } from "obsidian-local-rest-api";
import { z } from "zod";
import type { ExtensionContext } from "./context";
import {
  findPdfTextOccurrences,
  type PdfSearchResult,
  type PdfTextOccurrence,
} from "./pdf-util";

import {
	applyPersistentPdfHighlight,
	clearPersistentPdfHighlight,
} from "./pdf-highlight";
import {
	createSearchSession,
	getSearchPreview,
	type SearchPreviewInput,
	type SearchPreviewReference,
} from "./search-session";

export const OMNISEARCH_SEARCH_TOOL = "omnisearch_search";
export const OMNISEARCH_OCCURRENCES_TOOL = "omnisearch_file_occurrences";
export const OMNISEARCH_OPEN_OCCURRENCE_TOOL = "omnisearch_open_occurrence";

type OmniMatch = { match?: string; offset?: number };
type OmniResult = {
  score?: number;
  vault?: string;
  path?: string;
  basename?: string;
  foundWords?: string[];
  matches?: OmniMatch[];
  excerpt?: string;
};
type OmniPlugin = {
  api?: { search?: (query: string) => Promise<OmniResult[]> };
};

type PdfFindState = {
  query: string;
  caseSensitive?: boolean;
  entireWord?: boolean;
  highlightAll?: boolean;
  findPrevious?: boolean;
};

type PdfFindController = {
  executeCommand?: (command: string, state: PdfFindState) => void;
};

type PdfViewerChild = {
  pdfViewer?: { findController?: PdfFindController };
  findBar?: { open?: () => void };
};

type PdfViewInternals = {
  file?: TFile;
  viewer?: { child?: PdfViewerChild };
};

const searchSchema = z.object({
  query: z.string().trim().min(1),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(10).default(10),
  occurrencesPerFile: z.number().int().min(1).max(10).default(3),
  contextLength: z.number().int().min(40).max(500).default(120),
  mapPdfPages: z.boolean().default(false),
});

const occurrencesSchema = z.object({
  query: z.string().trim().min(1),
  path: z.string().trim().min(1),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(10).default(10),
  contextLength: z.number().int().min(40).max(500).default(120),
});

const openSchema = z.object({
  mode: z.enum(["verified-occurrence", "search-preview"])
    .default("verified-occurrence"),
  query: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  occurrenceNumber: z.number().int().min(1).optional(),
  searchSessionId: z.string().trim().min(1).optional(),
  fileNumber: z.number().int().min(1).optional(),
  previewNumber: z.number().int().min(1).optional(),
  newLeaf: z.boolean().default(false),
}).superRefine((value, issueContext) => {
  if (value.mode === "verified-occurrence") {
    if (!value.query || !value.path || value.occurrenceNumber === undefined) {
      issueContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Verified occurrence mode requires query, path, and occurrenceNumber.",
      });
    }
  } else if (!value.searchSessionId || value.fileNumber === undefined || value.previewNumber === undefined) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Search preview mode requires searchSessionId, fileNumber, and previewNumber.",
    });
  }
});

function getOmnisearch(context: ExtensionContext): OmniPlugin {
  const plugins = (context.app as unknown as {
    plugins?: { plugins?: Record<string, unknown> };
  }).plugins?.plugins;
  const omni = plugins?.omnisearch as OmniPlugin | undefined;

  if (!omni || typeof omni.api?.search !== "function") {
    throw new Error("Omnisearch is not installed, enabled, or ready.");
  }
  return omni;
}

function clean(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function createContext(
  text: string,
  offset: number,
  matchLength: number,
  contextLength: number,
): string {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const before = Math.max(0, Math.floor((contextLength - Math.max(matchLength, 1)) / 2));
  const start = Math.max(0, safeOffset - before);
  const end = Math.min(
    text.length,
    Math.max(start + contextLength, safeOffset + Math.max(matchLength, 1)),
  );
  return `${start > 0 ? "..." : ""}${clean(text.slice(start, end))}${end < text.length ? "..." : ""}`;
}

function derivePdfQuery(query: string, result: OmniResult): string {
  const exactMatch = (result.matches ?? [])
    .map((item) => item.match?.trim())
    .find((item): item is string => Boolean(item));
  if (exactMatch) return exactMatch;

  const foundWord = (result.foundWords ?? [])
    .map((item) => item.trim())
    .find(Boolean);
  return foundWord || query;
}

function toPdfToolOccurrence(
  occurrence: PdfTextOccurrence,
  startIndex: number,
  index: number,
) {
  const occurrenceNumber = startIndex + index + 1;
  return {
    occurrenceNumber,
    match: occurrence.matchedText,
    context: occurrence.context,
    pageNumber: occurrence.pdfPage,
    pageNumberVerified: true,
    pageNumberSource: "pdfjs-page-text",
    pageCharacterOffset: occurrence.characterIndex,
    characterOffset: null,
    exactSelectionAvailable: occurrence.selection !== null,
    selectionSource: occurrence.selection ? "pdfjs-text-items" : null,
    nativeDestination: occurrence.destination,
    wikiLink: occurrence.wikiLink,
    selection: occurrence.selection,
    destination: {
      type: occurrence.selection ? "pdf-selection" : "pdf-page",
      path: occurrence.filePath,
      occurrenceNumber,
      pageNumber: occurrence.pdfPage,
      pageNumberVerified: true,
      nativeDestination: occurrence.destination,
    },
  };
}

async function mappedPdf(
  context: ExtensionContext,
  query: string,
  result: OmniResult,
  startIndex: number,
  pageSize: number,
  contextLength: number,
): Promise<PdfSearchResult> {
  const path = result.path ?? "";
  const file = context.app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") {
    throw new Error(`No PDF exists at "${path}".`);
  }

  return findPdfTextOccurrences(
    context.app,
    context.pluginDirectory,
    file,
    derivePdfQuery(query, result),
    {
      caseSensitive: false,
      wholeWord: false,
      contextCharacters: contextLength,
      startIndex,
      pageSize,
    },
  );
}

async function textOccurrences(
  context: ExtensionContext,
  result: OmniResult,
  start: number,
  size: number,
  contextLength: number,
) {
  const path = result.path ?? "";
  const file = context.app.vault.getAbstractFileByPath(normalizePath(path));
  const source = file instanceof TFile && file.extension.toLowerCase() === "md"
    ? await context.app.vault.read(file)
    : "";

  return (result.matches ?? []).slice(start, start + size).map((match, index) => {
    const occurrenceNumber = start + index + 1;
    const characterOffset = typeof match.offset === "number" ? match.offset : null;
    return {
      occurrenceNumber,
      match: match.match ?? "",
      context: source && characterOffset !== null
        ? createContext(
            source,
            characterOffset,
            Math.max(match.match?.length ?? 1, 1),
            contextLength,
          )
        : clean(result.excerpt ?? match.match ?? "").slice(0, contextLength),
      pageNumber: null,
      pageNumberVerified: false,
      pageNumberSource: "not-applicable",
      characterOffset,
      destination: characterOffset !== null && path.toLowerCase().endsWith(".md")
        ? { type: "markdown-position", path, occurrenceNumber, characterOffset }
        : { type: "file", path, occurrenceNumber, reason: "exact-position-unavailable" },
    };
  });
}

function resolveMarkdownOffset(source: string, expected: number, matchText: string): number {
  const safe = Math.max(0, Math.min(expected, source.length));
  if (!matchText) return safe;
  const sourceLower = source.toLocaleLowerCase();
  const matchLower = matchText.toLocaleLowerCase();
  if (sourceLower.slice(safe, safe + matchLower.length) === matchLower) return safe;

  const windowStart = Math.max(0, safe - 500);
  const windowEnd = Math.min(source.length, safe + 500);
  const nearby = sourceLower.slice(windowStart, windowEnd).indexOf(matchLower);
  if (nearby >= 0) return windowStart + nearby;

  const global = sourceLower.indexOf(matchLower);
  return global >= 0 ? global : safe;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function waitForPdfView(
  context: ExtensionContext,
  path: string,
  timeoutMilliseconds = 8000,
): Promise<PdfViewInternals | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMilliseconds) {
    const leaves = context.app.workspace.getLeavesOfType("pdf");
    for (const leaf of leaves) {
      const view = leaf.view as unknown as PdfViewInternals;
      if (view.file?.path === path) return view;
    }
    await delay(100);
  }

  return null;
}

async function startPersistentPdfSearch(
  context: ExtensionContext,
  path: string,
  query: string,
): Promise<{ started: boolean; searchBarOpened: boolean; message: string }> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return {
      started: false,
      searchBarOpened: false,
      message: "The PDF search query was empty.",
    };
  }

  const pdfView = await waitForPdfView(context, path);
  if (!pdfView) {
    return {
      started: false,
      searchBarOpened: false,
      message: "The loaded PDF view could not be found.",
    };
  }

  const child = pdfView.viewer?.child;
  const findController = child?.pdfViewer?.findController;
  if (typeof findController?.executeCommand !== "function") {
    return {
      started: false,
      searchBarOpened: false,
      message: "Obsidian's PDF find controller was unavailable.",
    };
  }

  let searchBarOpened = false;
  if (typeof child?.findBar?.open === "function") {
    child.findBar.open();
    searchBarOpened = true;
  }

  const state: PdfFindState = {
    query: normalizedQuery,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: false,
  };

  findController.executeCommand("find", state);
  await delay(350);
  findController.executeCommand("find", state);

  return {
    started: true,
    searchBarOpened,
    message: "Obsidian's built-in PDF search is active.",
  };
}

async function openPdfOccurrence(
	context: ExtensionContext,
	occurrence: PdfTextOccurrence,
	searchQuery: string,
	newLeaf: boolean,
) {
	clearPersistentPdfHighlight();

	const pageDestination =
					`${occurrence.filePath}#page=${occurrence.pdfPage}`;

	await context.app.workspace.openLinkText(
		pageDestination,
		"",
		newLeaf
			? "tab"
			: false,
	);

	await delay(600);

	const persistentOverlay =
		await applyPersistentPdfHighlight(
			context.app,
			occurrence,
		);

	let builtInSearch = {
		started:
			false,

		searchBarOpened:
			false,

		message:
			"Built-in PDF search was not needed.",
	};

	/*
	 * Do not invoke Obsidian's built-in PDF Find as a fallback.
	 * Starting another PDF search can trigger an additional PDF.js
	 * rerender and increase the annotation-layer race condition.
	 */
	if (!persistentOverlay.applied) {
		builtInSearch = {
			started:
				false,

			searchBarOpened:
				false,

			message:
				"The persistent overlay was unavailable. " +
				"The built-in PDF search fallback is disabled " +
				"to avoid triggering an additional PDF.js rerender.",
		};
	}

	const exactDestinationResolved =
		occurrence.selection !==
		null;

	return {
		opened:
			true,

		targetType:
			persistentOverlay.applied
				? "pdf-overlay"
				: "pdf-page",

		path:
			occurrence.filePath,

		pageNumber:
			occurrence.pdfPage,

		pageNumberVerified:
			true,

		exactDestinationResolved,

		nativeSelectionApplied:
			false,

		nativeSelectionPersistent:
			false,

		persistentOverlayApplied:
			persistentOverlay.applied,

		persistentOverlayMessage:
			persistentOverlay.reason,

		builtInSearchFallbackUsed:
			builtInSearch.started,

		searchBarOpened:
			builtInSearch
				.searchBarOpened,

		highlightedMatches:
			persistentOverlay.applied ||
			builtInSearch.started,

		highlightType:
			persistentOverlay.applied
				? "plugin-persistent-overlay"
				: builtInSearch.started
					? "native-pdf-search"
					: exactDestinationResolved
						? "transient-native-selection"
						: "page-only",

		searchQuery:
			builtInSearch.started
				? searchQuery
				: null,

		destination:
				pageDestination,

		nativeDestination:
				occurrence.destination,

		jumpedToDestination:
			true,

		openStatus:
			persistentOverlay.applied
				? `PDF opened at viewer page ${occurrence.pdfPage}, and the exact matching passage has a persistent highlight.`
				: builtInSearch.started
					? `PDF opened at viewer page ${occurrence.pdfPage}. Obsidian's built-in PDF search is highlighting "${searchQuery}".`
					: exactDestinationResolved
						? `PDF opened at viewer page ${occurrence.pdfPage}. The native selection highlight may be temporary.`
						: `PDF opened at viewer page ${occurrence.pdfPage}, but exact highlighting was unavailable.`,

		builtInSearchMessage:
			builtInSearch.message,
	};
}

async function openMarkdown(
  context: ExtensionContext,
  file: TFile,
  characterOffset: number,
  matchText: string,
  newLeaf: boolean,
) {
  const leaf = context.app.workspace.getLeaf(newLeaf ? "tab" : false);
  await leaf.openFile(file, { active: true });
  const view = leaf.view instanceof MarkdownView ? leaf.view : null;

  if (!view) {
    return {
      opened: true,
      targetType: "markdown-file",
      path: file.path,
      jumpedToDestination: false,
      openStatus: "Markdown file opened, but the editor view was unavailable.",
    };
  }

  const source = await context.app.vault.read(file);
  const resolvedOffset = resolveMarkdownOffset(source, characterOffset, matchText);
  const position = view.editor.offsetToPos(resolvedOffset);
  const selectionEnd = view.editor.offsetToPos(resolvedOffset + matchText.length);
  view.editor.setSelection(position, selectionEnd);
  view.editor.scrollIntoView({ from: position, to: selectionEnd }, true);
  view.editor.focus();

  return {
    opened: true,
    targetType: "markdown-selection",
    path: file.path,
    characterOffset: resolvedOffset,
    line: position.line + 1,
    column: position.ch + 1,
    exactTextSelected: true,
    jumpedToDestination: true,
    openStatus: "Markdown file opened and the exact matching text was selected.",
  };
}

async function openFile(
  context: ExtensionContext,
  file: TFile,
  newLeaf: boolean,
  reason: string,
) {
  const leaf = context.app.workspace.getLeaf(newLeaf ? "tab" : false);
  await leaf.openFile(file, { active: true });
  return {
    opened: true,
    targetType: "file",
    path: file.path,
    jumpedToDestination: false,
    openStatus: `File opened. Exact destination navigation was unavailable: ${reason}.`,
  };
}

function normalizeComparisonText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function contextSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeComparisonText(left).split(" ").filter((token) => token.length > 1));
  const rightTokens = new Set(normalizeComparisonText(right).split(" ").filter((token) => token.length > 1));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function resolvePreviewOccurrence(preview: SearchPreviewReference, occurrences: PdfTextOccurrence[]) {
  const ranked = occurrences.map((occurrence, index) => {
    const previewMatch = normalizeComparisonText(preview.match);
    const candidateMatch = normalizeComparisonText(occurrence.matchedText);
    let score = previewMatch === candidateMatch ? 100 : 0;
    score += contextSimilarity(preview.context, occurrence.context) * 100;
    const expected = occurrences.length <= 1 ? 0 : (preview.previewNumber - 1) / (occurrences.length - 1);
    const actual = occurrences.length <= 1 ? 0 : index / (occurrences.length - 1);
    score += Math.max(0, 1 - Math.abs(expected - actual)) * 10;
    return { occurrence, index, score };
  }).sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best) return { status: "not-found" as const, occurrence: null, occurrenceNumber: null, bestScore: 0, scoreMargin: 0 };
  const scoreMargin = best.score - (ranked[1]?.score ?? 0);
  if (best.score < 120 || scoreMargin < 8) {
    return { status: "ambiguous" as const, occurrence: null, occurrenceNumber: null, bestScore: best.score, scoreMargin };
  }
  return { status: "resolved" as const, occurrence: best.occurrence, occurrenceNumber: best.index + 1, bestScore: best.score, scoreMargin };
}

export function registerMcp(
  api: LocalRestApiPublicApi,
  context: ExtensionContext,
): void {
  api.addMcpTool(
    OMNISEARCH_SEARCH_TOOL,
    [
      "Search the Obsidian vault using Omnisearch.",
      "For a fast initial search use page 1, pageSize 10, occurrencesPerFile 3, contextLength 120, and mapPdfPages false.",
      "PDF matches include verified viewer page numbers produced by the custom PDF page-search utility.",
      "Markdown matches include editor destinations.",
      "Never infer a PDF page from an offset, count, occurrence number, file number, or ranking.",
    ].join(" "),
    {
      query: searchSchema.shape.query,
      page: searchSchema.shape.page.optional(),
      pageSize: searchSchema.shape.pageSize.optional(),
      occurrencesPerFile: searchSchema.shape.occurrencesPerFile.optional(),
      contextLength: searchSchema.shape.contextLength.optional(),
      mapPdfPages: searchSchema.shape.mapPdfPages.optional(),
    },
    async (args) => {
      const input = searchSchema.parse(args);
      const results = await getOmnisearch(context).api!.search!(input.query);
      const start = (input.page - 1) * input.pageSize;
      const selected = results.slice(start, start + input.pageSize);
      const totalFilePages = results.length ? Math.ceil(results.length / input.pageSize) : 0;

      const files = await Promise.all(selected.map(async (result, index) => {
        const path = result.path ?? "";
        const fileNumber = start + index + 1;
        const displayName = result.basename || path || "Unnamed file";
        const omnisearchMatchCount = result.matches?.length ?? 0;

        if (input.mapPdfPages && path.toLowerCase().endsWith(".pdf")) {
          const mapped = await mappedPdf(
            context,
            input.query,
            result,
            0,
            input.occurrencesPerFile,
            input.contextLength,
          );
          const occurrencePreviews = mapped.occurrences.map(
            (occurrence, occurrenceIndex) =>
              toPdfToolOccurrence(occurrence, mapped.startIndex, occurrenceIndex),
          );
          const remaining = Math.max(
            mapped.totalOccurrences - mapped.returnedOccurrenceCount,
            0,
          );

          return {
            fileNumber,
            selectionNumber: fileNumber,
            path,
            fileType: "pdf",
            score: result.score ?? null,
            displaySummary: `${displayName} - ${mapped.totalOccurrences} page-mapped matches`,
            omnisearchMatchCount,
            pageMappedMatchCount: mapped.totalOccurrences,
            matchCountStatus: omnisearchMatchCount === mapped.totalOccurrences
              ? "same"
              : "different",
            pdfPageMappingStatus: mapped.status,
            pdfPageCount: mapped.totalPages,
            pageMappingMessage: mapped.message,
            displayedOccurrenceCount: occurrencePreviews.length,
            remainingOccurrenceCount: remaining,
            showMoreOccurrencesAvailable: mapped.hasMoreOccurrences,
            nextOccurrencePage: mapped.hasMoreOccurrences ? 2 : null,
            occurrencePreviews,
          };
        }

        const occurrencePreviews = await textOccurrences(
          context,
          result,
          0,
          input.occurrencesPerFile,
          input.contextLength,
        );
        const remaining = Math.max(omnisearchMatchCount - occurrencePreviews.length, 0);

        return {
          fileNumber,
          selectionNumber: fileNumber,
          path,
          fileType: path.toLowerCase().endsWith(".pdf")
            ? "pdf"
            : path.toLowerCase().endsWith(".md")
              ? "markdown"
              : "other",
          resultMode: "fast-preview",
          score: result.score ?? null,
          displaySummary: `${displayName} - ${omnisearchMatchCount} matches`,
          omnisearchMatchCount,
          pageMappedMatchCount: null,
          pdfPageMappingStatus: "not-a-pdf",
          displayedOccurrenceCount: occurrencePreviews.length,
          remainingOccurrenceCount: remaining,
          showMoreOccurrencesAvailable: remaining > 0,
          nextOccurrencePage: remaining > 0 ? 2 : null,
          occurrencePreviews,
          previewPreviews: occurrencePreviews.map((preview) => ({
            previewNumber: preview.occurrenceNumber,
            previewType: "omnisearch-indexed",
            match: preview.match,
            context: preview.context,
            characterOffset: preview.characterOffset,
            pageNumber: null,
            pageNumberVerified: false,
          })),
          directPreviewOpenAvailable: occurrencePreviews.length > 0,
        };
      }));

   const previewInputs:
	SearchPreviewInput[] =
	[];

for (const file of files) {
	if (
		!(
			"previewPreviews" in
			file
		)
	) {
		continue;
	}

	const previews =
		file.previewPreviews;

	if (
		!Array.isArray(
			previews,
		)
	) {
		continue;
	}

	const fileType:
		SearchPreviewInput[
			"fileType"
		] =
		file.fileType ===
		"pdf"
			? "pdf"
			: file.fileType ===
					"markdown"
				? "markdown"
				: "other";

	for (
		const preview of
		previews
	) {
		/*
		 * A verified-result object might contain an empty
		 * previewPreviews array. Only valid indexed-preview
		 * objects are stored in the search session.
		 */
		if (
			typeof preview
				?.previewNumber !==
				"number" ||
			typeof preview
				?.match !==
				"string" ||
			typeof preview
				?.context !==
				"string"
		) {
			continue;
		}

		const characterOffset =
			typeof preview
				.characterOffset ===
				"number"
				? preview
					.characterOffset
				: null;

		previewInputs.push({
			fileNumber:
				file.fileNumber,

			previewNumber:
				preview
					.previewNumber,

			query:
				input.query,

			path:
				file.path,

			fileType,

			match:
				preview.match,

			context:
				preview.context,

			characterOffset,
		});
	}
}

const session =
	createSearchSession(
		previewInputs,
	);

      return {
        query: input.query,
        resultMode: input.mapPdfPages ? "verified" : "fast-preview",
        searchSessionId: session.searchSessionId,
        searchSessionExpiresInSeconds: 600,
        fileResultPage: input.page,
        filesPerPage: input.pageSize,
        returnedFileCount: files.length,
        totalMatchingFiles: results.length,
        totalFilePages,
        remainingFileCount: Math.max(results.length - (start + files.length), 0),
        showMoreFilesAvailable: input.page < totalFilePages,
        nextFilePage: input.page < totalFilePages ? input.page + 1 : null,
        files,
      };
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  );

  api.addMcpTool(
    OMNISEARCH_OCCURRENCES_TOOL,
    "Return one occurrence-results page for an exact Omnisearch file path. PDF results include verified viewer page numbers; Markdown results include editor positions.",
    {
      query: occurrencesSchema.shape.query,
      path: occurrencesSchema.shape.path,
      page: occurrencesSchema.shape.page.optional(),
      pageSize: occurrencesSchema.shape.pageSize.optional(),
      contextLength: occurrencesSchema.shape.contextLength.optional(),
    },
    async (args) => {
      const input = occurrencesSchema.parse(args);
      const result = (await getOmnisearch(context).api!.search!(input.query))
        .find((item) => item.path === input.path);
      if (!result) {
        throw new Error(
          `No Omnisearch result exists at path "${input.path}" for query "${input.query}".`,
        );
      }

      const start = (input.page - 1) * input.pageSize;

      if (input.path.toLowerCase().endsWith(".pdf")) {
        const mapped = await mappedPdf(
          context,
          input.query,
          result,
          start,
          input.pageSize,
          input.contextLength,
        );
        const occurrences = mapped.occurrences.map((occurrence, index) =>
          toPdfToolOccurrence(occurrence, mapped.startIndex, index),
        );
        const totalPages = mapped.totalOccurrences
          ? Math.ceil(mapped.totalOccurrences / input.pageSize)
          : 0;

        return {
          query: input.query,
          path: input.path,
          fileType: "pdf",
          pdfPageMappingStatus: mapped.status,
          pdfPageCount: mapped.totalPages,
          pageMappingMessage: mapped.message,
          occurrencePage: input.page,
          occurrencesPerPage: input.pageSize,
          returnedOccurrenceCount: mapped.returnedOccurrenceCount,
          totalOccurrences: mapped.totalOccurrences,
          totalOccurrencePages: totalPages,
          remainingOccurrenceCount: Math.max(
            mapped.totalOccurrences - (start + mapped.returnedOccurrenceCount),
            0,
          ),
          hasNextOccurrencePage: mapped.hasMoreOccurrences,
          nextOccurrencePage: mapped.hasMoreOccurrences ? input.page + 1 : null,
          occurrences,
        };
      }

      const occurrences = await textOccurrences(
        context,
        result,
        start,
        input.pageSize,
        input.contextLength,
      );
      const totalOccurrences = result.matches?.length ?? 0;
      const totalPages = totalOccurrences
        ? Math.ceil(totalOccurrences / input.pageSize)
        : 0;

      return {
        query: input.query,
        path: input.path,
        fileType: input.path.toLowerCase().endsWith(".md") ? "markdown" : "other",
        occurrencePage: input.page,
        occurrencesPerPage: input.pageSize,
        returnedOccurrenceCount: occurrences.length,
        totalOccurrences,
        totalOccurrencePages: totalPages,
        remainingOccurrenceCount: Math.max(
          totalOccurrences - (start + occurrences.length),
          0,
        ),
        hasNextOccurrencePage: input.page < totalPages,
        nextOccurrencePage: input.page < totalPages ? input.page + 1 : null,
        occurrences,
      };
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  );

  api.addMcpTool(
    OMNISEARCH_OPEN_OCCURRENCE_TOOL,
    [
	"Open one exact Omnisearch occurrence in Obsidian.",
	"For PDF occurrences, open the verified native selection and apply a plugin-owned persistent highlight overlay.",
	"If the persistent overlay is unavailable, use Obsidian's built-in PDF search as a fallback.",
	"For Markdown occurrences, open the file and select the exact matching text.",
	"The server resolves all page, offset, and selection information.",
	"Do not invent page numbers, offsets, selection indexes, or destinations.",
	].join(" "),
    {
      mode: z.enum(["verified-occurrence", "search-preview"]).optional(),
      query: z.string().optional(),
      path: z.string().optional(),
      occurrenceNumber: z.number().int().min(1).optional(),
      searchSessionId: z.string().optional(),
      fileNumber: z.number().int().min(1).optional(),
      previewNumber: z.number().int().min(1).optional(),
      newLeaf: z.boolean().optional(),
    },
    async (args) => {
      const input = openSchema.parse(args);

      if (input.mode === "search-preview") {
        const preview = getSearchPreview(input.searchSessionId!, input.fileNumber!, input.previewNumber!);
        if (!preview) {
          return { opened: false, resolutionStatus: "expired-search-session", requiresNewSearch: true, openStatus: "The search preview expired. Run the search again." };
        }
        const previewFile = context.app.vault.getAbstractFileByPath(normalizePath(preview.path));
        if (!(previewFile instanceof TFile)) {
          return { opened: false, resolutionStatus: "file-not-found", requiresNewSearch: true, path: preview.path, openStatus: "The preview file no longer exists in the vault." };
        }
        if (preview.fileType === "pdf") {
          const previewResult = (await getOmnisearch(context).api!.search!(preview.query)).find((item) => item.path === preview.path);
          if (!previewResult) {
            return { opened: false, resolutionStatus: "omnisearch-result-not-found", requiresNewSearch: true, path: preview.path, openStatus: "The original Omnisearch result is no longer available." };
          }
          const mapped = await mappedPdf(context, preview.query, previewResult, 0, Number.MAX_SAFE_INTEGER, 120);
          if (mapped.status !== "mapped") {
            return openFile(context, previewFile, input.newLeaf, mapped.message ?? "verified PDF page mapping was unavailable");
          }
          const resolution = resolvePreviewOccurrence(preview, mapped.occurrences);
          if (resolution.status !== "resolved" || !resolution.occurrence) {
            return {
              opened: false,
              resolutionStatus: resolution.status,
              requiresVerifiedOccurrenceSelection: true,
              searchSessionId: input.searchSessionId,
              fileNumber: input.fileNumber,
              previewNumber: input.previewNumber,
              query: preview.query,
              path: preview.path,
              bestScore: Math.round(resolution.bestScore * 100) / 100,
              scoreMargin: Math.round(resolution.scoreMargin * 100) / 100,
              openStatus: "The selected preview could not be mapped unambiguously. Display verified PDF occurrences for this file.",
            };
          }
          return {
            resolutionStatus: "resolved",
            previewNumber: preview.previewNumber,
            resolvedOccurrenceNumber: resolution.occurrenceNumber,
            mappingConfidence: { bestScore: Math.round(resolution.bestScore * 100) / 100, scoreMargin: Math.round(resolution.scoreMargin * 100) / 100 },
            ...(await openPdfOccurrence(context, resolution.occurrence, preview.query, input.newLeaf)),
          };
        }
        if (preview.fileType === "markdown" && preview.characterOffset !== null) {
          return { resolutionStatus: "resolved", previewNumber: preview.previewNumber, ...(await openMarkdown(context, previewFile, preview.characterOffset, preview.match, input.newLeaf)) };
        }
        return openFile(context, previewFile, input.newLeaf, "the selected preview does not have an exact destination");
      }

      const query = input.query!;
      const path = input.path!;
      const occurrenceNumber = input.occurrenceNumber!;
      const result = (await getOmnisearch(context).api!.search!(query))
        .find((item) => item.path === path);
      if (!result) {
        throw new Error(
          `No Omnisearch result exists at path "${path}" for query "${query}".`,
        );
      }

      const file = context.app.vault.getAbstractFileByPath(normalizePath(path));
      if (!(file instanceof TFile)) {
        throw new Error(`No vault file exists at "${path}".`);
      }

      if (file.extension.toLowerCase() === "pdf") {
        const mapped = await mappedPdf(
          context,
          query,
          result,
          occurrenceNumber - 1,
          1,
          160,
        );
        const occurrence = mapped.occurrences[0];
        if (mapped.status === "mapped" && occurrence) {
          return openPdfOccurrence(
            context,
            occurrence,
            derivePdfQuery(query, result),
            input.newLeaf,
          );
        }
        return openFile(
          context,
          file,
          input.newLeaf,
          mapped.message ?? "verified PDF page mapping was unavailable",
        );
      }

      if (file.extension.toLowerCase() === "md") {
        const match = (result.matches ?? [])[occurrenceNumber - 1];
        if (match && typeof match.offset === "number") {
          return openMarkdown(
            context,
            file,
            match.offset,
            match.match ?? "",
            input.newLeaf,
          );
        }
        return openFile(
          context,
          file,
          input.newLeaf,
          "Markdown occurrence offset was unavailable",
        );
      }

      return openFile(
        context,
        file,
        input.newLeaf,
        "the selected file type does not support exact occurrence navigation",
      );
    },
    { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  );
}
