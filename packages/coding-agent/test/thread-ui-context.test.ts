import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { ThreadUIContext } from "../src/modes/interactive/thread-ui-context.ts";

/** A host UI whose confirm dialogs stay open until the test answers or the signal cancels them. */
function fakeHostUI() {
	const shown: Array<{ title: string; answer: (value: boolean) => void; signal?: AbortSignal }> = [];
	const ui = {
		confirm: vi.fn(
			(title: string, _message: string, opts?: { signal?: AbortSignal }) =>
				new Promise<boolean>((resolve) => {
					shown.push({ title, answer: resolve, signal: opts?.signal });
					opts?.signal?.addEventListener("abort", () => resolve(false), { once: true });
				}),
		),
		setStatus: vi.fn(),
		setEditorComponent: vi.fn(),
		notify: vi.fn(),
		getEditorComponent: vi.fn(() => undefined),
	};
	return { ui: ui as unknown as ExtensionUIContext, raw: ui, shown };
}

describe("ThreadUIContext", () => {
	it("holds a background dialog until the thread is back on screen", async () => {
		const { ui, raw, shown } = fakeHostUI();
		const pending: boolean[] = [];
		const thread = new ThreadUIContext(ui, (hasPending) => pending.push(hasPending));

		thread.detach();
		const answer = thread.context.confirm("Run tests?", "");
		expect(raw.confirm).not.toHaveBeenCalled();
		expect(thread.hasPendingDialogs).toBe(true);

		thread.attach();
		expect(shown.map((dialog) => dialog.title)).toEqual(["Run tests?"]);
		shown[0]!.answer(true);
		await expect(answer).resolves.toBe(true);
		expect(pending).toEqual([true, false]);
	});

	it("takes a visible dialog off screen on detach and shows it again on attach", async () => {
		const { ui, shown } = fakeHostUI();
		const thread = new ThreadUIContext(ui, () => {});

		const answer = thread.context.confirm("Deploy?", "");
		expect(shown).toHaveLength(1);

		thread.detach();
		expect(shown[0]!.signal?.aborted).toBe(true);
		expect(thread.hasPendingDialogs).toBe(true);

		thread.attach();
		expect(shown).toHaveLength(2);
		shown[1]!.answer(true);
		await expect(answer).resolves.toBe(true);
	});

	it("times out a background dialog on schedule", async () => {
		vi.useFakeTimers();
		try {
			const { ui } = fakeHostUI();
			const thread = new ThreadUIContext(ui, () => {});
			thread.detach();

			const answer = thread.context.confirm("Continue?", "", { timeout: 1000 });
			vi.advanceTimersByTime(1000);
			await expect(answer).resolves.toBe(false);
			expect(thread.hasPendingDialogs).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("records persistent UI while in the background and replays it on return", () => {
		const { ui, raw } = fakeHostUI();
		const thread = new ThreadUIContext(ui, () => {});
		const factory = vi.fn();

		thread.detach();
		thread.context.setStatus("tests", "running");
		thread.context.setEditorComponent(factory as never);
		thread.context.notify("dropped while off screen");
		expect(raw.setStatus).not.toHaveBeenCalled();

		thread.attach();
		expect(raw.setStatus).toHaveBeenCalledWith("tests", "running");
		expect(raw.setEditorComponent).toHaveBeenCalledWith(factory);
		expect(raw.notify).not.toHaveBeenCalled();
	});

	it("settles waiting dialogs with their fallback when the thread is disposed", async () => {
		const { ui } = fakeHostUI();
		const thread = new ThreadUIContext(ui, () => {});
		thread.detach();

		const answer = thread.context.confirm("Keep going?", "");
		thread.dispose();
		await expect(answer).resolves.toBe(false);
	});
});
