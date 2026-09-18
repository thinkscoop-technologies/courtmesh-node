# @courtmesh/sdk

Official TypeScript SDK for the CourtMesh API. Ships dual ESM and CommonJS builds with full type definitions, uses the global `fetch` (Node 18+), and has zero runtime dependencies.

## Install

```bash
npm install @courtmesh/sdk
```

## Quickstart

```ts
import { CourtMeshClient } from "@courtmesh/sdk";

const client = new CourtMeshClient({
  apiKey: "cm-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-xxxx",
});

const result = await client.searchCases({ query: "arbitration clause" });
console.log(result.data.length, "hits, total:", result.pagination.total);
console.log(result.data[0]?.id);
```

## Auth

Every endpoint except `GET /health` requires an API key. Two header forms are accepted by the API, in this order:

1. `X-API-Key: <key>`
2. `Authorization: Bearer <key>`

This SDK always sends the second form:

```
Authorization: Bearer <apiKey>
```

You can pass the key to the constructor, or set the `COURTMESH_API_KEY` environment variable and omit it:

```ts
// Explicit.
const client = new CourtMeshClient({ apiKey: "cm-..." });

// From process.env.COURTMESH_API_KEY.
const client = new CourtMeshClient();
```

If you are calling the API directly without this SDK (curl, another language, and so on), either header form works:

```bash
curl -H "X-API-Key: cm-..." https://research.courtmesh.ai/api/v1/prod/health
curl -H "Authorization: Bearer cm-..." https://research.courtmesh.ai/api/v1/prod/health
```

## Configuration

```ts
const client = new CourtMeshClient({
  apiKey: "cm-...",
  baseUrl: "https://research.courtmesh.ai/api/v1/prod", // default
  maxRetries: 3,             // default, retry attempts after the first try
  timeoutMs: 30000,          // default per request AbortController timeout, 0 disables it
                             // (semanticSearch, requestTimeline, analyzeConsolidated and
                             // screenParty each default to a longer per-endpoint timeout,
                             // see Timeouts below; override per call via that method's
                             // second/third argument, e.g. client.searchCases(opts, { timeoutMs }))
  retryPosts: false,         // default, see Retries below: retry a POST after it has
                             // already reached the network (a network error, a read
                             // timeout, or a 502/503/504) only when you opt in
  maxRetryAfterSeconds: 60,  // default cap on how long a 429 is retried automatically
  fetch: myFetch,            // default: global fetch, override for testing or custom transports
});
```

A client side timeout does not cancel the request server side and never triggers a refund: the call may still complete (and be billed) after the SDK has already thrown `RequestTimeoutError`.

## Rate limit

Per key requests-per-minute, requests-per-day and requests-per-month ceilings apply, and vary by tier (Free is the tightest, Enterprise the widest). Exceeding one returns HTTP 429 with `code: "RATE_LIMITED"`, a `retryAfter` field in seconds, and a `resetTime` ISO timestamp. This SDK retries a `RATE_LIMITED` 429 automatically (see Retries below), but if you are issuing many requests in a script, throttle client side to stay under the limit rather than relying on retries alone.

## Endpoint examples

### 1. `searchJudges`, `GET /judges/search`

```ts
const { data, meta } = await client.searchJudges({ q: "khanna" });
// data: string[] of judge names, at most 50
console.log(meta?.totalMatches);
```

### 2. `searchCases`, `POST /search/cases`

Keyword search over the OpenSearch index. `caseNumber` is applied server side (one value; an array's first element is used). `sortBy` accepts `"relevance" | "recent" | "oldest"`, plus the deprecated alias `"date"` (resolved to `"recent"`, with a note in `meta.warnings`).

```ts
const { data, meta, pagination } = await client.searchCases({
  query: "arbitration clause",
  court: "Delhi High Court",
  year: 2023,
  fromDate: "2023-01-01",
  toDate: "2023-12-31",
  sortBy: "recent",
  page: 1,
  limit: 20,
});
// data: SearchHit[], each with id, score, optional highlights (plus legacy _id/_score)
console.log(pagination.total, pagination.hasMore, pagination.nextCursor);
console.log(meta.sortBy, meta.someRecordsWithheld, meta.restrictedCheckDegraded);
```

Paging past the first screen: pass the previous page's `pagination.nextCursor` back as `cursor` (a signed, opaque string on self-serve accounts) - an invalid or query-mismatched cursor throws `ValidationError` with `apiCode: "CURSOR_INVALID"`. `iterSearchCases` (see Pagination below) does this for you, including the legacy array-shaped `nextCursor` some accounts still get.

### 3. `semanticSearch`, `POST /search/cases/semantic`

Vector search, billed as an AI interaction. **Not available on the Free tier**: throws `PermissionError` with `apiCode: "SEMANTIC_NOT_ALLOWED"` before any work or charge. The top level filter fields, whatever the query's natural language implies, and the `filters` object are all merged, weakest first in that order - `filters` (the vector store's own keys) always wins on overlap.

