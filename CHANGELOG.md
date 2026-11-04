# Changelog

All notable changes to `@courtmesh/sdk` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Each entry also states which server flags/behaviour the version targets on
the CourtMesh research server, since some of this SDK's contract only takes
effect once a given server flag is on for your account.

## [0.6.0]

Adds case depth and refresh by CNR (API docs 1.4.0).

### Added

- `include` on `getCase` and `getCaseByCnr`: hearing history and advocates, at no extra charge. Either can be null when no such record is held.
- `listCaseOrders` (1 credit): the documents of a case with availability flags. `getCaseDocumentText`: the stored text of one, 2 credits and charged only when text is returned.
- `refreshCaseByCnr`, `getCaseRefreshState` and `refreshCasesBatch`: refresh by CNR, one at a time or up to 50, with a free status read.
- `ORDER_TEXT_LIMIT_REACHED` error code.

## [0.5.0]

Adds CNR lookup and case monitoring (API docs 1.3.0).

### Added

- `getCaseByCnr(cnr, { fetch })` for `GET /cases/by-cnr/{cnr}`, and a `cnr` option on `searchCases` (exact match, `query` is now optional when `cnr` is given).
- Watchlists: `createWatchlist`, `listWatchlists`, `getWatchlist`, `updateWatchlist`, `deleteWatchlist`, `addWatchlistItems`, `listWatchlistItems`, `removeWatchlistItem`.
- Change feed: `listChanges`, `listWatchlistEvents`, with async iterators `iterChanges` and `iterWatchlistEvents` that walk pages until caught up.
- Webhooks: `createWebhook`, `listWebhooks`, `getWebhook`, `updateWebhook`, `deleteWebhook`, `rotateWebhookSecret`, `testWebhook`, `listWebhookDeliveries`, `retryWebhookDelivery`, plus `iterWatchlists`, `iterWatchlistItems`, `iterWebhooks` and `iterWebhookDeliveries`.
- `verifyWebhookSignature(rawBody, header, secret, { toleranceSeconds })` and `WebhookSignatureError`.
- `normalizeCnr` and `assertCnr`, exported, matching the server's CNR normalisation.
- Typed models for all of the above, including `ChangeEvent`.
- `PATCH` and `DELETE` support in the HTTP layer. `DELETE` is retried like `GET`; `PATCH` and all new `POST` calls follow the `retryPosts` rule and send an `Idempotency-Key` when it is in effect.
- `repository`, `homepage` and `bugs` fields in `package.json`, and a `prepublishOnly` check.

### Changed

