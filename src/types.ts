/**
 * Types for the CourtMesh Enterprise API.
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
}

/* -------------------------------------------------------------------------- */
/* Pagination, two distinct shapes, do not unify them                        */
/* -------------------------------------------------------------------------- */

/**
 * Pagination shape returned by `POST /search/cases`.
 *
 * `page` is absent when the caller used cursor pagination via `searchAfter`.
 * `totalPages` does not exist on this endpoint. `nextCursor` is an array or
 * null, its element types are not documented beyond the example
 * `[12.34, "68f0..."]`, so it is modeled loosely.
 */
export interface KeywordSearchPagination {
  total: number;
  hasMore: boolean;
  page?: number;
  limit: number;
  nextCursor: Array<number | string> | null;
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
  /** Accepted and echoed back in `meta.filters`, but never applied server side. */
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
  /** Min 1, default 1. */
  page?: number;
  /** 1..100, default 20. */
  limit?: number;
  /** Cursor for `searchAfter` pagination. A JSON encoded array string is accepted. */
  searchAfter?: string;
  /**
   * Only `"relevance"` is meaningful today, the search backend actually
   * expects `relevance|recent|oldest` while this field only validates
   * `relevance|date`.
   */
  sortBy?: "relevance" | "date";
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
  _id: string;
  _score: number;
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
  s3Key?: string;
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
  /** Validated but ignored by the handler, use `filters` instead. */
  court?: StringOrArray;
  /** Validated but ignored by the handler, use `filters` instead. */
  caseType?: StringOrArray;
  /** Validated but ignored by the handler, use `filters` instead. */
  caseNumber?: StringOrArray;
  /** Validated but ignored by the handler, use `filters` instead. */
  judgeName?: StringOrArray;
  /** Validated but ignored by the handler, use `filters` instead. */
  judges?: StringOrArray;
  /** Validated but ignored by the handler, use `filters` instead. */
  judge?: StringOrArray;
  /** Validated but ignored by the handler, use `filters` instead. */
  year?: YearParam;
  /** Validated but ignored by the handler, use `filters` instead. */
  fromDate?: string;
  /** Validated but ignored by the handler, use `filters` instead. */
  toDate?: string;
  /** Min 1, default 1. */
  page?: number;
  /** 1..100, default 20. */
  limit?: number;
  /** The channel the handler actually reads filters from. */
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
  /** Present only on the no results variant: `"No similar cases found."`. */
  message?: string;
  /** Present only when the cleaned query was too short and the handler fell back to keyword search. */
  fallbackMode?: "opensearch";
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

export type TimelineJobStatus = "pending" | "completed" | "failed";

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
  hasS3Key?: boolean;
  s3Key?: string;
  s3Bucket?: string;
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
}

export interface RequestTimelineMeta {
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

/** Not enveloped in `data`, this endpoint has its own top level shape. */
export interface HealthResponse {
  success: true;
  status: string;
  version: string;
  timestamp: string;
}
