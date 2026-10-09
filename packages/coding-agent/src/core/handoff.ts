/**
 * Handoff: distil the current thread into a self-contained seed prompt for a new one.
 *
 * Instead of compaction (which is lossy and keeps you in the same thread), a handoff asks a
 * cheap model to turn the current transcript plus the user's goal into a rich prompt, then the
 * interactive layer opens a brand-new session with it. The old thread is left intact.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	serializeConversation,
} from "./compaction/utils.ts";
import { convertToLlm } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { defaultModelPerProvider } from "./model-resolver.ts";

/** Provider whose models write the handoff prompt. */
export const HANDOFF_PROVIDER = "deepseek";

/**
 * DeepSeek routes in preference order. The native provider wins when it has auth; otherwise
 * OpenRouter serves DeepSeek with the user's OpenRouter key. Earlier ids win when several exist.
 */
const HANDOFF_MODEL_CANDIDATES: ReadonlyArray<{ provider: string; id: string }> = [
	...(defaultModelPerProvider.deepseek ? [{ provider: "deepseek", id: defaultModelPerProvider.deepseek }] : []),
	{ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" },
	{ provider: "openrouter", id: "deepseek/deepseek-chat" },
];
/** Small output budget: the seed is a prompt, not an answer. */
const HANDOFF_MAX_TOKENS = 6000;
/** Leave room for the prompt wrapper and the model's answer when truncating the transcript. */
const HANDOFF_TRANSCRIPT_RESERVE_TOKENS = HANDOFF_MAX_TOKENS + 4096;
/** Cap the file-activity hint so it cannot crowd out the transcript. */
const HANDOFF_MAX_FILES = 40;

export const HANDOFF_SYSTEM_PROMPT = `You write the opening message for a new coding thread. You are given a finished conversation and the user's rough goal for what comes next. Transform that goal into a self-contained, actionable prompt for a fresh agent that has none of the old context.

Rules:
- Lead with the objective. Make the user's goal concrete, specific, and testable. Do not just restate it.
- Carry over only what the next thread needs: decisions already made, constraints, gotchas, and the state of the work. Never summarize or dump the whole conversation.
- Name real files by path, with the relevant symbol or area, and say why each matters.
- Give an ordered plan the next agent can execute, and a verifiable definition of done.
- Mention an open question or risk only when it could change the approach.
- Prefer specifics over prose. No preamble, no "here is the prompt", no meta commentary.

Output exactly this markdown structure and nothing else:

# Objective
<one concrete paragraph: what to achieve and why>

# Context
<bullets: only the decisions, constraints, and findings the next thread must know>

# Current state
- Done: <what already works>
- Pending: <what is unfinished>
- Risky: <what is fragile or unverified, if anything>

# Relevant files
- \`path/to/file.ts\` — the symbol/area and why it matters

# Plan
1. <concrete step>
2. <concrete step>

# Acceptance
- <a verifiable outcome>
- <another verifiable outcome>`;

export interface HandoffPromptInput {
	modelRegistry: ModelRegistry;
	messages: AgentMessage[];
	/** The user's raw goal for the new thread. */
	goal: string;
	signal?: AbortSignal;
}

function isDeepseekModel(model: Model<any>): boolean {
	return model.provider === HANDOFF_PROVIDER || (model.provider === "openrouter" && /(^|\/)deepseek/i.test(model.id));
}

/**
 * Pick a DeepSeek model to write the prompt: a configured candidate first, then any available
 * DeepSeek model, then a candidate that exists at all so auth failures surface with a clear error.
 */
export function resolveHandoffModel(registry: ModelRegistry): Model<any> | undefined {
	for (const candidate of HANDOFF_MODEL_CANDIDATES) {
		const model = registry.find(candidate.provider, candidate.id);
		if (model && registry.hasConfiguredAuth(model)) return model;
	}
	const availableDeepseek = registry.getAvailable().find(isDeepseekModel);
	if (availableDeepseek) return availableDeepseek;
	for (const candidate of HANDOFF_MODEL_CANDIDATES) {
		const model = registry.find(candidate.provider, candidate.id);
		if (model) return model;
	}
	return undefined;
}

/** Final message text: the generated opening prompt plus a pointer back at the parent thread. */
export function buildHandoffPrompt(input: { expanded: string; parentSession?: string }): string {
	const parts = [input.expanded.trim()];
	if (input.parentSession) parts.push("", `**Parent session:** \`${input.parentSession}\``);
	return parts.join("\n");
}

/**
 * Keep the head and tail when the serialized transcript would not fit the model's window.
 * The first messages carry the task; the last ones carry where the work actually got to.
 */
export function truncateTranscript(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.25);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n\n[... middle of conversation omitted ...]\n\n${text.slice(-tail)}`;
}

/** Files read or modified across the transcript, as candidates for the next thread's "Relevant files". */
export function collectTouchedFiles(messages: AgentMessage[]): string {
	const fileOps = createFileOps();
	for (const message of messages) extractFileOpsFromMessage(message, fileOps);
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	return formatFileOperations(readFiles.slice(0, HANDOFF_MAX_FILES), modifiedFiles.slice(0, HANDOFF_MAX_FILES));
}

/**
 * Generate the expanded handoff prompt. Returns null when the call was aborted.
 * Throws on missing auth or a provider failure; the caller keeps handoff mode active.
 */
export async function generateHandoffPrompt(input: HandoffPromptInput): Promise<string | null> {
	const model = resolveHandoffModel(input.modelRegistry);
	if (!model) {
		throw new Error(
			`Handoff needs a DeepSeek model. Configure the "${HANDOFF_PROVIDER}" provider or an OpenRouter key with /login.`,
		);
	}

	const auth = await input.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

	const serialized = serializeConversation(convertToLlm(input.messages));
	const windowChars = Math.max(20_000, (model.contextWindow - HANDOFF_TRANSCRIPT_RESERVE_TOKENS) * 4);
	const conversationText = truncateTranscript(serialized, windowChars);
	const fileHint = collectTouchedFiles(input.messages);
	const fileSection = fileHint
		? `\n\n## Files read or modified in this session\nCandidates for the "Relevant files" section; include only the ones the next thread needs.\n${fileHint}`
		: "";

	const response = await completeSimple(
		requestModel,
		{
			systemPrompt: HANDOFF_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `## Conversation history\n\n${conversationText}${fileSection}\n\n## User's goal for the new thread\n\n${input.goal}\n\nWrite the new thread's opening message now.`,
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			maxTokens: HANDOFF_MAX_TOKENS,
			// No `reasoning`: a disabled reasoning pass is expressed by omitting the level, and the
			// adapters then apply the model's `thinkingLevelMap.off` ("none").
			signal: input.signal,
			cacheRetention: "none",
		},
	);

	if (response.stopReason === "aborted") return null;
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Handoff prompt generation failed");
	}

	const text = contentText(response.content).trim();
	if (!text) throw new Error("Handoff prompt generation returned no text");
	return text;
}