- `getCaseByCnr` with `fetch: true`: the call that starts the fetch returns `pending` and is free; the poll that returns the record is the one 1 credit charge. `requestId` is opaque and is polled via the same call, not `getTimeline`.
- New error codes typed: `ITEM_NOT_FOUND` (removing a CNR not in the list) and the other monitoring codes.
- `Webhook.secretRotating`.
- `requestTimeline({ refresh: true })` now costs 1 credit (it was 20). Docs and docstrings updated.
- `SearchCasesOptions.query` is optional (required unless `cnr` is set).
- `User-Agent` is `courtmesh-node/0.5.0`.
- `WatchItemStatus` gains `unavailable` (a case taken down at a party's request: `caseId`, `court`, `title`, `snapshot`, `lastCheckedAt` and `lastChangedAt` are `null`, no events are sent). Adding a taken down CNR returns `not_found`.
- Documented the daily add allowance per account (Free 50, Pay As You Go 5,000, Scale 50,000, Enterprise 500,000) on top of the daily limit on new CNRs; both report `cap_exceeded`. The watch cap counts distinct CNRs across all lists.
- Documented the 24 hour cooldown after the court portal has nothing for a CNR: watchlist adds return `not_found` and `getCaseByCnr(..., { fetch: true })` throws `NotFoundError` without a new fetch.
- Documented that `searchCases({ cnr })` returns one ordinary search hit, that `case.tracking_started` is sent after the first fresh refresh, that a burst announces the newest 20 orders and never orders dated more than 7 days before watching began, that feed cursors are opaque and `since` is converted once, and that dates are `YYYY-MM-DD` with 9999 meaning no date.
- Documented webhook behaviour: `testWebhook` is sent even to a disabled endpoint, 10 second deadline and 64 KB read per attempt, never attempted deliveries older than 24 hours are `failed` with `lastError: "expired"`, a webhook created without `events` echoes the full default `case.*` list, and `watchlistIds: []` means all lists. `createWebhook` honours `Idempotency-Key`.
- Validation error `details` is an array of `"path: message"` strings for query and body alike (`ValidationError.details`).

## [0.4.1]

Live QA pass against the redeployed production research server
(`research.courtmesh.ai`, 2026-09-19) and its updated OpenAPI spec. All items
below were confirmed with live calls against an Enterprise key, not only
against the spec.

### Added

- `User-Agent: courtmesh-node/0.4.1` sent on every request.
- `UsageTierLimits.published`: this tier's number in the OpenAPI rate-limit
  table, distinct from `requestsPerMinute` (the number actually enforced
  right now) until the API self-serve tiers flag is on for your account, at
  which point the two converge.
- `CoverageMeta.snapshotAgeSeconds`, `.cacheAgeSeconds` and `.stale`,
  replacing a single `ageSeconds` field that never actually existed on the
  wire.
- `CoverageCourt.courtType`, now explicitly nullable (added to the live
  schema 2026-09-19).
- `HealthCheckEntry`, `HealthCheckResult`, `PartyScreenRedactedName` and
  `PartyScreenRedactedAliases` (carried forward from the interim QA branch,
  re-verified live, see Changed below).

### Changed

- **Breaking:** `AuditHit.userAgent` removed - the redeployed server no
  longer sends it at all (dropped for privacy alongside raw `ipAddress`,
  which never appeared on the wire in the first place). `AuditHit.ipHash`
  (a SHA-256 digest of the caller's IP) is retained; a same-day interim fix
  had renamed `ipAddress` to `ipHash`, which remains correct.
- **Breaking:** `UsageTierLimits`: every field but `requestsPerMinute` (and
  now `published`) is nullable, matching a live Enterprise-key response with
  the self-serve tiers flag off. `limits` itself is confirmed always a
  populated object, never `null`.
- **Breaking:** `CoverageMeta.corpusNote` is now required (the server always
  sends it). `CoverageCourt`/`CoverageByCourtType`/`CoverageDistrictCourts`
  date and `businessDaysBehind` fields are now nullable, not only optional,
  matching the live schema.
- `AuditHit.metadata` is now `Record<string, unknown> | null` - observed
  `null` in production for hits with nothing to log, not only omitted.
- `HealthResponse.checks` entries are bare status strings in production
  (`"ok" | "fail" | "skipped"`), not `{ status, latencyMs?, error? }`
  objects; `HealthCheckEntry` accepts either shape (interim fix, re-verified
  live).
- `PartyScreenQueryEcho.name`/`.aliases` are redacted to
  `{ redacted: true, length }`/`{ redacted: true, count }` on a replayed
  idempotent `party/screen` response instead of echoing the original
  string/array (interim fix, re-verified live via a same-key replay).
- Confirmed unchanged and correct: `caseNumber` is `string` (never a number)
  on every endpoint that returns one; the five idempotency-key-aware POST
  endpoints (`screenParty`, `screenPartyBatch`, `analyzeCase`,
  `analyzeConsolidated`, `requestTimeline`) still send `Idempotency-Key` and
  mark a replay; the per-endpoint default timeouts (`semanticSearch` 630s,
  `requestTimeline` 240s, `analyzeConsolidated` 300s, `screenParty`/
  `screenPartyBatch` 90s) are unchanged.

### Removed

- `AuditHit.userAgent` (see Changed above).

## [0.4.0]

Targets the research server's account-introspection endpoints
(`GET /usage`, `GET /me`, `GET /audit`), the public reference endpoints
(`GET /reference/courts`, `GET /reference/case-types`), the new
`POST /party/screen/batch` endpoint, and the `Idempotency-Key` contract
being rolled out across the five job/charge-triggering POST endpoints.

### Added

- `usage()`: `GET /usage`, this key's tier, wallet balance, `TIER_LIMITS` for
  that tier, the current Asia/Kolkata billing period and a per endpoint call
  breakdown. Unmetered.
- `me()`: `GET /me`, the calling account's id, email, name, role and (if
  any) organization id.
- `audit(options)`: `GET /audit`, this key's own logged calls (or, for an
  org admin, an organization's), with summary stats and a top-endpoints
  breakdown. Takes `organizationId`, `userId`, `limit`, `offset`,
  `startDate`, `endDate`.
- `referenceCourts()`: `GET /reference/courts`, the court taxonomy accepted
  by `court` filters elsewhere in this API. No API key required.
- `referenceCaseTypes()`: `GET /reference/case-types`, every `caseType`
  value accepted elsewhere in this API. No API key required.
- `screenPartyBatch(options)`: `POST /party/screen/batch`, screens 1 to 25
  names in one call; each item is independently priced and can
  independently fail (`data.results[i].ok`) without failing the whole
  batch. Not available on the Free tier. LLM adjudication is not supported
  in the batch endpoint.
- `health()` now takes an options argument, `health({ deep: true })` calls
  `GET /health?deep=1`: also checks Mongo, OpenSearch, Qdrant, Redis and IAM
  standing, and reports `status: "degraded"`/`"unhealthy"` plus a
  `checks` object per dependency. `HealthResponse` gained `commit` and
  `checks`.
- `idempotencyKey` option on `screenParty`, `screenPartyBatch`,
  `analyzeCase`, `analyzeConsolidated` and `requestTimeline`: sent as the
  `Idempotency-Key` header (1 to 128 characters, `[A-Za-z0-9_.-]`, scoped
  per API key for 24 hours). A replayed call with the same key and body
  returns the stored response again (`response.replayed === true`, no new
  charge); the same key with a different body throws `ValidationError`
  with `apiCode === "IDEMPOTENCY_KEY_REUSED"`. When omitted, and
  `retryPosts` is in effect for that call (the call's own override, or the
  client's default), the SDK auto-generates a UUID v4 so an automatic retry
  of that exact call is always safe from a double charge or a double-run
  job.
- `ApiResponse.requestId`: every response now carries the request id, either
  the server's own `meta.requestId`/body-level `requestId` when it set one,
  or (as a fallback the SDK backfills client side) the `X-Request-Id`
  response header.
- `ApiResponse.replayed`: `true` when the response carried
  `Idempotency-Replayed: true`.
- `ConflictError` (409): thrown by the five idempotency-key-aware POST
  methods when the same `Idempotency-Key` was reused with a different body
  (`apiCode === "IDEMPOTENCY_KEY_REUSED"`) or a request with that key is
  still in flight (`apiCode === "IDEMPOTENCY_IN_PROGRESS"`).
  `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS` and
  `IDEMPOTENCY_KEY_INVALID` added to `API_REFUSAL_CODES`/`ApiRefusalCode`.
- New types: `ApiTier`, `UsageData`/`UsageMeta`/`UsageBalance`/
  `UsageTierLimits`/`UsagePeriod`/`UsageByEndpoint`/`UsageWalletOwner`,
  `MeData`, `AuditOptions`/`AuditResponse`/`AuditHit`/`AuditSummary`/
  `AuditTopEndpoint`/`AuditPagination`, `CourtHierarchy`/`CourtNamesMap`/
  `ReferenceCourtsResponse`, `CaseTypeEntry`/`ReferenceCaseTypesResponse`,
  `PartyScreenBatchOptions`/`PartyScreenBatchItem`/`PartyScreenBatchResult`/
  `PartyScreenBatchItemResult`/`PartyScreenBatchSummary`/
  `PartyScreenBatchMeta`, `HealthCheckResult`.

## [0.3.0]

Targets the research server after the 2026-09-18 API abuse-control and
parity pass (`server/config/api-tiers.ts`, `server/routes/api-v1-prod.ts`,
`server/middleware/api-tier-limits.ts`, `server/utils/rate-limiter.ts`).
Correct against that server regardless of whether `API_SELF_SERVE_TIERS` is
on for your account, though several fields (`cursor`, tier refusal codes,
per tier pagination caps) are only ever populated once it is.

### Added

- `cursor` request field on `searchCases`, and `pagination.nextCursor` is now
  typed `string | Array<number | string> | null` (a signed opaque string
  when the API self-serve tiers flag is on for your account, the legacy raw
  array otherwise). `searchAfter` is marked deprecated/legacy.
- `iterSearchCases` is now cursor-first: it passes `pagination.nextCursor`
  back as `cursor` (or, on the legacy array shape, continues via
  `searchAfter`) instead of only incrementing `page`.
- `refresh` option on `requestTimeline`; `meta.liveFetch` and
  `data.liveFetchSupported` on its response.
- `allowRemoteFetch` option on `analyzeCase`.
- `meta.sortBy`, `meta.warnings`, `meta.someRecordsWithheld` and
  `meta.restrictedCheckDegraded` on `searchCases` and `semanticSearch`.
- `PayloadTooLargeError` (413).
- `API_REFUSAL_CODES` (runtime object) and `ApiRefusalCode` (type), mirroring
  the server's own machine refusal codes plus the handler-local and
  SDK-synthesised ones (`CASE_RESTRICTED`, `PDF_NOT_STORED`, `CASE_NOT_FOUND`,
  `PARTY_SCREEN_SEARCH_DEGRADED`, `CURSOR_INVALID`, `PAGE_LIMIT_EXCEEDED`,
  `PAGINATION_DEPTH_EXCEEDED`, the `API_KEY_*` auth codes,
  `ORGANIZATION_DEACTIVATED`, `ACCOUNT_STANDING_UNAVAILABLE`,
  `IP_NOT_ALLOWED`, `VALIDATION_ERROR`, `MALFORMED_JSON`,
  `PAYLOAD_TOO_LARGE`, and more).
- `apiCode` and `requestId` on every error class (previously only on
  `PermissionError`/`RateLimitError`).
- `wallet`, `walletOwner` and `contactAdmin` on `InsufficientCreditsError`;
  `limit` and `tier` on `ValidationError`, with a synthesised `message` for
  the two pagination cap codes (whose response body carries no message of
  its own).
- `retryPosts` and `maxRetryAfterSeconds` client options, and a per call
  `RequestConfig` (`timeoutMs`, `retryPosts`) accepted by every method.
- Per endpoint default timeouts: `semanticSearch` 630s, `requestTimeline`
  240s, `analyzeConsolidated` 300s, `screenParty` 90s, everything else 30s.
- `PartyRole` and `PartyScreenQueryEcho` types.

### Changed

- **Breaking:** `SearchHit` now exposes `id`/`score`/`highlights` as the
  primary fields; `_id`/`_score` are kept but marked legacy/optional.
- **Breaking:** `PartyScreenCoverage` no longer has `candidatesEvaluated` or
  `adjudicationsRun` - `adjudicationsRun` moved to a top level field of
  `PartyScreenResult` (matching the server's actual response shape).
- **Breaking:** `PartyScreenSignal.status` is now
  `"matched" | "conflicted" | "absent"` and `.weight` is now
  `"strong" | "moderate" | "weak"` (both were loosely typed as `string`/
  `number` before). `PartyScreenConfidence.engine` is now `"rules" | "llm"`.
- **Breaking:** `PartyScreenMatch.partyRole` is now required and typed
  `PartyRole`; `PartyScreenRelatedMatch` now omits `partyRole`, `confidence`,
  `evidence` and `rationale` (previously only `confidence`).
- **Breaking:** `SearchCasesOptions.sortBy` widened to
  `"relevance" | "recent" | "oldest" | "date"` (was `"relevance" | "date"`,
  which did not match what the server actually accepts).
- Only `RATE_LIMITED` and `CONCURRENT_ANALYSIS_LIMIT` are retried
  automatically on a 429; a daily/monthly cap code never is.
- A POST is no longer retried automatically after a network error, a read
  timeout, or a 502/503/504 response, unless `retryPosts: true`. A 429 is
  unaffected by this (it is a pre-flight refusal on every method).
- Renamed "CourtMesh Enterprise API" to "CourtMesh API" throughout.

### Removed

- Deleted four stale README caveats that no longer describe the live server:
  `caseNumber` is applied server side (not ignored); `sortBy` supports
  `relevance`/`recent`/`oldest` (not only `relevance`); `semanticSearch`'s
  top level filter fields are merged in, not ignored; `semanticSearch` no
  longer returns HTTP 200 for a failed request.

## [0.2.0] and earlier

Pre-dates this changelog. See git history.
