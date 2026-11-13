/**
 * Types for `POST /party/profile` and `GET /party/profile/{requestId}`.
 *
 * A party profile is everything `screenParty` finds, grouped into identities
 * and enriched with each case's status, acts, FIR details and documents. A
 * quick profile answers in one call; a full profile answers 202 at once and
 * the work runs behind it (read it with `getPartyProfileRequest`).
 */
import type { CourtRecordAct, CourtRecordFir, PartyScreenOptions, PartyScreenRelatedMatch, SameMatterEntry } from "./types.js";

export type PartyProfileBand = "confirmed" | "probable" | "possible" | "unlikely";

/** Which sections to build. Omitted means all of them. */
export type PartyProfileSection = "documents" | "acts" | "fir" | "status" | "summary";

/** Where to send the notice when a full profile ends. */
export interface PartyProfileWebhookOptions {
  /** A public https address. No credentials in the url. Redirects are not followed. */
  url: string;
  /**
   * Headers to send with the notice, for example your own `Authorization`.
   * At most 20, each value at most 1024 printable characters. Headers the
   * delivery sets itself (such as `Content-Type`, `Host` and any
   * `CourtMesh-` header) are refused.
   */
  headers?: Record<string, string>;
}

/**
 * Every field of `PartyScreenOptions`, with the same validation and caps,
 * plus the profile fields.
 */
export interface PartyProfileOptions extends PartyScreenOptions {
  /**
   * `"full"`: answer 202, then refresh every case of the first identity from
   * its court, analyse each case and write an analysis of the party; read the
   * outcome with `getPartyProfileRequest`. `"quick"`: the profile from what is
   * held, in one answer. The server defaults to `"full"` where full mode is
   * available, else `"quick"`. Send `"quick"` explicitly when you want one
   * answer in one call.
   */
  mode?: "full" | "quick";
  /**
   * Full mode only. The most this request may spend, 100 to 5000; the work
   * stops there. Server default 1000, or your balance if that is lower.
   */
  maxCredits?: number;
  /** Full mode only. Where to send the notice when the request ends. */
  webhook?: PartyProfileWebhookOptions;
  /**
   * The lowest band an identity needs to be reported as the primary, and the
   * lowest band a case of the primary needs to be listed, enriched and
   * billed. Server default: `probable` for a person, `possible` for a company.
   */
  minConfidence?: "possible" | "probable" | "confirmed";
  /**
   * Which sections to build, at least one. Omitted means all of them.
   * `documents` and `status` need the case records to be read (and are what
   * the per case reads bill for); `acts`, `fir` and `summary` cost nothing
   * extra.
   */
  include?: PartyProfileSection[];
  /**
   * For a person, let a group of cases matched on name alone be reported as
   * the primary. Default false: such a group is listed under
   * `possibleOtherPeople` and the verdict is `no_confirmed_identity`.
   */
  allowUnconfirmedPrimary?: boolean;
}

export interface PartyProfileCreditCount {
  count: number;
  credits: number;
}

/** What each part of a quick profile cost. */
export interface PartyProfileCreditsBreakdown {
  /** Search calls that completed. A call that failed is not counted. */
  searches: PartyProfileCreditCount;
  /** Case records read for status and documents. */
  caseRecords: PartyProfileCreditCount;
  /** Documents listings read that offered a document. */
  documentLists: PartyProfileCreditCount;
  /** Present only when the AI review was charged, never above the 80 credit allowance. */
  aiReview?: PartyProfileCreditCount;
  /** Present only when the call used less than 100 credits: the top up to that minimum, so the parts add up. */
  minimumCharge?: { credits: number };
}

/** `meta` of a quick profile (200). */
export interface PartyProfileMeta {
  /** What actually left the wallet on this call, or 0 whenever `metered` is false. */
  creditsCharged: number;
  /** Whether this account is billed for API credits at all. */
  metered: boolean;
  creditsBreakdown: PartyProfileCreditsBreakdown;
  /** Echo of the request's `adjudicate` flag. */
  adjudicated: boolean;
  corpusAsOf: string;
  responseTime?: string;
  requestId?: string;
}

/** `meta` of an accepted full profile (202) and of the status call. Both cost nothing. */
export interface PartyProfileRequestMeta {
  creditsCharged?: number;
  metered?: boolean;
  requestId?: string;
}

/** One document held for a case. Never the document body. */
export interface PartyProfileDocument {
  /** Usable as `documentId` on `getCaseDocumentText`. */
  documentId: string;
  kind: "case_document" | "order";
  /** YYYY-MM-DD, or null when the record carries no date. */
  date: string | null;
  links: {
    /** Path of the text endpoint, relative to the API base; null when the text is not offered. */
    text: string | null;
    /**
     * A download URL valid for one hour that needs no API key; null when no
     * PDF is held that may be shown. Receiving the link is free. The first
     * time it is opened it is charged as one PDF call to the key that read the
     * profile and counts toward the monthly PDF limit; opening it again is
     * free. An expired link answers 403 `DOWNLOAD_LINK_INVALID`: read the
     * profile again for fresh links.
     */
    pdf: string | null;
    /** When `pdf` stops working. Present only with a link. */
    pdfExpiresAt?: string;
  };
}

