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

Keyword search across Indian court records. `caseNumber` is applied server side (one value; an array's first element is used). `sortBy` accepts `"relevance" | "recent" | "oldest"`, plus the deprecated alias `"date"` (resolved to `"recent"`, with a note in `meta.warnings`).

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

Paging past the first screen: pass the previous page's `pagination.nextCursor` back as `cursor` (a signed, opaque string); an invalid or query-mismatched cursor throws `ValidationError` with `apiCode: "CURSOR_INVALID"`. `iterSearchCases` (see Pagination below) does this for you, including the legacy array-shaped `nextCursor`.

### 3. `semanticSearch`, `POST /search/cases/semantic`

AI search by meaning, billed as an AI interaction. **Not available on the Free tier**: throws `PermissionError` with `apiCode: "SEMANTIC_NOT_ALLOWED"` before any work or charge. The top level filter fields, whatever the query's natural language implies, and the `filters` object are all merged, weakest first in that order; `filters` (the AI search's own filter keys) always wins on overlap.

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

`id` may be a 24 character hexadecimal case id or a case number.

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
// data.pdfUrl is a fetchable link: no API key, no decryption, no credits.
console.log(data.expiresIn); // 3600
```

Failure codes: `CASE_NOT_FOUND` (404), `CASE_RESTRICTED` (403), `PDF_NOT_STORED` (404, no stored document; `POST /request-timeline` with `refresh: true` may fetch one for High Court and District Court cases).

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

`caseId` must be the 24 character hexadecimal case id. `refresh: true` forces a live court-portal fetch instead of serving the last stored read. Both cost 1 credit, and `meta.liveFetch` says which one actually happened; `data.liveFetchSupported` comes back `false` when the case's court has no live refresh at all. Not available on the Free tier (`LIVE_FETCH_NOT_ALLOWED`, 403) and capped per day per tier (`LIVE_FETCH_LIMIT_REACHED`, 429).

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

No auth required, not enveloped in `data`.

```ts
const status = await client.health();
console.log(status.status, status.version);
```

### 13. `screenParty`, `POST /party/screen`

Screens a person or company name against the case law corpus for litigation, insolvency and other court records. Requires an API key. Costs 100 credits when matches are found, 20 when none are, plus a flat surcharge only when `result.data.adjudicationsRun > 0`; requesting `adjudicate: true` does not by itself guarantee a model call happened (every candidate may already have been decided deterministically), so it does not by itself bill the surcharge either. `adjudicate: true` is not available on the Free tier (`API_TIER_NOT_ALLOWED`, 403).

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

Verdict semantics: `matches_found` describes what was found internally, independent of `displayThreshold`; raising the threshold can leave `matches` empty (`summary.matchCount: 0`) while the verdict is still `matches_found`. `since` forces `inconclusive` (it is a best-effort filter, so completeness can never be certified either way). `no_matches_found` is only ever returned when `coverage.exhaustive` is true and nothing was withheld.

**DPDP note.** `purpose` is required on every call and is the only thing about the query the server retains in its logs, `name`, `aliases`, `knownPersons`, `identifiers` and `address` are never logged. The results are drawn entirely from public court records, they are not sourced from or cross-checked against any private database. **A screen is not an identity check**: it tells you whether a name (optionally narrowed by identifiers, address or known associates) appears in litigation or insolvency records, it does not verify who a person or company actually is. `notice` in the response links the case removal / takedown policy; `coverage.someRecordsWithheld` is `true` when one or more otherwise-matching cases were removed from the results because they are under a takedown order.

### 14. `coverage`, `GET /coverage`

Corpus coverage and freshness stats: totals, by court type, by year, per court, and a rolled up District Courts row. No API key is required, this SDK sends one anyway when the client is configured with one. Server side cached for up to 6 hours.

```ts
const { data } = await client.coverage();
console.log(data.total);
for (const court of data.courts) {
  console.log(court.court, court.records, court.latestDecisionDate, court.businessDaysBehind);
}
console.log(data.districtCourts.records);
```

## Case depth and refresh by CNR

```ts
// Hearing history and advocates, at no extra charge. Either can be null when we hold no such record.
const record = await client.getCase(id, { include: ["hearings", "advocates"] });

