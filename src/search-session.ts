/**
 * Short-lived, in-memory storage for fast-search previews.
 *
 * `omnisearch_search` (fast-preview mode) stores every preview it returns
 * under a `searchSessionId`, so a later `omnisearch_open_occurrence` call in
 * `search-preview` mode can reopen "file N, preview M" without the agent
 * re-sending the preview text. Sessions expire after 10 minutes.
 */

export type SearchPreviewFileType =
	| "pdf"
	| "markdown"
	| "other";

export type SearchPreviewReference = {
	searchSessionId: string;
	fileNumber: number;
	previewNumber: number;
	query: string;
	path: string;
	fileType: SearchPreviewFileType;
	match: string;
	context: string;
	characterOffset: number | null;
	createdAt: number;
};

export type SearchPreviewInput = Omit<
	SearchPreviewReference,
	"searchSessionId" | "createdAt"
>;

export type SearchSessionInfo = {
	searchSessionId: string;
	createdAt: number;
	expiresAt: number;
	previewCount: number;
};

const SEARCH_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SEARCH_SESSIONS = 20;

type SearchSession = {
	id: string;
	createdAt: number;
	expiresAt: number;
	previews: Map<string, SearchPreviewReference>;
};

const sessions = new Map<string, SearchSession>();

function previewKey(fileNumber: number, previewNumber: number): string {
	return `${fileNumber}:${previewNumber}`;
}

function createSessionId(): string {
	const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
	if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
		return cryptoApi.randomUUID();
	}
	return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function pruneSessions(now: number): void {
	for (const [id, session] of sessions) {
		if (session.expiresAt <= now) sessions.delete(id);
	}

	// Map iteration order is insertion order, so the first entries are oldest.
	while (sessions.size > MAX_SEARCH_SESSIONS) {
		const oldest = sessions.keys().next().value;
		if (oldest === undefined) break;
		sessions.delete(oldest);
	}
}

export function createSearchSession(
	previews: SearchPreviewInput[],
): SearchSessionInfo {
	const now = Date.now();
	const id = createSessionId();
	const stored = new Map<string, SearchPreviewReference>();

	for (const preview of previews) {
		stored.set(previewKey(preview.fileNumber, preview.previewNumber), {
			...preview,
			searchSessionId: id,
			createdAt: now,
		});
	}

	sessions.set(id, {
		id,
		createdAt: now,
		expiresAt: now + SEARCH_SESSION_TTL_MS,
		previews: stored,
	});
	pruneSessions(now);

	return {
		searchSessionId: id,
		createdAt: now,
		expiresAt: now + SEARCH_SESSION_TTL_MS,
		previewCount: stored.size,
	};
}

/**
 * Returns the stored preview, or null when the session is unknown, expired,
 * or has no preview with that file/preview number.
 */
export function getSearchPreview(
	searchSessionId: string,
	fileNumber: number,
	previewNumber: number,
): SearchPreviewReference | null {
	const now = Date.now();
	pruneSessions(now);

	const session = sessions.get(searchSessionId.trim());
	if (!session || session.expiresAt <= now) return null;

	return session.previews.get(previewKey(fileNumber, previewNumber)) ?? null;
}

export function clearSearchSessions(): void {
	sessions.clear();
}