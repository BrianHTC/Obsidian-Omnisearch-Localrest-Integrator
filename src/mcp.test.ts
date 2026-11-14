import { App, Events } from "obsidian";

import {
	OMNISEARCH_OCCURRENCES_TOOL,
	OMNISEARCH_OPEN_OCCURRENCE_TOOL,
	OMNISEARCH_SEARCH_TOOL,
	registerMcp,
} from "./mcp";
import { FakeHost, makeContext } from "./testing/fakeHost";

function setUp(results: unknown[] = [], installOmnisearch = true): {
	host: FakeHost;
	search: jest.Mock;
} {
	const app = new App();
	const search = jest.fn().mockResolvedValue(results);

	if (installOmnisearch) {
		app.plugins.plugins.omnisearch = { api: { search } };
	}

	const host = new FakeHost(app);
	registerMcp(host.api, makeContext(app, new Events()));
	return { host, search };
}

function getTool(host: FakeHost, name: string) {
	const tool = host.simpleTools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing MCP tool "${name}".`);
	return tool;
}

describe("Omnisearch MCP tools", () => {
	test("registers search, occurrence, and open tools", () => {
		const { host } = setUp();

		expect(host.simpleTools.map((tool) => tool.name)).toEqual([
			OMNISEARCH_SEARCH_TOOL,
			OMNISEARCH_OCCURRENCES_TOOL,
			OMNISEARCH_OPEN_OCCURRENCE_TOOL,
		]);
	});

	test("trims the query and returns an empty indexed result page", async () => {
		const { host, search } = setUp();
		const tool = getTool(host, OMNISEARCH_SEARCH_TOOL);

		await expect(tool.callback({ query: "  example  " })).resolves.toMatchObject({
			query: "example",
			resultMode: "fast-preview",
			totalMatchingFiles: 0,
			files: [],
		});
		expect(search).toHaveBeenCalledWith("example");
		expect(tool.annotations?.readOnlyHint).toBe(true);
	});

	test("reports when Omnisearch is unavailable", async () => {
		const { host } = setUp([], false);
		const tool = getTool(host, OMNISEARCH_SEARCH_TOOL);

		await expect(tool.callback({ query: "example" })).rejects.toThrow(
			"Omnisearch is not installed, enabled, or ready.",
		);
	});

	test("rejects an occurrence request for a path not returned by Omnisearch", async () => {
		const { host } = setUp();
		const tool = getTool(host, OMNISEARCH_OCCURRENCES_TOOL);

		await expect(
			tool.callback({ query: "example", path: "missing.md" }),
		).rejects.toThrow('No Omnisearch result exists at path "missing.md"');
	});

	test("requires occurrence coordinates when opening a verified result", async () => {
		const { host } = setUp();
		const tool = getTool(host, OMNISEARCH_OPEN_OCCURRENCE_TOOL);

		await expect(
			tool.callback({ mode: "verified-occurrence" }),
		).rejects.toThrow(
			"Verified occurrence mode requires query, path, and occurrenceNumber.",
		);
	});
});
