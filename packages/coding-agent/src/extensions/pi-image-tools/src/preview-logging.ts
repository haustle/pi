import type { DebugLogger } from "./debug-logger.js";
import { getErrorMessage } from "./errors.js";

/**
 * Best-effort debug logging for Pi preview code.
 *
 * `DebugLogger.log` already swallows its own failures, and `getErrorMessage`
 * never throws, so callers need no try/catch guard. Consolidating the call
 * here keeps both preview renderers consistent and avoids duplicated guards.
 */
export function logPreviewEvent(
  logger: DebugLogger | undefined,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  logger?.log(event, fields);
}

/**
 * Best-effort debug logging for a caught error inside a Pi event handler.
 */
export function logPreviewHandlerError(
  logger: DebugLogger | undefined,
  event: string,
  error: unknown,
): void {
  logPreviewEvent(logger, event, { error: getErrorMessage(error) });
}
