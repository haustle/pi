import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Sky blue, hardcoded: pi's theme palette has no matching token, and this border
 * stands in for the editor border rather than decorating a themed component.
 */
const SKY = "\u001b[38;2;135;206;235m";
const RESET = "\u001b[0m";

export type FocusableMessage = {
	entryId: string;
	text: string;
};

type MessagePart = { type: string; text?: string };
type EntryLike = { id: string; type: string; message?: { role?: string; content?: unknown } };

function textOfParts(parts: readonly MessagePart[]): string {
	return parts
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/**
 * User messages on the current branch, oldest first.
 *
 * Only user messages: those are the ones worth copying or rewriting, and skipping
 * assistant replies keeps the list stable while a response is still streaming.
 */
export function collectFocusableMessages(entries: readonly EntryLike[]): FocusableMessage[] {
	const messages: FocusableMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;

		const { role, content } = entry.message ?? {};
		if (role !== "user") continue;

		const text =
			typeof content === "string" ? content : Array.isArray(content) ? textOfParts(content as MessagePart[]) : "";
		if (!text.trim()) continue;

		messages.push({ entryId: entry.id, text });
	}
	return messages;
}

export function frameTop({ width, label }: { width: number; label: string }): string {
	const safeLabel = truncateToWidth(label, Math.max(0, width - 3));
	const fill = Math.max(0, width - 3 - visibleWidth(safeLabel));
	return `${SKY}┏━${safeLabel}${"━".repeat(fill)}┓${RESET}`;
}

/** Wraps one already-rendered line: `┃` + space + inner + space + `┃` totals `width`. */
export function frameRow({ width, content }: { width: number; content: string }): string {
	const inner = Math.max(1, width - 4);
	const trimmed = truncateToWidth(content, inner);
	const padding = " ".repeat(Math.max(0, inner - visibleWidth(trimmed)));
	return `${SKY}┃${RESET} ${trimmed}${padding} ${SKY}┃${RESET}`;
}

export function frameBottom(width: number): string {
	return `${SKY}┗${"━".repeat(Math.max(0, width - 2))}┛${RESET}`;
}
