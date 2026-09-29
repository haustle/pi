import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../../core/extensions/index.ts";

type WidgetArgs = Parameters<ExtensionUIContext["setWidget"]>;
type FooterFactory = Parameters<ExtensionUIContext["setFooter"]>[0];
type HeaderFactory = Parameters<ExtensionUIContext["setHeader"]>[0];
type EditorFactory = Parameters<ExtensionUIContext["setEditorComponent"]>[0];
type AutocompleteFactory = Parameters<ExtensionUIContext["addAutocompleteProvider"]>[0];
type TerminalInputHandler = Parameters<ExtensionUIContext["onTerminalInput"]>[0];
type WorkingIndicatorOptions = Parameters<ExtensionUIContext["setWorkingIndicator"]>[0];

/** An extension dialog the user has not answered yet. */
interface PendingDialog {
	show: (ui: ExtensionUIContext, options: { signal: AbortSignal; timeout?: number }) => Promise<unknown>;
	fallback: unknown;
	resolve: (value: unknown) => void;
	/** When a timed dialog gives up, so a background dialog still times out on schedule. */
	deadline?: number;
	timer?: ReturnType<typeof setTimeout>;
	/** Cancels the dialog currently on screen for this request. */
	attempt?: AbortController;
}

/**
 * Last value of an optional setter. `set` distinguishes "never called" from "called with
 * undefined", so replay only touches what the extension actually set.
 */
interface Recorded<T> {
	set: boolean;
	value: T;
}

function recorded<T>(value: T): Recorded<T> {
	return { set: false, value };
}

/**
 * The extension UI context for one thread. While the thread is on screen, calls go straight
 * to the interactive UI. While it runs in the background, dialogs wait until the user opens
 * the thread again, persistent UI (widgets, statuses, footer, editor component, ...) is
 * recorded and replayed on return, and calls that only make sense on screen are dropped.
 */
export class ThreadUIContext {
	readonly context: ExtensionUIContext;
	private readonly ui: ExtensionUIContext;
	private readonly onPendingChange: (hasPending: boolean) => void;
	private attached = true;
	private readonly pending: PendingDialog[] = [];

	private readonly statuses = new Map<string, string | undefined>();
	private readonly widgets = new Map<string, WidgetArgs>();
	private readonly footer = recorded<FooterFactory>(undefined);
	private readonly header = recorded<HeaderFactory>(undefined);
	private readonly editorComponent = recorded<EditorFactory>(undefined);
	private readonly title = recorded<string>("");
	private readonly workingMessage = recorded<string | undefined>(undefined);
	private readonly workingVisible = recorded(true);
	private readonly workingIndicator = recorded<WorkingIndicatorOptions>(undefined);
	private readonly hiddenThinkingLabel = recorded<string | undefined>(undefined);
	private readonly autocompleteProviders: AutocompleteFactory[] = [];
	private readonly terminalInputs = new Set<{ handler: TerminalInputHandler; unsubscribe?: () => void }>();

	constructor(ui: ExtensionUIContext, onPendingChange: (hasPending: boolean) => void) {
		this.ui = ui;
		this.onPendingChange = onPendingChange;
		this.context = this.createContext();
	}

	get hasPendingDialogs(): boolean {
		return this.pending.length > 0;
	}

	/**
	 * Take the thread off screen. Visible dialogs are cancelled on screen but stay pending, and
	 * terminal input listeners stop receiving keys meant for another thread.
	 */
	detach(): void {
		if (!this.attached) return;
		this.attached = false;
		for (const dialog of this.pending) {
			const attempt = dialog.attempt;
			dialog.attempt = undefined;
			attempt?.abort();
		}
		for (const input of this.terminalInputs) {
			input.unsubscribe?.();
			input.unsubscribe = undefined;
		}
	}

	/** Put the thread back on screen: replay recorded UI, then show dialogs still waiting. */
	attach(): void {
		if (this.attached) return;
		this.attached = true;
		const ui = this.ui;

		for (const [key, text] of this.statuses) ui.setStatus(key, text);
		for (const args of this.widgets.values()) (ui.setWidget as (...a: WidgetArgs) => void)(...args);
		if (this.footer.set) ui.setFooter(this.footer.value);
		if (this.header.set) ui.setHeader(this.header.value);
		if (this.editorComponent.set) ui.setEditorComponent(this.editorComponent.value);
		if (this.title.set) ui.setTitle(this.title.value);
		if (this.workingMessage.set) ui.setWorkingMessage(this.workingMessage.value);
		if (this.workingVisible.set) ui.setWorkingVisible(this.workingVisible.value);
		if (this.workingIndicator.set) ui.setWorkingIndicator(this.workingIndicator.value);
		if (this.hiddenThinkingLabel.set) ui.setHiddenThinkingLabel(this.hiddenThinkingLabel.value);
		for (const factory of this.autocompleteProviders) ui.addAutocompleteProvider(factory);
		for (const input of this.terminalInputs) input.unsubscribe = ui.onTerminalInput(input.handler);

		// One dialog at a time: the host shows a single dialog in the editor dock.
		const first = this.pending[0];
		if (first) this.show(first);
	}

	/** Settle every waiting dialog with its fallback. Called when the thread is disposed. */
	dispose(): void {
		for (const dialog of [...this.pending]) this.settle(dialog, dialog.fallback);
		this.detach();
	}

