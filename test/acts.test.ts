import { describe, expect, it } from "vitest";
import { CourtMeshClient } from "../src/client.js";
import { API_REFUSAL_CODES, BadGatewayError, NotFoundError, PermissionError } from "../src/errors.js";
import { queueFetch } from "./helpers.js";

const API_KEY = "cm-abcdefghij1234567890abcdefghijkl-wxyz";
const BASE = "https://research.courtmesh.ai/api/v1/prod";

function makeClient(entries: Parameters<typeof queueFetch>[0]) {
  const { fetch, calls } = queueFetch(entries);
  const client = new CourtMeshClient({ apiKey: API_KEY, fetch, maxRetries: 1 });
  return { client, calls };
}

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ status: 200, body: { success: true, data, ...extra } });
const act = { slug: "indian-penal-code-1860", title: "The Indian Penal Code, 1860", repealed: true, repealNote: "Repealed by the Bharatiya Nyaya Sanhita, 2023" };
const pageInfo = { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false };

describe("searchActs", () => {
  it("sends q and filters and parses the page", async () => {
    const { client, calls } = makeClient([
      ok([act], { meta: { creditsCharged: 1, metered: true, weakMatch: false }, pagination: pageInfo }),
    ]);
    const res = await client.searchActs({ query: "penal code", docClass: "act", jurisdiction: "central", yearFrom: 1800, yearTo: 1900, page: 2, limit: 5 });
    expect(calls[0]?.method).toBe("GET");
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(`${BASE}/acts/search`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "penal code", docClass: "act", jurisdiction: "central", yearFrom: "1800", yearTo: "1900", page: "2", limit: "5",
    });
    expect(res.data[0]?.repealed).toBe(true);
    expect(res.meta?.weakMatch).toBe(false);
    expect(res.pagination.total).toBe(1);
  });

  it("omits options that were not given", async () => {
    const { client, calls } = makeClient([ok([], { pagination: pageInfo })]);
    await client.searchActs({ query: "x y" });
    expect(calls[0]?.url).toBe(`${BASE}/acts/search?q=x+y`);
  });

  it("maps a missing legislation scope to PermissionError", async () => {
    const { client } = makeClient([{ status: 403, body: { success: false, error: "Key lacks scope", code: "INSUFFICIENT_SCOPE" } }]);
    const err = await client.searchActs({ query: "ipc" }).catch((e) => e);
    expect(err).toBeInstanceOf(PermissionError);
  });
});

describe("resolveAct", () => {
  it("sends q and parses candidates", async () => {
    const { client, calls } = makeClient([ok({ query: "IPC", matches: [{ act, matchedBy: "short_form" }] })]);
    const res = await client.resolveAct("IPC");
    expect(calls[0]?.url).toBe(`${BASE}/acts/resolve?q=IPC`);
    expect(res.data.matches[0]?.matchedBy).toBe("short_form");
    expect(res.data.matches[0]?.act.slug).toBe("indian-penal-code-1860");
  });
});

describe("getAct and getActHistory", () => {
  it("encodes the slug in the path", async () => {
    const { client, calls } = makeClient([ok({ ...act, textSource: "sections", sectionCount: 511 })]);
    const res = await client.getAct("a/b c?d");
    expect(calls[0]?.url).toBe(`${BASE}/acts/a%2Fb%20c%3Fd`);
    expect(res.data.sectionCount).toBe(511);
  });

  it("throws NotFoundError with ACT_NOT_FOUND on a 404", async () => {
    const { client } = makeClient([{ status: 404, body: { success: false, error: "No published act matches this slug.", code: "ACT_NOT_FOUND" } }]);
    const err = await client.getAct("nope").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.apiCode).toBe("ACT_NOT_FOUND");
    expect(err.apiCode).toBe(API_REFUSAL_CODES.ACT_NOT_FOUND);
  });

  it("reads the act level history", async () => {
    const history = {
      slug: act.slug,
      succession: [{ note: "Repealed", byTitle: "The Bharatiya Nyaya Sanhita, 2023", bySlug: "bharatiya-nyaya-sanhita-2023" }],
      amendments: [], stateAmendments: [], editions: [], instruments: [], instrumentCounts: {},
    };
    const { client, calls } = makeClient([ok(history)]);
    const res = await client.getActHistory(act.slug);
    expect(calls[0]?.url).toBe(`${BASE}/acts/${act.slug}/history`);
    expect(res.data.succession[0]?.bySlug).toBe("bharatiya-nyaya-sanhita-2023");
  });

  it("throws NotFoundError with ACT_NOT_FOUND for history of an unknown act", async () => {
    const { client } = makeClient([{ status: 404, body: { success: false, error: "x", code: "ACT_NOT_FOUND" } }]);
    const err = await client.getActHistory("nope").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.apiCode).toBe("ACT_NOT_FOUND");
  });
});

