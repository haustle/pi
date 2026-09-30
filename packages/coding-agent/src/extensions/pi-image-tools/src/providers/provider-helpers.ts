import { buildNamespaceWrappedCommand, defaultCommandExists, type CommandExists } from "../shell-environment.js";
import {
  defaultCommandRunner,
  MAX_BUFFER_BYTES,
  READ_TIMEOUT_MS,
  type CommandResult,
  type CommandRunner,
} from "./command-runner.js";
import type {
  ClipboardImageProvider,
  ClipboardProviderContext,
  ClipboardReadResult,
  ProviderCapabilities,
} from "./types.js";

// Re-export the symbols command-based providers reference in their read
// overrides and option types. Routing every concrete provider's import
// through this one module — the shared `CommandRunnerProviderOptions`
// interface, the `LIST_TYPES_TIMEOUT_MS` constant, and the result types —
// keeps their import blocks short and avoids duplicated multi-line import
// boilerplate across providers.
export type { CommandExists } from "../shell-environment.js";
export type { CommandResult, CommandRunner } from "./command-runner.js";
export { LIST_TYPES_TIMEOUT_MS } from "./command-runner.js";
export type { ClipboardProviderContext, ClipboardReadResult } from "./types.js";

/**
 * Minimal read-result shape shared by command-based and PowerShell-based
 * clipboard providers. Both `CommandResult` (Buffer stdout) and
 * `PowerShellCommandResult` (string stdout) satisfy this structural contract.
 */
interface ProviderReadResult {
  missingCommand: boolean;
  ok: boolean;
  stdout: { length: number };
}

/** Result returned when the provider's command is not installed. */
export function providerUnavailable(): { available: false; image: null } {
  return { available: false, image: null };
}

/** Result returned when the clipboard is available but holds no image. */
export function providerEmptyImage(): { available: true; image: null } {
  return { available: true, image: null };
}

/** Result returned when a provider successfully read an image. */
export function providerImageResult(bytes: Uint8Array, mimeType: string): ClipboardReadResult {
  return { available: true, image: { bytes, mimeType } };
}

/**
 * Shared `isAvailable` implementation for providers that delegate to an
 * external command whose presence is verified via `commandExists`.
 */
export function createCommandAvailabilityChecker(
  commandName: string,
  commandExists: CommandExists = defaultCommandExists,
): (context: ClipboardProviderContext) => boolean {
  return (context: ClipboardProviderContext): boolean => {
    try {
      return commandExists(commandName, context);
    } catch {
      return false;
    }
  };
}

/**
 * Maps a command read result to the standard unavailable/empty sentinel.
 * Returns `null` when the caller should continue processing the result.
 */
export function mapProviderReadFallback(
  result: ProviderReadResult,
  requireNonEmptyStdout = true,
): { available: false; image: null } | { available: true; image: null } | null {
  if (result.missingCommand) {
    return providerUnavailable();
  }

  const isEmpty = !result.ok || (requireNonEmptyStdout && result.stdout.length === 0);
  return isEmpty ? providerEmptyImage() : null;
}

/**
 * Parses a command's stdout — a newline-separated list of MIME types as
 * emitted by `wl-paste --list-types` / `xclip -t TARGETS -o` — into a
 * trimmed, non-empty list. Shared by the Linux command-based providers so
 * the parse chain is not duplicated per provider.
 */
export function parseMimeTypeList(stdout: Buffer): string[] {
  return stdout
    .toString("utf8")
    .split(/\r?\n/)
    .map((mimeType) => mimeType.trim())
    .filter((mimeType) => mimeType.length > 0);
}

/** Options shared by namespace-wrapped (macOS) command providers. */
export interface NamespacedCommandProviderOptions {
  priority?: number;
  commandRunner?: CommandRunner;
  commandExists?: CommandExists;
}

/** Options shared by plain command-runner (Linux) providers. */
export interface CommandRunnerProviderOptions {
  priority?: number;
  commandRunner?: CommandRunner;
}

/**
 * Base for macOS providers that read the clipboard via a namespace-wrapped
 * command (osascript/pngpaste). Encapsulates the commandRunner/commandExists
 * wiring, the command-availability check, and the shared read preamble
 * (namespace wrap -> run -> fallback), so concrete providers only describe
 * their command args and how to turn stdout into an image.
 */
export abstract class NamespacedCommandProvider implements ClipboardImageProvider {
  readonly capabilities: ProviderCapabilities;
  private readonly commandRunner: CommandRunner;
  private readonly commandExists: CommandExists;
  private readonly isAvailableFn: (context: ClipboardProviderContext) => boolean;
  private readonly commandName: string;

  constructor(
    capabilities: ProviderCapabilities,
    commandName: string,
    options: NamespacedCommandProviderOptions = {},
  ) {
    this.capabilities = capabilities;
    this.commandName = commandName;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.commandExists = options.commandExists ?? defaultCommandExists;
    this.isAvailableFn = createCommandAvailabilityChecker(this.commandName, this.commandExists);
  }

  isAvailable(context: ClipboardProviderContext): boolean {
    return this.isAvailableFn(context);
  }

  read(context: ClipboardProviderContext): ClipboardReadResult {
    const wrapped = buildNamespaceWrappedCommand(this.commandName, this.buildArgs(), context, this.commandExists);
    const result = this.commandRunner(wrapped.command, wrapped.args, {
      environment: context.environment,
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: READ_TIMEOUT_MS,
    });

    const fallback = mapProviderReadFallback(result);
    if (fallback) {
      return fallback;
    }

    return this.readFromResult(result);
  }

  protected abstract buildArgs(): readonly string[];
  protected abstract readFromResult(result: CommandResult): ClipboardReadResult;
}

/**
 * Base for Linux providers that read the clipboard via a fixed command (no
 * namespace wrapping). Provides the commandRunner field, an always-available
 * `isAvailable`, and a shared `runCommand` helper so concrete providers only
 * implement `read`.
 */
export abstract class CommandRunnerProvider implements ClipboardImageProvider {
  readonly capabilities: ProviderCapabilities;
  protected readonly commandRunner: CommandRunner;

  constructor(capabilities: ProviderCapabilities, options: CommandRunnerProviderOptions = {}) {
    this.capabilities = capabilities;
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
  }

  isAvailable(_context: ClipboardProviderContext): boolean {
    return true;
  }

  protected runCommand(
    command: string,
    args: readonly string[],
    context: ClipboardProviderContext,
    timeout: number = READ_TIMEOUT_MS,
  ): CommandResult {
    return this.commandRunner(command, args, {
      environment: context.environment,
      maxBuffer: MAX_BUFFER_BYTES,
      timeout,
    });
  }

  abstract read(context: ClipboardProviderContext): ClipboardReadResult;
}

export type { ClipboardImageProvider };
