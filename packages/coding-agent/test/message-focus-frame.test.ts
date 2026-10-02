import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { builtInExtensions } from "../src/extensions/index.ts";
import { collectFocusableMessages, frameBottom, frameRow, frameTop } from "../src/extensions/message-focus/frame.ts";
import type { ExtensionAPI } from "../src/index.ts";

describe("built-in registration", () => {
	it("registers the focus command and editor takeover", () => {
		const commands: string[] = [];
		const events: string[] = [];
		const api = {
			registerCommand: (name: string) => commands.push(name),
			on: (event: string) => events.push(event),
		} as unknown as ExtensionAPI;

		const focus = builtInExtensions.find(
			(extension) => typeof extension === "object" && extension.name === "message-focus",
		);
		if (typeof focus !== "object") throw new Error("message-focus is not a built-in extension");

		focus.factory(api);
		expect(commands).toEqual(["focus"]);
		expect(events).toEqual(["session_start"]);
	});
});

describe("message focus frame", () => {
	it("renders every line at exactly the requested width", () => {
		const width = 40;
		const lines = [
			frameTop({ width, label: " [2/5] user " }),
			frameRow({ width, content: "hello \u001b[31mworld\u001b[0m and more" }),
			frameBottom(width),
		];
		for (const line of lines) expect(visibleWidth(line)).toBe(width);
	});

	it("clips row content to the inner width", () => {
		const truncated = frameRow({ width: 10, content: "abcdefghijklmnop" });
		expect(visibleWidth(truncated)).toBe(10);
		expect(truncated).not.toContain("jkl");
	});

	it("never lets a long label overflow a narrow frame", () => {
		expect(visibleWidth(frameTop({ width: 6, label: " [12/34] assistant " }))).toBeLessThanOrEqual(6);
	});
});

describe("collectFocusableMessages", () => {
	it("keeps only user messages with text, in branch order", () => {
		const messages = collectFocusableMessages([
			{ id: "a", type: "message", message: { role: "user", content: "hi" } },
			{ id: "b", type: "model_change" },
			{
				id: "c",
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "yo" },
						{ type: "toolCall", name: "bash" },
					],
				},
			},
			{ id: "d", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ignored" }] } },
			{
				id: "e",
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "with an image" }, { type: "image" }],
				},
			},
			{ id: "f", type: "message", message: { role: "user", content: [] } },
		]);

		expect(messages).toEqual([
			{ entryId: "a", text: "hi" },
			{ entryId: "e", text: "with an image" },
		]);
	});
});
