/**
 * Message focus: move the arrow keys off prompt history and onto your own messages.
 * Built into the fork, so it shares the host's extension API rather than loading via jiti.
 *
 * Up arrow in the editor opens a panel on the newest user message, so it works while a
 * response is still streaming. Up/down walk previous user messages, (c) copies, (e)
 * rewinds the session to that message and puts its text back in the editor. Rewinding
 * waits for the current response; browsing and copying do not.
 *
 * The panel renders in the editor dock because pi's extension API can replace the
 * editor but cannot draw around messages already rendered into the transcript.
 */

import { type Component, isViewportTUI, Key, Markdown, matchesKey, type TUI } from "@earendil-works/pi-tui";
// Concrete modules, not ../../index.ts: the barrel re-enters this file through
// extensions/index.ts, and a class-extends would then read an uninitialised binding.
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { CustomEditor } from "../../modes/interactive/components/custom-editor.ts";
import { rawKeyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { collectFocusableMessages, type FocusableMessage, frameBottom, frameRow, frameTop } from "./frame.ts";

const COMMAND_NAME = "focus";
/** Rows left free below the panel so the transcript and footer stay visible. */
const RESERVED_ROWS = 8;
const MIN_BODY_ROWS = 3;

type FocusResult = { action: "rewind"; entryId: string } | null;

type PanelOptions = {
	messages: readonly FocusableMessage[];
	theme: Theme;
	tui: TUI;
	onCopy: (message: FocusableMessage) => void;
	onReveal: (message: FocusableMessage) => void;
	onClose: (result: FocusResult) => void;
};

class MessageFocusPanel implements Component {
	private readonly options: PanelOptions;
	private index: number;
	private cachedKey = "";
	private cachedBody: string[] = [];

	constructor(options: PanelOptions) {
		this.options = options;
		this.index = options.messages.length - 1;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			if (this.index > 0) this.select(this.index - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			// Down off the newest message hands focus back to the editor.
			if (this.index < this.options.messages.length - 1) this.select(this.index + 1);
			else this.options.onClose(null);
			return;
		}

		const message = this.currentMessage();
		const key = data.toLowerCase();
		if (key === "c") {
			this.options.onCopy(message);
			return;
		}
		if (key === "e") {
			this.options.onClose({ action: "rewind", entryId: message.entryId });
			return;
		}
		// Escape, q, and ctrl+c all hand focus back to the editor.
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || key === "q") {
			this.options.onClose(null);
		}
	}

	render(width: number): string[] {
		const message = this.currentMessage();
		const label = ` [${this.index + 1}/${this.options.messages.length}] `;
		const bodyWidth = Math.max(1, width - 4);

		return [
			frameTop({ width, label }),
			...this.bodyLines({ message, width: bodyWidth }).map((line) => frameRow({ width, content: line })),
			frameBottom(width),
			this.hintLine(),
		];
	}

	invalidate(): void {
		this.cachedKey = "";
		this.cachedBody = [];
	}

	private currentMessage(): FocusableMessage {
		return this.options.messages[this.index]!;
	}

	private select(index: number): void {
		this.index = index;
		this.invalidate();
		this.options.onReveal(this.currentMessage());
		this.options.tui.requestRender();
	}

	/** Rows are cached per message and width; `invalidate()` clears them on theme changes. */
	private bodyLines({ message, width }: { message: FocusableMessage; width: number }): string[] {
		const key = `${message.entryId}:${width}`;
		if (key === this.cachedKey) return this.cachedBody;

		const capacity = Math.max(MIN_BODY_ROWS, this.options.tui.terminal.rows - RESERVED_ROWS);
		const rendered = new Markdown(message.text, 0, 0, getMarkdownTheme()).render(width);
		const body = rendered.slice(0, capacity);
		if (body.length < rendered.length) {
			body.push(this.options.theme.fg("dim", `… ${rendered.length - body.length} more lines`));
		}

		this.cachedKey = key;
		this.cachedBody = body;
		return body;
	}

	private hintLine(): string {
		const hints = [rawKeyHint("↑↓", "move"), rawKeyHint("c", "copy"), rawKeyHint("e", "edit & rewind")];
		hints.push(rawKeyHint("esc", "close"));
		return ` ${hints.join("  ")}`;
	}
}

class FocusEditor extends CustomEditor {
	openFocus?: () => void;

	handleInput(data: string): void {
		if (this.openFocus && matchesKey(data, Key.up) && this.shouldOpenFocus()) {
			this.openFocus();
			return;
		}
		super.handleInput(data);
	}

	/**
	 * Autocomplete list navigation and multi-line cursor movement still own up/down;
	 * only prompt history gave them up.
	 */
	private shouldOpenFocus(): boolean {
		// `autocompleteState` is private on Editor and has no getter, but only the type is private.
		if ((this as unknown as { autocompleteState?: unknown }).autocompleteState) return false;
		return this.getLines().length === 1 || this.getCursor().line === 0;
	}
}

async function copyMessage({
	ctx,
	message,
}: {
	ctx: ExtensionCommandContext;
	message: FocusableMessage;
}): Promise<void> {
	try {
		await copyToClipboard(message.text);
		ctx.ui.notify("Copied message", "info");
	} catch (error) {
		ctx.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

let warnedAboutScrolling = false;

/** `revealEntry` returns false when the transcript is not scrollable — i.e. regular mode. */
function revealMessage({
	ctx,
	message,
	tui,
}: {
	ctx: ExtensionCommandContext;
	message: FocusableMessage;
	tui: TUI;
}): void {
	if (ctx.ui.revealEntry(message.entryId)) return;

	// Regular mode writes the transcript into the terminal scrollback, so there is nothing to scroll.
	if (isViewportTUI(tui) || warnedAboutScrolling) return;
	warnedAboutScrolling = true;
	ctx.ui.notify("Scrolling to messages needs fullscreen mode (--tui-mode fullscreen)", "warning");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: "Focus a previous message: ↑↓ move, c copy, e edit & rewind",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;

			const messages = collectFocusableMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("No messages to focus", "info");
				return;
			}

			const result = await ctx.ui.custom<FocusResult>(
				(tui, theme, _keybindings, done) =>
					new MessageFocusPanel({
						messages,
						theme,
						tui,
						onCopy: (message) => void copyMessage({ ctx, message }),
						onReveal: (message) => revealMessage({ ctx, message, tui }),
						onClose: done,
					}),
			);

			if (result?.action === "rewind") {
				// Browsing works mid-response, but the tree cannot be rewound while the agent is running.
				if (!ctx.isIdle()) {
					ctx.ui.notify("Finish or abort the current response before rewinding", "warning");
					return;
				}
				// Rewinds the leaf to before that message and refills the editor with its text.
				await ctx.navigateTree(result.entryId);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new FocusEditor(tui, theme, keybindings);
			// Submitting the command hands us the command context, which owns navigateTree.
			editor.openFocus = () => void editor.onSubmit?.(`/${COMMAND_NAME}`);
			return editor;
		});
	});
}
