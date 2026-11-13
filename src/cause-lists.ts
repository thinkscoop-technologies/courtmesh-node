/**
 * Cause list types and the client side checks for the cause list endpoints.
 *
 * Every call here needs an API key with the `causelist` scope (keys without
 * explicit scopes have full access) and an account with cause lists enabled.
 * Only listings that were found are ever reported: an empty result, a
 * `no_entry_found` status or a missing row is not a statement that a case is
 * absent from a list.
 */
import { ValidationError } from "./errors.js";
import { normalizeCnr } from "./monitoring.js";

/* -------------------------------------------------------------------------- */
/* Shared shapes                                                              */
/* -------------------------------------------------------------------------- */

/** Pagination block of `listCauseListings`. Pages start at 1. */
export interface CauseListPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

/** `credits` meta of the cause list calls. */
export interface CauseListMeta {
  creditsCharged: number;
  metered: boolean;
  [key: string]: unknown;
}

/** The court a list belongs to. */
export interface CauseListCourt {
  /** `SC`, `HC` or `DC`. */
  kind: string | null;
  name: string | null;
  courtNo: string | null;
  judges: string[];
  designation: string | null;
}

/** One appearance of one of your matters on a cause list. */
export interface CauseListing {
  id: string;
  /** The matter in your account this listing belongs to. */
  matterId: string;
  matterTitle: string | null;
  /** Date of the list, `YYYY-MM-DD`. */
  date: string;
  /** Identifies the court. Usable as `courtKey` in `getCourtCauseList`. */
  courtKey: string;
  court: CauseListCourt | null;
  item: string | null;
  section: string | null;
  purpose: string | null;
  /** `civil` or `criminal`, when known. */
  listType: string | null;
  stage: string | null;
  /** The case number as written on the list. Null on a `related_key` match or a restricted row. */
  caseText: string | null;
  /** How the item was tied to your matter: `cnr`, `diary`, `key` or `related_key`. */
  matchedBy: string | null;
  /** Set when the item is an application or connected case of your matter rather than the matter itself. */
  relation: string | null;
  fetchedAt: string | null;
  firstSeenAt: string | null;
}

export interface CauseListRelatedItem {
  /** `application`, `connected` or `parent`. */
  relation: string | null;
  caseType: string | null;
  caseNumber: string | null;
  caseYear: string | null;
  key: string | null;
}

/** One item of a court's list. A restricted row carries no party names or advocates. */
export interface CauseListRow {
  item: string | null;
  itemRaw: string | null;
  section: string | null;
  purpose: string | null;
  listType: string | null;
  courtNo: string | null;
  courtName: string | null;
  judges: string[];
  caseText: string | null;
  caseType: string | null;
  caseNumber: string | null;
  caseYear: string | null;
  key: string | null;
  cnr: string | null;
  diaryNumber: string | null;
  diaryYear: string | null;
  petitioner: string | null;
  respondent: string | null;
  advocates: string | null;
  stage: string | null;
  related: CauseListRelatedItem[];
  restricted: boolean;
}

/**
 * What was read for a court and date. `ok` and `partial` carry rows; the
 * others carry none. `partial` means some parts of the list could not be read.
 */
export type CauseListStatus = "ok" | "partial" | "empty" | "not_published" | "unavailable" | "invalid_court" | "none";

export interface CauseListCourtList {
  courtKey: string;
  date: string;
  status: CauseListStatus;
  /** True only when every part of the list was read. */
  complete: boolean;
  fetchedAt: string | null;
  court: CauseListCourt | null;
  rows: CauseListRow[];
}

/* -------------------------------------------------------------------------- */
/* Options and responses                                                      */
/* -------------------------------------------------------------------------- */

/** Date range of the listing calls. Send both `from` and `to`, or neither (the default is today and the next 7 days). */
export interface CauseListRangeOptions {
  /** `YYYY-MM-DD`. */
  from?: string;
  /** `YYYY-MM-DD`, at most 31 days after `from`. */
  to?: string;
}

