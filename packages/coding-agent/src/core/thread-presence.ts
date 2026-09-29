import { readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * What a live thread is doing: running a turn, blocked on an extension dialog, or waiting
 * for the user's next message.
 */
export type ThreadActivity = "working" | "needs_input" | "idle";

/** A thread held by another pi process, as recorded in its presence file. */
export interface ThreadPresence {
	pid: number;
	activity: ThreadActivity;
	updatedAt: string;
}

/**
 * Presence files mark which process has a thread open, so a second window cannot resume it
 * and both append to the same JSONL. The file sits beside the session file; listing only
 * reads `*.jsonl`, so it never shows up as a thread.
 */
export function presencePath(sessionFile: string): string {
	return `${sessionFile}.active`;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		// EPERM: the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readPresenceFile(sessionFile: string): ThreadPresence | undefined {
	try {
		const parsed = JSON.parse(readFileSync(presencePath(sessionFile), "utf8")) as Partial<ThreadPresence>;
		if (typeof parsed.pid !== "number") return undefined;
		return {
			pid: parsed.pid,
			activity: parsed.activity === "working" || parsed.activity === "needs_input" ? parsed.activity : "idle",
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
		};
	} catch {
		return undefined;
	}
}

/**
 * The process holding `sessionFile`, if it is another live process. A presence file left by
 * a crashed process is stale and reads as free.
 */
export function readOtherPresence(sessionFile: string): ThreadPresence | undefined {
	const presence = readPresenceFile(sessionFile);
	if (!presence || presence.pid === process.pid || !isProcessAlive(presence.pid)) return undefined;
	return presence;
}

function writePresence(sessionFile: string, activity: ThreadActivity, flag: "w" | "wx"): void {
	const presence: ThreadPresence = { pid: process.pid, activity, updatedAt: new Date().toISOString() };
	writeFileSync(presencePath(sessionFile), `${JSON.stringify(presence)}\n`, { flag });
}

/**
 * Claim `sessionFile` for this process. Returns the other holder instead when a live process
 * already has it. Filesystem errors other than contention are ignored: presence is advisory
 * and must never keep a thread from opening.
 */
export function claimPresence(sessionFile: string, activity: ThreadActivity): ThreadPresence | undefined {
	try {
		writePresence(sessionFile, activity, "wx");
		return undefined;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
	}
	const holder = readOtherPresence(sessionFile);
	if (holder) return holder;
	// Stale or already ours: take it over.
	try {
		writePresence(sessionFile, activity, "w");
	} catch {}
	return undefined;
}

/** Record a new activity for a thread this process holds. */
export function updatePresence(sessionFile: string, activity: ThreadActivity): void {
	const presence = readPresenceFile(sessionFile);
	if (presence && presence.pid !== process.pid) return;
	try {
		writePresence(sessionFile, activity, "w");
	} catch {}
}

/** Release a thread this process holds. Leaves another process's claim alone. */
export function releasePresence(sessionFile: string): void {
	const presence = readPresenceFile(sessionFile);
	if (presence && presence.pid !== process.pid) return;
	try {
		rmSync(presencePath(sessionFile), { force: true });
	} catch {}
}

/** Thrown when a thread is already open in another pi process. */
export class ThreadInUseError extends Error {
	readonly sessionFile: string;
	readonly holder: ThreadPresence;

	constructor(sessionFile: string, holder: ThreadPresence) {
		super(`This thread is open in another pi window (pid ${holder.pid}). Switch to that window to continue it.`);
		this.name = "ThreadInUseError";
		this.sessionFile = sessionFile;
		this.holder = holder;
	}
}
