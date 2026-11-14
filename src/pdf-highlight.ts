import type { App, WorkspaceLeaf } from "obsidian";
import { buildSearchIndex, type PdfTextOccurrence } from "./pdf-util";

/*
 * Persistent PDF highlight.
 *
 * Uses the CSS Custom Highlight API, so the PDF.js text layer DOM is never
 * modified. A MutationObserver watches the viewer; when PDF.js rerenders the
 * page (zoom, scrolling the page out and back, resize) the highlight range is
 * rebuilt. A floating "Remove highlight" button clears everything.
 */

const HIGHLIGHT_NAME = "omnisearch-mcp-pdf-target";
const BUTTON_CLASS = "omnisearch-mcp-clear-highlight-button";
const TEXT_LAYER_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 100;
const REFRESH_DEBOUNCE_MS = 120;

export type PersistentHighlightResult = {
	applied: boolean;
	reason: string;
	method: "text-item-selection" | "text-search" | null;
};

type ActiveHighlight = {
	occurrence: PdfTextOccurrence;
	container: HTMLElement;
	range: Range | null;
	observer: MutationObserver | null;
	button: HTMLButtonElement | null;
	restorePosition: string | null;
	refreshTimer: number | null;
};

let generation = 0;
let active: ActiveHighlight | null = null;

function highlightApiAvailable(): boolean {
	return typeof CSS !== "undefined"
		&& typeof (CSS as { highlights?: unknown }).highlights !== "undefined"
		&& typeof Highlight === "function";
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

/* ------------------------------------------------------------------------ */
/* Leaf / text layer lookup                                                  */
/* ------------------------------------------------------------------------ */

function leafFilePath(leaf: WorkspaceLeaf | null): string | null {
	const view = leaf?.view as unknown as { file?: { path?: string } } | undefined;
	return view?.file?.path ?? null;
}

/**
 * Prefer the leaf that the open operation just activated. Only fall back to
 * other leaves showing the same PDF when the most recent leaf is not that PDF,
 * and then prefer a visible one, so a stale background tab is not targeted.
 */
function findPdfContainer(app: App, path: string): HTMLElement | null {
	const recent = app.workspace.getMostRecentLeaf();
	if (recent && leafFilePath(recent) === path && recent.view.getViewType() === "pdf") {
		return recent.view.containerEl;
	}

	const candidates = app.workspace
		.getLeavesOfType("pdf")
		.filter((leaf) => leafFilePath(leaf) === path)
		.map((leaf) => leaf.view.containerEl);

	return candidates.find((element) => element.isConnected && element.offsetParent !== null)
		?? candidates[0]
		?? null;
}

function findTextLayer(container: HTMLElement, pdfPage: number): HTMLElement | null {
	const page = container.querySelector<HTMLElement>(`.page[data-page-number="${pdfPage}"]`);
	const layer = page?.querySelector<HTMLElement>(".textLayer");
	if (!layer || !layer.textContent || !layer.textContent.trim()) return null;
	return layer;
}
/* ------------------------------------------------------------------------ */
/* Range construction                                                        */
/* ------------------------------------------------------------------------ */

function comparable(value: string): string {
	return buildSearchIndex(value).normalized;
}

function textPosition(element: Element, offset: number): { node: Text; offset: number } | null {
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let remaining = offset;
	let lastNode: Text | null = null;
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		lastNode = node;
		if (remaining <= node.length) return { node, offset: remaining };
		remaining -= node.length;
	}
	return lastNode ? { node: lastNode, offset: lastNode.length } : null;
}

