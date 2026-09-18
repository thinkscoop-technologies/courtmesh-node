import { CourtMeshError, isRetryable429Code, mapStatusToError, RateLimitError } from "./errors.js";
import type {
  AnalyzeCaseMeta,
  AnalyzeCaseOptions,
  AnalyzeCaseResult,
  AnalyzeConsolidatedMeta,
  AnalyzeConsolidatedOptions,
  AnalyzeConsolidatedResult,
  ApiResponse,
  AuditOptions,
  AuditResponse,
  CaseAnalysis,
  CaseDetails,
  CaseListItem,
  CaseTypeEntry,
  CourtHierarchy,
  CoverageData,
  CoverageMeta,
  GetCaseAnalysisMeta,
  GetCaseMeta,
  GetPdfMeta,
  GetTimelineMeta,
  HealthResponse,
  KeywordSearchPagination,
  MeData,
  PartyScreenBatchMeta,
  PartyScreenBatchOptions,
  PartyScreenBatchResult,
  PartyScreenMeta,
  PartyScreenOptions,
  PartyScreenResult,
  PdfResponse,
  ReferenceCaseTypesResponse,
  ReferenceCourtsResponse,
  RelatedMeta,
  RelatedResponse,
  RequestTimelineMeta,
  RequestTimelineOptions,
  RequestTimelineResult,
  SearchCasesMeta,
  SearchCasesOptions,
  SearchCasesResponse,
  SearchHit,
  SearchJudgesMeta,
  SearchJudgesOptions,
  SemanticSearchMeta,
  SemanticSearchOptions,
  SemanticSearchPagination,
  SemanticSearchResponse,
  TimelineJob,
  UsageData,
  UsageMeta,
} from "./types.js";

/** A fetch compatible function, this is what the `fetch` option and the global `fetch` both satisfy. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CourtMeshClientOptions {
  /** Defaults to the `COURTMESH_API_KEY` environment variable when running under Node. */
  apiKey?: string;
  /** Defaults to `https://research.courtmesh.ai/api/v1/prod`. */
  baseUrl?: string;
  /** Maximum number of retry attempts for retryable failures. Defaults to 3. */
  maxRetries?: number;
  /**
   * Per request timeout in milliseconds, enforced with AbortController.
   * Defaults to 30000, except on the endpoints with their own longer default
   * (semantic search: 630000, request-timeline: 240000,
   * analyze-consolidated: 300000, party screen: 90000 - all run far longer
   * server side than a typical call).
   * Set to 0 to disable. Overridable per call via that method's
   * `requestOptions.timeoutMs`. A client side timeout does not cancel the
   * request server side and never triggers a refund - the call may still
   * complete (and be billed) after the SDK has already thrown.
   */
  timeoutMs?: number;
  /**
   * Allow retrying a POST request after it has already reached the network
   * (a read timeout, a network error, or a 502/503/504 response) (R3).
   * Default false: a POST that may have already been received and acted on
   * server side is not retried automatically, to avoid double charging or
   * double running a job (analyze, party/screen, and similar). A 429
   * response is a pre-flight refusal - no work was done - so it is retried
   * regardless of this setting, subject to `isRetryable429Code`.
   * Overridable per call via that method's `requestOptions.retryPosts`.
   */
  retryPosts?: boolean;
  /**
   * Caps how long this client will wait on a `Retry-After`/`retryAfter` it
   * is honouring for a 429, in seconds. Default 60 (R1). When the
   * advertised delay is longer than this (a daily or monthly cap can carry a
   * `Retry-After` of up to a day), the SDK does not sleep and retry: it
   * raises `RateLimitError` immediately, with `retryAfterSeconds` set to the
   * real (uncapped) delay the server advertised, so the caller can decide
   * for itself whether to wait that long.
   */
  maxRetryAfterSeconds?: number;
  /** Inject a custom fetch implementation, primarily for testing. Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** Per call override of the client's request behaviour for one request. */
