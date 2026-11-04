/**
 * Types for the Acts and sections endpoints. They need the `legislation`
 * scope. Each call costs 1 credit when it returns something and nothing when
 * it returns nothing.
 *
 * Repeal status is on every act and provision. Check it before relying on a
 * provision.
 */
import type { ApiResponse } from "./types.js";
import type { CursorPagination } from "./monitoring.js";

export type ActDocClass = "act" | "ordinance" | "rule" | "regulation" | "amendment_act" | "constitution" | "code";
export type ActJurisdiction = "central" | "state" | "union_territory";

/** Pagination of the page-numbered acts endpoints. `total` counts matches before unpublished records are removed, so a page can hold fewer rows than `limit`. */
export interface ActsPagePagination {
  page: number;
  limit: number;
  total: number;
  totalPages?: number;
  hasMore: boolean;
}

/** Options shared by the page-numbered acts endpoints. */
export interface ActsPageOptions {
  /** Starts at 1. */
  page?: number;
  /** 1 to 100, and no more than your plan allows. Default 20. */
  limit?: number;
}

export interface SearchActsOptions extends ActsPageOptions {
  /** Words from the title or subject, or a short form. 2 to 200 characters. */
  query: string;
  docClass?: ActDocClass;
  jurisdiction?: ActJurisdiction;
  yearFrom?: number;
  yearTo?: number;
}

export interface ActSummary {
  slug: string;
  title: string;
  docClass?: string;
  year?: number | null;
  number?: string | null;
  citation?: string | null;
  jurisdiction?: string;
  stateName?: string | null;
  /** Short forms this act is known by. */
  aliases?: string[];
  /** Whether the act has been repealed. Check this before relying on it. */
  repealed: boolean;
  /** What repealed it, and from when. */
  repealNote?: string | null;
}

export interface ActsListMeta {
  responseTime?: string;
  /** 1 when the call returned something, 0 when it returned nothing. */
  creditsCharged?: number;
  metered?: boolean;
  /** True when nothing matched the words closely, so treat the results as a guess. */
  weakMatch?: boolean;
}

export interface SearchActsResponse {
  success: true;
  data: ActSummary[];
  meta?: ActsListMeta;
  pagination: ActsPagePagination;
  requestId?: string;
}

export type ActMatchedBy = "short_form" | "text";

export interface ActResolution {
  query: string;
  /** Up to five candidates, best first. */
  matches: Array<{ act: ActSummary; matchedBy: ActMatchedBy }>;
}

export interface Act extends ActSummary {
  shortTitle?: string | null;
  longTitle?: string | null;
  ministryName?: string | null;
  subjects?: string[];
  /** `sections` has a table of contents. `full-text` was published only as one document, so it has no provisions to list. */
  textSource: "sections" | "full-text";
  sectionCount: number;
  /** A caveat about how the text was extracted, when there is one. */
  textNote?: string | null;
}

export interface ActAmendment {
  slug?: string | null;
  title: string;
  year?: number | null;
  number?: string | null;
  citation?: string | null;
  sourceUrl?: string | null;
}

/** The act level history. It does not map old sections to new ones. */
export interface ActHistory {
  slug: string;
  /** What repealed this act. Empty when no repeal is recorded. */
  succession: Array<{ note: string; byTitle?: string | null; byCitation?: string | null; bySlug?: string | null }>;
  amendments: ActAmendment[];
  /** Amendments made by a State, which apply only in that State. */
  stateAmendments: Array<ActAmendment & { stateName?: string | null }>;
  editions: Array<{ slug: string; title: string; stateName?: string | null; jurisdiction?: string; year?: number | null; sections?: number }>;
  /** Rules, regulations and notifications made under the act, up to 100 of each kind. */
  instruments: Array<{ slug: string; title: string; docClass?: string; year?: number | null }>;
  /** How many instruments of each kind exist, which can exceed what is listed. */
  instrumentCounts: Record<string, number>;
}

/** One provision in an act's table of contents. */
export interface ActSectionEntry {
  actSlug: string;
  slug: string;
  partType: string;
  number?: string | null;
  heading?: string | null;
  /** Judgments recorded as citing this provision. Not an exhaustive count. */
  citationCount?: number;
  /** Whether this provision on its own was repealed. See `actRepealed` for the act. */
  repealedProvision?: boolean;
}

