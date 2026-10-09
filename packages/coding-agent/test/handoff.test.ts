import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	buildHandoffPrompt,
	collectTouchedFiles,
	resolveHandoffModel,
	truncateTranscript,
} from "../src/core/handoff.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { defaultModelPerProvider } from "../src/core/model-resolver.ts";

interface FakeRegistryOptions {
	models?: Record<string, { provider: string; id: string }>;
	configuredProviders?: string[];
	available?: { provider: string; id: string }[];
}

function fakeRegistry(options: FakeRegistryOptions = {}): ModelRegistry {
	const models = options.models ?? {};
	return {
		find: (provider: string, id: string) => models[`${provider}/${id}`],
		hasConfiguredAuth: (model: { provider: string }) => (options.configuredProviders ?? []).includes(model.provider),
		getAvailable: () => options.available ?? [],
	} as unknown as ModelRegistry;
}

describe("buildHandoffPrompt", () => {
	it("returns the generated prompt with a pointer to the parent session", () => {
		const text = buildHandoffPrompt({
			expanded: "# Objective\nShip teams",
			parentSession: "/tmp/session.jsonl",
		});
		expect(text).toBe("# Objective\nShip teams\n\n**Parent session:** `/tmp/session.jsonl`");
	});

	it("omits the parent line when the session is not persisted", () => {
		expect(buildHandoffPrompt({ expanded: "# Objective\nShip it" })).toBe("# Objective\nShip it");
	});
});

describe("truncateTranscript", () => {
	it("keeps short transcripts untouched", () => {
		expect(truncateTranscript("short", 100)).toBe("short");
	});

	it("keeps the head and tail when the transcript does not fit", () => {
		const text = "abcdefghij".repeat(100);
		const budget = 100;
		const out = truncateTranscript(text, budget);
		const headLength = Math.floor(budget * 0.25);
		const tailLength = budget - headLength;
		expect(out.length).toBeLessThan(text.length);
		expect(out).toContain("middle of conversation omitted");
		expect(out.slice(0, headLength)).toBe(text.slice(0, headLength));
		expect(out.slice(-tailLength)).toBe(text.slice(-tailLength));
	});
});

describe("collectTouchedFiles", () => {
	it("lists modified and read-only files from tool calls", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "1", name: "read", arguments: { path: "/a.ts" } },
					{ type: "toolCall", id: "2", name: "edit", arguments: { path: "/b.ts" } },
					{ type: "toolCall", id: "3", name: "write", arguments: { path: "/c.ts" } },
				],
			},
		] as unknown as AgentMessage[];
		const hint = collectTouchedFiles(messages);
		expect(hint).toContain("<read-files>\n/a.ts\n</read-files>");
		expect(hint).toContain("<modified-files>\n/b.ts\n/c.ts\n</modified-files>");
	});

	it("returns an empty hint when no files were touched", () => {
		expect(collectTouchedFiles([])).toBe("");
	});
});

describe("resolveHandoffModel", () => {
	it("prefers the native deepseek provider when it has auth", () => {
		const registry = fakeRegistry({
			models: {
				[`deepseek/${defaultModelPerProvider.deepseek}`]: { provider: "deepseek", id: "native" },
				"openrouter/deepseek/deepseek-v4.1-flash": { provider: "openrouter", id: "or" },
			},
			configuredProviders: ["deepseek", "openrouter"],
		});
		expect(resolveHandoffModel(registry)).toEqual({ provider: "deepseek", id: "native" });
	});

	it("falls back to an OpenRouter DeepSeek model when the native provider has no auth", () => {
		const registry = fakeRegistry({
			models: {
				[`deepseek/${defaultModelPerProvider.deepseek}`]: { provider: "deepseek", id: "native" },
				"openrouter/deepseek/deepseek-v4.1-flash": { provider: "openrouter", id: "or" },
			},
			configuredProviders: ["openrouter"],
		});
		expect(resolveHandoffModel(registry)).toEqual({ provider: "openrouter", id: "or" });
	});

	it("uses any available DeepSeek model when no candidate is configured", () => {
		const registry = fakeRegistry({
			configuredProviders: ["openrouter"],
			available: [{ provider: "openrouter", id: "deepseek/deepseek-v4-pro" }],
		});
		expect(resolveHandoffModel(registry)).toEqual({ provider: "openrouter", id: "deepseek/deepseek-v4-pro" });
	});

	it("returns undefined when no DeepSeek model exists", () => {
		const registry = fakeRegistry({
			models: { "openai/gpt-5": { provider: "openai", id: "gpt-5" } },
			configuredProviders: ["openai"],
		});
		expect(resolveHandoffModel(registry)).toBeUndefined();
	});
});
