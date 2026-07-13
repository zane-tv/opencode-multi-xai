import { z } from "zod";

/**
 * Zod schemas for the account pool. These schemas are the validation boundary
 * for persisted account storage.
 *
 * YAGNI-trimmed per oracle review: do NOT add healthScore, tokenBucket, or
 * activeIndexByModel here — those were cut from v1.
 */

/** Reason the account was (last) switched to / away from. */
export const LastSwitchReasonSchema = z.enum([
  "initial",
  "rotation",
  "quota-exhausted",
  "manual",
]);
export type LastSwitchReason = z.infer<typeof LastSwitchReasonSchema>;

/** Reason an account is in cooldown. */
export const CooldownReasonSchema = z.enum(["auth-failure", "network-error"]);
export type CooldownReason = z.infer<typeof CooldownReasonSchema>;

/**
 * Subscription lifecycle status.
 *
 * IMPORTANT: only set "dead" when the refresh grant returns invalid_grant.
 * Do NOT set "dead" based on inference-time credit/quota strings — those are
 * recoverable quota-exhausted signals, not terminal subscription death.
 */
export const SubscriptionStatusSchema = z.enum(["active", "dead", "unknown"]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const AccountMetadataSchema = z.object({
  accountId: z.string(),
  email: z.string().optional(),
  label: z.string().optional(),
  tags: z.array(z.string()).default([]),
  note: z.string().optional(),

  /** REQUIRED. xAI rotates refresh tokens on every grant. */
  refreshToken: z.string().min(1),
  accessToken: z.string().optional(),
  /** Epoch ms at which the access token expires. */
  expiresAt: z.number().optional(),
  oauthScope: z.string().optional(),

  enabled: z.boolean().default(true),
  addedAt: z.number(),
  lastUsed: z.number().default(0),
  lastSwitchReason: LastSwitchReasonSchema.default("initial"),

  /** Epoch ms when a quota-exhausted account may recover. */
  quotaResetAt: z.number().optional(),
  coolingDownUntil: z.number().optional(),
  cooldownReason: CooldownReasonSchema.optional(),

  subscriptionStatus: SubscriptionStatusSchema.default("unknown"),
  subscriptionCheckedAt: z.number().optional(),
  flaggedForRemoval: z.boolean().default(false),

  /**
   * True when the account hit the xAI per-account allowlist gate (#26847).
   * DISTINCT from `flaggedForRemoval` (prune semantics): this marks an account
   * that is entitlement-blocked so selection skips it. Optional-with-default so
   * pools written before this field still validate.
   */
  entitlementBlocked: z.boolean().default(false),
});
export type AccountMetadata = z.infer<typeof AccountMetadataSchema>;

export const AccountStorageSchema = z.object({
  version: z.literal(1),
  accounts: z.array(AccountMetadataSchema).default([]),
  activeIndex: z.number().default(0),
});
export type AccountStorage = z.infer<typeof AccountStorageSchema>;