export interface RequestConfig {
  /** Overrides the client's default timeout (or this endpoint's own default) for this one call. */
  timeoutMs?: number;
  /** Overrides the client's `retryPosts` default for this one call. Meaningless on a GET. */
  retryPosts?: boolean;
  /**
   * Only meaningful on `screenParty`, `screenPartyBatch`, `analyzeCase`,
   * `analyzeConsolidated` and `requestTimeline` - the five endpoints that
   * accept an `Idempotency-Key` header. 1 to 128 characters,
   * `[A-Za-z0-9_.-]`, scoped per API key for 24 hours: a replayed call with
   * the same key and the same body returns the stored 2xx response again
   * (`response.replayed` is then `true`) with no new charge; the same key
   * with a *different* body throws `ValidationError` with
   * `apiCode === "IDEMPOTENCY_KEY_REUSED"`.
   *
   * When omitted, and `retryPosts` (this call's override, or the client's
   * own default) is in effect for this call, the SDK generates a random
   * UUID v4 for you, so an automatic retry of this exact call is always
   * safe from a double charge or a double-run job. When `retryPosts` is
   * not in effect either, no key is generated or sent - use it explicitly
   * whenever you also intend to retry a call yourself (for example across
   * separate process runs).
   */
  idempotencyKey?: string;
}

const DEFAULT_BASE_URL = "https://research.courtmesh.ai/api/v1/prod";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 60;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const MAX_BACKOFF_MS = 30000;
const BASE_BACKOFF_MS = 500;

/**
 * Per endpoint request timeout defaults (R4), in milliseconds. Endpoints not
 * listed here use the client's general `timeoutMs` (default 30000).
 */
const ENDPOINT_TIMEOUT_MS = {
  semanticSearch: 630_000,
  requestTimeline: 240_000,
  analyzeConsolidated: 300_000,
  screenParty: 90_000,
} as const;

/** The maximum number of pages an async iterator will walk before it gives up as a safety guard. */
const MAX_ITERATOR_PAGES = 10000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(attempt: number): number {
  const capped = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  const jitter = Math.random() * capped * 0.5;
  return capped + jitter;
}

/** The advertised retry delay for a 429, in whole seconds: the `Retry-After` header if present and valid, else the JSON body's `retryAfter` field. `undefined` when neither is present, meaning "the server did not tell us how long to wait." */
function extractAdvertisedRetryAfterSeconds(response: Response, body: unknown): number | undefined {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return seconds;
    }
  }
  if (isRecord(body) && typeof body.retryAfter === "number" && body.retryAfter >= 0) {
    return body.retryAfter;
  }
  return undefined;
}

function extractErrorMessage(body: unknown, status: number): string {
  if (isRecord(body)) {
    if (typeof body.message === "string" && body.message.length > 0) {
      return body.message;
    }
    if (typeof body.error === "string" && body.error.length > 0) {
      return body.error;
    }
  }
  return `Request failed with status ${status}`;
}

function extractApiCode(body: unknown): string | undefined {
  return isRecord(body) && typeof body.code === "string" ? body.code : undefined;
}

/**
 * A random UUID v4, used to auto-generate an `Idempotency-Key` when a caller
 * has opted into `retryPosts` but did not supply their own key (see
 * `RequestConfig.idempotencyKey`). Prefers the standard `crypto.randomUUID`
 * (available in Node 18+ and every modern browser); falls back to a manual
 * RFC 4122 v4 implementation on a runtime without it.
 */
function generateIdempotencyKey(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: <T extends Uint8Array>(array: T) => T } }).crypto;
  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (globalCrypto?.getRandomValues) {
    globalCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** No `Authorization` header, for `GET /health`. */
  skipAuth?: boolean;
  /** Per call timeout override. Falls back to the endpoint default, then the client's own `timeoutMs`. */
  timeoutMs?: number;
  /** Per call override of the client's `retryPosts` default. */
  retryPosts?: boolean;
  /** Sent as the `Idempotency-Key` header when present. See `RequestConfig.idempotencyKey`. */
  idempotencyKey?: string;
}

/**
 * Client for the CourtMesh API.
 *
 * Uses the global `fetch`, no runtime dependencies. Retries a 429 whose
 * `code` is `RATE_LIMITED` or `CONCURRENT_ANALYSIS_LIMIT` (never a daily or
 * monthly cap code, see `isRetryable429Code`) and, for GET requests only by
 * default, 502/503/504 responses and network level failures - all with
 * exponential backoff and jitter unless the server advertised its own delay
 * via `Retry-After` or the JSON body's `retryAfter`. See `retryPosts` on
 * `CourtMeshClientOptions` to also retry POST requests, and
 * `maxRetryAfterSeconds` for the cap on how long a 429 is retried
 * automatically before the SDK gives up and throws instead of waiting.
 */
