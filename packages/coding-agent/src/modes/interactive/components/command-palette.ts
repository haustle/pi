/**
 * Command palette: fuzzy search over recent threads, slash commands, and editor toggles.
 *
 * Rendered as an overlay so it floats above the transcript. Navigation uses the
 * `tui.select.*` bindings and hints come from the live keybinding registry, so both
 * stay consistent with the rest of the app.
 */

import {
	type Component,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type Keybinding,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ThemeColor } from "../theme/theme.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

const CATEGORY_WIDTH = 9;
const COLUMN_GAP = 2;
const MIN_LABEL_WIDTH = 8;
/** Rows the palette spends on borders, the query line, a spacer, and the results count. */
const PALETTE_CHROME_ROWS = 5;
const PALETTE_MAX_VISIBLE = 24;
/** First rendered row inside the box: top border, query line, spacer, then rows. */
const ROWS_TOP_LINE = 3;

export type PaletteHint = { type: "key"; keybinding: Keybinding } | { type: "text"; text: string };

export type PaletteCategory = "thread" | "command" | "editor" | "extension" | "prompt" | "skill";

export interface PaletteEntry {
	category: PaletteCategory;
	label: string;
	/** Stable identity across `setEntries` refreshes. Defaults to category and label. */
	key?: string;
	/** Extra fuzzy-match text, typically the entry's description. */
	keywords?: string;
	/** Overrides the label color, so a row can stand out regardless of selection. */
	labelColor?: ThemeColor;
	hint?: PaletteHint;
	/** Keep this row above the filtered results and always visible. */
	pinned?: boolean;
	/** Leave this row out of the initial selection, so the list opens on its first real result. */
	skipInitialSelection?: boolean;
	/** Rows sharing a group get one heading above the first of them, when no query is typed. */
	group?: string;
	/** Replaces `label` when set, so a row can reflect the query it will act on. */
	labelFromQuery?: (query: string) => string;
	run: (query: string) => void | Promise<void>;
}

export interface CommandPaletteOptions {
	entries: readonly PaletteEntry[];
	maxVisible: number;
	title?: string;
	onAccept: (entry: PaletteEntry, query: string) => void;
	onCancel: () => void;
}

/** How many list rows to show: most of the terminal, leaving room for the box chrome. */
export function paletteMaxVisible(terminalRows: number): number {
	return Math.max(5, Math.min(PALETTE_MAX_VISIBLE, Math.floor(terminalRows * 0.8) - PALETTE_CHROME_ROWS));
}

function hintText(hint: PaletteHint | undefined): string {
	if (!hint) return "";
	return hint.type === "text" ? hint.text : keyText(hint.keybinding);
}

/** Entries matching `query`, best match first. Pinned rows stay on top. */
export function filterPaletteEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
	const pinned = entries.filter((entry) => entry.pinned);
	const rest = entries.filter((entry) => !entry.pinned);
	if (!query.trim()) return [...pinned, ...rest];
	return [
		...pinned,
		...fuzzyFilter(rest, query, (entry) => `${entry.category} ${entry.label} ${entry.keywords ?? ""}`),
	];
}

/** A rendered palette row: a group heading or a reference to a filtered entry. */
export type PaletteRow = { kind: "header"; label: string } | { kind: "entry"; index: number };

/**
 * Rows for the filtered list, with a heading before the first entry of each group. Headings
 * only appear for an empty query, so a typed query stays a flat ranked list.
 */
export function paletteRows(entries: readonly PaletteEntry[], query: string): PaletteRow[] {
	if (query.trim()) return entries.map((_, index) => ({ kind: "entry" as const, index }));
	const rows: PaletteRow[] = [];
	let group: string | undefined;
	entries.forEach((entry, index) => {
		if (entry.group && entry.group !== group) {
			group = entry.group;
			rows.push({ kind: "header", label: group });
		}
		rows.push({ kind: "entry", index });
	});
	return rows;
}

/**
 * Row to select after the list changes. A typed query means the user is looking for an
 * existing entry, so skip the pinned rows unless nothing else matched.
 */