```ts
const result = await client.semanticSearch({
  query: "landlord failed to return security deposit",
  limit: 10,
  court: "Delhi High Court", // merged in, but filters below wins if both set the same key
  filters: {
    court: "Delhi High Court",
    caseYear: 2023,
    decisionDate: { $gte: "2022-01-01" },
  },
});
// data: CaseListItem[] on the normal path, or SearchHit[] on the filter-only fallback path
console.log(result.meta.someRecordsWithheld, result.meta.restrictedCheckDegraded);
```

### 4. `getCase`, `GET /cases/{id}`

`id` may be a Mongo ObjectId or a case number.

```ts
const { data } = await client.getCase("64f0c2...");
console.log(data.title, data.hasAnalysis);
```

### 5. `getCaseAnalysis`, `GET /cases/{id}/analysis`

```ts
const { data } = await client.getCaseAnalysis("64f0c2...");
if (data.hasAnalysis) {
  console.log(data.analysis.summary, data.analysis.keyFacts);
} else {
  console.log(data.message);
}
```

### 6. `getRelated`, `GET /cases/{id}/related`

```ts
const { data } = await client.getRelated("64f0c2...");
console.log(data.relatedDocuments.length, data.timeline);
```

### 7. `getCasePdf`, `GET /cases/{id}/pdf`

```ts
const { data } = await client.getCasePdf("64f0c2...");
// data.pdfUrl is CIPHERTEXT, not a fetchable URL, see Caveats below.
console.log(data.expiresIn); // 3600
```

Failure codes: `CASE_NOT_FOUND` (404), `CASE_RESTRICTED` (403), `PDF_NOT_STORED` (404, no stored document - `POST /request-timeline` with `refresh: true` may fetch one for High Court and District Court cases).

### 8. `analyzeCase`, `POST /cases/{id}/analyze`

Asynchronous, 202 Accepted. Poll `getCase` after 30 to 60 seconds, then call `getCaseAnalysis`. Costs 100 credits (reduced from 150), plus a surcharge when `allowRemoteFetch` triggers an external fetch. **Not available on the Free tier**: `analyzeCase`, `analyzeConsolidated` and `getCaseAnalysis` all return a `PermissionError` with `apiCode: "API_TIER_NOT_ALLOWED"` and an `upgradeUrl` for Free tier keys, before any work is done or any credit is charged.

```ts
const { data } = await client.analyzeCase("64f0c2...");
if ("alreadyExists" in data) {
  console.log(data.analysis);
} else {
  console.log(data.status); // "processing"
}

// Force a re-run of an existing analysis.
await client.analyzeCase("64f0c2...", { force: true });

// A case with no stored document can only be analyzed by fetching it from an
// external URL. Not on the Free tier, and the host must be on the server's
// allowlist - either violation throws PermissionError with
// apiCode: "REMOTE_FETCH_NOT_ALLOWED".
await client.analyzeCase("64f0c2...", { allowRemoteFetch: true });
```

### 9. `analyzeConsolidated`, `POST /cases/{id}/analyze-consolidated`

Synchronous and slow (up to 300s, see Timeouts below), it analyses the case plus related documents.

```ts
const { data, meta } = await client.analyzeConsolidated("64f0c2...");
console.log(data.status, data.consolidatedAnalysis.outcome, meta?.relatedCases);
```

### 10. `requestTimeline`, `POST /request-timeline`

