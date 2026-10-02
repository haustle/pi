/**
 * Packages this fork always runs, so a fresh clone gets the same experience
 * without a separate `pi install` pass. The package manager installs anything
 * missing on first start, and skips this in offline mode.
 *
 * The specs are exact, but the managed npm project at `~/.pi/agent/npm` records
 * them as caret ranges, so a fresh machine can come up on a newer version than
 * the line below (`pi-mcp-adapter` and `pi-subagents` did on the first run).
 * Treat a line as a floor: bump it when you want a newer one, and expect
 * `pi update --extensions` to leave it alone.
 *
 * An explicit entry in `settings.json` wins over the same package here, because
 * package dedupe is first-wins and settings are read first. There is no opt-out
 * for a single default: remove the line and rebuild.
 */
export const FORK_DEFAULT_PACKAGES = [
	"npm:pi-subagents@0.70.0",
	"npm:pi-web-access@0.30.0",
	"npm:pi-mcp-adapter@2.34.0",
	"npm:@dietrichgebert/ponytail@4.10.0",
	"npm:@juicesharp/rpiv-ask-user-question@2.10.1",
] as const;