	private dialog<T>(show: PendingDialog["show"], fallback: T, options?: ExtensionUIDialogOptions): Promise<T> {
		return new Promise<T>((resolve) => {
			if (options?.signal?.aborted) {
				resolve(fallback);
				return;
			}
			const dialog: PendingDialog = { show, fallback, resolve: resolve as (value: unknown) => void };
			if (options?.timeout !== undefined) {
				dialog.deadline = Date.now() + options.timeout;
				dialog.timer = setTimeout(() => this.settle(dialog, fallback), options.timeout);
			}
			options?.signal?.addEventListener("abort", () => this.settle(dialog, fallback), { once: true });
			this.pending.push(dialog);
			this.onPendingChange(true);
			if (this.attached && this.pending.length === 1) this.show(dialog);
		});
	}

	private show(dialog: PendingDialog): void {
		const attempt = new AbortController();
		dialog.attempt = attempt;
		const timeout = dialog.deadline === undefined ? undefined : Math.max(0, dialog.deadline - Date.now());
		void dialog.show(this.ui, { signal: attempt.signal, timeout }).then((value) => {
			// Ignore a dialog that was taken off screen; it is shown again on return.
			if (dialog.attempt !== attempt) return;
			this.settle(dialog, value);
		});
	}

	private settle(dialog: PendingDialog, value: unknown): void {
		const index = this.pending.indexOf(dialog);
		if (index === -1) return;
		this.pending.splice(index, 1);
		if (dialog.timer) clearTimeout(dialog.timer);
		const attempt = dialog.attempt;
		dialog.attempt = undefined;
		attempt?.abort();
		dialog.resolve(value);
		this.onPendingChange(this.pending.length > 0);

		const next = this.pending[0];
		if (this.attached && next && !next.attempt) this.show(next);
	}

	private createContext(): ExtensionUIContext {
		const ui = this.ui;
		const onScreen = () => this.attached;
		const withSignal = (
			opts: ExtensionUIDialogOptions | undefined,
			shown: { signal: AbortSignal; timeout?: number },
		) => ({
			...opts,
			signal: shown.signal,
			timeout: shown.timeout,
		});

		return {
			select: (title, options, opts) =>
				this.dialog((target, shown) => target.select(title, options, withSignal(opts, shown)), undefined, opts),
			confirm: (title, message, opts) =>
				this.dialog((target, shown) => target.confirm(title, message, withSignal(opts, shown)), false, opts),
			input: (title, placeholder, opts) =>
				this.dialog((target, shown) => target.input(title, placeholder, withSignal(opts, shown)), undefined, opts),
			editor: (title, prefill) => this.dialog((target) => target.editor(title, prefill), undefined),
			custom: ((factory: Parameters<ExtensionUIContext["custom"]>[0], options) =>
				this.dialog((target) => target.custom(factory, options), undefined)) as ExtensionUIContext["custom"],

			notify: (message, type) => {
				if (onScreen()) ui.notify(message, type);
			},
			onTerminalInput: (handler) => {
				const input: { handler: TerminalInputHandler; unsubscribe?: () => void } = { handler };
				if (onScreen()) input.unsubscribe = ui.onTerminalInput(handler);
				this.terminalInputs.add(input);
				return () => {
					input.unsubscribe?.();
					this.terminalInputs.delete(input);
				};
			},
			setStatus: (key, text) => {
				this.statuses.set(key, text);
				if (onScreen()) ui.setStatus(key, text);
			},
			setWorkingMessage: (message) => {
				Object.assign(this.workingMessage, { set: true, value: message });
				if (onScreen()) ui.setWorkingMessage(message);
			},
			setWorkingVisible: (visible) => {
				Object.assign(this.workingVisible, { set: true, value: visible });
				if (onScreen()) ui.setWorkingVisible(visible);
			},
			setWorkingIndicator: (options) => {
				Object.assign(this.workingIndicator, { set: true, value: options });
				if (onScreen()) ui.setWorkingIndicator(options);
			},
			setHiddenThinkingLabel: (label) => {
				Object.assign(this.hiddenThinkingLabel, { set: true, value: label });
				if (onScreen()) ui.setHiddenThinkingLabel(label);
			},
			setWidget: ((...args: WidgetArgs) => {
				this.widgets.set(args[0], args);
				if (onScreen()) (ui.setWidget as (...a: WidgetArgs) => void)(...args);
			}) as ExtensionUIContext["setWidget"],
			setFooter: (factory) => {
				Object.assign(this.footer, { set: true, value: factory });
				if (onScreen()) ui.setFooter(factory);
			},
			setHeader: (factory) => {
				Object.assign(this.header, { set: true, value: factory });
				if (onScreen()) ui.setHeader(factory);
			},
			setTitle: (title) => {
				Object.assign(this.title, { set: true, value: title });
				if (onScreen()) ui.setTitle(title);
			},
			pasteToEditor: (text) => {
				if (onScreen()) ui.pasteToEditor(text);
			},
			setEditorText: (text) => {
				if (onScreen()) ui.setEditorText(text);
			},
			getEditorText: () => (onScreen() ? ui.getEditorText() : ""),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviders.push(factory);
				if (onScreen()) ui.addAutocompleteProvider(factory);
			},
			setEditorComponent: (factory) => {
				Object.assign(this.editorComponent, { set: true, value: factory });
				if (onScreen()) ui.setEditorComponent(factory);
			},
			getEditorComponent: () => (this.editorComponent.set ? this.editorComponent.value : ui.getEditorComponent()),
			get theme() {
				return ui.theme;
			},
			getAllThemes: () => ui.getAllThemes(),
			getTheme: (name) => ui.getTheme(name),
			setTheme: (themeOrName) => ui.setTheme(themeOrName),
			getToolsExpanded: () => ui.getToolsExpanded(),
			setToolsExpanded: (expanded) => {
				if (onScreen()) ui.setToolsExpanded(expanded);
			},
			revealEntry: (entryId) => (onScreen() ? ui.revealEntry(entryId) : false),
		};
	}
}