/** A provision with its act, as returned by section search and lookup. */
export interface SectionRow extends ActSectionEntry {
  actTitle?: string | null;
  actYear?: number | null;
  jurisdiction?: string | null;
  stateName?: string | null;
  /** Whether the act this provision belongs to was repealed. */
  actRepealed: boolean;
  actRepealNote?: string | null;
  /** Present on search results. */
  snippet?: string;
}

export interface ActSectionBlock {
  depth: number;
  kind: string;
  marker?: string | null;
  text: string;
}

export interface ActSectionAmendment {
  action: string;
  note: string;
  byInstrument?: string | null;
  byYear?: number | null;
}

export interface ActSectionNeighbour {
  slug: string;
  label?: string | null;
}

export interface ActSection extends ActSectionEntry {
  actTitle: string;
  actYear?: number | null;
  jurisdiction?: string;
  actRepealed: boolean;
  actRepealNote?: string | null;
  textNote?: string | null;
  /** The whole provision as plain text. */
  text: string;
  /** The same text with its structure: subsections, clauses, provisos, explanations. */
  blocks: ActSectionBlock[];
  amendments: ActSectionAmendment[];
  previous?: ActSectionNeighbour | null;
  next?: ActSectionNeighbour | null;
}

export interface ListActSectionsOptions extends ActsPageOptions {}

export interface ListActSectionsResponse {
  success: true;
  data: ActSectionEntry[];
  meta?: ActsListMeta;
  pagination: ActsPagePagination;
  requestId?: string;
}

export interface SearchSectionsOptions extends ActsPageOptions {
  /** Words to find in the provision. 2 to 200 characters. */
  query: string;
  /** Narrow the search to one act, by slug. */
  act?: string;
  /** Only provisions with this exact number, for example `498A`. */
  number?: string;
}

export interface SearchSectionsResponse {
  success: true;
  data: SectionRow[];
  meta?: ActsListMeta;
  pagination: ActsPagePagination;
  requestId?: string;
}

export type SectionMatchedBy = "alias" | "title" | "number_only";

export interface SectionLookup {
  query: string;
  /** Provisions the citation could name, best first. */
  matches: Array<{
    section: SectionRow;
    matchedBy: SectionMatchedBy;
    /** True when no act was named, so this is one of many provisions with that number. Choose or name the act. */
    ambiguous: boolean;
  }>;
}

export interface ListSectionCitingCasesOptions {
  /** From `pagination.nextCursor`. Valid only for the provision it was issued for. */
  cursor?: string;
  /** 1 to 100, and no more than your plan allows. Default 20. */
  limit?: number;
}

export interface CitingCase {
  /** Read the judgment with `getCase(id)`. */
  id: string;
  title?: string | null;
  court?: string | null;
  courtType?: string | null;
  cnr?: string | null;
  caseNumber?: string | null;
  /** ISO date. */
  decisionDate?: string | null;
}

/**
 * Judgments citing exactly one provision, newest first. This is not an
 * exhaustive list of every judgment applying the provision, and an empty
 * list does not mean no judgment applied it.
 */
export interface CitingCases {
  section: { actSlug: string; slug: string; number?: string | null };
  /** False when judgments cannot be listed for this provision. That says nothing about whether any exist. */
  listAvailable: boolean;
  note: string;
  /** Citing judgments found, before any are withheld. */
  total: number;
  /** True when there are at least `total`. */
  totalIsLowerBound: boolean;
  cases: CitingCase[];
}

export interface CitingCasesMeta extends ActsListMeta {
  /** True when some matters were left out because they are withheld. */
  someRecordsWithheld?: boolean;
  /** True when the withheld check could not run, in which case titles are masked. */
  restrictedCheckDegraded?: boolean;
}

export type CitingCasesPagination = CursorPagination & { hasMore: boolean; limit: number };

export interface CitingCasesResponse {
  success: true;
  data: CitingCases;
  meta?: CitingCasesMeta;
  pagination: CitingCasesPagination;
  requestId?: string;
}

export type ActResponse = ApiResponse<Act, ActsListMeta>;
export type ActResolutionResponse = ApiResponse<ActResolution, ActsListMeta>;
export type ActHistoryResponse = ApiResponse<ActHistory, ActsListMeta>;
export type ActSectionResponse = ApiResponse<ActSection, ActsListMeta>;
export type SectionLookupResponse = ApiResponse<SectionLookup, ActsListMeta>;