// The documents of a case, then the stored text of one. 2 credits when text comes back, free when it does not.
const { data } = await client.listCaseOrders(id);
const row = data.documents.find((d) => d.textAvailable);
if (row) {
  const text = await client.getCaseDocumentText(id, row.id);
  console.log(text.data.text);
}

// Refresh by CNR: answers at once. 1 credit when queued, 0 for every other status.
await client.refreshCaseByCnr("ZZAB010000012024");
const state = await client.getCaseRefreshState("ZZAB010000012024"); // free

// Up to 50 CNRs in one call, a status for each.
const batch = await client.refreshCasesBatch(["ZZAB010000012024", "ZZAB010000022024"]);
```

Not every order has readable text, and how many do varies by court and by age, so read `textAvailable` rather than assuming. Calls that return text count against a monthly allowance (`ORDER_TEXT_LIMIT_REACHED`). A refresh charged on acceptance is not refunded if the court fetch later fails.

## CNR lookup and case monitoring

Look a case up by CNR (any common spelling works), or watch a list of CNRs and be told when something changes. Tracking is free within your plan's watch cap; you pay only for reading the change feed (1 credit per non-empty page of up to 100 events) and for CNR lookups (1 credit per record returned).

```ts
import { CourtMeshClient, normalizeCnr } from "@courtmesh/sdk";

const client = new CourtMeshClient({ apiKey: process.env.COURTMESH_API_KEY });

normalizeCnr("CNR: ZZAB-01-000001-2024"); // "ZZAB010000012024", or null if it cannot be a CNR

// One-off lookup. fetch: true starts a live fetch for a CNR we do not hold yet.
// The starting call returns "pending" and is free; poll the same call (same CNR) until "found".
// A CNR we do not hold and did not fetch throws NotFoundError (CASE_NOT_FOUND). So does fetch: true
// for a CNR the court portal had nothing for in the last 24 hours: it is not asked again until that passes.
const lookup = await client.getCaseByCnr("ZZAB010000012024", { fetch: true });
console.log(lookup.data.status); // "found" | "pending"

// 1. Watch a CNR.
const wl = await client.createWatchlist({
  name: "Loan book",
  items: [{ cnr: "ZZAB010000012024", reference: "LOAN-42" }],
});
console.log(wl.data.id, wl.data.results); // per item: watching | pending | invalid | duplicate | cap_exceeded | not_found

// 2. Poll /changes. Store nextCursor and pass it back next time.
let cursor: string | undefined = loadCursorFromYourStore();
const page = await client.listChanges({ cursor, types: ["case.hearing_date_changed", "case.order_added"] });
for (const event of page.data) {
  console.log(event.type, event.cnr, event.data);
}
saveCursorToYourStore(page.pagination.nextCursor); // returned even when the page is empty

// Or walk everything until caught up.
for await (const events of client.iterChanges({ since: "2026-11-01T00:00:00Z" })) {
  for (const event of events) handle(event);
}
```

### Receive webhooks

Create an endpoint (https only). The `secret` is shown once, so store it.

```ts
const hook = await client.createWebhook({ url: "https://example.com/hooks/courtmesh" });
console.log(hook.data.secret); // whsec_...
console.log(hook.data.events); // the full default list of case.* types when you send none; watchlistIds is [] (all lists)
await client.testWebhook(hook.data.id); // sends a webhook.test event now (one attempt, no retries, even if the endpoint is switched off)
```

Verify every delivery with the RAW request body. Express example:

```ts
import express from "express";
import { verifyWebhookSignature, WebhookSignatureError } from "@courtmesh/sdk";

const app = express();

