/**
 * Handoff: start focused new threads instead of compacting in place.
 * Built into the fork, so it shares the host's extension API rather than loading via jiti.
 *
 * - `/handoff [goal]` distils the current thread plus the goal into a seed prompt and opens a
 *   fresh session with it. With no goal it first asks for one.
 * - The `handoff` tool lets the model start the same flow when the user explicitly asks to hand
 *   off. It dispatches the command, because only command context can replace the session; the
 *   command waits for the current turn to finish before switching.
 * - The `session_query` tool lets a handed-off thread (or any thread) ask a question about a
 *   previous session transcript, using that session's own model.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import { complete } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { serializeConversation } from "../../core/compaction/utils.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { buildHandoffPrompt, generateHandoffPrompt, truncateTranscript } from "../../core/handoff.ts";
import { convertToLlm } from "../../core/messages.ts";
import {
	type ModelChangeEntry,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "../../core/session-manager.ts";
import { BorderedLoader } from "../../modes/interactive/components/bordered-loader.ts";

const SESSION_QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given the conversation history from a pi coding session and a question, answer from the session contents.

Focus on specific facts, decisions, and outcomes, and on file paths and code changes that were mentioned. Be concise and direct. If the information is not in the session, say so.`;

/** Load a saved session's branch and message entries, or return an error string. */
function readSession(
	sessionPath: string,
): { branch: SessionEntry[]; messages: SessionMessageEntry[] } | { error: string } {
	if (!sessionPath.endsWith(".jsonl")) {
		return { error: `Invalid session path; expected a .jsonl file, got: ${sessionPath}` };
	}
	let sessionManager: SessionManager;
	try {
		sessionManager = SessionManager.open(sessionPath);
	} catch (error) {
		return { error: `Could not load session: ${error instanceof Error ? error.message : String(error)}` };
	}
	const branch = sessionManager.getBranch();
	const messages = branch.filter((entry): entry is SessionMessageEntry => entry.type === "message");
	if (messages.length === 0) return { error: "Session has no messages." };
	return { branch, messages };
}

/** The queried session's last model, falling back to the current one. */
function queryModelFor(ctx: ExtensionContext, branch: SessionEntry[]): Model<any> | undefined {
	const changes = branch.filter((entry): entry is ModelChangeEntry => entry.type === "model_change");
	const last = changes[changes.length - 1];
	if (last) {
		const found = ctx.modelRegistry.find(last.provider, last.modelId);
		if (found) return found;
	}
	return ctx.model;
}

async function generateWithLoader(
	ctx: ExtensionCommandContext,
	messages: AgentMessage[],
	goal: string,
): Promise<string | null> {
	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			done(value);
		};
		loader.onAbort = () => finish(null);
		generateHandoffPrompt({
			modelRegistry: ctx.modelRegistry,
			messages,
			goal,
			signal: loader.signal,
		})
			.then(finish)
			.catch((error: unknown) => {
				ctx.ui.notify(`Handoff: ${error instanceof Error ? error.message : String(error)}`, "error");
				finish(null);
			});
		return loader;
	});
}

async function performHandoff(ctx: ExtensionCommandContext, goal: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Handoff requires interactive mode", "error");
		return;
	}

	let finalGoal = goal.trim();
	if (!finalGoal) {
		const entered = await ctx.ui.input("Handoff goal", "What should the new thread do?");
		if (entered === undefined) return;
		finalGoal = entered.trim();
		if (!finalGoal) {
			ctx.ui.notify("Handoff needs a goal", "warning");
			return;
		}
	}

	const parentSession = ctx.sessionManager.getSessionFile();
	const messages = ctx.sessionManager.buildSessionProjection().messages;
	const expanded = await generateWithLoader(ctx, messages, finalGoal);
	if (expanded === null) return;

	const prompt = buildHandoffPrompt({ expanded, parentSession });
	// A tool-invoked handoff runs inside the current turn; let it settle before replacing the session.
	if (!ctx.isIdle()) await ctx.waitForIdle();
	const result = await ctx.newSession({
		parentSession,
		withSession: async (next) => {
			await next.sendUserMessage(prompt);
		},
	});
	if (result.cancelled) ctx.ui.notify("Handoff cancelled", "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Start a focused new thread with generated context",
		handler: async (args, ctx) => {
			await performHandoff(ctx, args);
		},
	});

	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Transfer context to a new focused thread. Only use when the user explicitly asks to hand off; provide the goal for the new thread.",
		parameters: Type.Object({
			goal: Type.String({ description: "The goal or task for the new thread" }),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Error: handoff requires interactive mode" }],
					details: { started: false },
				};
			}
			// Dispatch the command so it runs with command context, the only context that can
			// replace the session. expandPromptTemplates runs the handler without an LLM turn.
			pi.sendUserMessage(`/handoff ${params.goal}`, { expandPromptTemplates: true });
			return {
				content: [
					{
						type: "text",
						text: "Started a handoff. The current turn will finish before the new thread opens.",
					},
				],
				details: { started: true, goal: params.goal },
			};
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("handoff ")) + theme.fg("muted", args.goal), 0, 0);
		},
	});

	pi.registerTool({
		name: "session_query",
		label: "Session Query",
		description:
			"Ask a question about a previous pi session's transcript. Use to look up decisions, files, or context from a parent session.",
		parameters: Type.Object({
			sessionPath: Type.String({
				description: "Full path to the session .jsonl file",
			}),
			question: Type.String({ description: "What you want to know about that session" }),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const loaded = readSession(params.sessionPath);
			if ("error" in loaded) {
				return {
					content: [{ type: "text", text: `Error: ${loaded.error}` }],
					details: { error: true },
				};
			}

			const model = queryModelFor(ctx, loaded.branch);
			if (!model) {
				return {
					content: [{ type: "text", text: "Error: no model available to analyze the session" }],
					details: { error: true },
				};
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				return {
					content: [{ type: "text", text: `Error: ${auth.error}` }],
					details: { error: true },
				};
			}

			const branchMessages = loaded.messages.map((entry) => entry.message);
			const conversationText = truncateTranscript(
				serializeConversation(convertToLlm(branchMessages)),
				Math.max(20_000, (model.contextWindow - 8192) * 4),
			);

			try {
				const response = await complete(
					auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
					{
						systemPrompt: SESSION_QUERY_SYSTEM_PROMPT,
						messages: [
							{
								role: "user",
								content: [
									{
										type: "text",
										text: `## Session Conversation\n\n${conversationText}\n\n## Question\n\n${params.question}`,
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
						maxTokens: 4096,
						signal,
						cacheRetention: "none",
					},
				);
				if (response.stopReason === "aborted") {
					return {
						content: [{ type: "text", text: "Query was cancelled." }],
						details: { cancelled: true },
					};
				}
				if (response.stopReason === "error") {
					return {
						content: [{ type: "text", text: `Error: ${response.errorMessage || "query failed"}` }],
						details: { error: true },
					};
				}
				const answer = contentText(response.content).trim() || "(no answer)";
				return {
					content: [{ type: "text", text: `**Query:** ${params.question}\n\n---\n\n${answer}` }],
					details: { sessionPath: params.sessionPath, question: params.question, model: model.id },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
					details: { error: true },
				};
			}
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("session_query ")) + theme.fg("muted", args.question), 0, 0);
		},
	});
}
