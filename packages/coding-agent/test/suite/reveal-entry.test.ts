import { type Component, Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";

function block(height: number): Component {
	return {
		render: () => Array.from({ length: height }, (_, index) => `row ${index}`),
		invalidate: () => {},
	};
}

type RevealScrollView = {
	scrollTo: (top: number, options?: { disableFollow?: boolean }) => void;
	getContentWidth: (width: number) => number;
	viewportHeight: number;
};

type RevealContext = {
	sessionManager: { getEntry: (entryId: string) => unknown };
	messageComponents: Map<object, Component>;
	chatContainer: Container;
	documentContainer: Container;
	transcriptScrollView: RevealScrollView | undefined;
	ui: { terminal: { columns: number } };
	revealEntry(entryId: string): boolean;
	transcriptOffsetOf(component: Component, width: number): number;
};

type RevealHost = Pick<RevealContext, "revealEntry" | "transcriptOffsetOf">;

const prototype = InteractiveMode.prototype as unknown as RevealHost;

/** Mirrors the fullscreen transcript layout: header, then chat, inside the scroll view. */
function createContext({ fullscreen = true }: { fullscreen?: boolean } = {}) {
	const message = { role: "user", content: "hello" };
	const target = block(2);
	const chatContainer = new Container();
	chatContainer.addChild(block(4));
	chatContainer.addChild(target);

	const documentContainer = new Container();
	documentContainer.addChild(block(3));
	documentContainer.addChild(chatContainer);

	const scrollTo = vi.fn();
	const context: RevealContext = {
		sessionManager: {
			getEntry: (entryId: string) => (entryId === "entry-1" ? { type: "message", id: entryId, message } : undefined),
		},
		messageComponents: new Map([[message, target]]),
		chatContainer,
		documentContainer,
		transcriptScrollView: fullscreen ? { scrollTo, getContentWidth: (width) => width, viewportHeight: 9 } : undefined,
		ui: { terminal: { columns: 80 } },
		revealEntry: prototype.revealEntry,
		transcriptOffsetOf: prototype.transcriptOffsetOf,
	};
	return { context, scrollTo };
}

describe("revealEntry", () => {
	it("scrolls to the entry with context kept above it", () => {
		const { context, scrollTo } = createContext();

		expect(context.revealEntry("entry-1")).toBe(true);
		// header 3 + preceding chat child 4 = 7, minus one third of a 9 row viewport.
		expect(scrollTo).toHaveBeenCalledExactlyOnceWith(4);
	});

	it("reports false when the transcript cannot scroll", () => {
		const { context, scrollTo } = createContext({ fullscreen: false });

		expect(context.revealEntry("entry-1")).toBe(false);
		expect(scrollTo).not.toHaveBeenCalled();
	});

	it("reports false for an entry that renders nothing", () => {
		const { context, scrollTo } = createContext();
		context.sessionManager.getEntry = (entryId: string) => ({ type: "compaction", id: entryId });

		expect(context.revealEntry("entry-1")).toBe(false);
		expect(scrollTo).not.toHaveBeenCalled();
	});

	it("reports false for a component that left the transcript", () => {
		const { context, scrollTo } = createContext();
		const stale = { role: "assistant" };
		context.messageComponents.set(stale, block(1));
		context.sessionManager.getEntry = () => ({ type: "message", message: stale });

		expect(context.revealEntry("entry-1")).toBe(false);
		expect(scrollTo).not.toHaveBeenCalled();
	});
});