/** Primary strategy: PDF.js text-item indexes recorded during extraction. */
function rangeFromSelection(layer: HTMLElement, occurrence: PdfTextOccurrence): Range | null {
	const selection = occurrence.selection;
	if (!selection) return null;

	const expected = comparable(occurrence.matchedText);
	const tryBuild = (lookup: (itemIndex: number) => HTMLElement | undefined): Range | null => {
		const startElement = lookup(selection.startItemIndex);
		const endElement = lookup(selection.endItemIndex);
		if (!startElement || !endElement) return null;
		const start = textPosition(startElement, selection.startItemOffset);
		const end = textPosition(endElement, selection.endItemOffset);
		if (!start || !end) return null;
		try {
			const range = document.createRange();
			range.setStart(start.node, start.offset);
			range.setEnd(end.node, end.offset);
			// Only accept the range when it covers exactly the verified match.
			return comparable(range.toString()) === expected ? range : null;
		} catch {
			return null;
		}
	};

	// Obsidian/PDF.js versions differ on whether data-idx starts at 0 or 1.
	const indexed = Array.from(layer.querySelectorAll<HTMLElement>("[data-idx]"));
	const byIndex = new Map<number, HTMLElement>();
	for (const element of indexed) {
		const value = Number(element.dataset.idx);
		if (Number.isFinite(value)) byIndex.set(value, element);
	}
	if (byIndex.size) {
		const indexBase = Math.min(...Array.from(byIndex.keys()));
		for (const shift of Array.from(new Set([indexBase, 0, 1, -1]))) {
			const range = tryBuild((itemIndex) => byIndex.get(itemIndex + shift));
			if (range) return range;
		}
	}

	// No usable data-idx: PDF.js creates one span per text item, in order.
	const spans = Array.from(layer.querySelectorAll<HTMLElement>("span"))
		.filter((span) => !span.classList.contains("markedContent") && span.parentElement?.tagName !== "SPAN");
	return tryBuild((itemIndex) => spans[itemIndex]);
}

/** Fallback strategy: search the rendered text layer for the n-th match on the page. */
function rangeFromTextSearch(layer: HTMLElement, occurrence: PdfTextOccurrence): Range | null {
	const needle = comparable(occurrence.matchedText);
	if (!needle) return null;

	let haystack = "";
	const positions: { node: Text; offset: number }[] = [];
	const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		const { normalized, map } = buildSearchIndex(node.data);
		haystack += normalized;
		for (const sourceIndex of map) positions.push({ node, offset: sourceIndex });
	}

	const starts: number[] = [];
	for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + needle.length)) {
		starts.push(from);
	}
	if (!starts.length) return null;

	const wanted = Math.min(occurrence.pageOccurrenceIndex ?? 0, starts.length - 1);
	const first = positions[starts[wanted]];
	const last = positions[starts[wanted] + needle.length - 1];
	if (!first || !last) return null;

	try {
		const range = document.createRange();
		range.setStart(first.node, first.offset);
		range.setEnd(last.node, last.offset + 1);
		return range;
	} catch {
		return null;
	}
}

type BuiltRange = { range: Range; method: "text-item-selection" | "text-search" };

function buildRange(layer: HTMLElement, occurrence: PdfTextOccurrence): BuiltRange | null {
	const selected = rangeFromSelection(layer, occurrence);
	if (selected) return { range: selected, method: "text-item-selection" };
	const searched = rangeFromTextSearch(layer, occurrence);
	if (searched) return { range: searched, method: "text-search" };
	return null;
}
/* ------------------------------------------------------------------------ */
/* Highlight lifecycle                                                       */
/* ------------------------------------------------------------------------ */

/* HighlightRegistry's Map methods come from lib "DOM.Iterable", which this project's tsconfig omits. */
type HighlightRegistryMap = {
	set: (name: string, highlight: Highlight) => unknown;
	delete: (name: string) => boolean;
};

function highlightRegistry(): HighlightRegistryMap {
	return CSS.highlights as unknown as HighlightRegistryMap;
}

function setHighlight(range: Range): void {
	highlightRegistry().set(HIGHLIGHT_NAME, new Highlight(range));
}

function rangeIsLive(range: Range | null): boolean {
	return Boolean(range && range.startContainer.isConnected && range.endContainer.isConnected);
}

