/**
 * Threads: browse past sessions and hop between them.
 * Built into the fork, so it shares the host's extension API rather than loading via jiti.
 *
 * The `threads` tool lets the model surface earlier sessions when the user asks about past
 * work. The `/threads` command does the work: search this project (or every project with
 * --all), pick a session, then resume it or copy its id / file path.
 *
 * The tool does not render anything itself: `switchSession` exists only on command context,
 * never on tool context, so the tool dispatches the command it registers.
 *
 * Usage:
 *   /threads                 sessions in this project
 *   /threads --all           sessions from every project
 *   /threads auth refactor   filter by text in name/transcript
 */

// Concrete modules, not ../../index.ts: the barrel re-enters this file through
// extensions/index.ts, and a class-extends would then read an uninitialised binding.
import { Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { type SessionInfo, SessionManager } from "../../core/session-manager.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";

const MAX_RESULTS = 30;

interface ListItem {
	label: string;
	description?: string;
}

async function showList(
	ctx: ExtensionCommandContext,
	options: { title: string; subtitle?: string; items: ListItem[]; footer: string },
): Promise<number | null> {
	return await ctx.ui.custom<number | null>((tui, theme, _kb, done) => {
		let index = 0;
		let cached: string[] | undefined;

		const refresh = () => {
			cached = undefined;
			tui.requestRender();
		};

		function handleInput(data: string): void {
			const count = options.items.length;
			if (matchesKey(data, Key.up)) {
				index = (index - 1 + count) % count;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				index = (index + 1) % count;
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done(index);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(null);
			}
		}

		function render(width: number): string[] {
			if (cached) return cached;
			const renderWidth = Math.max(1, width);
			const lines: string[] = [];

			const wrapWithPrefix = (prefix: string, text: string) => {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= renderWidth) {
					lines.push(...wrapTextWithAnsi(prefix + text, renderWidth));
					return;
				}
				const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
				const continuation = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
				}
			};

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			wrapWithPrefix(" ", theme.fg("text", options.title));
			if (options.subtitle) wrapWithPrefix(" ", theme.fg("muted", options.subtitle));
			lines.push("");

			for (let i = 0; i < options.items.length; i++) {
				const item = options.items[i];
				if (!item) continue;
				const selected = i === index;
				wrapWithPrefix(
					selected ? theme.fg("accent", "> ") : "  ",
					theme.fg(selected ? "accent" : "text", `${i + 1}. ${item.label}`),
				);
				if (item.description) wrapWithPrefix("     ", theme.fg("muted", item.description));
			}

			lines.push("");
			wrapWithPrefix(" ", theme.fg("dim", options.footer));
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cached = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cached = undefined;
			},
			handleInput,
		};
	});
}

export function parseThreadsArgs(args: string): { all: boolean; query: string } {
	let all = false;
	const rest: string[] = [];
	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		if (token === "--all" || token === "-a") all = true;
		else rest.push(token);
	}
	return { all, query: rest.join(" ") };
}

export function matchesQuery(session: SessionInfo, query: string): boolean {
	const haystack =
		`${session.name ?? ""} ${session.firstMessage} ${session.allMessagesText} ${session.cwd}`.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((token) => haystack.includes(token));
}

export function sessionLabel(session: SessionInfo): string {
	const name = session.name?.trim();
	if (name) return name;
	const first = session.firstMessage.trim().replace(/\s+/g, " ");
	return first ? first.slice(0, 80) : "(empty session)";
}

export function relativeTime(date: Date): string {
	const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return date.toISOString().slice(0, 10);
}

function sessionDescription(session: SessionInfo): string {
	return `${relativeTime(session.modified)} · ${session.messageCount} msgs · ${session.cwd}`;
}

