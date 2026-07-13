import type { SessionRequestOptions } from "./session-options.js";

/**
 * Inject xAI Responses reasoning fields that `@ai-sdk/xai` would have written
 * if OpenCode had passed providerOptions under the key `xai`.
 *
 * Only mutates JSON bodies for /v1/responses. Chat-completions bodies get
 * reasoning_effort as a safe fallback. Never touches non-JSON / non-string bodies.
 */
export function injectXaiReasoningBody(
  url: URL,
  init: RequestInit | undefined,
  options: SessionRequestOptions | undefined,
): RequestInit | undefined {
  if (!options || !init || typeof init.body !== "string") return init;
  if (!init.body.trim()) return init;

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(init.body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return init;
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return init;
  }

  const path = url.pathname;
  let changed = false;

  if (path.endsWith("/responses") || path.includes("/responses")) {
    if (options.reasoningEffort || options.reasoningSummary) {
      const existing =
        body.reasoning &&
        typeof body.reasoning === "object" &&
        !Array.isArray(body.reasoning)
          ? { ...(body.reasoning as Record<string, unknown>) }
          : {};
      if (options.reasoningEffort && existing.effort === undefined) {
        existing.effort = options.reasoningEffort;
        changed = true;
      }
      if (options.reasoningSummary && existing.summary === undefined) {
        existing.summary = options.reasoningSummary;
        changed = true;
      }
      if (changed) body.reasoning = existing;
    }
    if (options.store === false && body.store === undefined) {
      body.store = false;
      changed = true;
    }
    if (options.include?.length) {
      const cur = Array.isArray(body.include) ? [...(body.include as unknown[])] : [];
      for (const item of options.include) {
        if (!cur.includes(item)) {
          cur.push(item);
          changed = true;
        }
      }
      if (changed) body.include = cur;
    }
    if (options.promptCacheKey && body.prompt_cache_key === undefined) {
      body.prompt_cache_key = options.promptCacheKey;
      changed = true;
    }
  } else if (
    path.endsWith("/chat/completions") ||
    path.includes("/chat/completions")
  ) {
    if (options.reasoningEffort && body.reasoning_effort === undefined) {
      body.reasoning_effort = options.reasoningEffort;
      changed = true;
    }
  }

  if (!changed) return init;
  return { ...init, body: JSON.stringify(body) };
}

/** Best-effort session id extraction from OpenCode request headers. */
export function sessionIdFromHeaders(
  headers: Headers | Record<string, string> | Array<[string, string]> | undefined,
): string | undefined {
  if (!headers) return undefined;
  const h = headers instanceof Headers ? headers : new Headers(headers);
  return (
    h.get("x-session-id") ??
    h.get("X-Session-Id") ??
    h.get("x-session-affinity") ??
    undefined
  ) || undefined;
}
