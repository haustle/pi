import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";
import type { StatusIndicator } from "./status-indicator.ts";

/** Blank columns between the terminal edge and the editor frame. */
const FRAME_MARGIN = 1;
/** Columns from the component edge to the text: the margin, the side border, and one space. */
const FRAME_INSET = FRAME_MARGIN + 2;
/** Narrower than this, the frame would crowd the text, so the plain top/bottom rules are kept. */
const MIN_FRAMED_WIDTH = FRAME_INSET * 2 + 8;
/** Dashes the top rule keeps for itself when it carries frame labels. */
const MIN_FRAME_RULE_DASHES = 4;

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	public readonly embedWorkingStatus: boolean;
	/** Text shown at the right end of the bottom border, such as background thread activity. */
	private bottomLabel: string | undefined;
	/**
	 * Text shown inside the top border: the project folder at the left, the git branch at the right.
	 * Both are shortened to their share of the width; an absent side leaves the rule plain there.
	 */
	private frameLabels: { left?: string; right?: string } = {};
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	/** Text shown at the right end of the bottom border, such as background thread activity. */
	setBottomLabel(label: string | undefined): void {
		this.bottomLabel = label;
	}

	setFrameLabels(labels: { left?: string; right?: string }): void {
		this.frameLabels = labels;
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		const label = this.bottomLabel ? ` ${this.bottomLabel} ` : "";
		const labelWidth = visibleWidth(label);
		// Scroll indicators take priority; the label only shows when it fits with room to spare.
		if (!label || hiddenLineCount > 0 || labelWidth + 4 > width) {
			return super.renderBottomBorder(width, hiddenLineCount);
		}
		return this.borderColor("─".repeat(width - labelWidth - 1)) + theme.fg("muted", label) + this.borderColor("─");
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	/**
	 * Draw the editor as a rounded box inset from the terminal edge. The base editor renders
	 * its top rule, text rows, bottom rule, then any autocomplete rows; this wraps the rules in
	 * corners, the text rows in side borders, and indents the autocomplete rows to match.
	 */
	override render(width: number): string[] {
		if (width < MIN_FRAMED_WIDTH) return super.render(width);

		const inner = width - FRAME_INSET * 2;
		const lines = super.render(inner);
		const bottomIndex = this.renderedVisibleLineCount + 1;
		const margin = " ".repeat(FRAME_MARGIN);
		const side = this.borderColor("│");
		return lines.map((line, index) => {
			if (index === 0) return `${margin}${this.borderColor("╭─")}${line}${this.borderColor("─╮")}${margin}`;
			if (index < bottomIndex) return `${margin}${side} ${line} ${side}${margin}`;
			if (index === bottomIndex)
				return `${margin}${this.borderColor("╰─")}${line}${this.borderColor("─╯")}${margin}`;
			return `${margin}  ${line}  ${margin}`;
		});
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.width < MIN_FRAMED_WIDTH) return super.handleMouse(event);
		return super.handleMouse({ ...event, x: event.x - FRAME_INSET, width: event.width - FRAME_INSET * 2 });
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const left = this.frameLabels.left;
		const right = this.frameLabels.right;
		if (!left && !right) return this.renderTopRule(width, hiddenLineCount);

		const labels = [left, right].filter((label) => label !== undefined).length;
		const share = Math.max(1, Math.floor((width - MIN_FRAME_RULE_DASHES - 2 * labels) / labels));
		const leftChunk = left ? this.frameLabelChunk(left, share) : "";
		const rightChunk = right ? this.frameLabelChunk(right, share) : "";
		const reserved = visibleWidth(leftChunk) + visibleWidth(rightChunk);
		return leftChunk + this.renderTopRule(width - reserved, hiddenLineCount) + rightChunk;
	}

	/** A top-rule label, padded by one space each side and shortened to fit its share. */
	private frameLabelChunk(label: string, share: number): string {
		return this.borderColor(` ${truncateToWidth(label, share, "…")} `);
	}

	/** The editor's own top rule at `width`, untouched by the frame labels. */
	private renderTopRule(width: number, hiddenLineCount: number): string {
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}

		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}

		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
