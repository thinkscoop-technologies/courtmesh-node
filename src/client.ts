import { CourtMeshError, mapStatusToError } from "./errors.js";
import type {
  AnalyzeCaseMeta,
  AnalyzeCaseOptions,
  AnalyzeCaseResult,
  AnalyzeConsolidatedMeta,
  AnalyzeConsolidatedOptions,
  AnalyzeConsolidatedResult,
  ApiResponse,
  CaseAnalysis,
  CaseDetails,
  CaseListItem,
  GetCaseAnalysisMeta,
  GetCaseMeta,
  GetPdfMeta,
  GetTimelineMeta,
  HealthResponse,
  KeywordSearchPagination,
  PdfResponse,
  RelatedMeta,
  RelatedResponse,
  RequestTimelineMeta,
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
  /** Per request timeout in milliseconds, enforced with AbortController. Defaults to 30000. Set to 0 to disable. */
  timeoutMs?: number;
  /** Inject a custom fetch implementation, primarily for testing. Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

const DEFAULT_BASE_URL = "https://research.courtmesh.ai/api/v1/prod";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30000;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const MAX_BACKOFF_MS = 30000;
const BASE_BACKOFF_MS = 500;

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

function computeRetryDelayMs(response: Response, body: unknown, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  if (isRecord(body) && typeof body.retryAfter === "number") {
    return body.retryAfter * 1000;
  }
  return computeBackoffMs(attempt);
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

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * Client for the CourtMesh Enterprise API.
 *
 * Uses the global `fetch`, no runtime dependencies. Retries 429, 502, 503
 * and 504 responses plus network errors with exponential backoff and
 * jitter, honouring `Retry-After` first, then the JSON body's `retryAfter`
 * in seconds.
 */
export class CourtMeshClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: CourtMeshClientOptions = {}) {
    this.apiKey = options.apiKey ?? readEnvApiKey();
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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

  async searchCases(options: SearchCasesOptions): Promise<SearchCasesResponse> {
    const response = await this.request<SearchCasesResponse>({
      method: "POST",
      path: "/search/cases",
      body: options,
    });
    return response;
  }