function refreshActiveHighlight(): void {
	const state = active;
	if (!state) return;
	state.refreshTimer = null;

	if (!state.container.isConnected) {
		clearPersistentPdfHighlight();
		return;
	}
	if (rangeIsLive(state.range)) return;

	// The page was rerendered or virtualised away; rebuild once its text layer exists.
	const layer = findTextLayer(state.container, state.occurrence.pdfPage);
	if (!layer) return;
	const built = buildRange(layer, state.occurrence);
	if (!built) return;
	state.range = built.range;
	setHighlight(built.range);
}

function scheduleRefresh(): void {
	const state = active;
	if (!state || state.refreshTimer !== null) return;
	state.refreshTimer = window.setTimeout(refreshActiveHighlight, REFRESH_DEBOUNCE_MS);
}

function createRemoveButton(state: ActiveHighlight): void {
	const host = state.container;
	if (window.getComputedStyle(host).position === "static") {
		state.restorePosition = host.style.position;
		host.style.position = "relative";
	}

	const button = document.createElement("button");
	button.type = "button";
	button.className = BUTTON_CLASS;
	button.textContent = "Remove highlight";
	button.setAttribute("aria-label", "Remove highlight");
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		clearPersistentPdfHighlight();
	});
	host.appendChild(button);
	state.button = button;
}

/**
 * Removes the CSS highlight, disconnects the observer, removes the floating
 * button and forgets the active state, so the highlight cannot reappear.
 */
export function clearPersistentPdfHighlight(): void {
	generation += 1;
	const state = active;
	active = null;

	if (highlightApiAvailable()) highlightRegistry().delete(HIGHLIGHT_NAME);
	if (!state) return;

	if (state.refreshTimer !== null) window.clearTimeout(state.refreshTimer);
	state.observer?.disconnect();
	state.button?.remove();
	if (state.restorePosition !== null) state.container.style.position = state.restorePosition;
	state.range = null;
}
export async function applyPersistentPdfHighlight(
	app: App,
	occurrence: PdfTextOccurrence,
): Promise<PersistentHighlightResult> {
	clearPersistentPdfHighlight();
	const myGeneration = generation;

	if (!highlightApiAvailable()) {
		return { applied: false, reason: "The CSS Custom Highlight API is unavailable in this Obsidian build.", method: null };
	}

	const deadline = Date.now() + TEXT_LAYER_TIMEOUT_MS;
	let container: HTMLElement | null = null;
	let layer: HTMLElement | null = null;
	let built: BuiltRange | null = null;

	while (Date.now() < deadline) {
		if (myGeneration !== generation) {
			return { applied: false, reason: "A newer highlight request replaced this one.", method: null };
		}
		container = findPdfContainer(app, occurrence.filePath);
		layer = container ? findTextLayer(container, occurrence.pdfPage) : null;
		if (layer) {
			built = buildRange(layer, occurrence);
			if (built) break;
		}
		await delay(POLL_INTERVAL_MS);
	}

	if (myGeneration !== generation) {
		return { applied: false, reason: "A newer highlight request replaced this one.", method: null };
	}
	if (!container) {
		return { applied: false, reason: "The PDF view for the target file could not be found.", method: null };
	}
	if (!layer) {
		return { applied: false, reason: "The page opened, but the target PDF text layer was unavailable.", method: null };
	}
	if (!built) {
		return { applied: false, reason: "The matching text could not be located in the rendered text layer.", method: null };
	}

	const state: ActiveHighlight = {
		occurrence,
		container,
		range: built.range,
		observer: null,
		button: null,
		restorePosition: null,
		refreshTimer: null,
	};
	active = state;
	setHighlight(built.range);

	built.range.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });

	state.observer = new MutationObserver(scheduleRefresh);
	state.observer.observe(container, { childList: true, subtree: true });
	createRemoveButton(state);

	return {
		applied: true,
		reason: built.method === "text-item-selection"
			? "Persistent highlight applied from verified PDF.js text-item indexes."
			: "Persistent highlight applied by locating the verified match in the rendered text layer.",
		method: built.method,
	};
}