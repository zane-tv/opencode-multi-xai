/**
 * Public barrel for the multi-xai plugin library.
 *
 * Phase 1 surface: constants, schemas, storage, logger, and the OAuth auth
 * modules. Multi-account rotation, error classification, CLI tools, and the
 * TUI are intentionally NOT exported yet — those arrive in later phases.
 */

export * from "./constants.js";
export * from "./schemas.js";
export * from "./logger.js";
export * from "./storage.js";
export * from "./accounts.js";

export * from "./auth/pkce.js";
export * from "./auth/oauth.js";
export * from "./auth/server.js";
export * from "./auth/device-code.js";
export * from "./auth/refresh.js";

export * from "./request/classify-error.js";
export * from "./request/fetch.js";

export * from "./tools/resolve.js";
export * from "./tools/registry.js";
export * from "./tui-status.js";
export * from "./models-sync.js";
// NOTE: do NOT `export * from "./plugin.js"` — the plugin entry must stay a
// dedicated module with only `export default { id, server }` so OpenCode's
// legacy loader never iterates non-plugin function exports.