  /**
   * Walks `POST /search/cases` page by page, yielding one page of hits at a
   * time. Stops when a page comes back empty or `pagination.hasMore` is
   * false. Uses page/limit pagination, starting from `options.page` (or 1).
   */
  async *iterSearchCases(options: SearchCasesOptions): AsyncGenerator<SearchHit[], void, unknown> {
    const limit = options.limit ?? 20;
    let page = options.page ?? 1;

    for (let i = 0; i < MAX_ITERATOR_PAGES; i++) {
      const response = await this.searchCases({ ...options, page, limit });
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
      `iterSearchCases exceeded the safety guard of ${MAX_ITERATOR_PAGES} pages. This usually means ` +
        "the server keeps reporting hasMore: true without making progress.",
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 3. POST /search/cases/semantic                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Throws if the response body has `success: false`, even though the
   * server sends HTTP 200 for failures that happen after it has already
   * started writing the response (a documented transport quirk).
   */
  async semanticSearch(options: SemanticSearchOptions): Promise<SemanticSearchResponse> {
    const json = await this.request<Record<string, unknown>>({
      method: "POST",
      path: "/search/cases/semantic",
      body: options,
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

  async getCase(id: string): Promise<ApiResponse<CaseDetails, GetCaseMeta>> {
    return this.request<ApiResponse<CaseDetails, GetCaseMeta>>({
      method: "GET",
      path: `/cases/${encodeURIComponent(id)}`,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 5. GET /cases/{id}/analysis                                            */
  /* ---------------------------------------------------------------------- */

  async getCaseAnalysis(id: string): Promise<ApiResponse<CaseAnalysis, GetCaseAnalysisMeta>> {
    return this.request<ApiResponse<CaseAnalysis, GetCaseAnalysisMeta>>({
      method: "GET",
      path: `/cases/${encodeURIComponent(id)}/analysis`,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 6. GET /cases/{id}/related                                             */
  /* ---------------------------------------------------------------------- */

  async getRelated(id: string): Promise<ApiResponse<RelatedResponse, RelatedMeta>> {
    return this.request<ApiResponse<RelatedResponse, RelatedMeta>>({
      method: "GET",
      path: `/cases/${encodeURIComponent(id)}/related`,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 7. GET /cases/{id}/pdf                                                 */
  /* ---------------------------------------------------------------------- */

  async getCasePdf(id: string): Promise<ApiResponse<PdfResponse, GetPdfMeta>> {
    return this.request<ApiResponse<PdfResponse, GetPdfMeta>>({
      method: "GET",
      path: `/cases/${encodeURIComponent(id)}/pdf`,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 8. POST /cases/{id}/analyze                                           */
  /* ---------------------------------------------------------------------- */

  async analyzeCase(
    id: string,
    options: AnalyzeCaseOptions = {},
  ): Promise<ApiResponse<AnalyzeCaseResult, AnalyzeCaseMeta>> {
    return this.request<ApiResponse<AnalyzeCaseResult, AnalyzeCaseMeta>>({
      method: "POST",
      path: `/cases/${encodeURIComponent(id)}/analyze`,
      body: { force: options.force ?? false },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 9. POST /cases/{id}/analyze-consolidated                              */
  /* ---------------------------------------------------------------------- */

  async analyzeConsolidated(
    id: string,
    options: AnalyzeConsolidatedOptions = {},
  ): Promise<ApiResponse<AnalyzeConsolidatedResult, AnalyzeConsolidatedMeta>> {
    return this.request<ApiResponse<AnalyzeConsolidatedResult, AnalyzeConsolidatedMeta>>({
      method: "POST",
      path: `/cases/${encodeURIComponent(id)}/analyze-consolidated`,
      body: { force: options.force ?? false },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 10. POST /request-timeline                                            */
  /* ---------------------------------------------------------------------- */

  async requestTimeline(caseId: string): Promise<ApiResponse<RequestTimelineResult, RequestTimelineMeta>> {
    return this.request<ApiResponse<RequestTimelineResult, RequestTimelineMeta>>({
      method: "POST",
      path: "/request-timeline",
      body: { case_id: caseId },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 11. GET /get-timeline/{requestId}                                     */
  /* ---------------------------------------------------------------------- */

  async getTimeline(requestId: string): Promise<ApiResponse<TimelineJob, GetTimelineMeta>> {
    return this.request<ApiResponse<TimelineJob, GetTimelineMeta>>({
      method: "GET",
      path: `/get-timeline/${encodeURIComponent(requestId)}`,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 12. GET /health                                                       */
  /* ---------------------------------------------------------------------- */

  /** No auth required, not rate limited, not enveloped in `data`. */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>({ method: "GET", path: "/health", query: undefined }, { skipAuth: true });
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

  private buildHeaders(hasBody: boolean, skipAuth: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!skipAuth && this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  private async request<T>(opts: RequestOptions, requestConfig: { skipAuth?: boolean } = {}): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    const maxAttempts = this.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: opts.method,
          headers: this.buildHeaders(opts.body !== undefined, requestConfig.skipAuth ?? false),
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        if (timer) clearTimeout(timer);
        const aborted = isAbortError(error);
        if (!aborted && attempt < maxAttempts) {
          await delay(computeBackoffMs(attempt));
          continue;
        }
        if (aborted) {
          throw new CourtMeshError(`Request timed out after ${this.timeoutMs}ms`, "request_timeout", 408, undefined);
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

      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxAttempts) {
        await delay(computeRetryDelayMs(response, json, attempt));
        continue;
      }

      if (!response.ok) {
        throw mapStatusToError(response.status, extractErrorMessage(json, response.status), json);
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