app.post("/hooks/courtmesh", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = verifyWebhookSignature(req.body, req.header("CourtMesh-Signature"), process.env.COURTMESH_WEBHOOK_SECRET!);
  } catch (err) {
    if (err instanceof WebhookSignatureError) return res.status(400).send("bad signature");
    throw err;
  }
  // Delivery is at least once: dedupe on event.id (also sent as the CourtMesh-Event-Id header).
  console.log(event.type, event.cnr);
  res.sendStatus(200); // any 2xx within 10 seconds counts as delivered
});
```

`verifyWebhookSignature(rawBody, header, secret, { toleranceSeconds = 300 })` rejects a timestamp more than 300 seconds from now, computes HMAC-SHA256 over `"<t>.<rawBody>"` and compares in constant time against every `v1=` value in the header (two during a 24 hour secret rotation). Pass an array of secrets to cover your side of a rotation. It returns the parsed event or throws `WebhookSignatureError`. It uses `node:crypto`, so it is for server runtimes.

Each attempt has a 10 second deadline and reads at most 64 KB of your response. Failed deliveries are retried after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and 24 h. A delivery that could not be attempted within 24 hours is marked `failed` with `lastError: "expired"` instead of being sent. Use `listWebhookDeliveries(id)` to inspect attempts and `retryWebhookDelivery(id, deliveryId)` to re-send one.

### What the change feed sends

- Dates are `YYYY-MM-DD` on the Indian calendar. A court's year 9999 "no date" is returned as `null`.
- `case.tracking_started` is sent once the first fresh refresh of the case completes, carrying the fresh snapshot, not at the moment you add the CNR (a record that is already current sends it at add time). A CNR we fetched live for you sends it as soon as the case lands.
- A burst of new orders announces only the newest 20, oldest first. An order dated more than 7 days before you started watching is never announced.
- A case taken down at a party's request shows as an `unavailable` item (`caseId`, `court`, `title`, `snapshot`, `lastCheckedAt` and `lastChangedAt` are `null`) and sends no events. Adding a CNR that is already taken down returns `not_found`.
- Cursors are opaque and ordered by an internal sequence. `since` is converted to a position once; keep using the `nextCursor` you get back.

### Monitoring methods

| Method | Endpoint | Credits |
|---|---|---|
| `getCaseByCnr(cnr, { fetch })` | `GET /cases/by-cnr/{cnr}` | 1 when a record is returned (`pending` and `not_found` are free; with `fetch`, the starting call is free and the poll that returns the record is the one charge) |
| `searchCases({ cnr })` | `POST /search/cases` | as search (returns one ordinary search hit; progress fields and `orderCount` are only on `getCaseByCnr`) |
| `createWatchlist`, `getWatchlist`, `updateWatchlist`, `deleteWatchlist` | `/watchlists` | 0 |
| `listWatchlists` / `iterWatchlists` | `GET /watchlists` | 0 |
| `addWatchlistItems`, `removeWatchlistItem` | `/watchlists/{id}/items` | 0 |
| `listWatchlistItems` / `iterWatchlistItems` | `GET /watchlists/{id}/items` | 0 |
| `listChanges` / `iterChanges` | `GET /changes` | 1 per non-empty page |
| `listWatchlistEvents` / `iterWatchlistEvents` | `GET /watchlists/{id}/events` | 1 per non-empty page |
| `createWebhook`, `getWebhook`, `updateWebhook`, `deleteWebhook`, `rotateWebhookSecret`, `testWebhook` | `/webhooks` | 0 |
| `listWebhooks` / `iterWebhooks` | `GET /webhooks` | 0 |
| `listWebhookDeliveries` / `iterWebhookDeliveries`, `retryWebhookDelivery` | `/webhooks/{id}/deliveries` | 0 |

Watch caps per account (distinct CNRs across all watchlists, so the same CNR on two lists uses one slot): Free 10, Pay As You Go 1,000, Scale 10,000, Enterprise by contract. Two daily limits apply to adding, counted per Indian calendar day, and items over either come back as `cap_exceeded` with a message: every add that results in a watched or pending item counts toward a daily add allowance (Free 50, Pay As You Go 5,000, Scale 50,000, Enterprise 500,000), and adding CNRs we do not hold yet starts a live fetch, so those also have their own daily limit (Free 20, Pay As You Go 500, Scale 5,000, Enterprise unlimited). A Supreme Court CNR we do not hold comes back `not_found` at once. If the court portal had nothing for a CNR in the last 24 hours, adding it again is `not_found` with a message and starts no new fetch (the same cooldown makes `getCaseByCnr(..., { fetch: true })` throw `NotFoundError`). `not_found`, `error` and `unavailable` items still count toward the cap until removed. At most 50 watchlists and 10 webhook endpoints per account. `WATCH_CAP_EXCEEDED` (403) is thrown only when the cap is already full and you sent a new CNR. Webhook delivery history is kept 30 days and events 90 days; an event appears in the feed about 2 seconds after it is created. New error codes surface as typed errors with `apiCode` set: `INVALID_CNR`, `WATCHLIST_NOT_FOUND`, `WEBHOOK_NOT_FOUND`, `DELIVERY_NOT_FOUND`, `WATCH_CAP_EXCEEDED`, `WATCHLIST_LIMIT_REACHED`, `WEBHOOK_LIMIT_REACHED`, `INVALID_WEBHOOK_URL`, `ITEM_NOT_FOUND` (removing a CNR that is not in the list). API keys need the `monitoring:read` and `monitoring:write` scopes (keys without explicit scopes have full access). Cause list calls need the `causelist` scope.

## Cause lists

Read the hearing listings found for your matters, read the published list of a court you have a matter in, and check whether CNRs you watch appear on a stored list. All calls need an API key with the `causelist` scope and an account with cause lists enabled.

```ts
// Listings found for your matters. Default range: today and the next 7 days. At most 31 days.
const first = await client.listCauseListings({ from: "2026-11-05", to: "2026-11-12", limit: 50 });
console.log(first.data, first.pagination); // { page, limit, total, totalPages, hasMore }

