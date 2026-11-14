import { TFile, loadPdfJs, normalizePath, type App } from "obsidian";

/*
 * Verified PDF page search.
 *
 * Text is extracted with the PDF.js build that Obsidian itself ships
 * (`loadPdfJs()`), i.e. the same PDF.js version that renders the PDF viewer's
 * text layer. Item strings therefore match the viewer's text-layer spans, and
 * Obsidian has already configured the PDF.js worker, so no separate
 * `pdfjs-dist` dependency or `pdf.worker.min.mjs` file is required.
 */

export interface PdfTextItemRange {
	itemIndex: number;
	text: string;
	pageStart: number;
	pageEnd: number;
}

export interface PdfTextSelection {
	startItemIndex: number;
	startItemOffset: number;
	endItemIndex: number;
	endItemOffset: number;
}

export interface PdfPageText {
	pdfPage: number;
	text: string;
	items: PdfTextItemRange[];
}

export interface PdfTextOccurrence {
	filePath: string;
	fileName: string;
	pdfPage: number;
	characterIndex: number;
	/** 0-based index of this match among the matches on the same page. */
	pageOccurrenceIndex: number;
	matchedText: string;
	context: string;
	selection: PdfTextSelection | null;
	destination: string;
	wikiLink: string;
}

export type PdfSearchStatus =
	| "mapped"
	| "no-text-layer"
	| "encrypted"
	| "worker-missing"
	| "parse-failed";

export interface PdfSearchOptions {
	caseSensitive?: boolean;
	wholeWord?: boolean;
	contextCharacters?: number;
	startIndex?: number;
	pageSize?: number;
	maxPages?: number;
}

export interface PdfSearchResult {
	status: PdfSearchStatus;
	message: string | null;
	filePath: string;
	query: string;
	totalPages: number;
	searchedPages: number;
	truncated: boolean;
	totalOccurrences: number;
	startIndex: number;
	returnedOccurrenceCount: number;
	hasMoreOccurrences: boolean;
	occurrences: PdfTextOccurrence[];
	pageCacheHit: boolean;
	queryCacheHit: boolean;
}

type PdfExtraction = {
	status: PdfSearchStatus;
	message: string | null;
	totalPages: number;
	pages: PdfPageText[];
	complete: boolean;
	pageCacheHit: boolean;
};

type PdfPageCacheEntry = {
	key: string;
	totalPages: number;
	pages: PdfPageText[];
	touchedAt: number;
};

type PdfQueryCacheEntry = {
	filePath: string;
	mtime: number;
	size: number;
	query: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	contextCharacters: number;
	maxPages: number | null;
	totalPages: number;
	searchedPages: number;
	truncated: boolean;
	occurrences: PdfTextOccurrence[];
	touchedAt: number;
};

const MAX_CACHE_ENTRIES = 10;
const MAX_QUERY_CACHE_ENTRIES = 30;
const DEFAULT_CONTEXT_CHARACTERS = 120;

const pageCache = new Map<string, PdfPageCacheEntry>();
const queryCache = new Map<string, PdfQueryCacheEntry>();
const inFlightExtractions = new Map<string, Promise<PdfExtraction>>();
/** Kept for diagnostics; the bundled worker is not needed with Obsidian's PDF.js. */
export function getPdfJsWorkerPath(pluginDirectory: string): string {
	return normalizePath(`${pluginDirectory}/pdf.worker.min.mjs`);
}

function createPageCacheKey(file: TFile): string {
	return `${file.path}|${file.stat.mtime}|${file.stat.size}`;
}

export function createPdfQueryCacheKey(
	file: TFile,
	query: string,
	caseSensitive: boolean,
	wholeWord: boolean,
	contextCharacters: number,
	maxPages: number | null,
): string {
	return [
		file.path,
		file.stat.mtime,
		file.stat.size,
		normalizeQuery(query, caseSensitive),
		caseSensitive ? "case" : "nocase",
		wholeWord ? "whole" : "partial",
		contextCharacters,
		maxPages === null ? "all-pages" : `pages-${maxPages}`,
	].join("|");
}

export function clearPdfCaches(): void {
	pageCache.clear();
	queryCache.clear();
}

function trimCache<T extends { touchedAt: number }>(
	cache: Map<string, T>,
	limit: number,
): void {
	while (cache.size > limit) {
		let oldestKey: string | null = null;
		let oldest = Number.POSITIVE_INFINITY;
		for (const [key, entry] of cache) {
			if (entry.touchedAt < oldest) {
				oldest = entry.touchedAt;
				oldestKey = key;
			}
		}
		if (oldestKey === null) break;
		cache.delete(oldestKey);
	}
}

