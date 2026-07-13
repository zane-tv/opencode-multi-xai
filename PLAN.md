# Plan: OpenCode Plugin — Multi-Account Auto-Switch cho xAI/Grok

> Plugin OpenCode quản lý nhiều tài khoản SuperGrok (grok.com / X subscription qua OAuth),
> tự động xoay account khi hết quota, và dọn dẹp account hết subscription (tự động + thủ công).

---

## ⚠️ REVISION sau @oracle review (nguồn sự thật: `.slim/deepwork/multi-xai-plugin.md`)

Oracle review đã sửa vài quyết định trong bản gốc bên dưới. **Khi có mâu thuẫn, theo mục này.**

- **B1 (data-loss bug):** `run out of credits` / `personal-team-blocked:spending-limit` =
  **quota tháng hết, HỒI PHỤC được** — KHÔNG phải hết subscription. Auto-prune `remove`
  sẽ xóa nhầm account khỏe. → Đổi tên state thành `quota-exhausted` (rotate + set reset).
  Chỉ coi là `dead` khi **refresh-token grant trả `invalid_grant`/401**.
- **B3 (3-way tại 403):** `classify-error` trả **discriminated union**:
  `ok | transient | quota-exhausted | entitlement-blocked | auth-dead | server | network`.
  `entitlement-blocked` (403 "caller does not have permission", xAI #26847) **KHÔNG rotate**
  (account cùng tier sẽ 403 y hệt) → skip account, cảnh báo user.
- **S1:** OAuth endpoints **đã public + confirmed** qua 5 repo shipping → **BỎ** phase
  "trích từ source OpenCode". Giá trị: `client_id=b1a00492-073a-47ea-816f-4c329264a828`,
  issuer `https://auth.x.ai`, discovery `/.well-known/openid-configuration`,
  redirect `http://127.0.0.1:56121/callback`,
  scope `openid profile email offline_access grok-cli:access api:access`,
  extra `plan=generic`. Làm discovery lúc runtime, pin HTTPS `*.x.ai`.
- **S2:** dùng `@ai-sdk/openai` (không phải `openai-compatible`) — theo plugin shipping
  `ysnock404/opencode-grok-auth`. Scrub reasoning params cho grok-4.x. Xác nhận ở P0.
- **S3:** loader/customFetch đúng hướng. **Ghi đè** (không append) header Authorization =
  OAuth bearer. **Classify trên initial response TRƯỚC khi pipe stream body.**
- **S4:** xAI **rotate refresh token** → single-flight per account + **persist atomic
  refresh mới TRƯỚC khi dùng**; luôn `refresh_token ?? old`. Sai = brick account.
- **S5:** chỉ attach bearer cho host `https://api.x.ai` (host-pin).
- **YAGNI — CẮT khỏi v1:** HealthScore, TokenBucket, PID offset, retry-budget 6-category,
  circuit breaker, `activeIndexByModel`, giữ **1 strategy = sticky/drain-first**,
  auto-prune `remove`. Giữ browser + device-code login, hoãn manual-paste.
- **Phasing mới:** P0 spike (2 account thật, go/no-go) → P1 fork+scaffold → P2 classify
  (fixtures thật) → P3 pool+sticky+single-flight refresh → P4 tools → P5 prune dry-run/flag
  → P6 TUI → P7 install+test.

---

## 0. Quyết định đã chốt

| # | Quyết định | Chọn |
|---|-----------|------|
| 1 | Đường auth | **Đường A — SuperGrok OAuth** (không scrape cookie) |
| 2 | Provider ID | **ID riêng `xai-multi`** (không override provider `xai` built-in) |
| 3 | TUI status | **Có** — hiển thị account active + quota ở prompt |
| 4 | Bulk remove account hết subscription | **Có** — cả tự động lẫn thủ công |

### Vì sao Đường A (OAuth) thay vì cookie scraping

| Tiêu chí | Đường A: SuperGrok OAuth ✅ | Đường B: Cookie grok.com ❌ |
|---------|---------------------------|----------------------------|
| Cơ chế | OAuth access + refresh token, tự refresh | Scrape 5 cookie + header anti-bot `x-statsig-id` |
| Ổn định | Cao | Rất fragile (Statsig đổi liên tục) |
| ToS | Gần sạch (OAuth chính thức xAI) | Vi phạm ToS, rủi ro khóa acc |
| Hệ sinh thái | Đang sống (oh-my-pi PR #4913 multi-account) | grok2api **đã khai tử** vì risk control |

---

## 1. Tổng quan kiến trúc

Plugin đăng ký với OpenCode theo khuôn `oc-codex-multi-auth`:

```ts
return {
  event: eventHandler,                 // nghe account.select + session.error
  auth: {
    provider: "xai-multi",             // provider ID RIÊNG
    loader: async (getAuth, provider) => ({
      apiKey: DUMMY_API_KEY,
      baseURL: "https://api.x.ai/v1",
      fetch: customFetch               // ← intercept mọi request tại đây
    }),
    methods: [
      { type: "oauth", label: "SuperGrok OAuth (browser)", authorize },
      { type: "oauth", label: "SuperGrok OAuth (device code)", authorize }
    ]
  },
  tool: { /* xai-list, xai-switch, xai-prune, ... */ }
}
```

**Điểm mấu chốt (xác nhận từ source OpenCode `packages/plugin/src/index.ts`):**
`auth.loader` chạy **trước mỗi request**, trả về `fetch` tùy biến. Toàn bộ logic
multi-account nằm trong `customFetch`:

1. Chọn account healthy nhất từ pool
2. Refresh token nếu sắp hết hạn (proactive)
3. Inject `Authorization: Bearer <access>`
4. Gửi request → lỗi quota/auth → phân loại → rotate → retry ngay trong cùng fetch
5. Cạn hết account → trả lỗi rõ ràng kèm thời điểm reset sớm nhất

**Provider config** (`opencode.json`, plugin tự ghi khi cài):
```jsonc
{
  "provider": {
    "xai-multi": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Grok Multi-Account",
      "options": { "baseURL": "https://api.x.ai/v1" },
      "models": {
        "grok-4": { "name": "Grok 4" },
        "grok-3": { "name": "Grok 3" }
      }
    }
  }
}
```

---

## 2. Cấu trúc thư mục

```
opencode-mutil-xai/
├── index.ts                    # Plugin entry: event + auth{provider,loader,methods} + tools
├── tui.ts                      # TUI plugin entry (quota status ở prompt)
├── package.json                # ESM; deps: @opencode-ai/plugin, @opencode-ai/sdk, zod, hono
├── tsconfig.json
├── vitest.config.ts
├── lib/
│   ├── constants.ts            # XAI_BASE_URL, PROVIDER_ID, OAuth endpoints, cooldowns
│   ├── schemas.ts              # Zod: AccountMetadata, AccountStorage
│   ├── config.ts               # Load config + env override chain
│   ├── logger.ts               # initLogger, logRequest, logDebug/Warn/Error
│   ├── storage.ts              # Atomic save/load pool (JSON, chmod 600), migration, backup
│   ├── auth/
│   │   ├── oauth.ts            # xAI OAuth: authorize + exchange + refresh   [VIẾT MỚI]
│   │   ├── server.ts           # Local callback server (hono)                [VIẾT MỚI]
│   │   └── device-code.ts      # Headless/SSH login                          [VIẾT MỚI]
│   ├── rotation.ts             # HealthScore + TokenBucket + hybrid/sticky/round-robin
│   ├── accounts.ts             # AccountManager (pool orchestrator)
│   ├── refresh-queue.ts        # Dedupe concurrent token refresh
│   ├── subscription.ts         # Detect + prune account hết subscription     [VIẾT MỚI]
│   ├── request/
│   │   ├── fetch.ts            # customFetch pipeline (rotate + retry loop)
│   │   └── classify-error.ts   # Phân loại lỗi xAI                           [VIẾT MỚI — quan trọng nhất]
│   └── tools/                   # Đăng ký CLI tools
│       ├── list.ts             # xai-list
│       ├── switch.ts           # xai-switch
│       ├── add.ts              # xai-add
│       ├── remove.ts           # xai-remove
│       ├── prune.ts            # xai-prune  (bulk remove hết subscription)
│       ├── meta.ts             # xai-label / xai-tag / xai-note
│       └── io.ts               # xai-export / xai-import / xai-refresh
├── scripts/
│   └── install.ts              # Ghi provider config vào opencode.json
├── test/                       # vitest
└── PLAN.md                     # (file này)
```

---

## 3. Quản lý nhiều account

### Schema account (`lib/schemas.ts`, Zod — biên giới validate)

```ts
AccountMetadata = {
  accountId: string,
  email?: string,
  label?: string,
  tags: string[],
  note?: string,
  refreshToken: string,            // BẮT BUỘC, non-empty
  accessToken?: string,
  expiresAt?: number,
  oauthScope?: string,
  enabled: boolean,
  addedAt: number,
  lastUsed: number,
  lastSwitchReason: "rate-limit" | "initial" | "rotation",
  rateLimitResetTimes: Record<string /*model*/, number>,
  coolingDownUntil?: number,
  cooldownReason?: "auth-failure" | "network-error",

  // --- cho tính năng prune (mục 5) ---
  subscriptionStatus?: "active" | "expired" | "unknown",
  subscriptionCheckedAt?: number,
  flaggedForRemoval?: boolean,     // đánh dấu để bulk-prune
}

AccountStorage = {
  version: 1,
  accounts: AccountMetadata[],
  activeIndex: number,
  activeIndexByModel?: Record<string, number>
}
```

### Storage
- Global: `~/.config/opencode/multi-xai-accounts.json`
- Per-project (tùy chọn): `~/.config/opencode/projects/<hash>/multi-xai-accounts.json`
- Atomic write + backup + `chmod 600`. **Không đụng `auth.json`** của OpenCode.
- Có transaction wrapper `withStorageTransaction` (read-modify-write an toàn).

### CLI tools (đăng ký qua `tool` hook)
| Tool | Chức năng |
|------|-----------|
| `xai-list` | Liệt kê account + trạng thái/quota/subscription |
| `xai-add` | Login OAuth thêm account (hoặc `opencode auth login`) |
| `xai-switch index=<n>` | Chuyển account thủ công |
| `xai-remove index=<n>` | Xóa 1 account |
| `xai-prune` | **Bulk remove** account hết subscription (mục 5) |
| `xai-label / xai-tag / xai-note` | Metadata |
| `xai-refresh index=<n>` | Refresh token thủ công |
| `xai-export / xai-import` | Backup / restore |

---

## 4. Cơ chế auto-switch khi hết quota (lõi)

### Phân loại lỗi (`classify-error.ts`)
xAI **không** phân biệt transient vs terminal bằng HTTP status — phải parse chuỗi `error`:

```ts
const TERMINAL = /used all available credits|monthly spending limit|purchase more credits|run out of credits|personal-team-blocked/i;
const TRANSIENT = /rate limit exceeded|too many requests/i;

// 429 + TRANSIENT        → transient : backoff, GIỮ account
// 429/403 + TERMINAL     → terminal  : mark exhausted + set reset time, SWITCH
// 401 / 400 invalid key  → permanent : refresh; nếu fail → SWITCH / remove
// 5xx / network          → backoff rồi rotate nếu lặp lại
```

Các JSON envelope thật (thu thập từ nghiên cứu) sẽ là fixture cho unit test.

### Vòng lặp rotate trong `customFetch`
```
attempted = {}
while attempted.size < accountCount:
    account = selectAccount(strategy)      # hybrid mặc định
    ensureFreshToken(account)              # proactive refresh nếu expiresAt gần
    res = await fetch(...)
    kind = classify(res)
    if ok:        return res
    if transient: backoff; retry cùng account (trong retry budget)
    if terminal:  mark exhausted; set rateLimitResetTimes; rotate
    if permanent: refresh || cooldown/remove account; rotate
# tất cả cạn:
return 429/503 "All N accounts exhausted" + thời điểm reset sớm nhất
```

### Rotation strategy (tái dùng nguyên từ repo tham chiếu)
- **`hybrid`** (mặc định): stick nếu account hiện tại healthy; else score
  `health*2 + tokens*5 + freshness*2` + PID offset (giãn tải giữa process)
- **`sticky`**: drain-first — dồn 1 account đến cạn (tốt để giãn cooldown theo tuần)
- **`round-robin`**: lần lượt

### Health & cooldown
- HealthScore: +1 success / −10 rate-limit / −20 fail, hồi +2/giờ, range 0–100
- TokenBucket: 50 max, refill 6/phút, drain 10 khi bị rate-limit
- Cooldown 30s; tự remove sau 3 lần auth-fail liên tiếp
- Retry budget theo category (authRefresh / network / server / rateLimit...)

---

## 5. Xóa hàng loạt account hết subscription (tính năng bổ sung)

### Phát hiện account hết subscription (`subscription.ts`)
Một account bị coi là **hết subscription** khi:
- Request trả `403` + body chứa `personal-team-blocked:spending-limit` / `run out of credits`, **và**
- Không phải rate-limit tạm thời (đã loại qua `classify-error`), **và**
- Lỗi lặp lại sau khi refresh token thành công (loại trừ token hỏng đơn thuần)

Khi phát hiện → set `subscriptionStatus = "expired"`, `subscriptionCheckedAt = now`,
`flaggedForRemoval = true`. Ghi log + toast TUI.

### Chế độ tự động (auto-prune)
- Config `autoPruneExpired`: `off` (mặc định) | `flag` | `remove`
  - `off`: không làm gì (chỉ đánh dấu)
  - `flag`: đánh dấu `flaggedForRemoval`, hiển thị trong `xai-list`, chờ user chạy `xai-prune`
  - `remove`: tự xóa ngay khi xác nhận hết subscription (kèm backup trước khi xóa)
- An toàn: chỉ auto-remove khi `subscriptionStatus === "expired"` đã xác nhận
  (không xóa nhầm account chỉ đang rate-limit tạm thời).

### Chế độ thủ công (`xai-prune`)
```
xai-prune                    # xóa tất cả account đang flaggedForRemoval / expired
xai-prune dry-run=true       # chỉ liệt kê account sẽ bị xóa, không xóa
xai-prune tag=<t>            # chỉ prune trong nhóm tag
```
- Luôn tạo backup trước khi xóa (dùng cho `xai-import` khôi phục).
- In tóm tắt: đã xóa N account (email/label), còn lại M account active.

---

## 6. OAuth flow (phần phải viết mới)

Mô phỏng `lib/auth/auth.ts` của repo tham chiếu, đổi endpoint sang xAI SuperGrok.

**Task ĐẦU TIÊN khi implement:** trích chính xác từ **source OpenCode**
(`packages/opencode/src/auth` / provider xAI) các giá trị:
`client_id`, `authorize_url`, `token_url`, `redirect_uri` (callback `127.0.0.1:56121`),
scopes. Đây là mảnh dữ liệu còn thiếu — phải đọc code OpenCode lúc code, không đoán.

- 3 chế độ login: browser callback (hono server), device-code (SSH/headless), manual paste
- Refresh: gửi `refresh_token` grant → nhận access mới (+ refresh mới nếu rotation)
- `refresh-queue.ts` dedupe refresh race
- Proactive refresh trước request nếu `expiresAt <= now + 60s`

---

## 7. TUI status

Plugin `tui.ts` riêng:
- Hiển thị account đang active + quota còn lại ở slot `session_prompt_right`
- Badge cảnh báo khi có account `flaggedForRemoval` / `expired`
- Cache dùng chung, refresh theo event (`account.select`, `session.idle`)
- Command `xai.quota.details` xem chi tiết pool

---

## 8. Verification

- **Unit (vitest):**
  - `classify-error.ts` với đúng JSON envelope xAI đã thu thập
  - rotation strategies (hybrid/sticky/round-robin)
  - storage atomic write + migration + transaction
  - refresh-queue dedupe
  - `subscription.ts` detect expired vs transient rate-limit
  - `xai-prune` dry-run vs real, backup được tạo
- **Integration:** mock `fetch` trả 429/403/401 → assert rotate/backoff/remove đúng
- **E2E thủ công:** 2 account SuperGrok, chạy đến khi 1 acc 403 credit
  → xác nhận auto-switch liền mạch; test auto-prune + `xai-prune`

---

## 9. Tái sử dụng vs viết mới

- **~60% tái dùng pattern** từ `oc-codex-multi-auth`: plugin entry, AccountManager,
  rotation, retry budget, circuit breaker, storage, config, logger, TUI, tool registry.
- **~40% viết mới**: OAuth flow (endpoint xAI), `classify-error.ts` (chuỗi lỗi xAI),
  `subscription.ts` (prune), request headers/URL cho `api.x.ai/v1`, model mapping Grok.

---

## 10. Lộ trình implement

1. Scaffold project + `package.json` + tsconfig + Zod schemas + storage + logger
2. Trích OAuth endpoints xAI từ source OpenCode → dựng `oauth.ts` + login server + device-code
3. `classify-error.ts` + test (rủi ro cao nhất, làm sớm)
4. `customFetch` pipeline + rotation + retry loop
5. AccountManager + CLI tools (list/add/switch/remove/meta/io)
6. `subscription.ts` + `xai-prune` + auto-prune config
7. `tui.ts` status
8. `scripts/install.ts` (ghi provider config)
9. Test toàn diện + E2E 2 account

---

## 11. Rủi ro & lưu ý

- **OAuth endpoints xAI chưa xác nhận 100%** — phải đọc source OpenCode lúc code (bước 2).
  Nếu OpenCode chưa expose sẵn SuperGrok OAuth cho provider ID tùy biến, cân nhắc
  reuse cơ chế OAuth của provider `xai` built-in qua `getAuth()`.
- **Phân loại lỗi phụ thuộc chuỗi text** (xAI không có mã lỗi ổn định) → regex có thể
  cần cập nhật nếu xAI đổi message. Cô lập trong `classify-error.ts` + test coverage cao.
- **Auto-prove `remove`** là hành động phá hủy → mặc định `off`, luôn backup trước khi xóa.
- Headers rate-limit (`x-ratelimit-*`, `retry-after`) của xAI **chưa được doc chính thức** →
  parse best-effort, fallback backoff cố định.
