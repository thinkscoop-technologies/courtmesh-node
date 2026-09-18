# Changelog

All notable changes to `@courtmesh/sdk` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Each entry also states which server flags/behaviour the version targets on
the CourtMesh research server, since some of this SDK's contract only takes
effect once a given server flag is on for your account.

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