`caseId` must be a Mongo ObjectId string. `refresh: true` forces a live court-portal fetch (20 credits) instead of serving the last stored read (1 credit) - `meta.liveFetch` says which one actually happened, `data.liveFetchSupported` comes back `false` when the case's court has no live refresh at all. Not available on the Free tier (`LIVE_FETCH_NOT_ALLOWED`, 403) and capped per day per tier (`LIVE_FETCH_LIMIT_REACHED`, 429).

```ts
const { data, meta } = await client.requestTimeline("64f0c2...");
console.log(data.requestId, data.status, meta.liveFetch);

// Force a live fetch instead of serving the cached read.
const refreshed = await client.requestTimeline("64f0c2...", { refresh: true });
console.log(refreshed.meta.liveFetch, refreshed.data.liveFetchSupported);
```

### 11. `getTimeline`, `GET /get-timeline/{requestId}`

Poll the job created by `requestTimeline`.

```ts
const { data } = await client.getTimeline(requestId);
if (data.status === "completed") {
  console.log(data.orders, data.orderCount);
}
```

### 12. `health`, `GET /health`

No auth required, not rate limited, not enveloped in `data`.

```ts
const status = await client.health();
console.log(status.status, status.version);
```

### 13. `screenParty`, `POST /party/screen`

Screens a person or company name against the case law corpus for litigation, insolvency and other court records. Requires an API key. Costs 100 credits when matches are found, 20 when none are, plus a flat surcharge only when `result.data.adjudicationsRun > 0` - requesting `adjudicate: true` does not by itself guarantee a model call happened (every candidate may already have been decided deterministically), so it does not by itself bill the surcharge either. `adjudicate: true` is not available on the Free tier (`API_TIER_NOT_ALLOWED`, 403).

```ts
const { data, meta } = await client.screenParty({
  name: "Acme Textiles Pvt Ltd",
  entityType: "company",
  purpose: "due_diligence",
  identifiers: { gstin: "07AAAAA0000A1Z5" },
  address: { city: "Delhi", state: "Delhi", stateCode: "DL" },
  limit: 40,
  adjudicate: true,
});

console.log(data.summary.verdict); // "matches_found" | "no_matches_found" | "inconclusive"
for (const match of data.matches) {
  console.log(match.title, match.confidence.band, match.confidence.engine, match.casePageUrl);
}
console.log(data.coverage.exhaustive, data.coverage.someRecordsWithheld, data.adjudicationsRun);
console.log(meta?.creditsCharged, meta?.adjudicated);
```

Verdict semantics: `matches_found` describes what was found internally, independent of `displayThreshold` - raising the threshold can leave `matches` empty (`summary.matchCount: 0`) while the verdict is still `matches_found`. `since` forces `inconclusive` (it is a best-effort filter, so completeness can never be certified either way). `no_matches_found` is only ever returned when `coverage.exhaustive` is true and nothing was withheld.

**DPDP note.** `purpose` is required on every call and is the only thing about the query the server retains in its logs, `name`, `aliases`, `knownPersons`, `identifiers` and `address` are never logged. The results are drawn entirely from public court records, they are not sourced from or cross-checked against any private database. **A screen is not an identity check**: it tells you whether a name (optionally narrowed by identifiers, address or known associates) appears in litigation or insolvency records, it does not verify who a person or company actually is. `notice` in the response links the case removal / takedown policy; `coverage.someRecordsWithheld` is `true` when one or more otherwise-matching cases were removed from the results because they are under a takedown order.

### 14. `coverage`, `GET /coverage`

Corpus coverage and freshness stats: totals, by court type, by year, per court, and a rolled up District Courts row (the index has no per-state field). No API key is required, this SDK sends one anyway when the client is configured with one. Server side cached for up to 6 hours.

```ts
const { data } = await client.coverage();
console.log(data.total, data.documentBearing, data.statusOnly);
for (const court of data.courts) {
  console.log(court.court, court.records, court.latestDecisionDate, court.businessDaysBehind);
}
console.log(data.districtCourts.records);
```

## Pagination