// Walk every page (pages start at 1; each page is one call).
for await (const listings of client.iterCauseListings({ from: "2026-11-05", to: "2026-11-12" })) {
  for (const listing of listings) console.log(listing.date, listing.courtKey, listing.caseText);
}

// One matter. matterId is the 24 character id.
const one = await client.listMatterCauseListings("66f1a2b3c4d5e6f7a8b9c0d1");
console.log(one.data.matter, one.data.listings);

// The published list of one court on one date. courtKey comes from a listing.
const court = await client.getCourtCauseList({ courtKey: "DC:99:1:9900001:1:1", date: "2026-11-05" });
console.log(court.data.status, court.data.complete, court.data.rows.length);

// Check CNRs you watch (1 to 100). Default range: today and tomorrow. At most 7 days.
const check = await client.checkCauseLists({ cnrs: ["ZZAB010000012024", "ZZAB010000022024"] });
for (const r of check.data.results) console.log(r.cnr, r.status, r.reason, r.listings);
console.log(check.data.summary, check.meta?.creditsCharged);
```

`from` and `to` are sent together or not at all. Dates, `matterId` and `courtKey` are checked before a request is sent and a bad value throws `ValidationError`. `courtKey` is `SC`, `HC:<state>:<bench>` or `DC:<state>:<district>:<complex>:<establishment>:<court number>`, digits only.

| Method | Endpoint | Credits |
|---|---|---|
| `listCauseListings` / `iterCauseListings` | `GET /cause-lists/listings` | 1 per successful call |
| `listMatterCauseListings(matterId)` | `GET /matters/{matterId}/cause-listings` | 1 per successful call |
| `getCourtCauseList({ courtKey, date })` | `GET /cause-lists/court` | 1 when `status` is `ok` or `partial`; 0 for `none`, `empty`, `not_published`, `invalid_court` and `unavailable` |
| `checkCauseLists({ cnrs, from, to })` | `POST /cause-lists/check` | 1 per CNR with status `listed` or `no_entry_found`; 0 for the rest |

`checkCauseLists` never contacts a court: it reads lists already held, and it takes an `Idempotency-Key` like the other POST calls. Each result has one of these statuses:

| Status | Meaning | Credits |
|---|---|---|
| `listed` | A row of this case was found. `listings` holds the rows. | 1 |
| `no_entry_found` | A list was read and no row was recognised. This does not show the case is not listed: `dates[].complete` says how much of each list was read. | 1 |
| `list_not_read` | No list was held for the dates. For a District Court it can also mean the list of the case's own courtroom could not be confirmed (`dates[].status` is then `none`). | 0 |
| `cannot_check` | `reason` says why: `pending`, `record_unavailable`, `court_not_supported`, or a court identification reason (`no_case_identity`, `no_court_key`, `no_court_number`, `invalid_court_key`, `unsupported_court`). `courtKey` can be null. | 0 |
| `not_watched` | Your account does not watch this CNR. | 0 |

Only listings that were found are reported. An empty result is not a statement that a case is absent from a list, so confirm against the court's own list when it matters. At most 100 CNRs, and distinct CNRs (repeats are ignored) times dates in the range (inclusive; 2 by default) at most 300, checked before a request is sent (`ValidationError`). The call also needs at least 1 credit available when it starts: a balance below the number of watched CNRs in the call throws `InsufficientCreditsError`. The same error can arrive after the answer is ready, when the credits due cannot be settled; no results are returned then. A `ServiceUnavailableError` with `apiCode` `SETTLEMENT_UNCONFIRMED` means the answer was ready but the charge outcome is unknown and no results were returned: it is never retried automatically, even with `retryPosts`, so check your balance with `usage()` first; repeating the call with the same `Idempotency-Key` is refused with 409 `IDEMPOTENCY_IN_PROGRESS` for up to 24 hours. A 503 `ENTITLEMENT_UNAVAILABLE` ran nothing and is safe to retry. A listing's `matchedBy` is `cnr`, `diary`, `key` or `related_key`; `caseText` and `courtKey` can be null. `data.from` and `data.to` give the dates that were looked at, including when you sent none. A temporary outage throws `BadGatewayError` (`UPSTREAM_UNAVAILABLE`) and is not charged; GET calls are retried, and the check call is retried only when `retryPosts` is on (it then sends an `Idempotency-Key`). An account without cause list access throws `PermissionError` (`CAUSE_LISTS_NOT_ENABLED`); an unknown matter or a court without an open matter of yours throws `NotFoundError`.

## Acts and sections

Read Indian statutes: find an act, read a provision with its amendment notes, follow what replaced a repealed law, and list judgments that cite a provision. These calls need the `legislation` scope. Each costs 1 credit when it returns something and nothing when it returns nothing. Text is the statute as published. Repeal status is on every act and provision, so check `repealed` (acts) and `actRepealed` or `repealedProvision` (provisions) before relying on one.

```ts
import { CourtMeshClient } from "@courtmesh/sdk";