describe("listActSections and getActSection", () => {
  it("passes page and limit and parses the table of contents", async () => {
    const entry = { actSlug: act.slug, slug: "section-302", partType: "section", number: "302", heading: "Punishment for murder", citationCount: 3, repealedProvision: false };
    const { client, calls } = makeClient([ok([entry], { pagination: pageInfo })]);
    const res = await client.listActSections(act.slug, { page: 3, limit: 50 });
    expect(calls[0]?.url).toBe(`${BASE}/acts/${act.slug}/sections?page=3&limit=50`);
    expect(res.data[0]?.number).toBe("302");
    expect(res.pagination.hasMore).toBe(false);
  });

  it("encodes both path parts when reading a provision", async () => {
    const { client, calls } = makeClient([ok({ actSlug: act.slug, slug: "section-498a", partType: "section", actTitle: act.title, actRepealed: true, text: "t", blocks: [], amendments: [] })]);
    const res = await client.getActSection("my act", "section 498a/x");
    expect(calls[0]?.url).toBe(`${BASE}/acts/my%20act/sections/section%20498a%2Fx`);
    expect(res.data.actRepealed).toBe(true);
  });

  it("throws NotFoundError with SECTION_NOT_FOUND", async () => {
    const { client } = makeClient([{ status: 404, body: { success: false, error: "No published provision matches this act and section.", code: "SECTION_NOT_FOUND" } }]);
    const err = await client.getActSection(act.slug, "section-9999").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.apiCode).toBe("SECTION_NOT_FOUND");
    expect(err.apiCode).toBe(API_REFUSAL_CODES.SECTION_NOT_FOUND);
  });
});

describe("listSectionCitingCases", () => {
  const caseRow = (id: string) => ({ id, title: "State v. Example", court: "Delhi High Court", cnr: "DLHC010084212021", decisionDate: "2024-05-06" });
  const body = (ids: string[], nextCursor: string | null) => ({
    section: { actSlug: act.slug, slug: "section-302", number: "302" },
    listAvailable: true, note: "Not an exhaustive list.", total: 3, totalIsLowerBound: false, cases: ids.map(caseRow),
  });

  it("sends cursor and limit and parses cases and meta flags", async () => {
    const { client, calls } = makeClient([
      ok(body(["a"], null), { meta: { someRecordsWithheld: true }, pagination: { limit: 1, hasMore: false, nextCursor: null } }),
    ]);
    const res = await client.listSectionCitingCases(act.slug, "section-302", { cursor: "c1", limit: 1 });
    expect(calls[0]?.url).toBe(`${BASE}/acts/${act.slug}/sections/section-302/citing-cases?cursor=c1&limit=1`);
    expect(res.data.cases[0]?.id).toBe("a");
    expect(res.data.listAvailable).toBe(true);
    expect(res.meta?.someRecordsWithheld).toBe(true);
    expect(res.pagination.nextCursor).toBeNull();
  });

  it("walks cursors with iterSectionCitingCases and stops on the last page", async () => {
    const { client, calls } = makeClient([
      ok(body(["a", "b"], "c2"), { pagination: { limit: 2, hasMore: true, nextCursor: "c2" } }),
      ok(body(["c"], null), { pagination: { limit: 2, hasMore: false, nextCursor: null } }),
    ]);
    const pages: string[][] = [];
    for await (const page of client.iterSectionCitingCases(act.slug, "section-302", { limit: 2 })) pages.push(page.map((c) => c.id));
    expect(pages).toEqual([["a", "b"], ["c"]]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("c2");
  });

  it("maps a bad cursor to ValidationError CURSOR_INVALID and 404 to SECTION_NOT_FOUND", async () => {
    const bad = makeClient([{ status: 400, body: { success: false, error: "bad cursor", code: "CURSOR_INVALID" } }]);
    const e1 = await bad.client.listSectionCitingCases(act.slug, "section-302", { cursor: "zzz" }).catch((e) => e);
    expect(e1.apiCode).toBe("CURSOR_INVALID");
    const nf = makeClient([{ status: 404, body: { success: false, error: "x", code: "SECTION_NOT_FOUND" } }]);
    const e2 = await nf.client.listSectionCitingCases(act.slug, "nope").catch((e) => e);
    expect(e2).toBeInstanceOf(NotFoundError);
    expect(e2.apiCode).toBe("SECTION_NOT_FOUND");
  });

  it("surfaces a 502 UPSTREAM_UNAVAILABLE as BadGatewayError after retries", async () => {
    const entry = { status: 502, body: { success: false, error: "Citing judgments are temporarily unavailable.", code: "UPSTREAM_UNAVAILABLE" } };
    const { client } = makeClient([entry, entry]);
    const err = await client.listSectionCitingCases(act.slug, "section-302").catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayError);
    expect(err.apiCode).toBe("UPSTREAM_UNAVAILABLE");
  });
});

describe("searchSections and lookupSection", () => {
  const row = { actSlug: act.slug, slug: "section-498a", partType: "section", number: "498A", actRepealed: true, snippet: "Husband or relative..." };

  it("sends q, act and number", async () => {
    const { client, calls } = makeClient([ok([row], { pagination: pageInfo })]);
    const res = await client.searchSections({ query: "cruelty", act: act.slug, number: "498A", limit: 10 });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/prod/sections/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "cruelty", act: act.slug, number: "498A", limit: "10" });
    expect(res.data[0]?.snippet).toContain("Husband");
  });

  it("looks up a citation and keeps the ambiguity flag", async () => {
    const { client, calls } = makeClient([ok({ query: "s.498A", matches: [{ section: row, matchedBy: "number_only", ambiguous: true }] })]);
    const res = await client.lookupSection("s.498A");
    expect(calls[0]?.url).toBe(`${BASE}/sections/lookup?q=s.498A`);
    expect(res.data.matches[0]?.ambiguous).toBe(true);
    expect(res.data.matches[0]?.section.number).toBe("498A");
  });
});
