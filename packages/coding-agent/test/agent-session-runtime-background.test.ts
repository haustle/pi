import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { claimPresence, presencePath, ThreadInUseError } from "../src/core/thread-presence.ts";

/** A promise with its resolver, for holding a faux model response open. */
function gate(): { promise: Promise<void>; open: () => void } {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
}

describe("AgentSessionRuntime background threads", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createRuntimeHost() {
		const tempDir = join(tmpdir(), `pi-runtime-bg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
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

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				modelRuntime,
				resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noExtensions: true },
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});
		return { runtimeHost, faux };
	}

	/** Start a turn on the current session whose reply waits for the returned gate. */
	async function startHeldTurn(host: Awaited<ReturnType<typeof createRuntimeHost>>) {
		const reply = gate();
		host.faux.setResponses([
			fauxAssistantMessage("warmup"),
			async () => {
				await reply.promise;
				return fauxAssistantMessage("done in the background");
			},
		]);
		// A first turn saves the session file, so the held turn runs on a persisted thread.
		await host.runtimeHost.session.prompt("warm up");
		const session = host.runtimeHost.session;
		const turn = session.prompt("long task");
		await until(() => !session.isIdle);
		return { session, sessionFile: session.sessionFile!, reply, turn };
	}

	it("keeps a working thread running in the background when a new thread starts", async () => {
		const host = await createRuntimeHost();
		const { session, sessionFile, reply, turn } = await startHeldTurn(host);

		await host.runtimeHost.newSession();
		expect(host.runtimeHost.session).not.toBe(session);
		expect(host.runtimeHost.backgroundSessions).toEqual([session]);
		expect(host.runtimeHost.getThreadStatus(sessionFile)).toEqual({ kind: "background", activity: "working" });
		expect(JSON.parse(readFileSync(presencePath(sessionFile), "utf8")).pid).toBe(process.pid);

		reply.open();
		await turn;
		await until(() => host.runtimeHost.backgroundSessions.length === 0);
		expect(host.runtimeHost.getThreadStatus(sessionFile)).toEqual({ kind: "finished" });
		expect(existsSync(presencePath(sessionFile))).toBe(false);
		expect(readFileSync(sessionFile, "utf8")).toContain("done in the background");
	});

	it("restores the live session when switching back to a background thread", async () => {
		const host = await createRuntimeHost();
		const { session, sessionFile, reply, turn } = await startHeldTurn(host);
		const restored: boolean[] = [];
		host.runtimeHost.setRebindSession(async (_session, options) => {
			restored.push(options.restored);
		});

		await host.runtimeHost.newSession();
		await host.runtimeHost.switchSession(sessionFile);

		expect(host.runtimeHost.session).toBe(session);
		expect(host.runtimeHost.backgroundSessions).toEqual([]);
		expect(host.runtimeHost.getThreadStatus(sessionFile)).toEqual({ kind: "current", activity: "working" });
		expect(restored).toEqual([false, true]);

		reply.open();
		await turn;
		expect(session.isIdle).toBe(true);
	});

	it("treats choosing the thread already on screen as a no-op", async () => {
		const host = await createRuntimeHost();
		const { session, sessionFile, reply, turn } = await startHeldTurn(host);

		await host.runtimeHost.switchSession(sessionFile);
		expect(host.runtimeHost.session).toBe(session);
		expect(session.isIdle).toBe(false);

		reply.open();
		await turn;
	});

	it("reports needs_input while a background thread waits on a dialog", async () => {
		const host = await createRuntimeHost();
		const { session, sessionFile, reply, turn } = await startHeldTurn(host);
		await host.runtimeHost.newSession();

		host.runtimeHost.setNeedsInput(session, true);
		expect(host.runtimeHost.getThreadStatus(sessionFile)).toEqual({ kind: "background", activity: "needs_input" });
		expect(JSON.parse(readFileSync(presencePath(sessionFile), "utf8")).activity).toBe("needs_input");

		host.runtimeHost.setNeedsInput(session, false);
		reply.open();
		await turn;
	});

	it("refuses to open a thread another live process holds", async () => {
		const host = await createRuntimeHost();
		await host.runtimeHost.session.prompt("hello");
		const sessionFile = host.runtimeHost.session.sessionFile!;
		await host.runtimeHost.newSession();

		// The parent process stands in for another pi window.
		writeFileSync(presencePath(sessionFile), JSON.stringify({ pid: process.ppid, activity: "working" }));
		expect(host.runtimeHost.getThreadStatus(sessionFile)).toEqual({ kind: "other_window", activity: "working" });
		await expect(host.runtimeHost.switchSession(sessionFile)).rejects.toBeInstanceOf(ThreadInUseError);
	});
});

describe("thread presence", () => {
	it("treats a presence file from a dead process as free", () => {
		const dir = join(tmpdir(), `pi-presence-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		const sessionFile = join(dir, "thread.jsonl");
		try {
			writeFileSync(presencePath(sessionFile), JSON.stringify({ pid: 2 ** 22 + 12345, activity: "working" }));
			expect(claimPresence(sessionFile, "idle")).toBeUndefined();
			expect(JSON.parse(readFileSync(presencePath(sessionFile), "utf8")).pid).toBe(process.pid);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
