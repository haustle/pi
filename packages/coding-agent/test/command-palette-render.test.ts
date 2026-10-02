import { beforeEach, describe, expect, it } from "vitest";
import { CommandPalette } from "../src/modes/interactive/components/command-palette.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

/** Strips SGR codes so assertions can look at the visible text. */
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

/** Mouse rows start under the top border, the query line, and the spacer. */
const ROWS_TOP_LINE = 3;

function makePalette(accepted: string[]): CommandPalette {
	return new CommandPalette({
		entries: [
			{ category: "thread", label: "New thread", run: () => {} },
			{ category: "thread", label: "today a", group: "Today", run: () => {} },
			{ category: "thread", label: "today b", group: "Today", run: () => {} },
			{ category: "thread", label: "last week", group: "Last week", run: () => {} },
		],
		maxVisible: 10,
		title: "Threads",
		onAccept: (entry) => accepted.push(entry.label),
		onCancel: () => {},
	});
}

describe("CommandPalette group headings", () => {
	beforeEach(() => initTheme("dark"));

	it("renders one heading per group, sized to the box", () => {
		const lines = plain(makePalette([]).render(60));
		// The heading rule fills the row, and every row stays inside the border.
		expect(lines).toContainEqual(expect.stringContaining("Today ──"));
		expect(lines).toContainEqual(expect.stringContaining("Last week ──"));
		expect(lines.every((line) => line.startsWith("│") || line.startsWith("╭") || line.startsWith("╰"))).toBe(true);
	});

	it("ignores clicks on a heading and accepts the entry under the cursor", () => {
		const accepted: string[] = [];
		const palette = makePalette(accepted);

		palette.render(60);
		expect(palette.handleMouse({ type: "press", button: "left", y: ROWS_TOP_LINE + 1 })).toBeUndefined();

		// Row 2 is the first "Today" entry.
		expect(palette.handleMouse({ type: "press", button: "left", y: ROWS_TOP_LINE + 2 })).toMatchObject({
			handled: true,
		});
		palette.handleMouse({ type: "click", button: "left", y: ROWS_TOP_LINE + 2 });
		expect(accepted).toEqual(["today a"]);
	});
});

describe("CommandPalette label color", () => {
	beforeEach(() => initTheme("dark"));

	it("uses the entry label color while another row is selected", () => {
		const palette = new CommandPalette({
			entries: [
				{ category: "thread", label: "New thread", pinned: true, run: () => {} },
				{ category: "thread", label: "Working thread", labelColor: "warning", run: () => {} },
				{ category: "thread", label: "Idle thread", run: () => {} },
			],
			maxVisible: 10,
			title: "Threads",
			onAccept: () => {},
			onCancel: () => {},
		});

		const lines = palette.render(60);
		expect(lines).toContainEqual(expect.stringContaining(theme.fg("warning", "Working thread")));
		expect(lines).not.toContainEqual(expect.stringContaining(theme.fg("warning", "Idle thread")));
	});
});
