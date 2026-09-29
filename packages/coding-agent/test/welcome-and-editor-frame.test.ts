import { setKeybindings, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { WelcomeComponent } from "../src/modes/interactive/components/welcome.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");

beforeAll(() => initTheme("dark"));
afterEach(() => setKeybindings(new KeybindingsManager()));

describe("CustomEditor frame", () => {
	it("draws a rounded box inset one column from each edge", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		editor.setText("hello");

		const lines = editor.render(40).map(strip);
		expect(lines).toEqual([` ╭${"─".repeat(36)}╮ `, ` │ hello${" ".repeat(29)} │ `, ` ╰${"─".repeat(36)}╯ `]);
		for (const line of editor.render(40)) expect(visibleWidth(line)).toBe(40);
	});

	it("keeps plain rules when the terminal is too narrow for a frame", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);

		expect(strip(editor.render(10)[0]!)).toBe("─".repeat(10));
	});
});

describe("WelcomeComponent", () => {
	const welcome = (height: number, visible = true) =>
		new WelcomeComponent({
			appName: "pi",
			version: "1.0.0",
			getHeight: () => height,
			getAvailableVersion: () => undefined,
			isVisible: () => visible,
		});

	it("fills the transcript height and centers the logo and text", () => {
		const lines = welcome(30).render(120);
		expect(lines).toHaveLength(30);
		expect(lines.some((line) => strip(line).includes("Welcome to pi"))).toBe(true);
		expect(lines.some((line) => strip(line).includes("●"))).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
	});

	it("drops the logo on narrow terminals", () => {
		const lines = welcome(0).render(50).map(strip);
		expect(lines.some((line) => line.includes("●"))).toBe(false);
		expect(lines.some((line) => line.includes("Welcome to pi"))).toBe(true);
	});

	it("notes a newer upstream release beside the version", () => {
		const lines = new WelcomeComponent({
			appName: "pi",
			version: "1.0.0",
			getHeight: () => 0,
			getAvailableVersion: () => "1.1.0",
			isVisible: () => true,
		})
			.render(120)
			.map(strip);
		expect(lines.some((line) => line.includes("v1.0.0 · v1.1.0 available, pi-fork sync"))).toBe(true);
	});

	it("renders nothing once the transcript has content", () => {
		expect(welcome(30, false).render(120)).toEqual([]);
	});
});