export interface ListCauseListingsOptions extends CauseListRangeOptions {
  /** From 1. */
  page?: number;
  /** 1..100 and no more than your tier's maximum page size. Defaults to 50, or to the tier maximum when that is lower. */
  limit?: number;
}

export interface CauseListingsResponse {
  success: true;
  data: CauseListing[];
  pagination: CauseListPagination;
  meta?: CauseListMeta;
  requestId?: string;
  replayed?: boolean;
}

export interface MatterCauseListings {
  matter: { id: string; title: string | null; courtKey: string | null };
  listings: CauseListing[];
}

export interface GetCourtCauseListOptions {
  /** `SC`, `HC:<state>:<bench>` or `DC:<state>:<district>:<complex>:<establishment>:<court number>`, digits only. */
  courtKey: string;
  /** `YYYY-MM-DD`. */
  date: string;
}

/* -------------------------------------------------------------------------- */
/* Watched CNR check                                                          */
/* -------------------------------------------------------------------------- */

export interface CheckCauseListsOptions {
  /** 1 to 100 CNRs, any common spelling. Normalised and de-duplicated in order. */
  cnrs: string[];
  /** `YYYY-MM-DD`. Send together with `to`, or omit both for today and tomorrow (Indian calendar). */
  from?: string;
  /** `YYYY-MM-DD`, at most 7 days after `from`. */
  to?: string;
}

/**
 * - `listed`: a row of this case was found. 1 credit.
 * - `no_entry_found`: a list was read and no row was recognised. This is not
 *   proof that the case is not listed; `dates[].complete` says how much of
 *   each list was read. 1 credit.
 * - `list_not_read`: no list was held for the dates. Free. For a District
 *   Court this can also mean the list of the case's own courtroom could not
 *   be confirmed (then `dates[].status` is `none`).
 * - `cannot_check`: `reason` says why (see `reason` on `CauseListCheckResult`). Free.
 * - `not_watched`: your account does not watch this CNR. Free.
 */
export type CauseListCheckStatus = "listed" | "no_entry_found" | "list_not_read" | "cannot_check" | "not_watched";

/** What was read for one date of one CNR's court. */
export interface CauseListCheckDate {
  date: string;
  status: CauseListStatus;
  complete: boolean;
  fetchedAt: string | null;
}

/** A listing found for a watched CNR. It carries no party or advocate fields. */
export interface CauseListCheckListing {
  date: string;
  /** The court the row was found in, when it can be given. */
  courtKey: string | null;
  court: CauseListCourt | null;
  item: string | null;
  section: string | null;
  purpose: string | null;
  listType: string | null;
  stage: string | null;
  /** The case number as written on the list. Null on a `related_key` match or a restricted row. */
  caseText: string | null;
  matchedBy: string | null;
  relation: string | null;
  fetchedAt: string | null;
}

export interface CauseListCheckResult {
  /** Canonical 16 character CNR. */
  cnr: string;
  status: CauseListCheckStatus;
  /**
   * Set on `cannot_check`: `pending` (the record is still being fetched),
   * `record_unavailable`, `court_not_supported`, or a court identification
   * reason (`no_case_identity`, `no_court_key`, `no_court_number`, `invalid_court_key`,
   * `unsupported_court`). Null otherwise. New reasons may be added.
   */
  reason: string | null;
  /** The court the case was looked for in. Null when the CNR was not watched or no court could be identified. */
  courtKey: string | null;
  dates: CauseListCheckDate[];
  listings: CauseListCheckListing[];
}

export interface CauseListCheckSummary {
  listed: number;
  noEntryFound: number;
  listNotRead: number;
  cannotCheck: number;
  notWatched: number;
}

export interface CauseListCheckData {
  results: CauseListCheckResult[];
  summary: CauseListCheckSummary;
  /** First date looked at, `YYYY-MM-DD`. The default range is resolved by the server. */
  from: string;
  /** Last date looked at, `YYYY-MM-DD`. */
  to: string;
}

