/**
 * Compatibility re-export. Canonical tools live in ./tools/registry.ts so the
 * plugin entry never exports non-plugin helpers.
 */
export { buildTools } from "./tools/registry.js";