export function initialPaletteSelection(entries: readonly PaletteEntry[], query: string): number {
	if (query.trim()) {
		const pinned = entries.filter((entry) => entry.pinned).length;
		return entries.length > pinned ? pinned : 0;
	}
	const first = entries.findIndex((entry) => !entry.skipInitialSelection);
	return first === -1 ? 0 : first;
}

/** Index window of at most `maxVisible` rows that keeps `selected` in view. */
export function paletteWindow(total: number, selected: number, maxVisible: number): { start: number; end: number } {
	if (total <= maxVisible) return { start: 0, end: total };
	const start = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), total - maxVisible));
	return { start, end: start + maxVisible };
}

export class CommandPalette implements Component, Focusable {
	private entries: readonly PaletteEntry[];
	private readonly maxVisible: number;
	private readonly title: string;
	private readonly onAccept: (entry: PaletteEntry, query: string) => void;
	private readonly onCancel: () => void;
	private readonly input: Input;
	private filtered: PaletteEntry[];
	private selectedIndex: number;
	private rows: PaletteRow[] = [];
	private rowStart = 0;
	private rowEnd = 0;
	private mousePressedIndex: number | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private focusedValue = false;

	constructor(options: CommandPaletteOptions) {
		this.entries = options.entries;
		this.maxVisible = Math.max(1, options.maxVisible);
		this.title = options.title ?? "Command Palette";
		this.onAccept = options.onAccept;
		this.onCancel = options.onCancel;
		this.filtered = filterPaletteEntries(options.entries, "");
		this.selectedIndex = initialPaletteSelection(this.filtered, "");
		this.input = new Input({ prompt: ">" });
		this.input.onSubmit = () => this.acceptSelected();
		this.input.onEscape = () => this.onCancel();
	}

