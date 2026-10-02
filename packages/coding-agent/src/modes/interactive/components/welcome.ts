import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * A Protoss pylon drawn in dots: three glyph sizes per material, so `@`/`o`/`.` is the
 * blue crystal spire (brightest at the middle) and `#`/`+`/`:` is the golden ring and
 * the two floating side plates. One glyph per cell, so the silhouette carries the read.
 */
const LOGO = [
	"               @",
	"   :+:        o@o       :+:",
	"   #o#       .@@@.       #o#",
	"   #o#      .@@@@@.      #o#",
	"   #o#     @@@@@@@@@     #o#",
	"   +o+  +++@@@@@@@@@+++  +o+",
	"   :+:   ++.@@@@@.++    :+:",
	"   :#:       .@@@.       :#:",
	"   ...        o@o       ...",
	"               .",
];
const CRYSTAL: ThemeColor = "borderAccent";
const GOLD: ThemeColor = "mdHeading";
const DOTS: Record<string, { glyph: string; color: ThemeColor }> = {
	"@": { glyph: "●", color: CRYSTAL },
	o: { glyph: "•", color: CRYSTAL },
	".": { glyph: "·", color: CRYSTAL },
	"#": { glyph: "●", color: GOLD },
	"+": { glyph: "•", color: GOLD },
	":": { glyph: "·", color: GOLD },
};
const LOGO_WIDTH = Math.max(...LOGO.map((row) => row.length));
/** Columns between the logo and the text beside it. */
const GUTTER = 6;
/** Below this width the logo moves above the text instead of sitting beside it. */
const MIN_SIDE_BY_SIDE_WIDTH = 72;
/** Below this width the logo does not fit at all, even on its own row. */
const MIN_LOGO_WIDTH = LOGO_WIDTH + 2;

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

/** Empty-session welcome: the pylon beside a greeting and two hints, centered in the transcript. */
export class WelcomeComponent implements Component {
	private readonly options: WelcomeOptions;

	constructor(options: WelcomeOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		if (!this.options.isVisible()) return [];

		const text = this.textLines();
		const block = this.block(width, text);
		const blockWidth = Math.max(...block.map((line) => visibleWidth(line)));
		const left = " ".repeat(Math.max(0, Math.floor((width - blockWidth) / 2)));
		const lines = block.map((line) => truncateToWidth(left + line, width));

		const height = this.options.getHeight();
		if (height <= lines.length) return lines;
		const top = Math.floor((height - lines.length) / 2);
		return [...Array<string>(top).fill(""), ...lines, ...Array<string>(height - lines.length - top).fill("")];
	}

	invalidate(): void {}

	/** Side by side when it fits, stacked above the text when it does not, dropped when neither works. */
	private block(width: number, text: string[]): string[] {
		if (width >= MIN_SIDE_BY_SIDE_WIDTH) return this.sideBySide(text);
		if (width < MIN_LOGO_WIDTH) return text;
		const textWidth = Math.max(...text.map((line) => visibleWidth(line)));
		const logo = this.logoLines().map((line) => {
			const inset = Math.max(0, Math.floor((textWidth - visibleWidth(line)) / 2));
			return " ".repeat(inset) + line;
		});
		return [...logo, "", ...text];
	}

	private textLines(): string[] {
		const key = (text: string) => theme.bold(theme.fg("text", text));
		const muted = (text: string) => theme.fg("muted", text);
		const lines = [
			theme.bold(theme.fg("accent", "Welcome to Pilon")),
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

	/** The logo rows, painted and right-trimmed. */
	private logoLines(): string[] {
		return LOGO.map((row) =>
			row
				.padEnd(LOGO_WIDTH)
				.replace(/[@o.#+:]/g, (dot) => {
					const { glyph, color } = DOTS[dot]!;
					return theme.fg(color, glyph);
				})
				.trimEnd(),
		);
	}

	/** The logo on the left with `text` vertically centered beside it. */
	private sideBySide(text: string[]): string[] {
		const offset = Math.floor((LOGO.length - text.length) / 2);
		return this.logoLines().map((dots, index) => {
			const beside = text[index - offset];
			if (!beside) return dots;
			return dots + " ".repeat(LOGO_WIDTH + GUTTER - visibleWidth(dots)) + beside;
		});
	}
}
