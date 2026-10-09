import { describe, expect, it } from "vitest";
import {
	filterPaletteEntries,
	initialPaletteSelection,
	type PaletteCategory,
	type PaletteEntry,
	paletteMaxVisible,
	paletteRows,
	paletteWindow,
} from "../../src/modes/interactive/components/command-palette.ts";

function entry(label: string, category: PaletteCategory = "command", keywords?: string): PaletteEntry {
	return { category, label, keywords, run: () => {} };
}

const createThread: PaletteEntry = {
	category: "thread",
	label: "New thread",
	pinned: true,
	run: () => {},
};

const entries = [
	entry("/model", "command", "Open model selector"),
	entry("/compact", "command", "Compact the conversation"),
	entry("fix the widget", "thread"),
	entry("Toggle tool output", "editor"),
];

describe("filterPaletteEntries", () => {
	it("keeps the caller's order for an empty query", () => {
		expect(filterPaletteEntries(entries, "")).toEqual(entries);
		expect(filterPaletteEntries(entries, "   ")).toEqual(entries);
	});

	it("matches on label, category, and keywords", () => {
		expect(filterPaletteEntries(entries, "model").map((item) => item.label)).toEqual(["/model"]);
		expect(filterPaletteEntries(entries, "thread").map((item) => item.label)).toEqual(["fix the widget"]);
		expect(filterPaletteEntries(entries, "conversation").map((item) => item.label)).toEqual(["/compact"]);
	});

	it("keeps pinned rows on top even when only they match", () => {
		const withPinned = [entry("/model"), createThread, entry("fix the widget", "thread")];

		expect(filterPaletteEntries(withPinned, "")[0]).toBe(createThread);
		expect(filterPaletteEntries(withPinned, "zzzz")).toEqual([createThread]);
		expect(filterPaletteEntries(withPinned, "model").map((item) => item.label)).toEqual(["New thread", "/model"]);
	});

	it("does not mutate the caller's list", () => {
		const before = [...entries];
		filterPaletteEntries(entries, "model");
		expect(entries).toEqual(before);
	});

	it("ranks commands, then skills, then extensions, then the rest", () => {
		const mixed = [
			entry("search threads", "thread"),
			entry("/search", "command"),
			entry("search skill", "skill"),
			entry("search ext", "extension"),
			entry("search prompt", "prompt"),
		];
		expect(filterPaletteEntries(mixed, "search").map((item) => item.label)).toEqual([
			"/search",
			"search skill",
			"search ext",
			"search threads",
			"search prompt",
		]);
	});

	it("keeps fuzzy ranking within a category", () => {
		const mixed = [entry("toggle model output", "extension"), entry("model picker", "extension")];
		expect(filterPaletteEntries(mixed, "model").map((item) => item.label)).toEqual([
			"model picker",
			"toggle model output",
		]);
	});
});

describe("initialPaletteSelection", () => {
	it("selects the first row when the query is empty", () => {
		expect(initialPaletteSelection([createThread, ...entries], "")).toBe(0);
	});

	it("skips rows marked skipInitialSelection when the query is empty", () => {
		expect(initialPaletteSelection([{ ...createThread, skipInitialSelection: true }, ...entries], "")).toBe(1);
	});

	it("falls back to a skipped row when it is the only one", () => {
		expect(initialPaletteSelection([{ ...createThread, skipInitialSelection: true }], "")).toBe(0);
	});

	it("skips pinned rows when a query matched something else", () => {
		expect(initialPaletteSelection([createThread, entry("/model")], "model")).toBe(1);
	});

	it("falls back to the pinned row when nothing else matched", () => {
		expect(initialPaletteSelection([createThread], "zzzz")).toBe(0);
	});
});

describe("paletteWindow", () => {
	it("shows every row when the list fits", () => {
		expect(paletteWindow(3, 0, 5)).toEqual({ start: 0, end: 3 });
	});

	it("keeps the selection centred while scrolling", () => {
		expect(paletteWindow(20, 10, 4)).toEqual({ start: 8, end: 12 });
	});

	it("clamps the window at both ends", () => {
		expect(paletteWindow(20, 0, 4)).toEqual({ start: 0, end: 4 });
		expect(paletteWindow(20, 19, 4)).toEqual({ start: 16, end: 20 });
	});
});

describe("paletteMaxVisible", () => {
	it("uses most of a typical terminal", () => {
		expect(paletteMaxVisible(24)).toBe(14);
		expect(paletteMaxVisible(40)).toBe(24);
	});

	it("stays usable on short terminals", () => {
		expect(paletteMaxVisible(12)).toBe(5);
	});
});

describe("paletteRows", () => {
	it("leaves ungrouped entries as a flat list", () => {
		expect(paletteRows(entries, "")).toEqual(entries.map((_, index) => ({ kind: "entry", index })));
	});

	it("puts one heading above the first row of each group", () => {
		const grouped = [
			createThread,
			{ ...entry("fix the widget", "thread"), group: "Today" },
			{ ...entry("ship the thing", "thread"), group: "Today" },
			{ ...entry("older thread", "thread"), group: "Older" },
		];

		expect(paletteRows(grouped, "")).toEqual([
			{ kind: "entry", index: 0 },
			{ kind: "header", label: "Today" },
			{ kind: "entry", index: 1 },
			{ kind: "entry", index: 2 },
			{ kind: "header", label: "Older" },
			{ kind: "entry", index: 3 },
		]);
	});

	it("drops headings while a query is typed", () => {
		const grouped = [{ ...entry("fix the widget", "thread"), group: "Today" }, entry("/model")];
		expect(paletteRows(grouped, "widget")).toEqual([
			{ kind: "entry", index: 0 },
			{ kind: "entry", index: 1 },
		]);
	});
});
