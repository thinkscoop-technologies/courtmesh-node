/**
 * Types for the CourtMesh API.
 *
 * These types mirror the real request and response shapes documented in the
 * authoritative API spec, derived from the CourtMesh research server source.
 * Nothing here is invented, if a field is not documented it is not modeled.
 */

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                          */
/* -------------------------------------------------------------------------- */

/** A single value or an array of the same value, accepted by several filters. */
export type StringOrArray = string | string[];

/** `year` accepts an int, a "YYYY" string, or an array of either. */
export type YearParam = number | string | Array<number | string>;

/**
 * The generic success envelope used by every endpoint except `GET /health`.
 *
 * `meta` and `pagination` are only present when the handler supplies them,
 * so both are optional here. Endpoints that always return pagination narrow
 * this field to a required one in their own response type.
 */
export interface ApiResponse<T, M = Record<string, unknown>> {
  success: true;
  data: T;
  meta?: M;
  pagination?: KeywordSearchPagination | SemanticSearchPagination;
  /**
   * Backfilled by this SDK from the `X-Request-Id` response header when the
   * server did not already put a `requestId` somewhere in the body. Some
   * endpoints (for example `GET /usage`, `POST /party/screen/batch`) also
   * carry their own `meta.requestId` sent directly by the server; both can
   * be present, they are not in conflict.
   */
  requestId?: string;
  /**
   * `true` only when this call sent an `Idempotency-Key` that matched a
   * previous request within its 24 hour window: the server returned the
   * stored response instead of doing the work again, and nothing was
   * charged. Backfilled from the `Idempotency-Replayed` response header,
   * present only on the five idempotency-key-aware POST methods
   * (`screenParty`, `screenPartyBatch`, `analyzeCase`,
   * `analyzeConsolidated`, `requestTimeline`).
   */
  replayed?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Pagination, two distinct shapes, do not unify them                        */
/* -------------------------------------------------------------------------- */

/**
 * Pagination shape returned by `POST /search/cases`.
 *
 * `page` is absent when the caller used cursor pagination. `totalPages` does
 * not exist on this endpoint. `nextCursor` has two shapes depending on
 * whether the API self-serve tiers flag is on for your account:
 *   - a signed, opaque string (pass it back as `cursor`) when it is on -
 *     this is the current, supported pagination mechanism;
 *   - the legacy raw OpenSearch sort tuple, an array like
 *     `[12.34, "68f0..."]` (pass it back as a JSON-encoded `searchAfter`
 *     string), when the flag is off for your account.
 * Either way, `null` means there is no next page. Prefer `cursor` /
 * `iterSearchCases`, which handles both shapes for you.
 */
export interface KeywordSearchPagination {
  total: number;
  hasMore: boolean;
  page?: number;
  limit: number;
  nextCursor: string | Array<number | string> | null;
}

/**
 * Pagination shape returned by `POST /search/cases/semantic`.
 *
 * `total` and `totalPages` are estimates, exact only on the last page: the
 * handler fetches `limit + 1` from Qdrant and reports
 * `skip + results.length (+1 if more)`.
 */
export interface SemanticSearchPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

/* -------------------------------------------------------------------------- */
/* 1. GET /judges/search                                                      */
/* -------------------------------------------------------------------------- */

export interface SearchJudgesOptions {
  /** Case insensitive substring match. Empty or omitted returns the first 50. */
  q?: string;
}

export interface SearchJudgesMeta {
  query: string;
  responseTime: string;
  totalMatches: number;
}

/* -------------------------------------------------------------------------- */
/* 2. POST /search/cases                                                      */
/* -------------------------------------------------------------------------- */

export interface SearchCasesOptions {
  /** Required, trimmed, minimum length 1. */
  query: string;
  court?: StringOrArray;
  /** Int must be 1947..current year. */
  year?: YearParam;
  caseType?: StringOrArray;
  /**
   * Filters the search to one case number. An array is accepted but only its
   * first string element is used; the schema rejects more than one value
   * rather than silently dropping the rest.
   */
  caseNumber?: StringOrArray;
  judgeName?: StringOrArray;
  /** Alias for `judgeName`. */
  judges?: StringOrArray;
  /** Alias for `judgeName`. */
  judge?: StringOrArray;
  /** `YYYY-MM-DD`. */
  fromDate?: string;
  /** `YYYY-MM-DD`. */
  toDate?: string;
  /** Min 1, default 1. Ignored once `cursor` is supplied. */
  page?: number;
  /** 1..100, default 20 (the Free tier's own max page size is 20; higher tiers allow more, see `PAGE_LIMIT_EXCEEDED`). */
  limit?: number;
  /**
   * The signed, opaque cursor from a previous page's `pagination.nextCursor`.
   * Prefer this over `page`/`searchAfter` for paging past the first screen;
   * see `iterSearchCases`, which manages it for you. An invalid or
   * query-mismatched cursor is refused with `CURSOR_INVALID` (400).
   */
  cursor?: string;
  /**
   * @deprecated Legacy cursor mechanism, honoured only for accounts without
   * the API self-serve tiers flag on. A JSON encoded array string (the raw
   * OpenSearch sort tuple from a previous page's `pagination.nextCursor`).
   * New integrations should use `cursor` instead.
   */
  searchAfter?: string;
  /**
   * `"date"` is a deprecated alias of `"recent"`, kept for older callers;
   * the response's `meta.sortBy` reports which sort was actually applied,
   * and `meta.warnings` carries a note when an alias was resolved.
   */
  sortBy?: "relevance" | "recent" | "oldest" | "date";
}

export interface SearchCasesMeta {
  /** The parser normalised free text query. */
  query: string;
  filters: {
    court?: StringOrArray;
    year?: YearParam;
    caseType?: StringOrArray;
    caseNumber?: StringOrArray;
    judgeName?: StringOrArray;
    fromDate?: string;
    toDate?: string;
  };
  /** The sort actually applied (after resolving a deprecated `sortBy` alias like `"date"`). */
  sortBy?: "relevance" | "recent" | "oldest";
  /** Present, and `true`, only when at least one deprecated input was silently resolved (for example `sortBy: "date"`). */
  warnings?: string[];
  /** Present, and `true`, only when one or more results were withheld by the restricted-case gate (a party's takedown, or a masked title). */
  someRecordsWithheld?: boolean;
  /** Present, and `true`, only when the restricted-case check itself could not run (fail-closed masking, not a confirmed clean page). */
  restrictedCheckDegraded?: boolean;
  responseTime: string;
}

/**
 * A raw OpenSearch hit: the `_source` fields for the v3 index, all optional
 * since presence varies per document, plus the hit metadata fields.
 *
 * `detailedSummary`, `holding`, `keyFacts_joined`, `legalIssues_joined` and
 * `courtsReasoning` are indexed but excluded from `_source`, so they never
 * appear here.
 */
export interface SearchHit {
  /** The documented contract name for this hit's id. Always present; use this, not `_id`. */
  id: string;
  /** The documented contract name for this hit's relevance score. Always present; use this, not `_score`. */
  score: number;
  /** Present only when the search backend attached highlighted snippets. Field name to snippet list, OpenSearch's usual highlight shape. */
  highlights?: Record<string, string[]>;
  /** @deprecated Legacy field name; the OpenSearch microservice's `_source` carries this today, kept for backwards compatibility. Prefer `id`. */
  _id?: string;
  /** @deprecated Legacy field name, kept for backwards compatibility. Prefer `score`. */
  _score?: number;
  _sort?: Array<number | string>;
  mongoId?: string;
  title?: string;
  titleRaw?: string;
  headnote?: string;
  summary?: string;
  petitioners?: string[];
  respondents?: string[];
  parties_all?: string[];
  judges?: string[];
  advocates?: string[];
  caseNumber?: string;
  extracted_citations?: string[];
  cited_sections?: string[];
  courtType?: string;
  court?: string;
  courtName?: string;
  caseType?: string;
  caseTypeFullForm?: string;
  caseStatus?: string;
  caseYear?: number;
  registrationYear?: number;
  cnr?: string;
  source?: string;
  decisionDate?: string;
  registrationDate?: string;
  citation?: string;
  disposalNature?: string;
  hasDocuments?: boolean;
  documentTypes?: string[];
  practiceAreas?: string[];
  precedentValue?: string;
  createdAt?: string;
  updatedAt?: string;
  /** The mapping documents more fields than any one hit is guaranteed to carry. */
  [key: string]: unknown;
}

export interface SearchCasesResponse extends ApiResponse<SearchHit[], SearchCasesMeta> {
  pagination: KeywordSearchPagination;
}

/* -------------------------------------------------------------------------- */
/* 3. POST /search/cases/semantic                                             */
/* -------------------------------------------------------------------------- */

/**
 * Free form filter channel actually read by the handler. Filters extracted
 * from the natural language query by GPT are merged with this object, and
 * values supplied here win. Keys beyond the recognised ones are passed
 * through untouched, hence the index signature.
 */
export interface SemanticSearchFilters {
  court?: StringOrArray;
  caseType?: StringOrArray;
  caseYear?: YearParam;
  caseNumber?: StringOrArray;
  judgeName?: StringOrArray;
  judges?: StringOrArray;
  judge?: StringOrArray;
  decisionDate?: { $gte?: string; $lte?: string };
  practiceArea?: StringOrArray;
  sourceCaseId?: string;
  [key: string]: unknown;
}

export interface SemanticSearchOptions {
  /** Required, trimmed, minimum length 3. */
  query: string;
  /**
   * Merged into the effective filters at explicit-top-level precedence: it
   * wins over whatever the language model inferred from `query`, but a value
   * in `filters` (the vector store's own keys, the most specific thing a
   * caller can send) wins over this.
   */
  court?: StringOrArray;
  /** Same precedence as `court` above. */
  caseType?: StringOrArray;
  /** Same precedence as `court` above. */
  caseNumber?: StringOrArray;
  /** Same precedence as `court` above. */
  judgeName?: StringOrArray;
  /** Same precedence as `court` above. */
  judges?: StringOrArray;
  /** Same precedence as `court` above. */
  judge?: StringOrArray;
  /** Same precedence as `court` above. */
  year?: YearParam;
  /** Same precedence as `court` above. */
  fromDate?: string;
  /** Same precedence as `court` above. */
  toDate?: string;
  /** Min 1, default 1. */
  page?: number;
  /** 1..100, default 20. */
  limit?: number;
  /**
   * The vector store's own filter keys, applied directly and taking
   * precedence over both the top level fields above and whatever the
   * language model inferred from `query`.
   */
  filters?: SemanticSearchFilters;
}

/** A watermarked list item returned by the semantic endpoint's normal path. */
export interface CaseListItem {
  id: string;
  caseNumber?: string;
  title?: string;
  court?: string;
  caseType?: string;
  judges?: string[];
  petitioners?: string[];
  respondents?: string[];
  decisionDate?: string;
  disposalNature?: string;
  summary?: string;
  hasDocuments?: boolean;
  hasAnalysis?: boolean;
  /** The Qdrant score. Minimum score threshold is 0.3. */
  similarity: number;
}

export interface SemanticSearchMeta {
  query: string;
  originalQuery?: string;
  appliedFilters?: Record<string, unknown>;
  responseTime: string;
  /** Absent for the no results and fallback variants. */
  searchType?: "semantic";
  /**
   * Present only on the no results variant: normally `"No similar cases
   * found."`, or a degraded-check notice when `restrictedCheckDegraded` is
   * also true (the restricted-case check itself could not run, so nothing
   * could be confirmed safe to return).
   */
  message?: string;
  /** Present only when the cleaned query was too short and the handler fell back to keyword search. */
  fallbackMode?: "opensearch";
  /** Present, and `true`, only when one or more results were withheld by the restricted-case gate (a party's takedown, or a masked title). */
  someRecordsWithheld?: boolean;
  /** Present, and `true`, only when the restricted-case check itself could not run (fail-closed masking, not a confirmed clean page). */
  restrictedCheckDegraded?: boolean;
}

/**
 * `data` is `CaseListItem[]` on the normal and no results paths. On the
 * filter-only fallback path (`meta.fallbackMode === "opensearch"`) it is
 * `SearchHit[]` instead, raw OpenSearch hits, see `searchCases`.
 */
export interface SemanticSearchResponse extends ApiResponse<Array<CaseListItem | SearchHit>, SemanticSearchMeta> {
  pagination: SemanticSearchPagination;
}

/* -------------------------------------------------------------------------- */
/* 4. GET /cases/{id}                                                         */
/* -------------------------------------------------------------------------- */

export interface CaseDetails {
  id: string;
  caseNumber?: string;
  title?: string;
  court?: string;
  caseType?: string;
  judges?: string[];
  petitioners?: string[];
  respondents?: string[];
  decisionDate?: string;
  disposalNature?: string;
  summary?: string;
  metadata?: { diaryNumber?: string };
  hasDocuments?: boolean;
  documentCount?: number;
  hasAnalysis?: boolean;
}

export interface GetCaseMeta {
  responseTime: string;
  note: string;
}

/* -------------------------------------------------------------------------- */
/* 5. GET /cases/{id}/analysis                                                */
/* -------------------------------------------------------------------------- */

export interface CaseAnalysisIssue {
  question?: string;
  holding?: string;
}

export interface CaseAnalysisCitedCases {
  followed?: string[];
  distinguished?: string[];
  overruled?: string[];
  referred?: string[];
}

export interface CaseAnalysisArguments {
  petitioner?: string[];
  respondent?: string[];
}

/** The AI analysis object shared by the analysis, analyze and consolidated endpoints. */
export interface CaseAnalysisData {
  summary?: string;
  detailedSummary?: string;
  comprehensiveSummary?: string;
  headnote?: string;
  holding?: string;
  keyFacts?: string[];
  issues?: CaseAnalysisIssue[];
  courtsReasoning?: string;
  citedCases?: CaseAnalysisCitedCases;
  precedentRelationships?: unknown;
  arguments?: CaseAnalysisArguments;
  practiceAreas?: string[];
  subCategories?: string[];
  tags?: string[];
  procedureType?: string;
  precedentValue?: string;
  legalPrinciples?: string[];
  doctrinesApplied?: string[];
  statutoryInterpretation?: string;
  constitutionalProvisions?: string[];
}

export interface CaseAnalysisNotAvailable {
  id: string;
  caseNumber?: string;
  hasAnalysis: false;
  message: string;
}

export interface CaseAnalysisAvailable {
  id: string;
  caseNumber?: string;
  hasAnalysis: true;
  analysis: CaseAnalysisData;
}

export type CaseAnalysis = CaseAnalysisNotAvailable | CaseAnalysisAvailable;

export interface GetCaseAnalysisMeta {
  responseTime: string;
  /** Empty string when the analysis exists, otherwise a hint to call the analyze endpoint. */
  note: string;
}

/* -------------------------------------------------------------------------- */
/* 6. GET /cases/{id}/related                                                 */
/* -------------------------------------------------------------------------- */

export interface RelatedDocument {
  id: string;
  title?: string;
  caseNumber?: string;
  court?: string;
  /** `YYYY-MM-DD`. */
  decisionDate: string;
  caseType?: string;
  isCurrent: boolean;
}

export type TimelineEventStatus = "Final Judgment" | "Hearings / Orders" | "Case Initiated";

export interface TimelineEvent {
  date: string;
  status: TimelineEventStatus;
  /** `disposalNature` when present, otherwise the status. */
  statusLabel: string;
  documentId: string;
}

export interface RelatedResponse {
  relatedDocuments: RelatedDocument[];
  timeline: TimelineEvent[];
}

export interface RelatedMeta {
  responseTime: string;
  /** Absent on the no case number variant. */
  caseNumber?: string;
  /** Absent on the no case number variant. */
  totalDocuments?: number;
  /** Absent on the no case number variant. */
  timelineEvents?: number;
  /** Present only when the case has no caseNumber: `"No case number found for this case"`. */
  message?: string;
}

/* -------------------------------------------------------------------------- */
/* 7. GET /cases/{id}/pdf                                                     */
/* -------------------------------------------------------------------------- */

export interface PdfResponse {
  /** Ciphertext, not a fetchable URL, decryption is not part of this API surface. */
  pdfUrl: string;
  /** Always 3600, the URL is valid for one hour. */
  expiresIn: number;
  caseId: string;
  caseNumber?: string;
  caseTitle?: string;
}

export interface GetPdfMeta {
  responseTime: string;
  note: string;
}

/* -------------------------------------------------------------------------- */
/* 8. POST /cases/{id}/analyze                                                */
/* -------------------------------------------------------------------------- */

export interface AnalyzeCaseOptions {
  /** Default false. */
  force?: boolean;
  /**
   * Required (`true`) when the only way to analyze this case is fetching its
   * document from an external URL (no `rawText` and no S3-stored document).
   * Not available on the Free tier (`REMOTE_FETCH_NOT_ALLOWED`, 403), and the
   * target host must be on the server's allowlist (also
   * `REMOTE_FETCH_NOT_ALLOWED` when it is not). Adds a credit surcharge on
   * top of the base analyze price, charged once at admission. Default false.
   */
  allowRemoteFetch?: boolean;
}

export interface AnalyzeCaseStarted {
  message: string;
  status: "processing";
}

export interface AnalyzeCaseAlreadyExists {
  message: string;
  /** Same analysis object as the analysis endpoint, minus the internal analysisModel/analysisVersion/analysisDate/analysisMethod fields. */
  analysis: CaseAnalysisData;
  alreadyExists: true;
}

export type AnalyzeCaseResult = AnalyzeCaseStarted | AnalyzeCaseAlreadyExists;

export interface AnalyzeCaseMeta {
  responseTime: string;
  note: string;
}

/* -------------------------------------------------------------------------- */
/* 9. POST /cases/{id}/analyze-consolidated                                   */
/* -------------------------------------------------------------------------- */

export interface AnalyzeConsolidatedOptions {
  force?: boolean;
}

export interface ConsolidatedAnalysisData extends CaseAnalysisData {
  benchComposition?: unknown;
  opinionType?: string;
  factPattern?: unknown;
  linkedCases?: unknown;
  outcome?: string;
}

export interface AnalyzeConsolidatedResult {
  status: "success" | "already_analyzed";
  consolidatedAnalysis: ConsolidatedAnalysisData;
  message?: string;
}

export interface AnalyzeConsolidatedMeta {
  responseTime: string;
  /** Present only on the success status, absent on already_analyzed. */
  relatedCases?: number;
}

/* -------------------------------------------------------------------------- */
/* 10. POST /request-timeline                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Job status values stored on the `case_jobs` record behind the timeline
 * endpoints. `running` only ever appears on GET /get-timeline, never on the
 * POST /request-timeline response. The union is widened with `(string & {})`
 * because the job type on the server side is extensible, so a future status
 * will not break type checking for callers.
 */
export type TimelineJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | (string & {});

/** An order document as returned in `orders[]` by both timeline endpoints. */
export interface OrderDocument {
  _id: string;
  title?: string;
  caseNumber?: string;
  decisionDate?: string;
  court?: string;
  caseType?: string;
  disposalNature?: string;
  judges?: string[];
  judge?: string;
  petitioners?: string[];
  respondents?: string[];
  /** Whether a document exists. The API never discloses where it is stored. */
  hasS3Key?: boolean;
}

export interface RequestTimelineOptions {
  /**
   * Force a live fetch from the court portal instead of serving the last
   * stored read. Default false. Costs 20 credits when it actually triggers
   * live work, versus 1 credit for a stored read - see `meta.liveFetch` on
   * the response to see which one happened. Not available on the Free tier
   * (`LIVE_FETCH_NOT_ALLOWED`, 403) and capped per day per tier
   * (`LIVE_FETCH_LIMIT_REACHED`, 429).
   */
  refresh?: boolean;
}

export interface RequestTimelineResult {
  /** The job id, or the case id itself for Supreme Court cases. */
  requestId: string;
  status: TimelineJobStatus;
  /** True when a timeline was already fetched today. */
  cached?: boolean;
  message?: string;
  orderCount?: number;
  orders?: OrderDocument[];
  /** Present, and `false`, only when this case's court does not support a live refresh at all (`refresh` is then a no-op regardless of tier). */
  liveFetchSupported?: boolean;
}

export interface RequestTimelineMeta {
  /** Whether this call actually reached a live source (true) or served a stored read (false), regardless of whether `refresh` was requested. Drives which of the two prices was charged. */
  liveFetch: boolean;
  responseTime: string;
}

/* -------------------------------------------------------------------------- */
/* 11. GET /get-timeline/{requestId}                                          */
/* -------------------------------------------------------------------------- */

export interface TimelineJob {
  requestId: string;
  status: TimelineJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** Omitted whenever `totalOrderCount` is present. */
  result?: unknown;
  orders?: OrderDocument[];
  orderCount?: number;
  totalOrderCount?: number;
}

export interface GetTimelineMeta {
  responseTime: string;
}

/* -------------------------------------------------------------------------- */
/* 12. GET /health                                                            */
/* -------------------------------------------------------------------------- */

/** One dependency's result within `HealthResponse.checks` (`deep: true` only). */
export interface HealthCheckResult {
  status: "ok" | "degraded" | "down" | (string & {});
  latencyMs?: number;
  error?: string;
}

/**
 * Not enveloped in `data`, this endpoint has its own top level shape.
 *
 * `commit`, `checks` and `requestId` are only present when the plain form
 * (`deep` not passed, or falsy) is being described loosely - in practice
 * `commit` is always sent, `checks` only when `deep: true` was passed to
 * `health()`, and `requestId` is backfilled by this SDK from the
 * `X-Request-Id` response header. `status` is `"healthy"` on the plain
 * form; the deep form's `status` is one of `"healthy"`, `"degraded"` or
 * `"unhealthy"` (the last one only alongside HTTP 503, meaning a hard
 * dependency - Mongo or OpenSearch - is down).
 */
export interface HealthResponse {
  success: boolean;
  status: string;
  version: string;
  /** The deployed commit SHA, or `null` when the server has no `GIT_SHA` set. */
  commit?: string | null;
  /** Present only when `deep: true` was passed: one entry per dependency (Mongo, OpenSearch, Qdrant, Redis, IAM). */
  checks?: Record<string, HealthCheckResult>;
  timestamp: string;
  requestId?: string;
}

/* -------------------------------------------------------------------------- */
/* 13. POST /party/screen                                                     */
/* -------------------------------------------------------------------------- */

export type PartyEntityType = "person" | "company";

/**
 * Required. Never logged, only the purpose itself, the entity type and
 * aggregate counts are, see the DPDP note in the README.
 */
export type PartyScreenPurpose = "kyc" | "bgv" | "due_diligence" | "litigation" | "research" | "compliance";

export interface PartyScreenIdentifiers {
  pan?: string;
  gstin?: string;
  cin?: string;
  llpin?: string;
}

export interface PartyScreenAddress {
  city?: string;
  state?: string;
  stateCode?: string;
}

export interface PartyScreenOptions {
  /** Required, 2..200 characters. */
  name: string;
  /** Alternate spellings or names, at most 7. */
  aliases?: string[];
  entityType: PartyEntityType;
  /** Required, drives DPDP purpose limitation logging, never the name itself. */
  purpose: PartyScreenPurpose;
  identifiers?: PartyScreenIdentifiers;
  address?: PartyScreenAddress;
  /** Names of persons known to be associated with this party, improves disambiguation for common names. */
  knownPersons?: string[];
  court?: StringOrArray;
  /** `YYYY-MM-DD`, only cases on or after this date are considered. */
  since?: string;
  /** 1..100, default 40. */
  limit?: number;
  /**
   * Run LLM adjudication on ambiguous candidates, capped at 40 per call.
   * Default false. Adds a flat credit surcharge on top of the base
   * match/no-match price, but only when `result.adjudicationsRun > 0` -
   * every candidate may already have been decided deterministically, in
   * which case the model is never called and no surcharge is billed even
   * though this was `true`. Not available on the Free tier
   * (`API_TIER_NOT_ALLOWED`, 403).
   */
  adjudicate?: boolean;
  /** Minimum calibrated confidence score, 0..1, required to appear in `matches` rather than `relatedButUnverified`. */
  displayThreshold?: number;
}

export type PartyScreenBand = "confirmed" | "probable" | "possible" | "unlikely";

/**
 * `no_matches_found` is only ever returned when `coverage.exhaustive` is
 * true and nothing was withheld. `matches_found` describes what the screen
 * found internally, independent of `displayThreshold`: raising
 * `displayThreshold` can leave `matches` empty (`summary.matchCount: 0`)
 * while the verdict is still `matches_found`, because something did match,
 * it is just not shown at your threshold. `inconclusive` covers every case
 * where the screen cannot certify a clean negative: `since` was supplied
 * (a best-effort filter, so completeness can never be certified either way),
 * something was withheld by the restricted-case gate, or the underlying
 * search itself was not exhaustive.
 */
export type PartyScreenVerdict = "matches_found" | "no_matches_found" | "inconclusive";

export interface PartyScreenConfidence {
  band: PartyScreenBand;
  /** Alias of `calibrated`, kept as a stable top-level "the number" field. */
  score: number;
  /** The score after calibration against the golden fixture, use this one. */
  calibrated: number;
  /** Which resolution engine produced this confidence: `"rules"` for the deterministic resolver, `"llm"` when `adjudicate: true` triggered adjudication for this candidate (or the LLM path degraded and fell back to rules). */
  engine: "rules" | "llm";
}

export interface PartyScreenSignal {
  name: string;
  status: "matched" | "conflicted" | "absent";
  weight: "strong" | "moderate" | "weak";
  /** The exact input token(s) the signal is grounded in (no outside knowledge). Absent when there is nothing to cite. */
  evidence?: string;
}

export interface PartyScreenEvidence {
  entityMatch: boolean;
  matchedFields: string[];
  strategies: string[];
  signals: PartyScreenSignal[];
  nameSimilarity: number;
  disambiguatorPresent: boolean;
}

/** `"unknown"` when the candidate's role in the case could not be determined. */
export type PartyRole = "petitioner" | "respondent" | "unknown";

export interface PartyScreenMatch {
  caseId: string;
  title?: string;
  court?: string;
  caseNumber?: string;
  cnr?: string;
  caseType?: string;
  acts?: string[];
  sections?: string[];
  petitioners?: string[];
  respondents?: string[];
  filingDate?: string;
  decisionDate?: string;
  disposalNature?: string;
  citation?: string;
  summary?: string;
  casePageUrl?: string;
  partyRole: PartyRole;
  confidence: PartyScreenConfidence;
  evidence: PartyScreenEvidence;
  rationale?: string;
}

/**
 * The plain case fields only: everything on `PartyScreenMatch` except
 * `partyRole`, `confidence`, `evidence` and `rationale`. A candidate the
 * screen found but could not confidently confirm, below `displayThreshold`
 * or withheld from full confidence scoring for another reason.
 */
export type PartyScreenRelatedMatch = Omit<PartyScreenMatch, "partyRole" | "confidence" | "evidence" | "rationale">;

export interface PartyScreenByBand {
  confirmed: number;
  probable: number;
  possible: number;
  unlikely: number;
}

export interface PartyScreenSummary {
  matchCount: number;
  byBand: PartyScreenByBand;
  highestBand: PartyScreenBand | null;
  verdict: PartyScreenVerdict;
}

/**
 * Exactly these six fields, no more: `candidatesEvaluated` and
 * `adjudicationsRun` are not part of this object (`adjudicationsRun` is a
 * top level field of `PartyScreenResult` instead, see below).
 */
export interface PartyScreenCoverage {
  /** Every strategy that could run, ran, and no candidate result was clamped by plan limits. */
  exhaustive: boolean;
  /** Exhaustive within the filters supplied (`court`, `since`), which may themselves narrow the corpus searched. */
  exhaustiveWithinFilters: boolean;
  /** True when the account's plan clamped candidate evaluation below what a full search would have covered. */
  planClamped: boolean;
  anyStrategyErrored: boolean;
  strategiesRun: string[];
  /** True when one or more candidate cases were removed from the results because they are restricted, see the takedown notice. */
  someRecordsWithheld: boolean;
}

/** The normalised request, echoed back for audit trails. */
export interface PartyScreenQueryEcho {
  name: string;
  aliases: string[];
  entityType: PartyEntityType;
  purpose: PartyScreenPurpose | string;
  /** The single court filter actually applied (never the raw request's array-or-string shape), absent when none was supplied. */
  court?: string;
  since?: string;
  limit: number;
  adjudicate?: boolean;
  displayThreshold: number;
}

export interface PartyScreenResult {
  query: PartyScreenQueryEcho;
  summary: PartyScreenSummary;
  matches: PartyScreenMatch[];
  relatedButUnverified: PartyScreenRelatedMatch[];
  coverage: PartyScreenCoverage;
  /**
   * How many candidates were actually sent to the LLM for adjudication.
   * Requesting `adjudicate: true` alone does not guarantee this is greater
   * than 0: every candidate may already have been decided deterministically
   * (an exact identifier match or a below-floor name similarity), in which
   * case the model is never called and this stays 0 - which is also why the
   * adjudication credit surcharge is billed on this being greater than 0,
   * not on the request flag alone.
   */
  adjudicationsRun: number;
  /** Links the case removal / takedown policy, and any withheld-records disclosure. */
  notice: string;
}

export interface PartyScreenMeta {
  /** 100 credits when matches are found, 20 when none are, plus 80 when `adjudicate: true` was honoured. */
  creditsCharged: number;
  adjudicated: boolean;
  /** ISO date the underlying corpus snapshot is current as of. */
  corpusAsOf: string;
}

/* -------------------------------------------------------------------------- */
/* 14. GET /coverage                                                          */
/* -------------------------------------------------------------------------- */

export interface CoverageByCourtType {
  courtType: string;
  records: number;
  documentBearing: number;
  latestDecisionDate?: string;
}

export interface CoverageByYear {
  year: number;
  records: number;
}

export interface CoverageCourt {
  court: string;
  courtType: string;
  records: number;
  documentBearing: number;
  earliestDecisionDate?: string;
  latestDecisionDate?: string;
  /** How many business days behind live filings this court's index appears to be. */
  businessDaysBehind?: number;
}

/** District Courts are reported as a single rolled up row, the index has no per-state field. */
export interface CoverageDistrictCourts {
  records: number;
  documentBearing: number;
  latestDecisionDate?: string;
  businessDaysBehind?: number;
}

export interface CoverageData {
  generatedAt: string;
  /** The OpenSearch index this snapshot was counted from, for example `"courtmesh_cases_v3"`. */
  index: string;
  total: number;
  documentBearing: number;
  statusOnly: number;
  byCourtType: CoverageByCourtType[];
  byYear: CoverageByYear[];
  courts: CoverageCourt[];
  districtCourts: CoverageDistrictCourts;
}

export interface CoverageMeta {
  generatedAt: string;
  /** How long this response may be served from cache, currently 21600 (6 hours). */
  cacheTtlSeconds: number;
  corpusNote?: string;
}

/* -------------------------------------------------------------------------- */
/* 15. GET /usage                                                             */
/* -------------------------------------------------------------------------- */

export type ApiTier = "free" | "payg" | "scale" | "enterprise" | (string & {});

export interface UsageWalletOwner {
  type: "user" | "org";
  id: string;
}

export interface UsageBalance {
  total: number;
  monthlyGrant: number;
  signupGrant: number;
  purchased: number;
}

/** Mirrors the server's `TierLimits` (server/config/api-tiers.ts). `-1` means unlimited on any per period field. */
export interface UsageTierLimits {
  requestsPerMinute: number;
  requestsPerDay: number;
  requestsPerMonth: number;
  maxPageSize: number;
  maxPaginationDepth: number;
  distinctCaseFetchesPerDay: number;
  pdfCallsPerMonth: number;
  aiCallsPerMonth: number;
  concurrentAnalyzeJobs: number;
  apiKeys: number;
  semanticSearchAllowed: boolean;
  liveFetchAllowed: boolean;
  liveFetchesPerDay: number;
  analysisReadAllowed: boolean;
  partyScreensPerMonth: number;
}

/** The [start, end] ISO timestamps of the Asia/Kolkata calendar month this usage was aggregated over. */
export interface UsagePeriod {
  start: string;
  end: string;
  /** `"YYYY-MM"`. */
  key: string;
}

export interface UsageByEndpoint {
  endpoint: string;
  calls: number;
  credits: number;
}

export interface UsageData {
  tier: ApiTier;
  walletOwner: UsageWalletOwner;
  balance: UsageBalance;
  limits: UsageTierLimits;
  period: UsagePeriod;
  creditsUsedThisPeriod: number;
  byEndpoint: UsageByEndpoint[];
  subscriptionRenewsAt: string | null;
}

export interface UsageMeta {
  requestId: string;
}

/* -------------------------------------------------------------------------- */
/* 16. GET /me                                                                */
/* -------------------------------------------------------------------------- */

export interface MeData {
  userId: string;
  email?: string;
  name: string | null;
  role: string | null;
  /** Only present when the account belongs to an organization. */
  organizationId?: string;
}

/* -------------------------------------------------------------------------- */
/* 17. GET /audit                                                             */
/* -------------------------------------------------------------------------- */

export interface AuditOptions {
  /** Required if `userId` is omitted. Must be the caller's own organization, or `PermissionError`. */
  organizationId?: string;
  /** Required if `organizationId` is omitted. Must be the caller's own id, or an org admin's teammate, or `PermissionError`. */
  userId?: string;
  /** 1..200, default 50. */
  limit?: number;
  /** Default 0. */
  offset?: number;
  /** ISO 8601. */
  startDate?: string;
  /** ISO 8601. */
  endDate?: string;
}

export interface AuditHit {
  id: string;
  userId?: string;
  organizationId?: string;
  endpoint: string;
  method: string;
  statusCode: number;
  responseTime: number;
  isAiAnalysis?: boolean;
  creditsDeducted?: number;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
}

export interface AuditTopEndpoint {
  endpoint: string;
  count: number;
}

export interface AuditSummary {
  totalHits: number;
  totalAiAnalysisHits: number;
  avgResponseTime: number;
  successfulHits: number;
  /** A string, e.g. `"98.5"` - the server formats it with `toFixed(1)`. */
  successRate: string;
  totalCreditsDeducted: number;
}

export interface AuditData {
  hits: AuditHit[];
  summary: AuditSummary;
  topEndpoints: AuditTopEndpoint[];
}

export interface AuditPagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** `GET /audit` nests its own pagination shape under the envelope, distinct from `KeywordSearchPagination`/`SemanticSearchPagination`. */
export interface AuditResponse {
  success: true;
  data: AuditData;
  pagination: AuditPagination;
  requestId?: string;
}

/* -------------------------------------------------------------------------- */
/* 18. GET /reference/courts                                                 */
/* -------------------------------------------------------------------------- */

/** court/courtType -> display name(s). */
export type CourtNamesMap = Record<string, string[]>;

export interface CourtHierarchy {
  /** The 4 court types (level 1). */
  courtTypes: string[];
  /** courtType -> court values (level 2). High Court is collapsed to representatives. */
  courtsByType: CourtNamesMap;
  /** court -> courtName values (level 3). Includes an entry per High Court representative. */
  courtNamesByCourt: CourtNamesMap;
}

/** No API key required. Not enveloped with `meta`, only `data`. */
export interface ReferenceCourtsResponse {
  success: true;
  data: CourtHierarchy;
  requestId?: string;
}

/* -------------------------------------------------------------------------- */
/* 19. GET /reference/case-types                                             */
/* -------------------------------------------------------------------------- */

export interface CaseTypeEntry {
  code: string;
  fullForm: string;
  primaryType: string;
  nature: string;
}

/** No API key required. Not enveloped with `meta`, only `data`. Deduplicated by code, sorted. */
export interface ReferenceCaseTypesResponse {
  success: true;
  data: CaseTypeEntry[];
  requestId?: string;
}

/* -------------------------------------------------------------------------- */
/* 20. POST /party/screen/batch                                              */
/* -------------------------------------------------------------------------- */

export interface PartyScreenBatchItem {
  /** Echoed back on the matching result item so you can line results up with requests; not sent to the server otherwise. */
  clientRef?: string;
  /** Required, 2..200 characters. */
  name: string;
  /** Alternate spellings or names, at most 7. */
  aliases?: string[];
  /** Falls back to the batch level `entityType` when omitted here. */
  entityType?: PartyEntityType;
  identifiers?: PartyScreenIdentifiers;
  address?: PartyScreenAddress;
  knownPersons?: string[];
  court?: StringOrArray;
  /** `YYYY-MM-DD`. */
  since?: string;
  /** 1..100, default 40. */
  limit?: number;
  /** Minimum calibrated confidence score, 0..1. */
  displayThreshold?: number;
}

export interface PartyScreenBatchOptions {
  /** 1..25 items. */
  items: PartyScreenBatchItem[];
  /** Required, drives DPDP purpose limitation logging for every item in this batch. */
  purpose: PartyScreenPurpose;
  /** Default entityType applied to any item that does not specify its own. */
  entityType?: PartyEntityType;
  /**
   * LLM adjudication is not supported in the batch endpoint. This field
   * only ever accepts `false` (or omission); pass `adjudicate: true` to
   * `screenParty` one item at a time instead.
   */
  adjudicate?: false;
}

export interface PartyScreenBatchItemOk {
  clientRef?: string;
  /** The item's 0 based position in the request's `items` array. */
  index: number;
  ok: true;
  screen: PartyScreenResult;
}

export interface PartyScreenBatchItemError {
  clientRef?: string;
  index: number;
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type PartyScreenBatchItemResult = PartyScreenBatchItemOk | PartyScreenBatchItemError;

export interface PartyScreenBatchSummary {
  items: number;
  matchesFound: number;
  noMatches: number;
  inconclusive: number;
  errors: number;
}

export interface PartyScreenBatchResult {
  results: PartyScreenBatchItemResult[];
  summary: PartyScreenBatchSummary;
}

export interface PartyScreenBatchMeta {
  /** Sum of the credits charged across every item that ran (a per-item error charges nothing for that item). */
  creditsCharged: number;
  requestId: string;
  /** Present, and `true`, only when the batch itself was clamped (for example the server capped how many items it would run). */
  truncated?: boolean;
  /** Present only alongside `truncated: true`. */
  truncatedReason?: string;
}
