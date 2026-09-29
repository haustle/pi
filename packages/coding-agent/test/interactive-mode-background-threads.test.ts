import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

/** Private InteractiveMode members this test drives directly instead of through key presses. */
interface InteractiveModeInternals {
	run(): Promise<void>;
	onInputCallback: ((text: string) => void) | undefined;
	editor: { onSubmit?: (text: string) => void | Promise<void> };
	stop(): void;
	handleClearCommand(): Promise<void>;
	handleResumeSession(sessionPath: string): Promise<{ cancelled: boolean }>;
	openCommandPalette(options: { mode: "all" | "threads" }): Promise<void>;
	paletteHandle: { hide(): void } | undefined;
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(await condition()).toBe(true);
}

describe("InteractiveMode background threads", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("starts a new thread without interrupting the working one, and shows its status", async () => {
		const tempDir = join(tmpdir(), `pi-bg-threads-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousOffline = process.env.PI_OFFLINE;
		process.env.PI_CODING_AGENT_DIR = tempDir;
		process.env.PI_OFFLINE = "1";

		const faux = registerFauxProvider();
		let releaseReply!: () => void;
		const replyReleased = new Promise<void>((resolve) => {
			releaseReply = resolve;
		});
		faux.setResponses([
			fauxAssistantMessage("warmed up"),
			async () => {
				await replyReleased;
				return fauxAssistantMessage("finished while you were away");
			},
			fauxAssistantMessage("second thread reply"),
		]);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const settingsManager = SettingsManager.inMemory({ quietStartup: true });
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				modelRuntime,
				settingsManager,
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true },
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});

		const terminal = new VirtualTerminal(100, 30);
		const mode = new InteractiveMode(runtime, { terminal, tuiMode: "fullscreen" });
		const internals = mode as unknown as InteractiveModeInternals;
		cleanups.push(async () => {
			internals.stop();
			await runtime.dispose();
			faux.unregister();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});
		// The real input loop, so submissions take the same path as a typed message.
		void internals.run();
		// Typing before the loop listens would hit the startup submit handler instead.
		await until(() => internals.onInputCallback !== undefined);
		const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
		// The editor's submit handler is what Enter calls; it feeds the input loop.
		const submit = (text: string) => void internals.editor.onSubmit?.(text);

		submit("warm up");
		await until(async () => (await screen()).includes("warmed up"));
		const workingSession = runtime.session;
		const workingFile = workingSession.sessionFile!;
		submit("long task");
		await until(() => !workingSession.isIdle);

		// A new thread leaves the working one running and shows the welcome screen.
		await internals.handleClearCommand();
		expect(runtime.session).not.toBe(workingSession);
		expect(workingSession.isIdle).toBe(false);
		await until(async () => (await screen()).includes("Welcome to pi"));
		expect(await screen()).toContain("1 thread working");

		// The new thread takes its own message while the first thread is still working.
		const secondSession = runtime.session;
		submit("second task");
		await until(async () => (await screen()).includes("second thread reply"));
		expect(workingSession.isIdle).toBe(false);
		expect(
			workingSession.sessionManager.getEntries().some((entry) => JSON.stringify(entry).includes("second task")),
		).toBe(false);
		expect(secondSession.sessionFile).not.toBe(workingFile);

		await internals.openCommandPalette({ mode: "threads" });
		await until(async () => (await screen()).includes("Working…"));
		internals.paletteHandle?.hide();

		// Switching back restores the live turn instead of reloading it.
		await internals.handleResumeSession(workingFile);
		expect(runtime.session).toBe(workingSession);
		await until(async () => (await screen()).includes("long task"));
		expect(await screen()).not.toContain("1 thread working");

		releaseReply();
		await until(async () => (await screen()).includes("finished while you were away"));
	});
});