const client = new CourtMeshClient({ apiKey: process.env.COURTMESH_API_KEY });

// "section 302 IPC" to the provision it names. A lettered section keeps its letter.
const found = await client.lookupSection("section 302 IPC");
const { section, ambiguous } = found.data.matches[0]!; // ambiguous is true when no act was named
console.log(section.actRepealed, section.actRepealNote);

// The full text, then judgments citing exactly this provision.
const text = await client.getActSection(section.actSlug, section.slug);
console.log(text.data.text);

for await (const page of client.iterSectionCitingCases(section.actSlug, section.slug)) {
  for (const c of page) console.log(c.id, c.title, c.decisionDate);
}
```

Methods: `searchActs`, `resolveAct`, `getAct`, `getActHistory`, `listActSections`, `getActSection`, `listSectionCitingCases` (with the `iterSectionCitingCases` generator), `searchSections`, `lookupSection`.

The citing list ends at your plan's pagination depth, and it is not exhaustive: an empty list does not mean no judgment applied the provision, and `listAvailable: false` means judgments cannot be listed for that provision. It matches the exact provision only, so a search for section 302 of the Penal Code does not return judgments that cite only its successor. Some matters are never listed: `listAvailable` is false for a provision we do not list judgments for, including sexual offences and cruelty provisions. A page can hold fewer rows than `limit`, or none, while `pagination.hasMore` is true, so keep following `pagination.nextCursor` (it is opaque); `iterSectionCitingCases` does this for you. `getActHistory` is at act level: it lists what repealed an act and what amended it, and does not map old sections to new ones. "Order VII Rule 11 CPC" style citations are not resolved by `lookupSection` and return no match.

An unknown act slug throws `NotFoundError` with `apiCode` `ACT_NOT_FOUND`, and an unknown provision throws it with `SECTION_NOT_FOUND`. Neither is charged. A temporary failure listing citing judgments throws `BadGatewayError` (`UPSTREAM_UNAVAILABLE`); it is free and safe to retry. `searchActs`, `resolveAct`, `searchSections`, `lookupSection` and `listSectionCitingCases` have a lower per minute limit than other calls and are refused with 429 (`RateLimitError`) above it.

## Party profile

`buildPartyProfile` takes everything `screenParty` does and returns the cases grouped into identities, with each case's court, bench, status, next hearing, acts and FIR as the court record states them, and the documents held for it. `purpose` is required, as on `screenParty`, and the same DPDP note applies. Not available on the Free tier.

```ts
import { isPartyProfileAccepted } from "@courtmesh/sdk";