	/** Focusable: propagate focus to the query input so the terminal cursor lands there. */
	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.acceptSelected();
			return;
		}
		if (keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (keybindings.matches(data, "tui.select.pageUp")) {
			this.move(-this.maxVisible);
			return;
		}
		if (keybindings.matches(data, "tui.select.pageDown")) {
			this.move(this.maxVisible);
			return;
		}

		this.input.handleInput(data);
		this.refilter();
	}

	/** Click selects and activates a row; the wheel moves the selection. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.filtered.length === 0) return undefined;

		if (event.type === "wheel" && event.wheelDelta) {
			const previous = this.selectedIndex;
			this.move(event.wheelDelta < 0 ? -1 : 1);
			return { handled: true, render: this.selectedIndex !== previous };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;

		const row = this.rowStart + (event.y - ROWS_TOP_LINE);
		if (row < this.rowStart || row >= this.rowEnd) return undefined;
		const target = this.rows[row];
		if (target?.kind !== "entry") return undefined;
		const index = target.index;

		if (event.type === "press") {
			this.mousePressedIndex = index;
			if (this.selectedIndex !== index) {
				this.selectedIndex = index;
				this.invalidate();
			}
			return { handled: true, focus: true };
		}

		this.selectedIndex = this.mousePressedIndex ?? index;
		this.mousePressedIndex = undefined;
		this.acceptSelected();
		return { handled: true };
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const inner = Math.max(MIN_LABEL_WIDTH + CATEGORY_WIDTH + COLUMN_GAP, width - 4);
		const query = this.input.getValue();
		const lines: string[] = [
			this.renderTopBorder(width),
			this.renderRow(inner, this.input.render(inner)[0] ?? ""),
			this.renderRow(inner, ""),
		];

		const rows = paletteRows(this.filtered, query);
		const selectedRow = rows.findIndex((item) => item.kind === "entry" && item.index === this.selectedIndex);
		const { start, end } = paletteWindow(rows.length, Math.max(0, selectedRow), this.maxVisible);
		this.rows = rows;
		this.rowStart = start;
		this.rowEnd = end;

		if (this.filtered.length === 0) {
			lines.push(this.renderRow(inner, theme.fg("muted", "no matches")));
		}
		for (let row = start; row < end; row++) {
			const item = rows[row];
			if (!item) continue;
			if (item.kind === "header") {
				lines.push(this.renderHeaderRow(inner, item.label));
				continue;
			}
			const entry = this.filtered[item.index];
			if (entry) {
				lines.push(this.renderEntryRow({ entry, query, inner, selected: item.index === this.selectedIndex }));
			}
		}
		if (this.filtered.length > this.maxVisible) {
			lines.push(this.renderRow(inner, theme.fg("muted", `(${this.selectedIndex + 1}/${this.filtered.length})`)));
		}

		lines.push(this.renderBottomBorder(width));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private acceptSelected(): void {
		const entry = this.filtered[this.selectedIndex];
		if (entry) this.onAccept(entry, this.input.getValue());
	}

	private move(delta: number): void {
		if (this.filtered.length === 0) return;
		const next = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIndex + delta));
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.invalidate();
	}

	/**
	 * Replace the entries while the palette is open, keeping the query and, when it is still
	 * listed, the selected row. Used to refresh live thread statuses.
	 */
	setEntries(entries: readonly PaletteEntry[]): void {
		const selected = this.filtered[this.selectedIndex];
		this.entries = entries;
		this.filtered = filterPaletteEntries(entries, this.input.getValue());
		const identity = (entry: PaletteEntry) => entry.key ?? `${entry.category}\u0000${entry.label}`;
		const kept = selected ? this.filtered.findIndex((entry) => identity(entry) === identity(selected)) : -1;
		this.selectedIndex = kept === -1 ? initialPaletteSelection(this.filtered, this.input.getValue()) : kept;
		this.invalidate();
	}

	private refilter(): void {
		const query = this.input.getValue();
		this.filtered = filterPaletteEntries(this.entries, query);
		this.selectedIndex = initialPaletteSelection(this.filtered, query);
		this.invalidate();
	}

	private renderTopBorder(width: number): string {
		const label = ` ${this.title} `;
		const fill = "─".repeat(Math.max(0, width - 3 - visibleWidth(label)));
		return `${theme.fg("border", "╭─")}${theme.fg("accent", theme.bold(label))}${theme.fg("border", `${fill}╮`)}`;
	}

	private renderBottomBorder(width: number): string {
		return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}

	/** Group heading: a muted label over a dim rule, so buckets read as sections. */
	private renderHeaderRow(inner: number, label: string): string {
		const rule = "─".repeat(Math.max(0, inner - visibleWidth(label) - 1));
		return this.renderRow(inner, `${theme.fg("muted", theme.bold(label))} ${theme.fg("border", rule)}`);
	}

	/** One row inside the box, padded to `inner`. `selected` fills the row background. */
	private renderRow(inner: number, content: string, selected = false): string {
		const padded = content + " ".repeat(Math.max(0, inner - visibleWidth(content)));
		const body = selected ? theme.bg("selectedBg", padded) : padded;
		return `${theme.fg("border", "│")} ${body} ${theme.fg("border", "│")}`;
	}

	private renderEntryRow({
		entry,
		query,
		inner,
		selected,
	}: {
		entry: PaletteEntry;
		query: string;
		inner: number;
		selected: boolean;
	}): string {
		const hint = hintText(entry.hint);
		const category = entry.category.slice(0, CATEGORY_WIDTH).padEnd(CATEGORY_WIDTH);
		const labelWidth = Math.max(MIN_LABEL_WIDTH, inner - CATEGORY_WIDTH - COLUMN_GAP * 2 - visibleWidth(hint));
		const label = truncateToWidth(entry.labelFromQuery ? entry.labelFromQuery(query) : entry.label, labelWidth);
		const used = CATEGORY_WIDTH + COLUMN_GAP + visibleWidth(label) + visibleWidth(hint);
		const gap = " ".repeat(Math.max(1, inner - used));
		const categoryStyle = selected ? "muted" : "dim";
		const labelStyle = entry.labelColor ?? (selected ? "accent" : undefined);
		const content =
			theme.fg(categoryStyle, category) +
			" ".repeat(COLUMN_GAP) +
			(labelStyle ? theme.fg(labelStyle, label) : label) +
			gap +
			theme.fg(categoryStyle, hint);
		return this.renderRow(inner, content, selected);
	}
}
