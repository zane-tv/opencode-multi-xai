/**
 * Package entry for OpenCode plugin loading.
 * Proven pattern (kiro): default export is PluginModule { id, server }.
 * Re-export the dedicated plugin entry (which has NO other named function exports).
 */
export { default } from "./lib/plugin.js";