`iterSearchCases` and `iterSemanticSearch` are async generators that walk pages automatically, yielding one page of results at a time. They stop when a page comes back empty, or when `pagination.hasMore` is false. Both have a built in safety guard of 10000 pages to prevent runaway loops. Default page size is 20 for both (also the Free tier's own `maxPageSize`; do not request more than your tier allows, see `PAGE_LIMIT_EXCEEDED` below).

`iterSearchCases` is cursor-first: once a page's `pagination.nextCursor` comes back as a signed string, it is passed back as `cursor` on the next call rather than incrementing `page`. On the legacy path (`nextCursor` comes back as a raw array instead), it walks pages via `searchAfter` instead - either way you do not have to branch on which shape your account gets.

```ts
for await (const page of client.iterSearchCases({ query: "arbitration clause", limit: 20 })) {
  for (const hit of page) {
    console.log(hit.id, hit.title);
  }
}

for await (const page of client.iterSemanticSearch({ query: "landlord deposit dispute", limit: 20 })) {
  console.log(page.length, "results in this page");
}
```

Note the two pagination shapes are different. `searchCases` returns `{ total, hasMore, page?, limit, nextCursor }`, `page` is absent once cursor pagination has taken over, there is no `totalPages`, and `nextCursor` is a signed opaque string (self-serve accounts) or a raw array (legacy accounts), never mix the two mechanisms in one request. `semanticSearch` returns `{ page, limit, total, totalPages, hasMore }`, and `total`/`totalPages` are estimates except on the last page.

An invalid or query-mismatched `cursor` throws `ValidationError` with `apiCode: "CURSOR_INVALID"`. Requesting a `limit` above your tier's cap throws `ValidationError` with `apiCode: "PAGE_LIMIT_EXCEEDED"` (`limit` and `tier` are set on the error); paging deeper than your tier allows throws the same class with `apiCode: "PAGINATION_DEPTH_EXCEEDED"`. Neither of these two response bodies carries a human message on the wire (`{ success: false, code, limit, tier }`), this SDK synthesises `error.message` for you.

## Error handling

Every error the SDK throws for a failed request extends `CourtMeshError` and carries `statusCode`, `message`, and the raw parsed response `body`.

```ts
import {
  CourtMeshClient,
  isCourtMeshError,
  ValidationError,
  AuthenticationError,
  PermissionError,
  InsufficientCreditsError,
  NotFoundError,
  RequestTimeoutError,
  RateLimitError,
  ServerError,
  BadGatewayError,
  ServiceUnavailableError,
  PayloadTooLargeError,
  API_REFUSAL_CODES,
} from "@courtmesh/sdk";

try {
  await client.getCase("does-not-exist");
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log("no such case");
  } else if (error instanceof InsufficientCreditsError) {
    console.log("need", error.shortfall, "more credits");
    if (error.contactAdmin) console.log("contact your org admin");
    else console.log("top up at", error.topUpUrl);
  } else if (error instanceof RateLimitError) {
    console.log("retry after", error.retryAfterSeconds, "seconds, resets at", error.resetTime, "code:", error.apiCode);
  } else if (isCourtMeshError(error)) {
    console.log(error.code, error.apiCode, error.statusCode, error.message, error.requestId, error.body);
  } else {
    throw error;
  }
}
```

| Class | Status | Notes |
|---|---|---|
| `ValidationError` | 400, 413 | `details` for a field-level zod failure; `apiCode`/`limit`/`tier` for `PAGE_LIMIT_EXCEEDED`/`PAGINATION_DEPTH_EXCEEDED`; `apiCode: "CURSOR_INVALID"` for a bad pagination cursor; `PayloadTooLargeError` (413) is a subclass for a request body over the size limit |
| `AuthenticationError` | 401 | missing, malformed, unknown, revoked or expired API key (`apiCode`: `API_KEY_MISSING`, `API_KEY_INVALID_FORMAT`, `API_KEY_INVALID`, `API_KEY_REVOKED`, `API_KEY_EXPIRED`) |
| `InsufficientCreditsError` | 402 | every priced endpoint pre-flight reserves the charge before doing any work; `required`, `balance`, `shortfall`, `wallet`, `walletOwner` (`"user"` \| `"org"`), and either `topUpUrl` or `contactAdmin: true` (never both) |
| `PermissionError` | 403 | org/account state, a plan limit (`callsToday`/`maxAllowed`), or a tier/feature restriction (`apiCode`/`upgradeUrl`/`tier`, for example `API_NOT_AVAILABLE_ON_TRIAL`, `API_TIER_NOT_ALLOWED`, `SEMANTIC_NOT_ALLOWED`, `LIVE_FETCH_NOT_ALLOWED`, `REMOTE_FETCH_NOT_ALLOWED`, `PARTY_SCREEN_LIMIT_REACHED`) |
| `NotFoundError` | 404 | `apiCode`: `CASE_NOT_FOUND` or `PDF_NOT_STORED` on the pdf endpoint |
| `RequestTimeoutError` | 408 | server side OpenSearch timeout, or the SDK's own client side timeout |
| `RateLimitError` | 429 | `retryAfter`/`retryAfterSeconds` (seconds), `resetTime` (ISO string), and `apiCode` (`RATE_LIMITED`, `CONCURRENT_ANALYSIS_LIMIT`, or a daily/monthly cap code like `DISTINCT_NAMES_LIMIT_REACHED`) |
| `ServerError` | 500 | |
| `BadGatewayError` | 502 | also `PARTY_SCREEN_SEARCH_DEGRADED` - the underlying case search itself errored and returned nothing usable, retry |
| `ServiceUnavailableError` | 503 | `apiCode: "ENTITLEMENT_UNAVAILABLE"` when account standing could not be verified |

Every error class exposes `apiCode` (the server's `code` field verbatim, when sent) and `requestId` (echoed once the API's request-id middleware ships). `API_REFUSAL_CODES` is exported as a runtime object mirroring the server's own refusal codes (`ApiRefusalCode` is the matching type), for comparing against `error.apiCode` without hand-typing string literals:

```ts
if (error instanceof PermissionError && error.apiCode === API_REFUSAL_CODES.SEMANTIC_NOT_ALLOWED) {
  // ...
}
```

### Retries

By default the client retries, with exponential backoff plus jitter:

- a 429 whose `code` is `RATE_LIMITED` or `CONCURRENT_ANALYSIS_LIMIT` - never a daily or monthly cap code (`DISTINCT_NAMES_LIMIT_REACHED`, `LIVE_FETCH_LIMIT_REACHED`, `DISTINCT_CASES_LIMIT_REACHED`, `PDF_LIMIT_REACHED`, `TOO_MANY_KEYS_FROM_IP`), since those will not clear before the advertised delay anyway;
- for a **GET** request only: a 502, 503 or 504 response, or a network level failure (a read timeout is never retried, on either method).

`maxRetries` defaults to 3.

**POST requests are not retried after they have reached the network** (a network error, a read timeout, or a 502/503/504 response) unless you opt in with `retryPosts: true` (client-wide) or per call. This is deliberate: a POST that may have already been received and acted on server side (analyze, party/screen, and similar) risks a double charge or a duplicate job if retried blindly. A 429 is not gated by `retryPosts` - it is a pre-flight refusal, so no work was done regardless of method.

For a 429, the delay is chosen in this order:

1. The `Retry-After` response header, if a proxy in front of the API sets one.
2. The JSON body's `retryAfter` field, in seconds (this is what the CourtMesh API itself sends today).
3. Exponential backoff with jitter, the same fallback used for 502, 503, 504 and network errors.

That delay is capped at `maxRetryAfterSeconds` (default 60). A daily or monthly cap can advertise a `Retry-After` of up to a day - when the advertised delay exceeds the cap, the SDK does not sleep and retry: it raises `RateLimitError` immediately, with `retryAfterSeconds` set to the real (uncapped) delay, so you can decide for yourself whether to wait that long.

### Timeouts

Per endpoint defaults, since some run far longer server side than a typical call: `semanticSearch` 630s, `requestTimeline` 240s, `analyzeConsolidated` 300s, `screenParty` 90s, everything else 30s. Override per call:

```ts
await client.screenParty(options, { timeoutMs: 120_000 });
```

A client side timeout does not cancel the request server side and never triggers a refund.

## Caveats (from the live API behaviour, not SDK bugs)

- **`getCasePdf`'s `pdfUrl` is ciphertext, not a fetchable URL.** Decrypting it uses a case specific key and is outside this API surface.

## Publishing

These are the exact commands a human runs, they are not automated by this SDK or any script in this repository.

```bash
# One time: point the local repo at your GitHub remote.
git remote add origin git@github.com:<your-org>/courtmesh-node.git
git push -u origin main

# Build and publish to npm.
npm run build
npm publish --access public
```

## License

MIT, Thinkscoop Technologies LLP. See `LICENSE`.