function loadSessions(cwd: string, all: boolean, signal?: AbortSignal): Promise<SessionInfo[]> {
	return all
		? SessionManager.listAll(undefined, undefined, signal)
		: SessionManager.list(cwd, undefined, undefined, signal);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("threads", {
		description: "Search past sessions and resume one or copy its id/path",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("threads requires interactive mode", "error");
				return;
			}

			const { all, query } = parseThreadsArgs(args);

			let sessions: SessionInfo[];
			try {
				sessions = await loadSessions(ctx.cwd, all, ctx.signal);
			} catch (error) {
				ctx.ui.notify(
					`Could not read sessions: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			const currentFile = ctx.sessionManager.getSessionFile();
			const filtered = sessions.filter((s) => s.path !== currentFile && (!query || matchesQuery(s, query)));
			if (filtered.length === 0) {
				ctx.ui.notify(query ? `No sessions match "${query}"` : "No other sessions found", "info");
				return;
			}

			const shown = filtered.slice(0, MAX_RESULTS);
			const count =
				filtered.length > shown.length ? `showing ${shown.length} of ${filtered.length}` : `${shown.length} found`;
			const listItems: ListItem[] = shown.map((s) => ({
				label: sessionLabel(s),
				description: sessionDescription(s),
			}));

			for (;;) {
				const picked = await showList(ctx, {
					title: all ? "All sessions" : `Sessions in ${ctx.cwd}`,
					subtitle: [query ? `filter: ${query}` : null, count].filter(Boolean).join(" · "),
					items: listItems,
					footer: "↑↓ navigate • Enter choose • Esc cancel",
				});
				if (picked === null) return;
				const session = shown[picked];
				if (!session) continue;

				const action = await showList(ctx, {
					title: sessionLabel(session),
					subtitle: `${sessionDescription(session)}\nid: ${session.id}\n${session.path}`,
					items: [
						{ label: "Resume this session", description: "Switch Pi to this session now" },
						{ label: "Copy session ID", description: session.id },
						{ label: "Copy session file path", description: session.path },
						{ label: "Back to list" },
					],
					footer: "↑↓ navigate • Enter select • Esc cancel",
				});
				if (action === null) return;
				if (action === 3) continue;

				if (action === 0) {
					const result = await ctx.switchSession(session.path, {
						withSession: async (next) => {
							next.ui.notify(`Resumed ${sessionLabel(session)}`, "info");
						},
					});
					if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
					return;
				}

				if (action === 1) {
					await copyToClipboard(session.id);
					ctx.ui.notify("Copied session ID", "info");
					return;
				}

				await copyToClipboard(session.path);
				ctx.ui.notify("Copied session file path", "info");
				return;
			}
		},
	});

	pi.registerTool({
		name: "threads",
		label: "Threads",
		description:
			"Open a picker of the user's past sessions so they can resume one or copy its id/file path. Use when the user asks about earlier sessions or work done in another thread.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Filter sessions by text in their name or conversation content" }),
			),
			all: Type.Optional(
				Type.Boolean({ description: "Search every project instead of just the current working directory" }),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Error: the threads picker requires interactive mode" }],
					details: { opened: false },
				};
			}

			const parts = ["/threads"];
			if (params.all) parts.push("--all");
			if (params.query?.trim()) parts.push(params.query.trim());
			// Dispatch the command so the picker runs with command context, which is
			// the only context that can switch sessions.
			pi.sendUserMessage(parts.join(" "), { expandPromptTemplates: true });

			return {
				content: [
					{
						type: "text",
						text: "Opened the thread picker for the user. They will resume a session or copy an id/path from the menu.",
					},
				],
				details: { opened: true, all: params.all ?? false, query: params.query ?? null },
			};
		},

		renderCall(args, theme, _context) {
			let text =
				theme.fg("toolTitle", theme.bold("threads ")) +
				theme.fg("muted", args.all ? "all projects" : "this project");
			if (args.query) text += theme.fg("dim", ` · ${args.query}`);
			return new Text(text, 0, 0);
		},
	});
}
