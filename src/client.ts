import { CourtMeshError, isRetryable429Code, mapStatusToError, RateLimitError, ValidationError } from "./errors.js";
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
  GetCaseOptions,
  CaseDocuments,
  CaseDocumentText,
  CaseInclude,
  CnrRefreshBatch,
  CnrRefreshResult,
  CnrRefreshState,
  DeleteAuditActivityMeta,
  DeleteAuditActivityOptions,
  DeleteAuditActivityResult,
} from "./types.js";
import type {
  PartyProfileAccepted,
  PartyProfileMeta,
  PartyProfileOptions,
  PartyProfileRequestMeta,
  PartyProfileRequestStatus,
  PartyProfileResult,
} from "./party-profile.js";
import { normalizeCnr } from "./monitoring.js";
import {
  assertCheckBody,
  assertCourtListQuery,
  assertDateRange,
  assertMatterId,
  LISTINGS_MAX_DAYS,
} from "./cause-lists.js";
import type {
  CauseListCheckData,
  CauseListCourtList,
  CauseListingsResponse,
  CauseListing,
  CauseListMeta,
  CheckCauseListsOptions,
  GetCourtCauseListOptions,
  ListCauseListingsOptions,
  CauseListRangeOptions,
  MatterCauseListings,
} from "./cause-lists.js";
import type {
  ActHistoryResponse,
  ActResolutionResponse,
  ActResponse,
  ActSectionResponse,
  CitingCase,
  CitingCasesResponse,
  ListActSectionsOptions,
  ListActSectionsResponse,
  ListSectionCitingCasesOptions,
  SearchActsOptions,
  SearchActsResponse,
  SearchSectionsOptions,
  SearchSectionsResponse,
  SectionLookupResponse,
} from "./acts.js";
import type {
  AddWatchlistItemsResult,
  ChangeEvent,
  CnrLookupData,
  CreateWatchlistOptions,
  CreateWatchlistResult,
  CreateWebhookOptions,
  CursorListOptions,
  CursorListResponse,
  DeleteResult,
  GetCaseByCnrOptions,
  ListChangesOptions,
  ListWatchlistItemsOptions,
  UpdateWatchlistOptions,
  UpdateWebhookOptions,
  Watchlist,
  WatchlistItem,
  WatchlistItemInput,
  Webhook,
  WebhookDelivery,
  WebhookWithSecret,
} from "./monitoring.js";

/**
 * Injected at build time by tsup's `define` (see tsup.config.ts) from
 * package.json's `version`. Falls back to a literal below only when this
 * file is consumed unbuilt (for example a test importing straight from
 * `src/`), so `User-Agent` is never blank.
 */
declare const __SDK_VERSION__: string;
const SDK_VERSION = typeof __SDK_VERSION__ !== "undefined" ? __SDK_VERSION__ : "0.6.0";
/** Sent as `User-Agent` on every request so the server (and anyone reading a request log) can tell this SDK, and which version, made the call. */
const USER_AGENT = `courtmesh-node/${SDK_VERSION}`;

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
   * Only meaningful on the POST methods that accept an `Idempotency-Key`
   * header: `screenParty`, `screenPartyBatch`, `buildPartyProfile`, `analyzeCase`,
   * `analyzeConsolidated`, `requestTimeline`, `createWatchlist`,
   * `addWatchlistItems`, `createWebhook`, `checkCauseLists`. (`rotateWebhookSecret`,
   * `testWebhook` and `retryWebhookDelivery` accept the option too, but the
   * server does not deduplicate them.) 1 to 128 characters,
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
  buildPartyProfile: 90_000,
} as const;

/**
 * The 503 codes on `POST /party/profile` that refused before any work or
 * charge. Any other 503 on that call (including one whose debit outcome is
 * unknown) is never retried automatically, whatever `retryPosts` says.
 */
const PARTY_PROFILE_SAFE_503_CODES: ReadonlySet<string> = new Set([
  "ACCOUNT_STANDING_UNAVAILABLE",
  "ENTITLEMENT_UNAVAILABLE",
]);

/** Matches the `requestId` of a full party profile: `ppr_` and 32 lowercase hex characters. */
const PARTY_PROFILE_REQUEST_ID = /^ppr_[0-9a-f]{32}$/;

/** The maximum number of pages an async iterator will walk before it gives up as a safety guard. */
const MAX_ITERATOR_PAGES = 10000;

function includeQuery(include: readonly CaseInclude[] | undefined): { include: string } | undefined {
  return include?.length ? { include: include.join(",") } : undefined;
}

/** Canonical CNR when the input normalises, else the trimmed input so the server can answer `INVALID_CNR`. */
function cnrForRequest(cnr: string): string {
  return normalizeCnr(cnr) ?? String(cnr).trim();
}

function normalizeItem(item: WatchlistItemInput): WatchlistItemInput {
  return { ...item, cnr: cnrForRequest(item.cnr) };
}

