import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * π drawn in dots: `@` is a large dot, `o` a medium one, `.` a small one. Dots shrink
 * toward the bottom and the right edge, and each row fades through the palette below,
 * so the glyph reads as lit from the top left.
 */
const LOGO = [
	"  .o@@@@@@@@@@@@@@@@@@oo.",
	" o@@@@@@@@@@@@@@@@@@@ooo.",
	"      @@@@      @@@o.",
	"      @@@@      @@@o.",
	"      @@@o      @@oo.",
	"     o@@@o      @@oo.",
	"     o@@o.      o@oo.",
	"    .o@oo       o@oo.  .",
	"    oooo.       .ooooo..",
	"   .oo.          .ooo.",
];
const LOGO_COLORS: ThemeColor[] = [
	"accent",
	"accent",
	"accent",
	"mdLink",
	"mdLink",
	"mdLink",
	"thinkingHigh",
	"thinkingHigh",
	"muted",
	"dim",
];
const DOTS: Record<string, string> = { "@": "●", o: "•", ".": "·" };
const LOGO_WIDTH = Math.max(...LOGO.map((row) => row.length));
/** Columns between the logo and the text beside it. */
const GUTTER = 6;
/** Below this width the logo is dropped and only the text is centered. */
const MIN_SIDE_BY_SIDE_WIDTH = 72;

export type WelcomeOptions = {
	appName: string;
	version: string;
	/** Rows the welcome fills, so it centers in the transcript. Zero until the first layout. */
	getHeight: () => number;
	/** Newer upstream release, if the startup check found one. */
	getAvailableVersion: () => string | undefined;
	/** One-line pointer to startup problems, when any were collected. */
	getIssueLine?: () => string | undefined;
	/** Hidden once the transcript has anything else to show. */
	isVisible: () => boolean;
};

/** Empty-session welcome: the π logo beside a greeting and two hints, centered in the transcript. */
export class WelcomeComponent implements Component {
	private readonly options: WelcomeOptions;

	constructor(options: WelcomeOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		if (!this.options.isVisible()) return [];

		const text = this.textLines();
		const block = width >= MIN_SIDE_BY_SIDE_WIDTH ? this.sideBySide(text) : text;
		const blockWidth = Math.max(...block.map((line) => visibleWidth(line)));
		const left = " ".repeat(Math.max(0, Math.floor((width - blockWidth) / 2)));
		const lines = block.map((line) => truncateToWidth(left + line, width));

		const height = this.options.getHeight();
		if (height <= lines.length) return lines;
		const top = Math.floor((height - lines.length) / 2);
		return [...Array<string>(top).fill(""), ...lines, ...Array<string>(height - lines.length - top).fill("")];
	}

	invalidate(): void {}

	private textLines(): string[] {
		const key = (text: string) => theme.bold(theme.fg("text", text));
		const muted = (text: string) => theme.fg("muted", text);
		const lines = [
			theme.bold(theme.fg("accent", `Welcome to ${this.options.appName}`)),
			"",
			`${key(keyText("app.palette.open"))}${muted(" for the palette, ")}${key("/")}${muted(" for commands")}`,
			"",
			this.versionLine(),
		];
		const issueLine = this.options.getIssueLine?.();
		if (issueLine) lines.push("", issueLine);
		return lines;
	}

	/** The running version, plus a quiet note when upstream has a newer release. */
	private versionLine(): string {
		const current = theme.fg("dim", `v${this.options.version}`);
		const available = this.options.getAvailableVersion();
		if (!available) return current;
		return `${current}${theme.fg("dim", " · ")}${theme.fg("accent", `v${available}`)}${theme.fg("dim", " available, pi-fork sync")}`;
	}

	/** The logo on the left with `text` vertically centered beside it. */
	private sideBySide(text: string[]): string[] {
		const offset = Math.floor((LOGO.length - text.length) / 2);
		return LOGO.map((row, index) => {
			const color = LOGO_COLORS[index] ?? "dim";
			const dots = row
				.padEnd(LOGO_WIDTH)
				.replace(/[@o.]/g, (dot) => theme.fg(color, DOTS[dot]!))
				.trimEnd();
			const beside = text[index - offset];
			if (!beside) return dots;
			return dots + " ".repeat(LOGO_WIDTH + GUTTER - visibleWidth(dots)) + beside;
		});
	}
}