/* ------------------------------------------------------------------------ */
/* Text normalization shared with pdf-highlight.ts                           */
/* ------------------------------------------------------------------------ */

const WHITESPACE = /\s/;

/**
 * Builds a whitespace-free, optionally lower-cased search string together with
 * the index of the source code unit for every output code unit. Whitespace is
 * ignored so that matches survive PDF line breaks and per-glyph CJK items.
 */
export function buildSearchIndex(
	text: string,
	caseSensitive = false,
): { normalized: string; map: number[] } {
	let normalized = "";
	const map: number[] = [];
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (WHITESPACE.test(char)) continue;
		const folded = caseSensitive ? char : char.toLowerCase();
		for (let part = 0; part < folded.length; part += 1) {
			normalized += folded[part];
			map.push(index);
		}
	}
	return { normalized, map };
}

export function normalizeQuery(query: string, caseSensitive = false): string {
	return buildSearchIndex(query.trim(), caseSensitive).normalized;
}

function isWordCharacter(char: string | undefined): boolean {
	return Boolean(char) && /[\p{L}\p{N}_]/u.test(char as string);
}

function cleanContext(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function createContext(
	text: string,
	start: number,
	end: number,
	contextCharacters: number,
): string {
	const matchLength = Math.max(end - start, 1);
	const before = Math.max(0, Math.floor((contextCharacters - matchLength) / 2));
	const from = Math.max(0, start - before);
	const to = Math.min(text.length, Math.max(from + contextCharacters, end));
	return `${from > 0 ? "..." : ""}${cleanContext(text.slice(from, to))}${to < text.length ? "..." : ""}`;
}

/* ------------------------------------------------------------------------ */
/* PDF.js extraction                                                         */
/* ------------------------------------------------------------------------ */

type PdfJsTextItem = { str?: string; hasEOL?: boolean };
type PdfJsPage = {
	getTextContent: (options?: Record<string, unknown>) => Promise<{ items: PdfJsTextItem[] }>;
	cleanup?: () => void;
};
type PdfJsDocument = {
	numPages: number;
	getPage: (pageNumber: number) => Promise<PdfJsPage>;
	destroy?: () => Promise<void>;
};
type PdfJsLoadingTask = {
	promise: Promise<PdfJsDocument>;
	destroy?: () => Promise<void>;
};
type PdfJsLib = {
	getDocument: (source: Record<string, unknown>) => PdfJsLoadingTask;
};

let pdfJsPromise: Promise<PdfJsLib> | null = null;

async function getPdfJs(): Promise<PdfJsLib> {
	if (!pdfJsPromise) {
		pdfJsPromise = loadPdfJs().then((lib: unknown) => {
			if (!lib || typeof (lib as PdfJsLib).getDocument !== "function") {
				throw new Error("Obsidian's PDF.js library did not expose getDocument().");
			}
			return lib as PdfJsLib;
		});
		pdfJsPromise.catch(() => {
			pdfJsPromise = null;
		});
	}
	return pdfJsPromise;
}

function buildPageText(pdfPage: number, items: PdfJsTextItem[]): PdfPageText {
	let text = "";
	const ranges: PdfTextItemRange[] = [];
	let itemIndex = 0;

	for (const item of items) {
		// Marked-content items carry no `str` and render no text-layer span.
		if (typeof item.str !== "string") continue;
		const pageStart = text.length;
		text += item.str;
		ranges.push({ itemIndex, text: item.str, pageStart, pageEnd: text.length });
		itemIndex += 1;
		if (item.hasEOL) text += "\n";
	}

	return { pdfPage, text, items: ranges };
}
async function extractPdfText(
	app: App,
	file: TFile,
	maxPages: number | null,
): Promise<PdfExtraction> {
	const cacheKey = createPageCacheKey(file);
	const cached = pageCache.get(cacheKey);
	if (cached) {
		cached.touchedAt = Date.now();
		const pages = maxPages === null ? cached.pages : cached.pages.slice(0, maxPages);
		return {
			status: pages.some((page) => page.text.trim()) ? "mapped" : "no-text-layer",
			message: null,
			totalPages: cached.totalPages,
			pages,
			complete: pages.length === cached.totalPages,
			pageCacheHit: true,
		};
	}

	const flightKey = `${cacheKey}|${maxPages ?? "all"}`;
	const pending = inFlightExtractions.get(flightKey);
	if (pending) return pending;

	const task = runExtraction(app, file, cacheKey, maxPages);
	inFlightExtractions.set(flightKey, task);
	try {
		return await task;
	} finally {
		inFlightExtractions.delete(flightKey);
	}
}

function failedExtraction(status: PdfSearchStatus, message: string): PdfExtraction {
	return { status, message, totalPages: 0, pages: [], complete: false, pageCacheHit: false };
}

async function runExtraction(
	app: App,
	file: TFile,
	cacheKey: string,
	maxPages: number | null,
): Promise<PdfExtraction> {
	let pdfjs: PdfJsLib;
	try {
		pdfjs = await getPdfJs();
	} catch (error) {
		return failedExtraction("worker-missing", `PDF.js could not be loaded from Obsidian: ${errorMessage(error)}`);
	}

	let loadingTask: PdfJsLoadingTask | null = null;
	let pdfDocument: PdfJsDocument | null = null;
	try {
		const binary = await app.vault.readBinary(file);
		loadingTask = pdfjs.getDocument({ data: new Uint8Array(binary) });
		pdfDocument = await loadingTask.promise;

		const totalPages = pdfDocument.numPages;
		const pageLimit = maxPages === null ? totalPages : Math.min(maxPages, totalPages);
		const pages: PdfPageText[] = [];

		for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
			const page = await pdfDocument.getPage(pageNumber);
			const content = await page.getTextContent({
				includeMarkedContent: true,
				disableNormalization: true,
			});
			pages.push(buildPageText(pageNumber, content.items));
			page.cleanup?.();
		}

		const complete = pages.length === totalPages;
		// Only complete extractions are cached, so a truncated scan is never reused as a full one.
		if (complete) {
			pageCache.set(cacheKey, { key: cacheKey, totalPages, pages, touchedAt: Date.now() });
			trimCache(pageCache, MAX_CACHE_ENTRIES);
		}

		const hasText = pages.some((page) => page.text.trim());
		return {
			status: hasText ? "mapped" : "no-text-layer",
			message: hasText ? null : "The PDF has no extractable text layer (it may be a scanned image).",
			totalPages,
			pages,
			complete,
			pageCacheHit: false,
		};
	} catch (error) {
		const name = (error as { name?: string } | null)?.name ?? "";
		if (/^Pass\w*Exception$/.test(name)) {
			return failedExtraction("encrypted", "The PDF is encrypted and cannot be opened without its key.");
		}
		return failedExtraction("parse-failed", `PDF text extraction failed: ${errorMessage(error)}`);
	} finally {
		try {
			if (pdfDocument?.destroy) await pdfDocument.destroy();
			else if (loadingTask?.destroy) await loadingTask.destroy();
		} catch {
			// Ignore cleanup failures.
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
/* ------------------------------------------------------------------------ */
/* Occurrence search                                                         */
/* ------------------------------------------------------------------------ */

function findSelection(
	page: PdfPageText,
	start: number,
	end: number,
): PdfTextSelection | null {
	const last = end - 1;
	const startItem = page.items.find((item) => start >= item.pageStart && start < item.pageEnd);
	const endItem = page.items.find((item) => last >= item.pageStart && last < item.pageEnd);
	if (!startItem || !endItem) return null;
	return {
		startItemIndex: startItem.itemIndex,
		startItemOffset: start - startItem.pageStart,
		endItemIndex: endItem.itemIndex,
		endItemOffset: last - endItem.pageStart + 1,
	};
}

function findPageOccurrences(
	file: TFile,
	page: PdfPageText,
	normalizedQuery: string,
	caseSensitive: boolean,
	wholeWord: boolean,
	contextCharacters: number,
): PdfTextOccurrence[] {
	if (!normalizedQuery || !page.text) return [];

	const { normalized, map } = buildSearchIndex(page.text, caseSensitive);
	const occurrences: PdfTextOccurrence[] = [];
	let from = 0;

	while (from <= normalized.length - normalizedQuery.length) {
		const found = normalized.indexOf(normalizedQuery, from);
		if (found < 0) break;
		from = found + 1;

		const start = map[found];
		const end = map[found + normalizedQuery.length - 1] + 1;

		if (wholeWord && (isWordCharacter(page.text[start - 1]) || isWordCharacter(page.text[end]))) {
			continue;
		}

		const selection = findSelection(page, start, end);
		const destinationBase = `${file.path}#page=${page.pdfPage}`;
		const destination = selection
			? `${destinationBase}&selection=${selection.startItemIndex},${selection.startItemOffset},${selection.endItemIndex},${selection.endItemOffset}`
			: destinationBase;

		occurrences.push({
			filePath: file.path,
			fileName: file.name,
			pdfPage: page.pdfPage,
			characterIndex: start,
			pageOccurrenceIndex: occurrences.length,
			matchedText: page.text.slice(start, end),
			context: createContext(page.text, start, end, contextCharacters),
			selection,
			destination,
			wikiLink: `[[${destination}|${file.basename}, p. ${page.pdfPage}]]`,
		});

		// Continue after this match so matches never overlap.
		from = found + normalizedQuery.length;
	}

	return occurrences;
}
export async function findPdfTextOccurrences(
	app: App,
	pluginDirectory: string,
	fileOrPath: TFile | string,
	query: string,
	options: PdfSearchOptions = {},
): Promise<PdfSearchResult> {
	void pluginDirectory;

	const file = typeof fileOrPath === "string"
		? app.vault.getAbstractFileByPath(normalizePath(fileOrPath))
		: fileOrPath;
	const requestedPath = typeof fileOrPath === "string" ? fileOrPath : fileOrPath.path;
	if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") {
		throw new Error(`No PDF exists at "${requestedPath}".`);
	}

	const caseSensitive = options.caseSensitive ?? false;
	const wholeWord = options.wholeWord ?? false;
	const contextCharacters = Math.max(20, options.contextCharacters ?? DEFAULT_CONTEXT_CHARACTERS);
	const startIndex = Math.max(0, Math.floor(options.startIndex ?? 0));
	const pageSize = Math.max(1, Math.floor(options.pageSize ?? 10));
	const maxPages = options.maxPages && options.maxPages > 0 ? Math.floor(options.maxPages) : null;

	const base = { filePath: file.path, query, startIndex };

	const paginate = (
		entry: Pick<PdfQueryCacheEntry, "occurrences" | "totalPages" | "searchedPages" | "truncated">,
		pageCacheHit: boolean,
		queryCacheHit: boolean,
	): PdfSearchResult => {
		const occurrences = entry.occurrences.slice(startIndex, startIndex + pageSize);
		return {
			...base,
			status: "mapped",
			message: entry.truncated
				? `Only the first ${entry.searchedPages} of ${entry.totalPages} pages were searched.`
				: null,
			totalPages: entry.totalPages,
			searchedPages: entry.searchedPages,
			truncated: entry.truncated,
			totalOccurrences: entry.occurrences.length,
			returnedOccurrenceCount: occurrences.length,
			hasMoreOccurrences: startIndex + occurrences.length < entry.occurrences.length,
			occurrences,
			pageCacheHit,
			queryCacheHit,
		};
	};

	const queryKey = createPdfQueryCacheKey(file, query, caseSensitive, wholeWord, contextCharacters, maxPages);
	const cachedQuery = queryCache.get(queryKey);
	if (cachedQuery) {
		cachedQuery.touchedAt = Date.now();
		return paginate(cachedQuery, true, true);
	}

	const extraction = await extractPdfText(app, file, maxPages);
	if (extraction.status !== "mapped") {
		return {
			...base,
			status: extraction.status,
			message: extraction.message,
			totalPages: extraction.totalPages,
			searchedPages: extraction.pages.length,
			truncated: !extraction.complete,
			totalOccurrences: 0,
			returnedOccurrenceCount: 0,
			hasMoreOccurrences: false,
			occurrences: [],
			pageCacheHit: extraction.pageCacheHit,
			queryCacheHit: false,
		};
	}

	const normalizedQuery = normalizeQuery(query, caseSensitive);
	const occurrences: PdfTextOccurrence[] = [];
	for (const page of extraction.pages) {
		occurrences.push(
			...findPageOccurrences(file, page, normalizedQuery, caseSensitive, wholeWord, contextCharacters),
		);
	}

	const entry: PdfQueryCacheEntry = {
		filePath: file.path,
		mtime: file.stat.mtime,
		size: file.stat.size,
		query: normalizedQuery,
		caseSensitive,
		wholeWord,
		contextCharacters,
		maxPages,
		totalPages: extraction.totalPages,
		searchedPages: extraction.pages.length,
		truncated: !extraction.complete,
		occurrences,
		touchedAt: Date.now(),
	};
	queryCache.set(queryKey, entry);
	trimCache(queryCache, MAX_QUERY_CACHE_ENTRIES);

	return paginate(entry, extraction.pageCacheHit, false);
}