// Quick mode: the profile in one answer.
const quick = await client.buildPartyProfile({
  name: "Ravi Example",
  entityType: "person",
  purpose: "due_diligence",
  knownPersons: ["Mohan Example"],
  address: { state: "Example State" },
  mode: "quick",
});
if (!isPartyProfileAccepted(quick.data)) {
  console.log(quick.data.verdict, quick.data.summary, quick.data.notes);
  for (const c of quick.data.identities[0]?.cases ?? []) {
    console.log(c.cnr, c.court, c.status, c.nextHearingDate, c.courtRecordActs, c.courtRecordFir);
  }
  console.log(quick.meta?.creditsCharged, quick.meta?.creditsBreakdown);
}

// Full mode: answers at once with a requestId; the work runs behind it.
const accepted = await client.buildPartyProfile({
  name: "Example Works Private Limited",
  entityType: "company",
  purpose: "bgv",
  identifiers: { cin: "U00000ZZ2020PTC000001" },
  mode: "full",
  maxCredits: 500,
});
if (isPartyProfileAccepted(accepted.data)) {
  const status = await client.getPartyProfileRequest(accepted.data.requestId); // free
  console.log(status.data.status, status.data.stage, status.data.credits.charged);
  if (status.data.status === "completed") console.log(status.data.result?.partyAnalysis);
}
```

Send `mode` explicitly: the server defaults to `full` where full mode is available. Pricing, as the API describes it:

- **Quick mode** is metered, at least 100 credits per profile even when no case is found. Above that: 1 credit per internal search call (at most 24), 1 per case record read and 1 per documents listing that offers a document (at most 100 cases are enriched), plus each AI review call priced by its tokens when `adjudicate: true` (never above an 80 credit allowance). One call never costs more than 304 credits. `meta.creditsBreakdown` itemises the charge.
- **Full mode** costs nothing to accept or to read. It is then charged by actual usage, stage by stage: the search stage at the rates above, 1 credit per court refresh started (retries are free), each case analysis by its tokens, each reused analysis at the price of reading a stored analysis, and the party analysis by its tokens. `maxCredits` (100 to 5000, default 1000 or your balance if lower) is the most a request may spend, and the balance must cover it when the request is accepted.

A short balance throws `InsufficientCreditsError` before anything runs. Full mode where it is not available throws `ServiceUnavailableError` (`PARTY_PROFILE_FULL_UNAVAILABLE`), and a fourth full profile while 3 are queued or running throws `RateLimitError` (`PARTY_PROFILE_TOO_MANY_ACTIVE`); neither is retried automatically. With `retryPosts`, the call sends an `Idempotency-Key` and is retried, but a 503 is retried only when it refused before any work (`ACCOUNT_STANDING_UNAVAILABLE`, `ENTITLEMENT_UNAVAILABLE`). Any other 503 means the charge outcome may be unknown: check `usage()` before sending it again. Poll `getPartyProfileRequest` every few seconds to a minute; a result can be read for 30 days. Pass `webhook: { url, headers }` to be told when a full profile ends; the `202` answer carries `webhook.signingSecret` once, so store it.

## Deleting audit activity

`deleteAuditActivityBefore` deletes the calling API key's own activity before a time. **This cannot be undone.** Those calls are no longer listed by `audit()`, and the request details kept with them (what was sent, IP address, user agent) are erased. Other keys on the account are not touched. What you were charged stays on your invoices, balance and usage totals. Needs the `account` scope, like `audit()`. Free.

```ts
const res = await client.deleteAuditActivityBefore({ before: "2026-11-05T00:00:00Z" });
console.log(res.data.removed, res.data.complete);
// complete is false when part is left: call it again with the same `before` to finish.
```

`before` is a full date and time with `Z` or an offset (or a `Date`), not in the future. This call is never retried automatically once it may have reached the server (a network error, a timeout or a 5xx), because the outcome is then unknown: read `audit()` to see where it stands before calling it again. A 429 `RATE_LIMITED` refusal is still retried, since nothing ran.

## Pagination

`iterSearchCases` and `iterSemanticSearch` are async generators that walk pages automatically, yielding one page of results at a time. They stop when a page comes back empty, or when `pagination.hasMore` is false. Both have a built in safety guard of 10000 pages to prevent runaway loops. Default page size is 20 for both (also the Free tier's own `maxPageSize`; do not request more than your tier allows, see `PAGE_LIMIT_EXCEEDED` below).

`iterSearchCases` is cursor-first: once a page's `pagination.nextCursor` comes back as a signed string, it is passed back as `cursor` on the next call rather than incrementing `page`. On the legacy path (`nextCursor` comes back as a raw array instead), it walks pages via `searchAfter` instead; either way you do not have to branch on the shape.

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

Note the two pagination shapes are different. `searchCases` returns `{ total, hasMore, page?, limit, nextCursor }`, `page` is absent once cursor pagination has taken over, there is no `totalPages`, and `nextCursor` is a signed opaque string or a legacy raw array, never mix the two mechanisms in one request. `semanticSearch` returns `{ page, limit, total, totalPages, hasMore }`, and `total`/`totalPages` are estimates except on the last page.

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
| `ValidationError` | 400, 413 | `details` for a field-level validation failure; `apiCode`/`limit`/`tier` for `PAGE_LIMIT_EXCEEDED`/`PAGINATION_DEPTH_EXCEEDED`; `apiCode: "CURSOR_INVALID"` for a bad pagination cursor; `PayloadTooLargeError` (413) is a subclass for a request body over the size limit |
| `AuthenticationError` | 401 | missing, malformed, unknown, revoked or expired API key (`apiCode`: `API_KEY_MISSING`, `API_KEY_INVALID_FORMAT`, `API_KEY_INVALID`, `API_KEY_REVOKED`, `API_KEY_EXPIRED`) |
| `InsufficientCreditsError` | 402 | every priced endpoint pre-flight reserves the charge before doing any work; `required`, `balance`, `shortfall`, `wallet`, `walletOwner` (`"user"` \| `"org"`), and either `topUpUrl` or `contactAdmin: true` (never both) |
| `PermissionError` | 403 | org/account state, a plan limit (`callsToday`/`maxAllowed`), or a tier/feature restriction (`apiCode`/`upgradeUrl`/`tier`, for example `API_NOT_AVAILABLE_ON_TRIAL`, `API_TIER_NOT_ALLOWED`, `SEMANTIC_NOT_ALLOWED`, `LIVE_FETCH_NOT_ALLOWED`, `REMOTE_FETCH_NOT_ALLOWED`, `PARTY_SCREEN_LIMIT_REACHED`) |
| `NotFoundError` | 404 | `apiCode`: `CASE_NOT_FOUND` or `PDF_NOT_STORED` on the pdf endpoint; `ACT_NOT_FOUND` or `SECTION_NOT_FOUND` on the acts endpoints |
| `RequestTimeoutError` | 408 | the server took too long to answer, or the SDK's own client side timeout |
| `RateLimitError` | 429 | `retryAfter`/`retryAfterSeconds` (seconds), `resetTime` (ISO string), and `apiCode` (`RATE_LIMITED`, `CONCURRENT_ANALYSIS_LIMIT`, or a daily/monthly cap code like `DISTINCT_NAMES_LIMIT_REACHED`) |
| `ServerError` | 500 | |
| `BadGatewayError` | 502 | also `PARTY_SCREEN_SEARCH_DEGRADED`; the underlying case search itself errored and returned nothing usable, retry |
| `ServiceUnavailableError` | 503 | `apiCode: "ENTITLEMENT_UNAVAILABLE"` when account standing could not be verified (safe to retry). `apiCode: "SETTLEMENT_UNCONFIRMED"` on `checkCauseLists`: the charge outcome is unknown, never retried automatically, check your balance first |

Every error class exposes `apiCode` (the server's `code` field verbatim, when sent) and `requestId` (when the API sends one). `API_REFUSAL_CODES` is exported as a runtime object mirroring the server's own refusal codes (`ApiRefusalCode` is the matching type), for comparing against `error.apiCode` without hand-typing string literals:

```ts
if (error instanceof PermissionError && error.apiCode === API_REFUSAL_CODES.SEMANTIC_NOT_ALLOWED) {
  // ...
}
```

### Retries

By default the client retries, with exponential backoff plus jitter:

- a 429 whose `code` is `RATE_LIMITED` or `CONCURRENT_ANALYSIS_LIMIT`; never a daily or monthly cap code (`DISTINCT_NAMES_LIMIT_REACHED`, `LIVE_FETCH_LIMIT_REACHED`, `DISTINCT_CASES_LIMIT_REACHED`, `PDF_LIMIT_REACHED`, `TOO_MANY_KEYS_FROM_IP`), since those will not clear before the advertised delay anyway;
- for a **GET** request only: a 502, 503 or 504 response, or a network level failure (a read timeout is never retried, on either method).

`maxRetries` defaults to 3.

**POST requests are not retried after they have reached the network** (a network error, a read timeout, or a 502/503/504 response) unless you opt in with `retryPosts: true` (client-wide) or per call. This is deliberate: a POST that may have already been received and acted on server side (analyze, party/screen, and similar) risks a double charge or a duplicate job if retried blindly. A 429 is not gated by `retryPosts`; it is a pre-flight refusal, so no work was done regardless of method.

For a 429, the delay is chosen in this order:

1. The `Retry-After` response header, if present.
2. The JSON body's `retryAfter` field, in seconds (this is what the CourtMesh API itself sends today).
3. Exponential backoff with jitter, the same fallback used for 502, 503, 504 and network errors.

That delay is capped at `maxRetryAfterSeconds` (default 60). A daily or monthly cap can advertise a `Retry-After` of up to a day; when the advertised delay exceeds the cap, the SDK does not sleep and retry: it raises `RateLimitError` immediately, with `retryAfterSeconds` set to the real (uncapped) delay, so you can decide for yourself whether to wait that long.

### Timeouts

Per endpoint defaults, since some run far longer server side than a typical call: `semanticSearch` 630s, `requestTimeline` 240s, `analyzeConsolidated` 300s, `screenParty` 90s, everything else 30s. Override per call:

```ts
await client.screenParty(options, { timeoutMs: 120_000 });
```

A client side timeout does not cancel the request server side and never triggers a refund.

## Releasing

Maintainers: see [RELEASING.md](RELEASING.md).

## License

MIT, Thinkscoop Technologies LLP. See `LICENSE`.
