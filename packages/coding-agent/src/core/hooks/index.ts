/**
 * Backward-compatible re-export from the unified extensions system.
 *
 * The legacy hooks module was merged into extensions in c6fc0845.
 * This subpath preserves the import path for consumers using
 *
 *   import { ... } from "@apholdings/jensen-code/hooks"
 *
 * Available symbols are re-exported from the extensions barrel.
 */

export type { LoadExtensionsResult as LoadHooksResult } from "../extensions/index.js";
export {
	discoverAndLoadExtensions as discoverAndLoadHooks,
	loadExtensions as loadHooks,
} from "../extensions/loader.js";

export type {
	ExtensionErrorListener as HookErrorListener,
	NavigateTreeHandler,
	NewSessionHandler,
} from "../extensions/runner.js";
export { ExtensionRunner as HookRunner } from "../extensions/runner.js";
// Handler types re-exported from extensions
export type {
	AppendEntryHandler,
	ExtensionFlag as HookFlag,
	ExtensionShortcut as HookShortcut,
	GetActiveToolsHandler,
	GetAllToolsHandler,
	SendMessageHandler,
	SetActiveToolsHandler,
} from "../extensions/types.js";
export {
	wrapToolsWithExtensions as wrapToolsWithHooks,
	wrapToolWithExtensions as wrapToolWithHooks,
} from "../extensions/wrapper.js";
export type { ReadonlySessionManager } from "../session-manager.js";
