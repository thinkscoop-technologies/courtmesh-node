# Changelog

All notable changes to `@courtmesh/sdk` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Each entry also states which server flags/behaviour the version targets on
the CourtMesh research server, since some of this SDK's contract only takes
effect once a given server flag is on for your account.

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
