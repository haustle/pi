import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";
import {
	claimPresence,
	presencePath,
	readOtherPresence,
	releasePresence,
	type ThreadActivity,
	ThreadInUseError,
	updatePresence,
} from "./thread-presence.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/** A session plus the cwd-bound services it was created with. */
interface RuntimeEntry {
	session: AgentSession;
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	modelFallbackMessage?: string;
}

/** Where a thread lives relative to this runtime, for thread lists. */
export type ThreadStatus =
	| { kind: "current"; activity: ThreadActivity }
	/** Still running after the user moved to another thread. */
	| { kind: "background"; activity: ThreadActivity }
	/** Finished in the background and not opened since. */
	| { kind: "finished" }
	/** Open in another pi process. */
	| { kind: "other_window"; activity: ThreadActivity };

/** Session events after which a thread's activity may have changed. */
const ACTIVITY_EVENTS = new Set([
	"agent_start",
	"turn_start",
	"message_end",
	"agent_end",
	"agent_settled",
	"compaction_start",
	"compaction_end",
]);

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 *
 * A busy session is not torn down when the user moves to another thread: it is parked
 * in the background and keeps running until it goes idle, then it is disposed. Switching
 * back to a parked thread restores the live session instead of reloading it from disk.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession, options: { restored: boolean }) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private beforeSessionPark?: (session: AgentSession) => void;
	private onBackgroundRetired?: (session: AgentSession) => void;
	private readonly background = new Map<string, RuntimeEntry>();
	private readonly finishedInBackground = new Set<string>();
	private readonly needsInput = new Set<AgentSession>();
	private readonly activityTrackers = new Map<AgentSession, () => void>();
	/** Last activity recorded per session, so unchanged activity neither rewrites presence nor notifies. */
	private readonly recordedActivity = new Map<AgentSession, ThreadActivity>();
	private readonly threadListeners = new Set<() => void>();
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this.track(_session);
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	/**
	 * Set the host callback that binds a newly current session. `restored` is true when the
	 * session was brought back from the background: it is already bound and must not see
	 * `session_start` again.
	 */
	setRebindSession(rebindSession?: (session: AgentSession, options: { restored: boolean }) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs before the current session moves to the background.
	 * The host detaches its UI from the session here; the session itself stays valid.
	 */
	setBeforeSessionPark(beforeSessionPark?: (session: AgentSession) => void): void {
		this.beforeSessionPark = beforeSessionPark;
	}

	/** Set a callback that runs when a background session finishes and is disposed. */
	setOnBackgroundRetired(onBackgroundRetired?: (session: AgentSession) => void): void {
		this.onBackgroundRetired = onBackgroundRetired;
	}

	/** Sessions still running in the background. */
	get backgroundSessions(): AgentSession[] {
		return [...this.background.values()].map((entry) => entry.session);
	}

	/** Status of a thread by session file, or undefined for a thread nobody has open. */
	getThreadStatus(sessionFile: string): ThreadStatus | undefined {
		if (sessionFile === this.session.sessionFile) {
			return { kind: "current", activity: this.activityOf(this.session) };
		}
		const parked = this.background.get(sessionFile);
		if (parked) return { kind: "background", activity: this.activityOf(parked.session) };
		if (this.finishedInBackground.has(sessionFile)) return { kind: "finished" };
		const other = readOtherPresence(sessionFile);
		if (other) return { kind: "other_window", activity: other.activity };
		return undefined;
	}

	/** Mark a session as blocked on (or released from) an extension dialog the user has not answered. */
	setNeedsInput(session: AgentSession, needsInput: boolean): void {
		if (needsInput === this.needsInput.has(session)) return;
		if (needsInput) this.needsInput.add(session);
		else this.needsInput.delete(session);
		this.recordActivity(session);
	}

	/** Subscribe to thread status changes. Returns the unsubscribe function. */
	onThreadsChanged(listener: () => void): () => void {
		this.threadListeners.add(listener);
		return () => this.threadListeners.delete(listener);
	}

	private notifyThreadsChanged(): void {
		for (const listener of this.threadListeners) listener();
	}

	private activityOf(session: AgentSession): ThreadActivity {
		if (this.needsInput.has(session)) return "needs_input";
		return session.isIdle ? "idle" : "working";
	}

	private recordActivity(session: AgentSession): void {
		const activity = this.activityOf(session);
		if (this.recordedActivity.get(session) === activity) return;
		this.recordedActivity.set(session, activity);
		const sessionFile = session.sessionFile;
		if (sessionFile && session.sessionManager.isPersisted()) updatePresence(sessionFile, activity);
		this.notifyThreadsChanged();
	}

	/** Claim a session's presence file and keep its recorded activity current. */
	private track(session: AgentSession): void {
		if (this.activityTrackers.has(session)) return;
		const sessionFile = session.sessionFile;
		const activity = this.activityOf(session);
		this.recordedActivity.set(session, activity);
		if (sessionFile && session.sessionManager.isPersisted()) claimPresence(sessionFile, activity);
		this.activityTrackers.set(
			session,
			session.subscribe((event) => {
				if (ACTIVITY_EVENTS.has(event.type)) this.recordActivity(session);
				// A new session's directory may not exist when it is claimed; claim once it is saved.
				if (event.type === "message_end" && sessionFile && !existsSync(presencePath(sessionFile))) {
					updatePresence(sessionFile, this.activityOf(session));
				}
			}),
		);
	}

	private untrack(session: AgentSession): void {
		this.activityTrackers.get(session)?.();
		this.activityTrackers.delete(session);
		this.recordedActivity.delete(session);
		this.needsInput.delete(session);
		const sessionFile = session.sessionFile;
		// A retiring background session may share its file with a session reopened from disk.
		if (sessionFile && !this.isHeld(sessionFile, session)) releasePresence(sessionFile);
	}

	/** Whether a session other than `except` in this runtime has `sessionFile` open. */
	private isHeld(sessionFile: string, except: AgentSession): boolean {
		if (this.session !== except && this.session.sessionFile === sessionFile) return true;
		const parked = this.background.get(sessionFile);
		return parked !== undefined && parked.session !== except;
	}

	/** Refuse to open a thread another pi process has open. */
	private assertThreadAvailable(sessionFile: string | undefined): void {
		if (!sessionFile) return;
		const holder = readOtherPresence(sessionFile);
		if (holder) throw new ThreadInUseError(sessionFile, holder);
	}

	private canPark(session: AgentSession): boolean {
		return !session.isIdle && session.sessionManager.isPersisted() && session.sessionFile !== undefined;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		const session = this.session;
		if (this.canPark(session)) {
			this.park(session, reason, targetSessionFile);
			return;
		}
		// Settle any active response first so the aborted turn (including tool
		// results) is persisted to the outgoing session before it is replaced.
		await session.abort();
		await emitSessionShutdownEvent(session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this.beforeSessionInvalidate?.();
		this.untrack(session);
		session.dispose();
	}

	/** Move the busy current session to the background, where it runs until idle. */
	private park(session: AgentSession, reason: SessionShutdownEvent["reason"], targetSessionFile?: string): void {
		const sessionFile = session.sessionFile!;
		this.beforeSessionPark?.(session);
		this.background.set(sessionFile, {
			session,
			services: this._services,
			diagnostics: this._diagnostics,
			modelFallbackMessage: this._modelFallbackMessage,
		});
		void this.retireWhenIdle(sessionFile, session, reason, targetSessionFile);
		this.notifyThreadsChanged();
	}

	/** Dispose a background session once it stops working, unless it was brought back first. */
	private async retireWhenIdle(
		sessionFile: string,
		session: AgentSession,
		reason: SessionShutdownEvent["reason"],
		targetSessionFile?: string,
	): Promise<void> {
		// An agent_end listener can queue more work, so idle is only final once it holds.
		do {
			await session.waitForIdle();
			await new Promise<void>((resolve) => setImmediate(resolve));
		} while (!session.isIdle);
		if (this.background.get(sessionFile)?.session !== session) return;

		this.background.delete(sessionFile);
		this.finishedInBackground.add(sessionFile);
		try {
			await emitSessionShutdownEvent(session.extensionRunner, {
				type: "session_shutdown",
				reason,
				targetSessionFile,
			});
		} finally {
			this.onBackgroundRetired?.(session);
			this.untrack(session);
			session.dispose();
			this.notifyThreadsChanged();
		}
	}

	private apply(result: RuntimeEntry): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
		const sessionFile = result.session.sessionFile;
		if (sessionFile) this.finishedInBackground.delete(sessionFile);
		this.track(result.session);
		this.notifyThreadsChanged();
	}

	private async finishSessionReplacement(
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
		options: { restored?: boolean } = {},
	): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session, { restored: options.restored ?? false });
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		// Choosing the thread already on screen must not reload it, or a running turn would be cut off.
		if (sessionPath === this.session.sessionFile) {
			return { cancelled: false };
		}
		const parked = this.background.get(sessionPath);
		if (!parked) this.assertThreadAvailable(sessionPath);

		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		if (parked) {
			// Take it out of the pool first so its idle watcher does not dispose it mid-switch.
			this.background.delete(sessionPath);
			await this.teardownCurrent("resume", sessionPath);
			this.apply(parked);
			await this.finishSessionReplacement(options?.withSession, { restored: true });
			return { cancelled: false };
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.teardownCurrent("new", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}),
		);
		if (options?.setup) {
			await options.setup(this.session.sessionManager);
			this.session.refreshContext();
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				this.apply(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			if (!existsSync(currentSessionFile)) {
				throw new Error("This session has not been saved yet. Send a message before cloning or forking it.");
			}
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		let destinationPath = join(sessionDir, basename(resolvedPath));
		const sourceAlreadyStored = resolve(destinationPath) === resolvedPath;
		if (!sourceAlreadyStored) {
			const { name, ext } = parse(destinationPath);
			let suffix = 1;
			while (existsSync(destinationPath)) {
				destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`);
			}
		}
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		if (!sourceAlreadyStored) {
			copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	async dispose(): Promise<void> {
		// Background threads stop with the process; abort persists their partial turns.
		const parked = [...this.background.values()];
		this.background.clear();
		await Promise.all(
			parked.map(async ({ session }) => {
				await session.abort();
				await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
				this.untrack(session);
				session.dispose();
			}),
		);

		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
		});
		this.beforeSessionInvalidate?.();
		this.untrack(this.session);
		this.session.dispose();
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
