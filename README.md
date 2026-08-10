# @courtmesh/sdk

Official TypeScript SDK for the CourtMesh Enterprise API. Ships dual ESM and CommonJS builds with full type definitions, uses the global `fetch` (Node 18+), and has zero runtime dependencies.

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
  maxRetries: 3,     // default, retry attempts after the first try
  timeoutMs: 30000,  // default, per request AbortController timeout, 0 disables it
  fetch: myFetch,    // default: global fetch, override for testing or custom transports
});
```

## Rate limit

The API allows 10 requests per minute per API key. Exceeding it returns HTTP 429 with a `retryAfter` field, in seconds, and a `resetTime` ISO timestamp. This SDK retries 429 automatically (see below), but if you are issuing many requests in a script, throttle client side to stay under the limit rather than relying on retries alone.

## Endpoint examples

### 1. `searchJudges`, `GET /judges/search`

```ts
const { data, meta } = await client.searchJudges({ q: "khanna" });
// data: string[] of judge names, at most 50
console.log(meta?.totalMatches);
```

### 2. `searchCases`, `POST /search/cases`

Keyword search over the OpenSearch index.

```ts
const { data, meta, pagination } = await client.searchCases({
  query: "arbitration clause",
  court: "Delhi High Court",
  year: 2023,
  fromDate: "2023-01-01",
  toDate: "2023-12-31",
  page: 1,
  limit: 20,
});
// data: SearchHit[], raw OpenSearch hits with _id, _score, _sort plus indexed fields
console.log(pagination.total, pagination.hasMore);
```

### 3. `semanticSearch`, `POST /search/cases/semantic`

Vector search, billed as an AI interaction. Use the `filters` object, not the top level fields, to actually constrain results (see Caveats below).

```ts
const result = await client.semanticSearch({
  query: "landlord failed to return security deposit",
  limit: 10,
  filters: {
    court: "Delhi High Court",
    caseYear: 2023,
    decisionDate: { $gte: "2022-01-01" },
  },
});
// data: CaseListItem[] on the normal path, or SearchHit[] on the filter-only fallback path
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

### 8. `analyzeCase`, `POST /cases/{id}/analyze`

Asynchronous. Poll `getCase` after 30 to 60 seconds, then call `getCaseAnalysis`.

```ts
const { data } = await client.analyzeCase("64f0c2...");
if ("alreadyExists" in data) {
  console.log(data.analysis);
} else {
  console.log(data.status); // "processing"
}

// Force a re-run of an existing analysis.
await client.analyzeCase("64f0c2...", { force: true });
```

### 9. `analyzeConsolidated`, `POST /cases/{id}/analyze-consolidated`

Synchronous and slow, it analyses the case plus related documents.

```ts
const { data, meta } = await client.analyzeConsolidated("64f0c2...");
console.log(data.status, data.consolidatedAnalysis.outcome, meta?.relatedCases);
```

### 10. `requestTimeline`, `POST /request-timeline`

`caseId` must be a Mongo ObjectId string.

```ts
const { data } = await client.requestTimeline("64f0c2...");
console.log(data.requestId, data.status);
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

## Pagination

`iterSearchCases` and `iterSemanticSearch` are async generators that walk pages automatically, yielding one page of results at a time. They stop when a page comes back empty, or when `pagination.hasMore` is false. Both have a built in safety guard of 10000 pages to prevent runaway loops.

```ts
for await (const page of client.iterSearchCases({ query: "arbitration clause", limit: 50 })) {
  for (const hit of page) {
    console.log(hit._id, hit.title);
  }
}

for await (const page of client.iterSemanticSearch({ query: "landlord deposit dispute", limit: 20 })) {
  console.log(page.length, "results in this page");
}
```

Note the two pagination shapes are different. `searchCases` returns `{ total, hasMore, page?, limit, nextCursor }`, `page` is absent when a `searchAfter` cursor was used, and there is no `totalPages`. `semanticSearch` returns `{ page, limit, total, totalPages, hasMore }`, and `total`/`totalPages` are estimates except on the last page.

## Error handling

Every error the SDK throws for a failed request extends `CourtMeshError` and carries `statusCode`, `message`, and the raw parsed response `body`.

```ts
import {
  CourtMeshClient,
  isCourtMeshError,
  ValidationError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  RequestTimeoutError,
  RateLimitError,
  ServerError,
  BadGatewayError,
  ServiceUnavailableError,
} from "@courtmesh/sdk";

try {
  await client.getCase("does-not-exist");
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log("no such case");
  } else if (error instanceof RateLimitError) {
    console.log("retry after", error.retryAfter, "seconds, resets at", error.resetTime);
  } else if (isCourtMeshError(error)) {
    console.log(error.code, error.statusCode, error.message, error.body);
  } else {
    throw error;
  }
}
```

| Class | Status | Notes |
|---|---|---|
| `ValidationError` | 400 | `details` carries the server's field level messages when present |
| `AuthenticationError` | 401 | missing, malformed, unknown or deactivated API key |
| `PermissionError` | 403 | org/account state, or a plan limit, `callsToday`/`maxAllowed` when applicable |
| `NotFoundError` | 404 | |
| `RequestTimeoutError` | 408 | server side OpenSearch timeout, or the SDK's own client side timeout |
| `RateLimitError` | 429 | `retryAfter` (seconds) and `resetTime` (ISO string) |
| `ServerError` | 500 | |
| `BadGatewayError` | 502 | |
| `ServiceUnavailableError` | 503 | |

`RequestTimeoutError`, `RateLimitError`, `ServerError`, `BadGatewayError` and `ServiceUnavailableError` correspond to statuses the SDK also retries automatically (429, 502, 503, 504) before giving up and throwing, see below.

### Retries

The client retries 429, 502, 503 and 504 responses, and network level failures, with exponential backoff plus jitter. `maxRetries` defaults to 3.

For a 429, the delay is chosen in this order:

1. The `Retry-After` response header, if a proxy in front of the API sets one.
2. The JSON body's `retryAfter` field, in seconds (this is what the CourtMesh API itself sends today).
3. Exponential backoff with jitter, the same fallback used for 502, 503, 504 and network errors.

## Caveats (from the live API behaviour, not SDK bugs)

- **`caseNumber` on `POST /search/cases` is accepted and echoed back in `meta.filters`, but it is never applied to the search.** Use `query` or another filter to narrow by case number today.
- **`sortBy` on `POST /search/cases` only meaningfully supports `"relevance"`.** The field validates `"relevance" | "date"`, but the search backend underneath expects `"relevance" | "recent" | "oldest"`, so `"date"` does not sort as you would expect.
- **`POST /search/cases/semantic` ignores its top level filter fields** (`court`, `caseType`, `caseNumber`, `judgeName`, `judges`, `judge`, `year`, `fromDate`, `toDate`). They are validated but never read by the handler. Use the `filters` object instead, whose recognised keys are `court`, `caseType`, `caseYear`, `caseNumber`, `judgeName` (also `judges`/`judge`), `decisionDate: { $gte, $lte }`, `practiceArea`, `sourceCaseId`.
- **`semanticSearch` can return HTTP 200 with a failed request.** The handler starts writing the response before it knows the vector search will succeed, so failures after that point (`Failed to generate query embedding`, `Vector search failed`, `Failed to fetch results from search API`) still arrive as HTTP 200 with `{ success: false, error }`. This SDK checks the `success` field for you and throws in that case, but if you call the API directly, check `success`, not just the status code.
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