/* -------------------------------------------------------------------------- */
/* Client side validation                                                     */
/* -------------------------------------------------------------------------- */

/** Same pattern as the server. */
export const COURT_KEY_PATTERN = /^(SC|HC:\d{1,3}:\d{1,3}|DC:\d{1,3}:\d{1,4}:\d{1,9}:\d{1,4}:\d{1,5})$/;
const MATTER_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const DAY_MS = 86_400_000;

function fail(details: string[]): never {
  throw new ValidationError(
    "Validation failed. Please check your request and try again.",
    undefined,
    details,
    undefined,
    undefined,
    { apiCode: "VALIDATION_ERROR" },
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** Checks the `from`/`to` rules shared by the listing calls. `maxDays` is 31 for listings and 7 for the check. */
export function assertDateRange(options: CauseListRangeOptions, maxDays: number): void {
  const details: string[] = [];
  const { from, to } = options;
  if (from !== undefined && !isIsoDate(from)) details.push("from: from must be a real date written YYYY-MM-DD.");
  if (to !== undefined && !isIsoDate(to)) details.push("to: to must be a real date written YYYY-MM-DD.");
  if (details.length === 0) {
    if ((from === undefined) !== (to === undefined)) {
      details.push("Send both from and to, or neither.");
    } else if (from !== undefined && to !== undefined) {
      const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
      if (days < 0) details.push("to cannot be before from.");
      else if (days > maxDays) details.push(`from and to can be at most ${maxDays} days apart.`);
    }
  }
  if (details.length > 0) fail(details);
}

export function assertMatterId(matterId: unknown): string {
  if (typeof matterId !== "string" || !MATTER_ID_PATTERN.test(matterId)) {
    fail(["matterId: matterId must be a 24 character hexadecimal id."]);
  }
  return matterId;
}

export function assertCourtListQuery(options: GetCourtCauseListOptions): void {
  const details: string[] = [];
  if (typeof options?.courtKey !== "string" || !COURT_KEY_PATTERN.test(options.courtKey)) {
    details.push(
      "courtKey: courtKey is not a valid court key. Use SC, HC:<state>:<bench> or DC:<state>:<district>:<complex>:<establishment>:<court number>.",
    );
  }
  if (!isIsoDate(options?.date)) details.push("date: date must be a real date written YYYY-MM-DD.");
  if (details.length > 0) fail(details);
}

export const CHECK_MAX_CNRS = 100;
/** CNRs times dates in the range, at most. The default range is 2 dates. */
export const CHECK_MAX_CNR_DATES = 300;
export const CHECK_MAX_DAYS = 7;
export const LISTINGS_MAX_DAYS = 31;

export function assertCheckBody(options: CheckCauseListsOptions): void {
  if (!Array.isArray(options?.cnrs) || options.cnrs.length < 1 || options.cnrs.length > CHECK_MAX_CNRS) {
    fail([`cnrs: send between 1 and ${CHECK_MAX_CNRS} CNRs.`]);
  }
  assertDateRange(options, CHECK_MAX_DAYS);
  const dates =
    options.from !== undefined && options.to !== undefined
      ? Math.round((Date.parse(`${options.to}T00:00:00Z`) - Date.parse(`${options.from}T00:00:00Z`)) / DAY_MS) + 1
      : 2;
  // Repeats are removed before counting, as the server does.
  const distinct = new Set(options.cnrs.map((c) => normalizeCnr(c) ?? String(c).trim())).size;
  if (distinct * dates > CHECK_MAX_CNR_DATES) {
    fail([
      `A call can cover at most ${CHECK_MAX_CNR_DATES} CNR and date pairs. This one asks for ${distinct} CNRs over ${dates} dates; send fewer CNRs or a shorter date range.`,
    ]);
  }
}