export type PartyProfileCourtRefreshStatus =
  | "refreshed"
  | "already_current"
  | "recently_refreshed"
  | "not_supported_for_this_court"
  | "not_available"
  | "not_found_at_court"
  | "no_cnr"
  | "in_progress"
  | "failed"
  | "timed_out"
  | "not_started";

export type PartyProfileCaseAnalysisStatus = "new" | "updated" | "existing" | "short" | "not_done";

/** One case of the primary identity. Fields with no value are left out. */
export interface PartyProfileCase {
  /** Usable as the `id` on the case methods. */
  caseId: string;
  cnr?: string;
  /** The case number as filed. Present only when it differs from `cnr`. */
  caseNumber?: string;
  /** The court name. */
  court?: string;
  /** Supreme Court, High Court, Tribunal or District Court. */
  courtType?: string;
  /** Tribunal cases only: the bench that heard the matter. */
  bench?: string;
  caseType?: string;
  title?: string;
  petitioners?: string[];
  respondents?: string[];
  partyRole: "petitioner" | "respondent" | "unknown";
  /** `unknown` when the court record does not state it or `status` was not included. */
  status: "pending" | "disposed" | "unknown";
  filingDate?: string;
  /** The next listing, as recorded by the court. Present when `include` has `status`, the record was read and it lists one. */
  nextHearingDate?: string;
  /** YYYY-MM-DD of a real decision; null for a pending case. */
  decisionDate: string | null;
  disposalNature?: string;
  /** Acts from analysis of the judgment. Present when `include` has `acts`. */
  acts?: string[];
  sections?: string[];
  /** Acts and sections as the court record states them. Present when `include` has `acts` and the court record lists them. */
  courtRecordActs?: CourtRecordAct[];
  /** District cases only. Present when `include` has `fir`, under the same rule as `courtRecordActs`. */
  courtRecordFir?: CourtRecordFir[];
  /** Supreme Court only: the other orders and documents of the same matter. */
  sameMatter?: SameMatterEntry[];
  /** How likely this case is to belong to the subject. */
  confidence: PartyProfileBand;
  /** Plain sentences naming the details that tied this case to the subject. */
  matchReasons?: string[];
  /** Present when `include` has `documents` and the listing was read. Newest first. */
  documents?: PartyProfileDocument[];
  /** Present when the order text and order PDFs of this case are not offered. */
  documentsNote?: string;
  /** Present, and true, when the case holds more documents than one listing carries. */
  documentsMore?: true;
  /** Full mode only: how the read from the court went for this case. */
  courtRefresh?: {
    status: PartyProfileCourtRefreshStatus;
    /** How many tries were made. Present only when there was more than one. */
    attempts?: number;
  };
  /**
   * Full mode only. `new` was written for this request, `updated` replaced an
   * older one, `existing` was current and reused, `short` is a brief summary
   * written for this request only, and `not_done` carries a `reason`.
   */
  analysis?: {
    status: PartyProfileCaseAnalysisStatus;
    summary?: string;
    outcome?: string | null;
    issues?: string[];
    analysedAt?: string;
    reason?: string;
  };
}

export type PartyProfileCategory =
  | "criminal"
  | "civil"
  | "tax"
  | "insolvency"
  | "banking and recovery"
  | "cheque bounce NI Act 138"
  | "consumer"
  | "labour"
  | "other";

/** Built from the returned cases without a model. Counts of zero, empty lists and unknown dates are left out. */
export interface PartyProfileSummary {
  summary?: string;
  byCourtType?: Record<string, number>;
  byRole?: { petitioner?: number; respondent?: number; unknown?: number };
  pending: number;
  disposed: number;
  /** Cases whose status the court record does not state. Present only when there are some. */
  statusUnknown?: number;
  categories?: Array<PartyProfileCategory | (string & {})>;
  flags?: string[];
  /** Earliest date on any record, YYYY-MM-DD. */
  firstSeen?: string;
  /** Latest past date on any record, YYYY-MM-DD. */
  lastActivity?: string;
}

/** The primary identity: the cases judged to belong to the person or company asked about. */
export interface PartyProfileIdentity {
  /** The band of the identity's strongest case. */
  confidence: PartyProfileBand;
  /** Plain sentences explaining the grouping. */
  why: string[];
  caseCount: number;
  profile?: PartyProfileSummary;
  cases: PartyProfileCase[];
}

/** Basic facts of a case of another identity, at no extra cost. Fields with no value are left out. */
export interface PartyProfileOtherCase {
  caseId: string;
  cnr?: string;
  caseNumber?: string;
  court?: string;
  caseType?: string;
  title?: string;
  petitioners?: string[];
  respondents?: string[];
  partyRole?: "petitioner" | "respondent";
  filingDate?: string;
  decisionDate?: string;
  disposalNature?: string;
}

