/**
 * Bridges OpenCode variant options into xAI Responses requests.
 *
 * Built-in provider id `xai` uses `@ai-sdk/xai`, which reads providerOptions.xai.
 * Our provider id is `xai-multi`, so OpenCode wraps options under
 * providerOptions["xai-multi"] and the xAI SDK ignores them. We therefore stash
 * the selected session options here and re-apply them in customFetch.
 */

export type SessionRequestOptions = {
  reasoningEffort?: string;
  reasoningSummary?: string;
  store?: boolean;
  include?: string[];
  promptCacheKey?: string;
};

// sessionID → last options observed by chat.params for that session.
const bySession = new Map<string, SessionRequestOptions>();
// Fallback when the outbound request has no session header.
let lastOptions: SessionRequestOptions | undefined;

export function rememberSessionOptions(
  sessionID: string | undefined,
  options: Record<string, unknown>,
): void {
  const next = pickOptions(options);
  if (!next) return;
  lastOptions = next;
  if (sessionID) bySession.set(sessionID, next);
}

export function getSessionOptions(
  sessionID: string | undefined,
): SessionRequestOptions | undefined {
  if (sessionID) {
    const hit = bySession.get(sessionID);
    if (hit) return hit;
  }
  return lastOptions;
}

export function clearSessionOptions(sessionID?: string): void {
  if (sessionID) bySession.delete(sessionID);
  else {
    bySession.clear();
    lastOptions = undefined;
  }
}

function pickOptions(
  options: Record<string, unknown>,
): SessionRequestOptions | undefined {
  const out: SessionRequestOptions = {};
  if (typeof options.reasoningEffort === "string") {
    out.reasoningEffort = options.reasoningEffort;
  }
  if (typeof options.reasoningSummary === "string") {
    out.reasoningSummary = options.reasoningSummary;
  }
  if (typeof options.store === "boolean") out.store = options.store;
  if (Array.isArray(options.include)) {
    out.include = options.include.filter(
      (v): v is string => typeof v === "string",
    );
  }
  if (typeof options.promptCacheKey === "string") {
    out.promptCacheKey = options.promptCacheKey;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