function changesQuery(options: ListChangesOptions): Record<string, string | number | undefined> {
  return {
    cursor: options.cursor,
    since: options.since,
    types: Array.isArray(options.types) ? options.types.join(",") : options.types,
    cnr: options.cnr === undefined ? undefined : cnrForRequest(options.cnr),
    limit: options.limit,
  };
}

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
  method: "GET" | "POST" | "PATCH" | "DELETE";
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
  /**
   * When true, the request is never retried once it may have reached the
   * server (a network error, a timeout, or a 5xx), whatever the method or
   * `retryPosts` say. A 429 with a retryable code is still retried, since it
   * is a refusal before any work.
   */
  noRetryAfterDispatch?: boolean;
  /**
   * When set, a 503 is retried (subject to the other rules) only when its
   * `code` is in this set. Any other 503 is thrown at once.
   */
  retryable503Codes?: ReadonlySet<string>;
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
    const body: SearchCasesOptions =
      options.cnr === undefined ? options : { ...options, cnr: normalizeCnr(options.cnr) ?? options.cnr.trim() };
    const response = await this.request<SearchCasesResponse>({
      method: "POST",
      path: "/search/cases",
      body,
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
   * passed back as `cursor` on the next call (the current
   * pagination mechanism) rather than incrementing `page`. On the legacy path,
   * `nextCursor` comes back as a raw array
   * and this walks it via `searchAfter` instead - either way, you never have
   * to branch on the shape. `PAGE_LIMIT_EXCEEDED` and
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
        // Current mechanism: hand the signed cursor straight back.
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
   * semantic search failure today, so this branch should never trigger in
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

  /**
   * Pass `{ include: ["hearings", "advocates"] }` for hearing history and
   * advocates, at no extra charge. Either can come back `null` when we hold no
   * such record for this case, and empty when we hold it and it lists none.
   */
  async getCase(id: string, options: GetCaseOptions = {}): Promise<ApiResponse<CaseDetails, GetCaseMeta>> {
    return this.request<ApiResponse<CaseDetails, GetCaseMeta>>({
      method: "GET",
      path: `/cases/${encodeURIComponent(id)}`,
      query: includeQuery(options.include),
      timeoutMs: options.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* GET /cases/{id}/orders                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Lists the documents we hold for a case, newest first, with what is
   * available for each. Read `textAvailable` before asking for the text: not
   * every order has readable text. 1 credit.
   */
  async listCaseOrders(id: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<CaseDocuments>> {
    return this.request<ApiResponse<CaseDocuments>>({
      method: "GET",
      path: `/cases/${encodeURIComponent(id)}/orders`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* GET /cases/{id}/orders/{documentId}/text                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Reads the stored text of one document of a case. 2 credits when text is
   * returned; when we hold none, `data.textAvailable` is `false`, `data.text`
   * is `null` and the call is free. Calls that return text count against a
   * monthly allowance (`ORDER_TEXT_LIMIT_REACHED`). The text is machine read
   * from the court document, so check anything you rely on against the
   * original. Taken down and masked matters throw `PermissionDeniedError`
   * (`CASE_RESTRICTED`).
   */
  async getCaseDocumentText(
    id: string,
    documentId: string,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<CaseDocumentText>> {
    return this.request<ApiResponse<CaseDocumentText>>({
      method: "GET",
      path: `/cases/${encodeURIComponent(id)}/orders/${encodeURIComponent(documentId)}/text`,
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
   * Check API health. No auth required, rate limited by the public
   * health limiter.
   *
   * The plain form (`deep` omitted or false) is a cheap liveness probe: no
   * dependency calls, always fast, always HTTP 200 while the process is up.
   * Pass `deep: true` to also check each backing dependency's
   * standing (each bounded to 1s) - `status` then also reports `"degraded"`,
   * and HTTP 503 (`status: "unhealthy"`) when a hard dependency is
   * down. Unlike every other endpoint, the response is not
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
  /* DELETE /audit                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Permanently deletes this API key's own activity before `before`.
   * **This cannot be undone.** Those calls are no longer listed by `audit()`,
   * and the request details kept with them for your account (what was sent,
   * IP address, user agent) are erased. Only the calling key's own activity
   * is touched; other keys on the account are not. Needs the `account`
   * scope, like `audit()`. Free and unmetered. What you were charged stays
   * on your invoices, credit balance and usage totals.
   *
   * A large history is removed in parts: when `data.complete` is false, call
   * this again with the same `before` to finish.
   *
   * Never retried automatically once it may have reached the server (a
   * network error, a timeout or a 5xx): the outcome is then unknown, so read
   * `audit()` to see where it stands before you call it again. A 429
   * `RATE_LIMITED` refusal is still retried, since nothing ran.
   *
   * `before` must be a full date and time with `Z` or an offset (or a
   * `Date`), not in the future; otherwise `ValidationError`. A `Date` is sent
   * as its UTC ISO string. An invalid `Date` or an empty string throws
   * `ValidationError` before a request is sent.
   */
  async deleteAuditActivityBefore(
    options: DeleteAuditActivityOptions,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<DeleteAuditActivityResult, DeleteAuditActivityMeta>> {
    const raw = options?.before;
    let before: string;
    if (raw instanceof Date) {
      if (Number.isNaN(raw.getTime())) {
        throw new ValidationError("before must be a valid date and time.", undefined, undefined, undefined, undefined, {
          apiCode: "VALIDATION_ERROR",
        });
      }
      before = raw.toISOString();
    } else if (typeof raw === "string" && raw.trim().length > 0) {
      before = raw.trim();
    } else {
      throw new ValidationError(
        "before is required: a date and time with Z or an offset, for example 2026-11-05T00:00:00Z.",
        undefined,
        undefined,
        undefined,
        undefined,
        { apiCode: "VALIDATION_ERROR" },
      );
    }
    return this.request<ApiResponse<DeleteAuditActivityResult, DeleteAuditActivityMeta>>({
      method: "DELETE",
      path: "/audit",
      query: { before },
      timeoutMs: requestOptions.timeoutMs,
      noRetryAfterDispatch: true,
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
  /* POST /party/profile                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Builds a litigation profile of a person or company: everything
   * `screenParty` finds, grouped into identities, with each case's court,
   * bench, status, next hearing, acts and FIR as the court record states
   * them, and the documents held for it. Takes every `screenParty` option
   * plus `mode`, `maxCredits`, `webhook`, `minConfidence`, `include` and
   * `allowUnconfirmedPrimary`. `purpose` is required, as on `screenParty`.
   * Not available on the Free tier (`PermissionError`,
   * `apiCode === "API_TIER_NOT_ALLOWED"`).
   *
   * Two answers, told apart by `data`:
   * - `mode: "quick"`: the profile in one answer (`PartyProfileResult`).
   * - `mode: "full"`: a 202 with a `requestId` (`PartyProfileAccepted`); read
   *   the outcome with `getPartyProfileRequest`, or pass `webhook`. The
   *   server defaults to `full` where full mode is available, so send `mode`
   *   explicitly. Where full mode is not available, `mode: "full"` throws
   *   `ServiceUnavailableError` with
   *   `apiCode === "PARTY_PROFILE_FULL_UNAVAILABLE"` and nothing is charged.
   *   An account may have at most 3 full profiles queued or running at once
   *   (`RateLimitError`, `apiCode === "PARTY_PROFILE_TOO_MANY_ACTIVE"`, not
   *   retried automatically).
   *
   * Pricing (quick mode), as the API describes it: metered, at least 100
   * credits per profile even when no case is found. Above that, 1 credit per
   * internal search call (at most 24), 1 per case record read and 1 per
   * documents listing that offers a document (at most 100 cases are
   * enriched), plus each AI review call priced by its tokens (only with
   * `adjudicate: true`, never above an 80 credit allowance). One call never
   * costs more than 304 credits. `meta.creditsCharged` is what left the
   * wallet and `meta.creditsBreakdown` itemises it. The balance is checked
   * first against the most the request could cost; a short balance throws
   * `InsufficientCreditsError` and nothing runs. A refused or failed call
   * charges nothing.
   *
   * Pricing (full mode): accepting the request costs nothing. It is then
   * charged by actual usage, stage by stage: the search stage at the rates
   * above, 1 credit per court refresh started (retries are free), each case
   * analysis by its tokens, each reused analysis at the price of reading a
   * stored analysis, and the party analysis by its tokens. `maxCredits` (100
   * to 5000, server default 1000 or your balance if lower) is the most the
   * request may spend, and the balance must cover it when the request is
   * accepted.
   *
   * Retries: a POST is retried only with `retryPosts`, and then with an
   * `Idempotency-Key` (yours, or one generated for you). A 503 is retried
   * only when its `code` is `ACCOUNT_STANDING_UNAVAILABLE` or
   * `ENTITLEMENT_UNAVAILABLE` (refused before any work). Any other 503,
   * including one where the outcome of the debit is unknown, is thrown at
   * once: check `usage()` before you send the request again.
   */
  async buildPartyProfile(
    options: PartyProfileOptions,
    requestOptions: RequestConfig = {},
  ): Promise<
    ApiResponse<PartyProfileResult, PartyProfileMeta> | ApiResponse<PartyProfileAccepted, PartyProfileRequestMeta>
  > {
    return this.request<
      ApiResponse<PartyProfileResult, PartyProfileMeta> | ApiResponse<PartyProfileAccepted, PartyProfileRequestMeta>
    >({
      method: "POST",
      path: "/party/profile",
      body: options,
      timeoutMs: requestOptions.timeoutMs ?? ENDPOINT_TIMEOUT_MS.buildPartyProfile,
      retryPosts: requestOptions.retryPosts,
      idempotencyKey: this.resolveIdempotencyKey(requestOptions),
      retryable503Codes: PARTY_PROFILE_SAFE_503_CODES,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* GET /party/profile/{requestId}                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Where a full mode party profile stands: `status` (`queued`, `running`,
   * `completed`, `failed`), `stage` while running, `progress` counts and
   * `credits` charged so far. Once `status` is `completed`, `result` holds
   * the profile. A failed request carries `failure`. Free to call.
   *
   * Poll every few seconds to a minute; waiting for court refreshes can take
   * up to 25 minutes. Only the account that made the request can read it;
   * any other id throws `NotFoundError`. The result can be read for 30 days
   * after the request ends; after that `resultExpired` is true and only the
   * status, progress and credits remain.
   *
   * `requestId` must be the `ppr_` id from the 202 answer; anything else
   * throws `ValidationError` before a request is sent.
   */
  async getPartyProfileRequest(
    requestId: string,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<PartyProfileRequestStatus, PartyProfileRequestMeta>> {
    if (typeof requestId !== "string" || !PARTY_PROFILE_REQUEST_ID.test(requestId)) {
      throw new ValidationError(
        "requestId must be the requestId from the accepted profile: ppr_ followed by 32 lowercase hex characters.",
        undefined,
        undefined,
        undefined,
        undefined,
        { apiCode: "VALIDATION_ERROR" },
      );
    }
    return this.request<ApiResponse<PartyProfileRequestStatus, PartyProfileRequestMeta>>({
      method: "GET",
      path: `/party/profile/${encodeURIComponent(requestId)}`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 22. GET /cases/by-cnr/{cnr}                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Looks a case up by its CNR (any common spelling, normalised for you).
   * 1 credit, charged only when a record is returned.
   *
   * `data.status` is `found` (200, `data.case` holds the record), or
   * `pending` (202, a live fetch is running: poll this same call with the
   * same CNR; `data.requestId` is opaque and is not accepted by
   * `getTimeline`). A CNR that is not in the corpus and was not fetched
   * throws `NotFoundError` (`apiCode === "CASE_NOT_FOUND"`). A Supreme Court
   * CNR that is not in the corpus cannot be fetched live and throws it
   * straight away.
   *
   * Pass `{ fetch: true }` to start a live court portal fetch for a CNR we
   * do not hold yet. The call that starts the fetch returns `pending` and is
   * free; the poll that returns the record is the one 1 credit charge, and a
   * fetch the court portal cannot satisfy costs nothing. Fetches share the
   * daily live fetch cap with `requestTimeline({ refresh: true })`. If the
   * court portal had nothing for the CNR in the last 24 hours, `fetch: true`
   * does not call it again: it throws `NotFoundError` immediately.
   */
  async getCaseByCnr(
    cnr: string,
    options: GetCaseByCnrOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<CnrLookupData, GetCaseMeta>> {
    return this.request<ApiResponse<CnrLookupData, GetCaseMeta>>({
      method: "GET",
      path: `/cases/by-cnr/${encodeURIComponent(cnrForRequest(cnr))}`,
      query: options.fetch || options.include?.length
        ? { ...(options.fetch ? { fetch: true } : {}), ...includeQuery(options.include) }
        : undefined,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* POST /cases/by-cnr/{cnr}/refresh                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Queues a fresh read from the court and answers at once. A CNR we do not
   * hold yet is fetched too. `data.status === "queued"` costs 1 credit, charged
   * on acceptance; every other status costs 0, including `running` when a
   * refresh is already under way. Read progress with `getCaseRefreshState`.
   * Not available on the Free tier.
   */
  async refreshCaseByCnr(cnr: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<CnrRefreshResult>> {
    return this.request<ApiResponse<CnrRefreshResult>>({
      method: "POST",
      path: `/cases/by-cnr/${encodeURIComponent(cnrForRequest(cnr))}/refresh`,
      body: {},
      timeoutMs: requestOptions.timeoutMs,
      retryPosts: requestOptions.retryPosts,
      idempotencyKey: this.resolveIdempotencyKey(requestOptions),
    });
  }

  /**
   * Where a CNR's refresh stands. Free, and counts against the daily distinct
   * cases allowance, so poll a few at a time. `failed` when the latest attempt
   * gave up. Not available on the Free tier.
   */
  async getCaseRefreshState(cnr: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<CnrRefreshState>> {
    return this.request<ApiResponse<CnrRefreshState>>({
      method: "GET",
      path: `/cases/by-cnr/${encodeURIComponent(cnrForRequest(cnr))}/refresh`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* POST /cases/refresh/batch                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Refreshes up to 50 CNRs in one call and answers at once, with a `status`
   * for each. 1 credit per CNR that reaches `queued`; every other status costs
   * 0. When the daily live fetch allowance runs out the rest answer
   * `not_accepted` and `meta.truncated` is `true`.
   */
  async refreshCasesBatch(cnrs: string[], requestOptions: RequestConfig = {}): Promise<ApiResponse<CnrRefreshBatch>> {
    return this.request<ApiResponse<CnrRefreshBatch>>({
      method: "POST",
      path: "/cases/refresh/batch",
      body: { cnrs: cnrs.map(cnrForRequest) },
      timeoutMs: requestOptions.timeoutMs,
      retryPosts: requestOptions.retryPosts,
      idempotencyKey: this.resolveIdempotencyKey(requestOptions),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Watchlists                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Creates a watchlist, optionally with up to 100 CNRs to start watching.
   * The result carries one outcome per CNR in `data.results`; a partial
   * success is still a 200. Management calls are free.
   */
  async createWatchlist(
    options: CreateWatchlistOptions,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<CreateWatchlistResult>> {
    const body = options.items ? { ...options, items: options.items.map(normalizeItem) } : options;
    return this.postJson("/watchlists", body, requestOptions);
  }

  /** One page of your watchlists. */
  async listWatchlists(
    options: CursorListOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<CursorListResponse<Watchlist>> {
    return this.request<CursorListResponse<Watchlist>>({
      method: "GET",
      path: "/watchlists",
      query: { cursor: options.cursor, limit: options.limit },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /** Walks `listWatchlists`, yielding one page at a time until the last. */
  iterWatchlists(options: CursorListOptions = {}): AsyncGenerator<Watchlist[], void, unknown> {
    return this.iterCursor("iterWatchlists", options, (o) => this.listWatchlists(o), false);
  }

  async getWatchlist(id: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<Watchlist>> {
    return this.request<ApiResponse<Watchlist>>({
      method: "GET",
      path: `/watchlists/${encodeURIComponent(id)}`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /** Renames a watchlist and/or replaces its metadata. */
  async updateWatchlist(
    id: string,
    options: UpdateWatchlistOptions,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<Watchlist>> {
    return this.request<ApiResponse<Watchlist>>({
      method: "PATCH",
      path: `/watchlists/${encodeURIComponent(id)}`,
      body: options,
      timeoutMs: requestOptions.timeoutMs,
      retryPosts: requestOptions.retryPosts,
    });
  }

  /** Deletes a watchlist and its items. Events already emitted stay readable in `listChanges`. */
  async deleteWatchlist(id: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<DeleteResult>> {
    return this.deleteRequest(`/watchlists/${encodeURIComponent(id)}`, requestOptions);
  }

  /**
   * Adds 1 to 100 CNRs to a watchlist. Each gets a result in `data.results`:
   * `watching`, `pending` (not in the corpus yet, so a live fetch was
   * started), `invalid`, `duplicate`, `cap_exceeded` or `not_found`.
   *
   * `cap_exceeded` also means you passed the daily add allowance for the
   * account (Free 50, Pay As You Go 5,000, Scale 50,000, Enterprise
   * 500,000 per Indian calendar day) or the daily limit on new CNRs.
   * `not_found` is returned for a case taken down at a party's request and
   * for a CNR the court portal had nothing for in the last 24 hours.
   */
  async addWatchlistItems(
    id: string,
    items: WatchlistItemInput[],
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<AddWatchlistItemsResult>> {
    return this.postJson(`/watchlists/${encodeURIComponent(id)}/items`, { items: items.map(normalizeItem) }, requestOptions);
  }

  /** One page of the CNRs in a watchlist, optionally filtered by `status`. */
  async listWatchlistItems(
    id: string,
    options: ListWatchlistItemsOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<CursorListResponse<WatchlistItem>> {
    return this.request<CursorListResponse<WatchlistItem>>({
      method: "GET",
      path: `/watchlists/${encodeURIComponent(id)}/items`,
      query: { cursor: options.cursor, limit: options.limit, status: options.status },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /** Walks `listWatchlistItems`, yielding one page at a time until the last. */
  iterWatchlistItems(id: string, options: ListWatchlistItemsOptions = {}): AsyncGenerator<WatchlistItem[], void, unknown> {
    return this.iterCursor("iterWatchlistItems", options, (o) => this.listWatchlistItems(id, o), false);
  }

  /** Stops watching one CNR in one watchlist. */
  async removeWatchlistItem(id: string, cnr: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<DeleteResult>> {
    return this.deleteRequest(
      `/watchlists/${encodeURIComponent(id)}/items/${encodeURIComponent(cnrForRequest(cnr))}`,
      requestOptions,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Change feed                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * One page of change events across all your watchlists, oldest first.
   * 1 credit per non-empty page of up to 100 events; an empty page is free.
   *
   * `pagination.nextCursor` is always returned, even on an empty page, so
   * you can store it and poll forward forever: pass it back as `cursor` on
   * the next poll. Events are kept for 90 days. Delivery is at least once
   * across webhooks, so dedupe on `event.id`.
   */
  async listChanges(
    options: ListChangesOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<CursorListResponse<ChangeEvent>> {
    return this.request<CursorListResponse<ChangeEvent>>({
      method: "GET",
      path: "/changes",
      query: changesQuery(options),
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * Walks `listChanges` until it is caught up, yielding one page of events
   * at a time. Stops at the first empty page (which is free). To keep a
   * durable position between runs, call `listChanges` yourself and store
   * `pagination.nextCursor`.
   */
  iterChanges(options: ListChangesOptions = {}): AsyncGenerator<ChangeEvent[], void, unknown> {
    return this.iterCursor("iterChanges", options, (o) => this.listChanges(o), true);
  }

  /** Same as `listChanges`, filtered to one watchlist. Same pricing. */
  async listWatchlistEvents(
    id: string,
    options: ListChangesOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<CursorListResponse<ChangeEvent>> {
    return this.request<CursorListResponse<ChangeEvent>>({
      method: "GET",
      path: `/watchlists/${encodeURIComponent(id)}/events`,
      query: changesQuery(options),
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /** Walks `listWatchlistEvents` until caught up. See `iterChanges`. */
  iterWatchlistEvents(id: string, options: ListChangesOptions = {}): AsyncGenerator<ChangeEvent[], void, unknown> {
    return this.iterCursor("iterWatchlistEvents", options, (o) => this.listWatchlistEvents(id, o), true);
  }

  /* ---------------------------------------------------------------------- */
  /* Webhooks                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Registers a webhook endpoint (https only). The returned `secret` is
   * shown once, here and on `rotateWebhookSecret`: store it. Use it with
   * `verifyWebhookSignature`.
   */
  async createWebhook(
    options: CreateWebhookOptions,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<WebhookWithSecret>> {
    return this.postJson("/webhooks", options, requestOptions);
  }

  async listWebhooks(
    options: CursorListOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<CursorListResponse<Webhook>> {
    return this.request<CursorListResponse<Webhook>>({
      method: "GET",
      path: "/webhooks",
      query: { cursor: options.cursor, limit: options.limit },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /** Walks `listWebhooks`, yielding one page at a time until the last. */
  iterWebhooks(options: CursorListOptions = {}): AsyncGenerator<Webhook[], void, unknown> {
    return this.iterCursor("iterWebhooks", options, (o) => this.listWebhooks(o), false);
  }

  /** Never returns the secret. */
  async getWebhook(id: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<Webhook>> {
    return this.request<ApiResponse<Webhook>>({
      method: "GET",
      path: `/webhooks/${encodeURIComponent(id)}`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /** Changes the URL, event filter, watchlist filter, description, or re-enables a disabled endpoint with `enabled: true`. */
  async updateWebhook(
    id: string,
    options: UpdateWebhookOptions,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<Webhook>> {
    return this.request<ApiResponse<Webhook>>({
      method: "PATCH",
      path: `/webhooks/${encodeURIComponent(id)}`,
      body: options,
      timeoutMs: requestOptions.timeoutMs,
      retryPosts: requestOptions.retryPosts,
    });
  }

  async deleteWebhook(id: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<DeleteResult>> {
    return this.deleteRequest(`/webhooks/${encodeURIComponent(id)}`, requestOptions);
  }

  /**
   * Issues a new signing secret. The old secret keeps signing in parallel
   * for 24 hours (deliveries then carry two `v1=` signatures), so you can
   * switch over without dropping events.
   */
  async rotateWebhookSecret(id: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<WebhookWithSecret>> {
    return this.postJson(`/webhooks/${encodeURIComponent(id)}/rotate-secret`, undefined, requestOptions);
  }

  /**
   * Sends a `webhook.test` event to the endpoint now (a single attempt, never
   * retried) and returns the delivery object. It is sent even if the endpoint
   * is switched off, and does not count toward its failure streak. Each
   * attempt has a hard 10 second deadline and reads at most 64 KB of your
   * response.
   */
  async testWebhook(id: string, requestOptions: RequestConfig = {}): Promise<ApiResponse<WebhookDelivery>> {
    return this.postJson(`/webhooks/${encodeURIComponent(id)}/test`, undefined, requestOptions);
  }

  /** One page of delivery attempts for an endpoint. */
  async listWebhookDeliveries(
    id: string,
    options: CursorListOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<CursorListResponse<WebhookDelivery>> {
    return this.request<CursorListResponse<WebhookDelivery>>({
      method: "GET",
      path: `/webhooks/${encodeURIComponent(id)}/deliveries`,
      query: { cursor: options.cursor, limit: options.limit },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /** Walks `listWebhookDeliveries`, yielding one page at a time until the last. */
  iterWebhookDeliveries(id: string, options: CursorListOptions = {}): AsyncGenerator<WebhookDelivery[], void, unknown> {
    return this.iterCursor("iterWebhookDeliveries", options, (o) => this.listWebhookDeliveries(id, o), false);
  }

  /** Re-queues one delivery to be sent now. */
  async retryWebhookDelivery(
    id: string,
    deliveryId: string,
    requestOptions: RequestConfig = {},
  ): Promise<ApiResponse<WebhookDelivery>> {
    return this.postJson(
      `/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/retry`,
      undefined,
      requestOptions,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Acts and sections (needs the `legislation` scope)                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Finds acts by title, short form or subject, `GET /acts/search`. 1 credit
   * when something is returned, nothing when nothing is. `pagination.total`
   * counts matches before unpublished records are removed, so a page can hold
   * fewer rows than `limit`. `meta.weakMatch` is true when nothing matched
   * closely. Check `repealed` on each act before relying on it.
   */
  async searchActs(options: SearchActsOptions, requestOptions: RequestConfig = {}): Promise<SearchActsResponse> {
    return this.request<SearchActsResponse>({
      method: "GET",
      path: "/acts/search",
      query: {
        q: options.query,
        docClass: options.docClass,
        jurisdiction: options.jurisdiction,
        yearFrom: options.yearFrom,
        yearTo: options.yearTo,
        page: options.page,
        limit: options.limit,
      },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * Turns what a lawyer writes ("IPC", "NI Act") into the act,
   * `GET /acts/resolve`. Returns up to five candidates, best first. Same
   * pricing as `searchActs`.
   */
  async resolveAct(query: string, requestOptions: RequestConfig = {}): Promise<ActResolutionResponse> {
    return this.request<ActResolutionResponse>({
      method: "GET",
      path: "/acts/resolve",
      query: { q: query },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * One act's details and repeal status, without its text,
   * `GET /acts/{slug}`. An unknown slug throws `NotFoundError` with
   * `apiCode === "ACT_NOT_FOUND"` and costs nothing. 1 credit otherwise.
   */
  async getAct(slug: string, requestOptions: RequestConfig = {}): Promise<ActResponse> {
    return this.request<ActResponse>({
      method: "GET",
      path: `/acts/${encodeURIComponent(slug)}`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * What repealed an act and what amended it, `GET /acts/{slug}/history`.
   * This is act level only: it does not map old sections to new ones. An
   * unknown slug throws `NotFoundError` (`ACT_NOT_FOUND`). 1 credit.
   */
  async getActHistory(slug: string, requestOptions: RequestConfig = {}): Promise<ActHistoryResponse> {
    return this.request<ActHistoryResponse>({
      method: "GET",
      path: `/acts/${encodeURIComponent(slug)}/history`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * The provisions of an act in order, without their text,
   * `GET /acts/{slug}/sections`. An act published only as one document has
   * none (see `textSource` on `getAct`). An unknown slug throws
   * `NotFoundError` (`ACT_NOT_FOUND`). 1 credit when rows come back.
   */
  async listActSections(
    slug: string,
    options: ListActSectionsOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<ListActSectionsResponse> {
    return this.request<ListActSectionsResponse>({
      method: "GET",
      path: `/acts/${encodeURIComponent(slug)}/sections`,
      query: { page: options.page, limit: options.limit },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * One provision's full text, structured into blocks, with its amendment
   * notes and repeal status, `GET /acts/{slug}/sections/{sectionSlug}`. An
   * unknown act or provision throws `NotFoundError` with
   * `apiCode === "SECTION_NOT_FOUND"`, at no charge. 1 credit otherwise.
   */
  async getActSection(slug: string, sectionSlug: string, requestOptions: RequestConfig = {}): Promise<ActSectionResponse> {
    return this.request<ActSectionResponse>({
      method: "GET",
      path: `/acts/${encodeURIComponent(slug)}/sections/${encodeURIComponent(sectionSlug)}`,
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * Judgments citing exactly this provision, newest first,
   * `GET /acts/{slug}/sections/{sectionSlug}/citing-cases`. A search for
   * section 302 of the Penal Code does not return judgments that cite only
   * its successor.
   *
   * This is not an exhaustive list of every judgment applying the provision,
   * and an empty list does not mean no judgment applied it. `listAvailable`
   * is false for a provision we do not list judgments for, including sexual
   * offences and cruelty provisions. Some matters are never listed. A page
   * can hold fewer rows than `limit`, or none, while `pagination.hasMore` is
   * true, so keep following `pagination.nextCursor`; it is opaque, so pass it
   * back unchanged. Read a judgment with `getCase(id)`. A failed check
   * throws `BadGatewayError` (`UPSTREAM_UNAVAILABLE`), is free and is safe to
   * retry. 1 credit when cases come back.
   */
  async listSectionCitingCases(
    slug: string,
    sectionSlug: string,
    options: ListSectionCitingCasesOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<CitingCasesResponse> {
    return this.request<CitingCasesResponse>({
      method: "GET",
      path: `/acts/${encodeURIComponent(slug)}/sections/${encodeURIComponent(sectionSlug)}/citing-cases`,
      query: { cursor: options.cursor, limit: options.limit },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * Walks `listSectionCitingCases`, yielding one page of judgments at a time
   * until `nextCursor` is null. An empty page in the middle is skipped over, not
   * treated as the end. The same caveats apply: the list is not exhaustive.
   */
  iterSectionCitingCases(
    slug: string,
    sectionSlug: string,
    options: ListSectionCitingCasesOptions = {},
  ): AsyncGenerator<CitingCase[], void, unknown> {
    return this.iterCursor(
      "iterSectionCitingCases",
      options,
      async (o) => {
        const res = await this.listSectionCitingCases(slug, sectionSlug, o);
        return { success: true as const, data: res.data.cases, pagination: res.pagination };
      },
      false,
    );
  }

  /**
   * Full text search across provisions, with a short snippet per row,
   * `GET /sections/search`. Narrow it with `act` (a slug) or `number`. Same
   * pricing and `pagination.total` caveat as `searchActs`.
   */
  async searchSections(options: SearchSectionsOptions, requestOptions: RequestConfig = {}): Promise<SearchSectionsResponse> {
    return this.request<SearchSectionsResponse>({
      method: "GET",
      path: "/sections/search",
      query: { q: options.query, act: options.act, number: options.number, page: options.page, limit: options.limit },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * Turns shorthand such as "section 302 IPC", "s.138 NI Act" or "Article 21"
   * into the provision it names, `GET /sections/lookup`. A lettered section
   * keeps its letter. "Order VII Rule 11 CPC" is not resolved and returns no
   * match. `ambiguous` is true on a match when no act was named: choose or
   * name the act. 1 credit when something is returned.
   */
  async lookupSection(citation: string, requestOptions: RequestConfig = {}): Promise<SectionLookupResponse> {
    return this.request<SectionLookupResponse>({
      method: "GET",
      path: "/sections/lookup",
      query: { q: citation },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Cause lists                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * One page of the listings found for the matters in your account, within a
   * date range of at most 31 days (default: today and the next 7 days).
   * Needs the `causelist` scope. 1 credit per successful call; a failed call
   * is not charged. Only listings that were found are returned: an empty page
   * does not mean a matter is not listed. Pages start at 1.
   *
   * Throws `ValidationError` for a bad date range before any request is
   * sent (`page` and `limit` are checked by the server). A temporary outage is
   * `BadGatewayError` (`UPSTREAM_UNAVAILABLE`, not charged; GET calls are
   * retried by the client before it is thrown); an account without cause list access is
   * `PermissionError` (`CAUSE_LISTS_NOT_ENABLED`).
   */
  async listCauseListings(
    options: ListCauseListingsOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<CauseListingsResponse> {
    assertDateRange(options, LISTINGS_MAX_DAYS);
    return this.request<CauseListingsResponse>({
      method: "GET",
      path: "/cause-lists/listings",
      query: { from: options.from, to: options.to, page: options.page, limit: options.limit },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * Walks `listCauseListings`, yielding one page of listings at a time until
   * `pagination.hasMore` is false. Each page is one call and one credit.
   * `PAGE_LIMIT_EXCEEDED` and `PAGINATION_DEPTH_EXCEEDED` surface as
   * `ValidationError`, as on search.
   */
  async *iterCauseListings(
    options: ListCauseListingsOptions = {},
  ): AsyncGenerator<CauseListing[], void, unknown> {
    let page = options.page ?? 1;
    for (let i = 0; i < MAX_ITERATOR_PAGES; i++) {
      const response = await this.listCauseListings({ ...options, page });
      const data = response.data ?? [];
      if (data.length > 0) yield data;
      if (data.length === 0 || !response.pagination?.hasMore) return;
      page += 1;
    }
    throw new Error(
      `iterCauseListings exceeded the safety guard of ${MAX_ITERATOR_PAGES} pages. This usually means ` +
        "the server keeps reporting hasMore: true without making progress.",
    );
  }

  /**
   * The listings found for one matter in your account (`matterId` is its 24
   * character id), within a date range of at most 31 days. 1 credit per
   * successful call. An unknown matter throws `NotFoundError`
   * (`MATTER_NOT_FOUND`), not charged.
   */
  async listMatterCauseListings(
    matterId: string,
    options: CauseListRangeOptions = {},
    requestOptions: RequestConfig = {},
  ): Promise<{ success: true; data: MatterCauseListings; meta?: CauseListMeta; requestId?: string }> {
    assertMatterId(matterId);
    assertDateRange(options, LISTINGS_MAX_DAYS);
    return this.request({
      method: "GET",
      path: `/matters/${encodeURIComponent(matterId)}/cause-listings`,
      query: { from: options.from, to: options.to },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * The published list of one court for one date, for a court you have an
   * open matter in. `data.status` says what was read: `ok` and `partial`
   * carry rows (1 credit); `none`, `empty`, `not_published`, `invalid_court`
   * and `unavailable` are a 200 with no rows and cost 0 (read
   * `meta.creditsCharged`). The call still needs 1 credit available when it
   * starts. A court with no open matter of yours throws `NotFoundError`
   * (`COURT_LIST_NOT_FOUND`), not charged.
   */
  async getCourtCauseList(
    options: GetCourtCauseListOptions,
    requestOptions: RequestConfig = {},
  ): Promise<{ success: true; data: CauseListCourtList; meta?: CauseListMeta; requestId?: string }> {
    assertCourtListQuery(options);
    return this.request({
      method: "GET",
      path: "/cause-lists/court",
      query: { courtKey: options.courtKey, date: options.date },
      timeoutMs: requestOptions.timeoutMs,
    });
  }

  /**
   * Checks whether 1 to 100 CNRs that your account watches appear on a stored
   * cause list, for a range of at most 7 days (default: today and tomorrow,
   * Indian calendar). Needs the `causelist` scope. The call never contacts a
   * court: it reads lists already held.
   *
   * Each result has a `status`:
   * - `listed`: a row of the case was found (1 credit).
   * - `no_entry_found`: a list was read and no row was recognised (1 credit).
   *   This is not proof that the case is not listed; `dates[].complete` says
   *   how much was read.
   * - `list_not_read`, `cannot_check`, `not_watched`: free.
   *
   * At most 100 CNRs, and the number of distinct CNRs times the number of
   * dates in the range (inclusive, 2 by default) at most 300; both are
   * checked before a request is sent. Repeats of a CNR are ignored.
   *
   * Price: 1 credit per CNR with status `listed` or `no_entry_found`, settled
   * once for the whole call (`meta.creditsCharged`). The call also needs at
   * least 1 credit available when it starts: a balance below the number of
   * watched CNRs in it throws `InsufficientCreditsError`. The same error can
   * arrive after the answer is ready, when the credits due cannot be settled;
   * no results are returned then. A `ServiceUnavailableError` with
   * `apiCode === "SETTLEMENT_UNCONFIRMED"` means the charge outcome is unknown:
   * it is never retried automatically, even with `retryPosts`, and you should
   * check your balance (`usage()`) first. Repeating the call with the same
   * `Idempotency-Key` is refused with 409 `IDEMPOTENCY_IN_PROGRESS` for up to
   * 24 hours. A 503 `ENTITLEMENT_UNAVAILABLE` ran nothing and is safe to retry.
   *
   * `data.from` and `data.to` are the dates that were looked at (the default
   * range is resolved by the server). Only positive listings are reported. A
   * temporary outage is `BadGatewayError` (`UPSTREAM_UNAVAILABLE`) for the
   * whole call, not charged. Accepts an `Idempotency-Key` like the other
   * POST calls.
   */
  async checkCauseLists(
    options: CheckCauseListsOptions,
    requestOptions: RequestConfig = {},
  ): Promise<{
    success: true;
    data: CauseListCheckData;
    meta?: CauseListMeta;
    requestId?: string;
    replayed?: boolean;
  }> {
    assertCheckBody(options);
    const body: Record<string, unknown> = { cnrs: options.cnrs.map(cnrForRequest) };
    if (options.from !== undefined) body.from = options.from;
    if (options.to !== undefined) body.to = options.to;
    return this.postJson("/cause-lists/check", body, requestOptions);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private postJson<T>(path: string, body: unknown, requestOptions: RequestConfig): Promise<T> {
    return this.request<T>({
      method: "POST",
      path,
      body,
      timeoutMs: requestOptions.timeoutMs,
      retryPosts: requestOptions.retryPosts,
      idempotencyKey: this.resolveIdempotencyKey(requestOptions),
    });
  }

  /** DELETE; some servers answer 204 with no body, so an empty reply becomes `{ success: true, data: { deleted: true } }`. */
  private async deleteRequest(path: string, requestOptions: RequestConfig): Promise<ApiResponse<DeleteResult>> {
    const json = await this.request<ApiResponse<DeleteResult> | undefined>({
      method: "DELETE",
      path,
      timeoutMs: requestOptions.timeoutMs,
    });
    return json ?? { success: true, data: { deleted: true } };
  }

  /**
   * Shared cursor walker. `stopOnEmpty` is the change feed rule: an empty
   * page means caught up. Other lists stop when there is no `nextCursor`.
   */
  private async *iterCursor<T, O extends CursorListOptions>(
    name: string,
    options: O,
    fetchPage: (o: O) => Promise<CursorListResponse<T>>,
    stopOnEmpty: boolean,
  ): AsyncGenerator<T[], void, unknown> {
    let cursor = options.cursor;
    for (let i = 0; i < MAX_ITERATOR_PAGES; i++) {
      const response = await fetchPage({ ...options, cursor });
      const data = response.data ?? [];
      if (data.length === 0 && stopOnEmpty) return;
      if (data.length > 0) yield data;
      const next = response.pagination?.nextCursor;
      if (typeof next !== "string" || next.length === 0 || next === cursor) return;
      if (!stopOnEmpty && response.pagination?.hasMore === false) return;
      cursor = next;
    }
    throw new Error(
      `${name} exceeded the safety guard of ${MAX_ITERATOR_PAGES} pages. This usually means ` +
        "the server keeps returning a new cursor without making progress.",
    );
  }

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
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": USER_AGENT };
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
    // GET and DELETE are idempotent, so they are retried by default; POST and
    // PATCH are retried only on opt-in.
    const canRetryAfterDispatch =
      !opts.noRetryAfterDispatch &&
      (opts.method === "GET" || opts.method === "DELETE" || (opts.retryPosts ?? this.retryPosts));

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
      } else if (
        RETRYABLE_STATUS_CODES.has(response.status) &&
        attempt < maxAttempts &&
        canRetryAfterDispatch &&
        // The charge outcome is unknown: a retry could charge again, whatever retryPosts says.
        !(response.status === 503 && extractApiCode(json) === "SETTLEMENT_UNCONFIRMED") &&
        !(
          response.status === 503 &&
          opts.retryable503Codes !== undefined &&
          !opts.retryable503Codes.has(extractApiCode(json) ?? "")
        )
      ) {
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