/** An identity other than the primary. `why` says which kind. */
export interface PartyProfileOtherIdentity {
  confidence: PartyProfileBand;
  why: string[];
  caseCount: number;
  caseIds: string[];
  cases?: PartyProfileOtherCase[];
}

/**
 * Full mode only. Written by a model from the court record facts and case
 * analyses of this profile only. Being a party to a case is not a finding
 * against anyone.
 */
export interface PartyProfileAnalysis {
  overview: string;
  litigationPattern: string;
  keyRisks: Array<{ risk: string; caseIds: string[] }>;
  notableCases: Array<{ caseId: string; why: string }>;
  openMatters: Array<{ caseId: string; note: string }>;
  caveats: string[];
}

export type PartyProfileVerdict = "identity_found" | "no_confirmed_identity" | "no_matches_found" | "inconclusive";

export interface PartyProfileResult {
  subject: {
    name: string;
    entityType: "person" | "company";
    /** Present when the request gave aliases. */
    aliases?: string[];
  };
  verdict?: PartyProfileVerdict | (string & {});
  /** One plain sentence on what was found. */
  summary?: string;
  /** The primary identity, in full. Empty when none reaches `minConfidence`. */
  identities: PartyProfileIdentity[];
  possibleOtherPeople: PartyProfileOtherIdentity[];
  /** As on `screenParty`: plain case fields only. */
  relatedButUnverified: PartyScreenRelatedMatch[];
  /** Full mode only. Null when it could not be written (`notes` says why). */
  partyAnalysis?: PartyProfileAnalysis | null;
  /** Always present. Plain sentences on anything left out; empty when nothing was. */
  notes: string[];
  notice?: string;
}

/** The 202 answer of a full profile. Nothing is charged yet. */
export interface PartyProfileAccepted {
  /** `ppr_` followed by 32 hex characters. Pass it to `getPartyProfileRequest`. */
  requestId: string;
  mode: "full";
  status: "queued";
  /** Path of the status call for this request. */
  statusUrl: string;
  /** The most this request may spend. */
  maxCredits: number;
  /** Present when the request carried `webhook`. */
  webhook?: {
    /** Shown once: store it. The key for checking `CourtMesh-Signature` on the completion notice. */
    signingSecret: string;
    note?: string;
  };
}

export type PartyProfileRequestState = "queued" | "running" | "completed" | "failed";

export type PartyProfileStage = "find" | "refresh" | "await_refresh" | "reread" | "analyse" | "review" | "finish";

export type PartyProfileFailureCode =
  | "INTERNAL_ERROR"
  | "PARTY_SCREEN_SEARCH_DEGRADED"
  | "INSUFFICIENT_CREDITS"
  | "SETTLEMENT_UNCONFIRMED"
  | "API_KEY_INACTIVE"
  | "PROFILE_FAILED";

/** What a full profile has been charged so far, per stage. */
export interface PartyProfileRequestCredits {
  /** What has left the wallet for this request so far. */
  charged: number;
  maxCredits: number;
  /** True while the outcome of a debit is not yet confirmed; `charged` may still rise by that stage. */
  unconfirmed?: boolean;
  breakdown: {
    search: { credits: number };
    /** Court refreshes started. A retry of a refresh is never charged. */
    courtRefreshes: PartyProfileCreditCount;
    caseAnalyses: {
      full: number;
      short: number;
      existing: number;
      tokens: number;
      credits: number;
    };
    partyAnalysis: { tokens: number; credits: number };
    /** Present only when a completed request used less than 100 credits: the top up to that minimum. */
    minimumCharge?: { credits: number };
  };
}

/** Where a full profile stands, and its result once finished. */
export interface PartyProfileRequestStatus {
  requestId: string;
  mode: "full";
  status: PartyProfileRequestState;
  /** While queued or running. */
  stage?: PartyProfileStage;
  progress: {
    /** Cases of the first identity. */
    casesFound: number;
    refreshesStarted: number;
    refreshesFinished: number;
    casesAnalysed: number;
    casesNotAnalysed: number;
    partyAnalysis: "pending" | "done" | "not_done";
  };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Until when `result` can be read. Null until the request ends. */
  resultExpiresAt: string | null;
  credits: PartyProfileRequestCredits;
  /** Present when the request carried `webhook`. */
  webhook?: { state: "pending" | "delivered" | "failed"; attempts: number };
  /** Present on a failed request. What it was charged before failing stays in `credits`. */
  failure?: { code: PartyProfileFailureCode | (string & {}); message: string };
  /** True once the result can no longer be read (30 days after the request ends). */
  resultExpired?: boolean;
  /** Present once `status` is `completed` and the result has not expired. */
  result?: PartyProfileResult;
}

/**
 * True when `buildPartyProfile` answered with an accepted full profile (202)
 * rather than a finished quick profile. Narrows `response.data`.
 */
export function isPartyProfileAccepted(data: PartyProfileResult | PartyProfileAccepted): data is PartyProfileAccepted {
  return (data as Partial<PartyProfileAccepted>).status === "queued" && typeof (data as Partial<PartyProfileAccepted>).requestId === "string";
}