export class CourtMeshClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly retryPosts: boolean;
  private readonly maxRetryAfterSeconds: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: CourtMeshClientOptions = {}) {
    this.apiKey = options.apiKey ?? readEnvApiKey();
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryPosts = options.retryPosts ?? false;
    this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS;

    const injected = options.fetch ?? (typeof fetch === "function" ? (fetch as FetchLike) : undefined);
    if (!injected) {
      throw new Error(
        "No fetch implementation is available. Run under Node 18+, or provide one via the `fetch` option.",
      );
    }
    this.fetchImpl = injected;
  }

  /* ---------------------------------------------------------------------- */
  /* 1. GET /judges/search                                                  */
  /* ---------------------------------------------------------------------- */

  async searchJudges(options: SearchJudgesOptions = {}): Promise<ApiResponse<string[], SearchJudgesMeta>> {
    return this.request<ApiResponse<string[], SearchJudgesMeta>>({
      method: "GET",
      path: "/judges/search",
      query: { q: options.q },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 2. POST /search/cases                                                  */
  /* ---------------------------------------------------------------------- */

  async searchCases(options: SearchCasesOptions, requestOptions: RequestConfig = {}): Promise<SearchCasesResponse> {
    const response = await this.request<SearchCasesResponse>({
      method: "POST",
      path: "/search/cases",
      body: options,
      timeoutMs: requestOptions.timeoutMs,
      retryPosts: requestOptions.retryPosts,
    });
    return response;
  }

  /**
   * Walks `POST /search/cases` page by page, yielding one page of hits at a
   * time. Stops when a page comes back empty or `pagination.hasMore` is
   * false. Default page size is 20 (also the Free tier's own cap; higher
   * tiers allow more, but 20 is a safe default for every tier).
   *
   * Cursor-first: once a page's `pagination.nextCursor` comes back, it is
   * passed back as `cursor` on the next call (the current, self-serve
   * pagination mechanism) rather than incrementing `page`. If the account
   * is on the legacy path instead, `nextCursor` comes back as a raw array
   * and this walks it via `searchAfter` instead - either way, you never have
   * to branch on which shape your account gets. `PAGE_LIMIT_EXCEEDED` and
   * `PAGINATION_DEPTH_EXCEEDED` surface as a typed `ValidationError`, same as
   * calling `searchCases` directly.
   */
  async *iterSearchCases(options: SearchCasesOptions): AsyncGenerator<SearchHit[], void, unknown> {
    const limit = options.limit ?? 20;
    let page = options.page ?? 1;
    let cursor = options.cursor;
    let searchAfter = options.searchAfter;

    for (let i = 0; i < MAX_ITERATOR_PAGES; i++) {
      const usingCursor = typeof cursor === "string" && cursor.length > 0;
      const response = await this.searchCases({
        ...options,
        limit,
        page: usingCursor ? undefined : page,
        cursor,
        searchAfter: usingCursor ? undefined : searchAfter,
      });
      const data = response.data ?? [];
      if (data.length === 0) {
        return;
      }
      yield data;
      if (!response.pagination.hasMore) {
        return;
      }

      const nextCursor = response.pagination.nextCursor;
      if (typeof nextCursor === "string" && nextCursor.length > 0) {
        // Current, self-serve mechanism: hand the signed cursor straight back.
        cursor = nextCursor;
        searchAfter = undefined;
      } else if (Array.isArray(nextCursor) && nextCursor.length > 0) {
        // Legacy path: continue via a JSON-encoded searchAfter instead.
        cursor = undefined;
        searchAfter = JSON.stringify(nextCursor);
        page += 1;
      } else {
        cursor = undefined;
        page += 1;
      }
    }

    throw new Error(
      `iterSearchCases exceeded the safety guard of ${MAX_ITERATOR_PAGES} pages. This usually means ` +
        "the server keeps reporting hasMore: true without making progress.",
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 3. POST /search/cases/semantic                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Defensive fallback only: the server sends a proper non-200 status for a
   * semantic search failure today (`sendSemanticFailure`,
   * `routes/api-v1-prod.ts`), so this branch should never trigger in
   * practice. It stays as a belt-and-braces check in case a future response
   * ever starts streaming before failing.
   */
  async semanticSearch(
    options: SemanticSearchOptions,
    requestOptions: RequestConfig = {},
  ): Promise<SemanticSearchResponse> {
    const json = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/search/cases/semantic",
      body: options,
      timeoutMs: requestOptions.timeoutMs ?? ENDPOINT_TIMEOUT_MS.semanticSearch,
      retryPosts: requestOptions.retryPosts,
    });

    if (json.success === false) {
      throw new CourtMeshError(extractErrorMessage(json, 200), "server_error", 200, json);
    }

    return json as unknown as SemanticSearchResponse;
  }

  /**
   * Walks `POST /search/cases/semantic` page by page, yielding one page of
   * results at a time. Stops when a page comes back empty or
   * `pagination.hasMore` is false.
   */
  async *iterSemanticSearch(
    options: SemanticSearchOptions,
  ): AsyncGenerator<Array<CaseListItem | SearchHit>, void, unknown> {
    const limit = options.limit ?? 20;
    let page = options.page ?? 1;

    for (let i = 0; i < MAX_ITERATOR_PAGES; i++) {
      const response = await this.semanticSearch({ ...options, page, limit });
      const data = response.data ?? [];
      if (data.length === 0) {
        return;
      }
      yield data;
      if (!response.pagination.hasMore) {
        return;
      }
      page += 1;
    }

    throw new Error(
      `iterSemanticSearch exceeded the safety guard of ${MAX_ITERATOR_PAGES} pages. This usually means ` +
        "the server keeps reporting hasMore: true without making progress.",
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 4. GET /cases/{id}                                                     */
  /* ---------------------------------------------------------------------- */

  async getCase(id: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<CaseDetails, GetCaseMeta>> {
    return this.request<ApiResponse<CaseDetails, GetCaseMeta>>({
      method: "GET",
      path: `/cases/${encodeURIComponent(id)}`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 5. GET /cases/{id}/analysis                                            */
  /* ---------------------------------------------------------------------- */

  async getCaseAnalysis(
    id: string,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<CaseAnalysis, GetCaseAnalysisMeta>> {
    return this.request<ApiResponse<CaseAnalysis, GetCaseAnalysisMeta>>({
      method: "GET",
      path: `/cases/${encodeURIComponent(id)}/analysis`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 6. GET /cases/{id}/related                                             */
  /* ---------------------------------------------------------------------- */

  async getRelated(
    id: string,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<RelatedResponse, RelatedMeta>> {
    return this.request<ApiResponse<RelatedResponse, RelatedMeta>>({
      method: "GET",
      path: `/cases/${encodeURIComponent(id)}/related`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 7. GET /cases/{id}/pdf                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * `PDF_NOT_STORED` (404) means no stored document exists for this case;
   * `POST /request-timeline` with `refresh: true` may fetch orders for High
   * Court and District Court cases (tribunal documents are not fetchable via
   * this API). `CASE_NOT_FOUND` (404) and `CASE_RESTRICTED` (403) are the
   * other two documented failure codes for this endpoint.
   */
  async getCasePdf(id: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<PdfResponse, GetPdfMeta>> {
    return this.request<ApiResponse<PdfResponse, GetPdfMeta>>({
      method: "GET",
      path: `/cases/${encodeURIComponent(id)}/pdf`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 8. POST /cases/{id}/analyze                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Starts (or reads back an already-complete) AI analysis for one case,
   * 202 Accepted, processed in the background. `allowRemoteFetch: true` is
   * required when the case has no stored document and can only be analyzed
   * by fetching it from an external URL - see `AnalyzeCaseOptions`.
   */
  async analyzeCase(
    id: string,
    options: AnalyzeCaseOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<AnalyzeCaseResult, AnalyzeCaseMeta>> {
    return this.request<ApiResponse<AnalyzeCaseResult, AnalyzeCaseMeta>>({
      method: "POST",
      path: `/cases/${encodeURIComponent(id)}/analyze`,
      body: { force: options.force ?? false, ...(options.allowRemoteFetch ? { allowRemoteFetch: true } : {}) },
      timeoutMs: requestOptions.timeoutMs,
      retryPosts: requestOptions.retryPosts,
      idempotencyKey: this.resolveIdempotencyKey(requestOptions),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 9. POST /cases/{id}/analyze-consolidated                              */
  /* ---------------------------------------------------------------------- */

  async analyzeConsolidated(
    id: string,
    options: AnalyzeConsolidatedOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<AnalyzeConsolidatedResult, AnalyzeConsolidatedMeta>> {
    return this.request<ApiResponse<AnalyzeConsolidatedResult, AnalyzeConsolidatedMeta>>({
      method: "POST",
      path: `/cases/${encodeURIComponent(id)}/analyze-consolidated`,
      body: { force: options.force ?? false },
      timeoutMs: requestOptions.timeoutMs ?? ENDPOINT_TIMEOUT_MS.analyzeConsolidated,
      retryPosts: requestOptions.retryPosts,
      idempotencyKey: this.resolveIdempotencyKey(requestOptions),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 10. POST /request-timeline                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Requests (or reads back a cached) order/document timeline for a case.
   * `options.refresh: true` forces a live court-portal fetch instead of
   * serving the last stored read - see `RequestTimelineOptions`. The
   * response's `meta.liveFetch` says which one actually happened, and
   * `data.liveFetchSupported` comes back `false` when this case's court does
   * not support a live refresh at all.
   */
  async requestTimeline(
    caseId: string,
    options: RequestTimelineOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<RequestTimelineResult, RequestTimelineMeta>> {
    return this.request<ApiResponse<RequestTimelineResult, RequestTimelineMeta>>({
      method: "POST",
      path: "/request-timeline",
      body: { case_id: caseId, ...(options.refresh ? { refresh: true } : {}) },
      timeoutMs: requestOptions.timeoutMs ?? ENDPOINT_TIMEOUT_MS.requestTimeline,
      retryPosts: requestOptions.retryPosts,
      idempotencyKey: this.resolveIdempotencyKey(requestOptions),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 11. GET /get-timeline/{requestId}                                     */
  /* ---------------------------------------------------------------------- */

  async getTimeline(
    requestId: string,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<TimelineJob, GetTimelineMeta>> {
    return this.request<ApiResponse<TimelineJob, GetTimelineMeta>>({
      method: "GET",
      path: `/get-timeline/${encodeURIComponent(requestId)}`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 13. POST /party/screen                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Screens a person or company name against the case law corpus for
   * litigation, insolvency and related court records. Requires an API key.
   *
   * Costs 100 credits when matches are found, 20 when none are, plus a flat
   * surcharge only when `result.adjudicationsRun > 0` (requesting
   * `adjudicate: true` alone does not guarantee a model call happened, and
   * does not by itself bill the surcharge - see `PartyScreenOptions.adjudicate`
   * and `PartyScreenResult.adjudicationsRun`). See the DPDP note in the
   * README: `purpose` is required, results are public court records, and a
   * screen is not an identity check. Every priced endpoint including this
   * one pre-flight reserves the charge before doing any work: a shortfall
   * throws `InsufficientCreditsError` (402) before the screen runs.
   */
  async screenParty(
    options: PartyScreenOptions,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<PartyScreenResult, PartyScreenMeta>> {
    return this.request<ApiResponse<PartyScreenResult, PartyScreenMeta>>({
      method: "POST",
      path: "/party/screen",
      body: options,
      timeoutMs: requestOptions.timeoutMs ?? ENDPOINT_TIMEOUT_MS.screenParty,
      retryPosts: requestOptions.retryPosts,
      idempotencyKey: this.resolveIdempotencyKey(requestOptions),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 14. GET /coverage                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Corpus coverage and freshness stats: totals, by court type, by year,
   * per court, and a rolled up District Courts row. No API key is
   * required, this SDK sends one anyway when the client is configured
   * with one. Server side cached for up to 6 hours.
   */
  async coverage(requestOptions: RequestConfig = {}): Promise<ApiResponse<CoverageData, CoverageMeta>> {
    return this.request<ApiResponse<CoverageData, CoverageMeta>>({
      method: "GET",
      path: "/coverage",
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 15. GET /usage                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Reports this API key's tier, wallet balance, per period limits and per
   * endpoint call volume for the current Asia/Kolkata calendar month.
   * Unmetered like every other account introspection call - checking your
   * own usage never itself burns a credit.
   */
  async usage(requestOptions: RequestConfig = {}): Promise<ApiResponse<UsageData, UsageMeta>> {
    return this.request<ApiResponse<UsageData, UsageMeta>>({
      method: "GET",
      path: "/usage",
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 16. GET /health?deep=1                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Check API health. No auth required, not rate limited beyond the public
   * health limiter.
   *
   * The plain form (`deep` omitted or false) is a cheap liveness probe: no
   * dependency calls, always fast, always HTTP 200 while the process is up.
   * Pass `deep: true` to also check Mongo, OpenSearch, Qdrant, Redis and IAM
   * standing (each bounded to 1s) - `status` then also reports `"degraded"`,
   * and HTTP 503 (`status: "unhealthy"`) when a hard dependency (Mongo or
   * OpenSearch) is down. Unlike every other endpoint, the response is not
   * enveloped in `data`.
   */
  async health(options: { deep?: boolean } = {}, requestOptions: RequestConfig = {}): Promise<HealthResponse> {
    return this.request<HealthResponse>({
      method: "GET",
      path: "/health",
      query: options.deep ? { deep: "1" } : undefined,
      skipAuth: true,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 17. GET /me                                                           */
  /* ---------------------------------------------------------------------- */

  /** The calling account's own id, email, name, role and (if any) organization id. */
  async me(requestOptions: RequestConfig = {}): Promise<ApiResponse<MeData, undefined>> {
    return this.request<ApiResponse<MeData, undefined>>({
      method: "GET",
      path: "/me",
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 18. GET /audit                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Fetches this API key's own logged calls (or, for an org admin, an
   * organization's), with summary stats and a top-endpoints breakdown.
   * Exactly one of `organizationId`/`userId` should be supplied; supplying
   * a `userId` other than your own, or an `organizationId` you do not
   * belong to, throws `PermissionError`.
   */
  async audit(options: AuditOptions = {}, requestOptions: RequestConfig = {}): Promise<AuditResponse> {
    return this.request<AuditResponse>({
      method: "GET",
      path: "/audit",
      query: {
        organizationId: options.organizationId,
        userId: options.userId,
        limit: options.limit,
        offset: options.offset,
        startDate: options.startDate,
        endDate: options.endDate,
      },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 19. GET /reference/courts                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * The court taxonomy accepted by `court` filters elsewhere in this API:
   * the 4 court types, courts per type, and display names per court. No
   * API key required. Cached for 1 hour server side (`ETag`/`Cache-Control`),
   * this SDK does not send `If-None-Match` itself.
   */
  async referenceCourts(requestOptions: RequestConfig = {}): Promise<ReferenceCourtsResponse> {
    return this.request<ReferenceCourtsResponse>({
      method: "GET",
      path: "/reference/courts",
      skipAuth: !this.apiKey,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 20. GET /reference/case-types                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Every `caseType` value accepted elsewhere in this API, deduplicated by
   * code and sorted. No API key required, same caching as
   * `referenceCourts`.
   */
  async referenceCaseTypes(requestOptions: RequestConfig = {}): Promise<ReferenceCaseTypesResponse> {
    return this.request<ReferenceCaseTypesResponse>({
      method: "GET",
      path: "/reference/case-types",
      skipAuth: !this.apiKey,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 21. POST /party/screen/batch                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Screens up to 25 names in one call. Each item is independently priced
   * and can independently fail without failing the whole batch - check
   * `ok` on each entry in `data.results`. Not available on the Free tier.
   * LLM adjudication is not supported here (`adjudicate` may only be
   * `false`/omitted); use `screenParty` one at a time for that. See
   * `screenParty` for the DPDP note: `purpose` is required and is the only
   * thing about the query the server retains in its logs.
   */
  async screenPartyBatch(
    options: PartyScreenBatchOptions,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<PartyScreenBatchResult, PartyScreenBatchMeta>> {
    return this.request<ApiResponse<PartyScreenBatchResult, PartyScreenBatchMeta>>({
      method: "POST",
      path: "/party/screen/batch",
      body: options,
      timeoutMs: requestOptions.timeoutMs ?? ENDPOINT_TIMEOUT_MS.screenParty,
      retryPosts: requestOptions.retryPosts,
      idempotencyKey: this.resolveIdempotencyKey(requestOptions),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private buildHeaders(hasBody: boolean, skipAuth: boolean, idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!skipAuth && this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }
    return headers;
  }

  /**
   * Resolves the `Idempotency-Key` to send for one of the five
   * idempotency-aware POST methods: the caller's own explicit key, else an
   * auto-generated UUID v4 when `retryPosts` is in effect for this call
   * (the per-call override, falling back to the client's own default), else
   * `undefined` (no header sent).
   */
  private resolveIdempotencyKey(requestOptions: RequestConfig): string | undefined {
    if (requestOptions.idempotencyKey) return requestOptions.idempotencyKey;
    const retryPosts = requestOptions.retryPosts ?? this.retryPosts;
    return retryPosts ? generateIdempotencyKey() : undefined;
  }

  private async request<T>(opts: RequestOptions): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    const maxAttempts = this.maxRetries + 1;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    // R3: a POST is only retried after it has reached the network (a network
    // error, a read timeout, or a 502/503/504 response) when this call, or
    // the client, opted in. A 429 is not gated by this - see below, it is a
    // pre-flight refusal, not evidence the request was ever processed.
    const canRetryAfterDispatch = opts.method === "GET" || (opts.retryPosts ?? this.retryPosts);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: opts.method,
          headers: this.buildHeaders(opts.body !== undefined, opts.skipAuth ?? false, opts.idempotencyKey),
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        if (timer) clearTimeout(timer);
        const aborted = isAbortError(error);
        if (!aborted && attempt < maxAttempts && canRetryAfterDispatch) {
          await delay(computeBackoffMs(attempt));
          continue;
        }
        if (aborted) {
          throw new CourtMeshError(`Request timed out after ${timeoutMs}ms`, "request_timeout", 408, undefined);
        }
        throw new CourtMeshError(
          error instanceof Error ? error.message : "Network request failed",
          "network_error",
          undefined,
          error,
        );
      }
      if (timer) clearTimeout(timer);

      const text = await response.text();
      let json: unknown;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      const headerRequestId = response.headers.get("x-request-id") ?? undefined;

      if (response.status === 429) {
        const apiCode = extractApiCode(json);
        const advertisedSeconds = extractAdvertisedRetryAfterSeconds(response, json);
        const retryableCode = isRetryable429Code(apiCode);
        const capExceeded = advertisedSeconds !== undefined && advertisedSeconds > this.maxRetryAfterSeconds;

        if (retryableCode && capExceeded) {
          // R1: do not sleep for longer than maxRetryAfterSeconds. Raise
          // immediately instead, with the real (uncapped) delay attached so
          // the caller can decide for itself whether to wait that long.
          const mapped = mapStatusToError(429, extractErrorMessage(json, 429), json, headerRequestId);
          if (mapped instanceof RateLimitError) {
            throw new RateLimitError(mapped.message, json, advertisedSeconds, mapped.resetTime, {
              apiCode: mapped.apiCode,
              requestId: mapped.requestId,
            });
          }
          throw mapped;
        }

        if (retryableCode && attempt < maxAttempts) {
          const delayMs = advertisedSeconds !== undefined ? advertisedSeconds * 1000 : computeBackoffMs(attempt);
          await delay(delayMs);
          continue;
        }

        // Not a retryable code (a daily/monthly cap, R2) or attempts are
        // exhausted: fall through to the generic throw below.
      } else if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxAttempts && canRetryAfterDispatch) {
        await delay(computeBackoffMs(attempt));
        continue;
      }

      if (!response.ok) {
        throw mapStatusToError(response.status, extractErrorMessage(json, response.status), json, headerRequestId);
      }

      if (isRecord(json)) {
        // Backfill requestId from the X-Request-Id header for every success
        // response that does not already carry one somewhere in its body
        // (some endpoints, e.g. GET /usage, set their own meta.requestId
        // directly - both can coexist, they are not in conflict).
        if (json.requestId === undefined && headerRequestId) {
          json.requestId = headerRequestId;
        }
        // Only the five idempotency-key-aware POST methods ever receive
        // this header, so this is a no-op on every other endpoint.
        const idempotencyReplayed = response.headers.get("idempotency-replayed");
        if (idempotencyReplayed && idempotencyReplayed.toLowerCase() === "true") {
          json.replayed = true;
        }
      }

      return json as T;
    }

    // Unreachable, the loop above always returns or throws, this satisfies the compiler.
    throw new CourtMeshError("Request failed after exhausting all retries.", "network_error", undefined, undefined);
  }
}

function readEnvApiKey(): string | undefined {
  if (typeof process === "undefined" || typeof process.env !== "object" || process.env === null) {
    return undefined;
  }
  return process.env.COURTMESH_API_KEY;
}
