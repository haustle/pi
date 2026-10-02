import { Box, Container, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** How long a snackbar stays before it clears itself. */
export const SNACKBAR_DURATION_MS = 5_000;

export type SnackbarKind = "info" | "warning";

/**
 * One-line transient message docked above the editor. Unlike a transcript entry it
 * leaves the empty-session welcome alone and clears itself instead of scrolling away.
 */
export class SnackbarComponent extends Container {
	constructor(message: string, kind: SnackbarKind = "info") {
		super();
		const text = kind === "warning" ? theme.fg("warning", message) : theme.fg("text", message);
		const box = new Box(1, 0, (line) => theme.bg("customMessageBg", line));
		box.addChild(new Text(text, 0, 0));
		this.addChild(box);
	}
}
