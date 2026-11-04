import { describe, expect, it } from "vitest";
import { CourtMeshClient } from "../src/client.js";
import { BadGatewayError, NotFoundError, PermissionError, ServiceUnavailableError, ValidationError } from "../src/errors.js";
import { COURT_KEY_PATTERN } from "../src/cause-lists.js";
import { queueFetch } from "./helpers.js";

const API_KEY = "cm-abcdefghij1234567890abcdefghijkl-wxyz";
const BASE = "https://research.courtmesh.ai/api/v1/prod";
const MATTER = "66f1a2b3c4d5e6f7a8b9c0d1";
const COURT_KEY = "DC:99:1:9900001:1:1";
const CNR = "ZZAB010000012024";

function makeClient(entries: Parameters<typeof queueFetch>[0], overrides: Record<string, unknown> = {}) {
  const { fetch, calls } = queueFetch(entries);
  const client = new CourtMeshClient({ apiKey: API_KEY, fetch, maxRetries: 1, ...overrides });
  return { client, calls };
}

const listing = (id: string) => ({
  id,
  matterId: MATTER,
  matterTitle: "Alpha Finance Ltd v. Beta Traders",
  date: "2026-11-05",
  courtKey: COURT_KEY,
  court: { kind: "DC", name: "District Court, Example City", courtNo: "1", judges: ["Sh. A. Example"], designation: null },
  item: "1",
  section: "Urgent Cases",
  purpose: "REPLY",
  listType: "civil",
  stage: null,
  caseText: "CMA/1/2024",
  matchedBy: "cnr",
  relation: null,
  fetchedAt: "2026-11-04T15:30:12.000Z",
  firstSeenAt: "2026-11-04T15:31:02.000Z",
});

const page = (ids: string[], p: number, hasMore: boolean) => ({
  status: 200,
  body: {
    success: true,
    data: ids.map(listing),
    meta: { creditsCharged: 1, metered: true },
    pagination: { page: p, limit: 2, total: 3, totalPages: 2, hasMore },
  },
});

describe("listCauseListings", () => {
  it("sends from, to, page and limit as query parameters", async () => {
    const { client, calls } = makeClient([page(["a"], 1, false)]);
    const res = await client.listCauseListings({ from: "2026-11-05", to: "2026-11-12", page: 2, limit: 20 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BASE}/cause-lists/listings?from=2026-11-05&to=2026-11-12&page=2&limit=20`);
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(res.pagination.hasMore).toBe(false);
    expect(res.data[0]?.matchedBy).toBe("cnr");
  });

  it("sends no query at all when called without options", async () => {
    const { client, calls } = makeClient([page([], 1, false)]);
    await client.listCauseListings();
    expect(calls[0]?.url).toBe(`${BASE}/cause-lists/listings`);
  });

  it("refuses a half range, a reversed range and a range over 31 days before any request", async () => {
    const { client, calls } = makeClient([]);
    const half = await client.listCauseListings({ from: "2026-11-05" }).catch((e) => e);
    expect(half).toBeInstanceOf(ValidationError);
    expect(half.details).toEqual(["Send both from and to, or neither."]);
    const reversed = await client.listCauseListings({ from: "2026-11-05", to: "2026-11-01" }).catch((e) => e);
    expect(reversed.details).toEqual(["to cannot be before from."]);
    const wide = await client.listCauseListings({ from: "2026-11-01", to: "2026-12-05" }).catch((e) => e);
    expect(wide.details).toEqual(["from and to can be at most 31 days apart."]);
    const bad = await client.listCauseListings({ from: "2026-02-30", to: "2026-03-01" }).catch((e) => e);
    expect(bad.details).toEqual(["from: from must be a real date written YYYY-MM-DD."]);
    expect(calls).toHaveLength(0);
  });

  it("allows exactly 31 days", async () => {
    const { client, calls } = makeClient([page([], 1, false)]);
    await client.listCauseListings({ from: "2026-11-01", to: "2026-12-02" });
    expect(calls).toHaveLength(1);
  });
});

describe("iterCauseListings", () => {
  it("walks pages from 1 until hasMore is false", async () => {
    const { client, calls } = makeClient([page(["a", "b"], 1, true), page(["c"], 2, false)]);
    const seen: string[][] = [];
    for await (const items of client.iterCauseListings({ limit: 2 })) seen.push(items.map((i) => i.id));
    expect(seen).toEqual([["a", "b"], ["c"]]);
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("stops on an empty page even if hasMore is true", async () => {
    const { client, calls } = makeClient([page([], 1, true)]);
    const seen: unknown[] = [];
    for await (const items of client.iterCauseListings()) seen.push(items);
    expect(seen).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe("listMatterCauseListings", () => {
  it("calls the matter path and returns the matter with its listings", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: { success: true, data: { matter: { id: MATTER, title: "T", courtKey: COURT_KEY }, listings: [listing("a")] }, meta: { creditsCharged: 1, metered: true } },
      },
    ]);
    const res = await client.listMatterCauseListings(MATTER, { from: "2026-11-05", to: "2026-11-06" });
    expect(calls[0]?.url).toBe(`${BASE}/matters/${MATTER}/cause-listings?from=2026-11-05&to=2026-11-06`);
    expect(res.data.matter.courtKey).toBe(COURT_KEY);
    expect(res.data.listings).toHaveLength(1);
  });

  it.each(["", "abc", "66f1a2b3c4d5e6f7a8b9c0d", "66f1a2b3c4d5e6f7a8b9c0d1x", "66f1a2b3c4d5e6f7a8b9c0g1", "../cases"])(
    "refuses matterId %j before any request",
    async (id) => {
      const { client, calls } = makeClient([]);
      const error = await client.listMatterCauseListings(id).catch((e) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.details).toEqual(["matterId: matterId must be a 24 character hexadecimal id."]);
      expect(error.apiCode).toBe("VALIDATION_ERROR");
      expect(calls).toHaveLength(0);
    },
  );

  it("maps an unknown matter to NotFoundError with MATTER_NOT_FOUND", async () => {
    const { client } = makeClient([{ status: 404, body: { success: false, code: "MATTER_NOT_FOUND", message: "Matter not found." } }]);
    const error = await client.listMatterCauseListings(MATTER).catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.apiCode).toBe("MATTER_NOT_FOUND");
  });
});

describe("getCourtCauseList", () => {
  const courtList = { courtKey: COURT_KEY, date: "2026-11-05", status: "unavailable", complete: false, fetchedAt: null, court: null, rows: [] };

  it("sends courtKey and date and returns a free unavailable list as data, not an error", async () => {
    const { client, calls } = makeClient([{ status: 200, body: { success: true, data: courtList, meta: { creditsCharged: 0, metered: true } } }]);
    const res = await client.getCourtCauseList({ courtKey: COURT_KEY, date: "2026-11-05" });
    expect(calls[0]?.url).toBe(`${BASE}/cause-lists/court?courtKey=${encodeURIComponent(COURT_KEY)}&date=2026-11-05`);
    expect(res.data.status).toBe("unavailable");
    expect(res.meta?.creditsCharged).toBe(0);
  });

  it.each(["SC", "HC:99:2", "DC:99:1:9900001:1:1", "DC:1:2:3:4:5"])("accepts court key %s", (key) => {
    expect(COURT_KEY_PATTERN.test(key)).toBe(true);
  });

  it.each(["", "sc", "SC:1", "HC:1", "HC:1234:2", "DC:99:1:9900001:1", "DC:99:1:9900001:1:1:9", "DC:a:1:2:3:4", "HC:99:2\nSC", "SC "])(
    "refuses court key %j before any request",
    async (key) => {
      const { client, calls } = makeClient([]);
      const error = await client.getCourtCauseList({ courtKey: key, date: "2026-11-05" }).catch((e) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.details?.[0]).toMatch(/^courtKey: courtKey is not a valid court key\./);
      expect(calls).toHaveLength(0);
    },
  );

  it("refuses a bad date", async () => {
    const { client, calls } = makeClient([]);
    const error = await client.getCourtCauseList({ courtKey: "SC", date: "05-11-2026" }).catch((e) => e);
    expect(error.details).toEqual(["date: date must be a real date written YYYY-MM-DD."]);
    expect(calls).toHaveLength(0);
  });

  it("maps 403 CAUSE_LISTS_NOT_ENABLED to PermissionError", async () => {
    const { client } = makeClient([{ status: 403, body: { success: false, code: "CAUSE_LISTS_NOT_ENABLED", message: "This account does not have access to cause lists." } }]);
    const error = await client.getCourtCauseList({ courtKey: "SC", date: "2026-11-05" }).catch((e) => e);
    expect(error).toBeInstanceOf(PermissionError);
    expect(error.apiCode).toBe("CAUSE_LISTS_NOT_ENABLED");
  });
});

describe("502 UPSTREAM_UNAVAILABLE", () => {
  const outage = { status: 502, body: { success: false, code: "UPSTREAM_UNAVAILABLE", message: "Cause lists are temporarily unavailable. Please retry shortly. You have not been charged." } };

  it("a GET is retried and then raised as BadGatewayError", async () => {
    const { client, calls } = makeClient([outage, outage]);
    const error = await client.listCauseListings().catch((e) => e);
    expect(error).toBeInstanceOf(BadGatewayError);
    expect(error.apiCode).toBe("UPSTREAM_UNAVAILABLE");
    expect(calls).toHaveLength(2);
  });

  it("a GET recovers when the retry succeeds", async () => {
    const { client, calls } = makeClient([outage, page(["a"], 1, false)]);
    const res = await client.listCauseListings();
    expect(res.data).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("the check POST is not retried by default (it may have been received)", async () => {
    const { client, calls } = makeClient([outage, outage]);
    const error = await client.checkCauseLists({ cnrs: [CNR] }).catch((e) => e);
    expect(error).toBeInstanceOf(BadGatewayError);
    expect(calls).toHaveLength(1);
  });

  it("a 503 SETTLEMENT_UNCONFIRMED is never retried, even with retryPosts on", async () => {
    const unconfirmed = {
      status: 503,
      body: {
        success: false,
        code: "SETTLEMENT_UNCONFIRMED",
        message: "We could not confirm the credit charge for this call, so no results were returned. Please check your usage before retrying.",
        error: "We could not confirm the credit charge for this call, so no results were returned. Please check your usage before retrying.",
      },
    };
    const { client, calls } = makeClient([unconfirmed, { status: 200, body: { success: true, data: { results: [], summary: {}, from: "a", to: "b" } } }], {
      retryPosts: true,
      maxRetries: 3,
    });
    const error = await client.checkCauseLists({ cnrs: [CNR] }).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error.apiCode).toBe("SETTLEMENT_UNCONFIRMED");
    expect(calls).toHaveLength(1);
  });

  it("any other 503 on the check is still retried with retryPosts on", async () => {
    const { client, calls } = makeClient(
      [{ status: 503, body: { success: false, error: "Unable to verify API entitlement. Please retry.", code: "ENTITLEMENT_UNAVAILABLE" } }, { status: 200, body: { success: true, data: { results: [], summary: {}, from: "a", to: "b" } } }],
      { retryPosts: true },
    );
    await client.checkCauseLists({ cnrs: [CNR] });
    expect(calls).toHaveLength(2);
  });

  it("the check POST is retried with the same Idempotency-Key when retryPosts is on", async () => {
    const { client, calls } = makeClient(
      [outage, { status: 200, body: { success: true, data: { results: [], summary: { listed: 0, noEntryFound: 0, listNotRead: 0, cannotCheck: 0, notWatched: 0 } } } }],
      { retryPosts: true },
    );
    await client.checkCauseLists({ cnrs: [CNR] });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers["idempotency-key"]).toBeTruthy();
    expect(calls[1]?.headers["idempotency-key"]).toBe(calls[0]?.headers["idempotency-key"]);
  });
});

describe("checkCauseLists", () => {
  const body = {
    success: true,
    data: {
      results: [
        {
          cnr: CNR,
          status: "listed",
          reason: null,
          courtKey: COURT_KEY,
          dates: [{ date: "2026-11-05", status: "ok", complete: true, fetchedAt: "2026-11-04T15:30:12.000Z" }],
          listings: [
            { date: "2026-11-05", courtKey: COURT_KEY, court: null, item: "1", section: "Urgent Cases", purpose: "REPLY", listType: "civil", stage: null, caseText: "CMA/1/2024", matchedBy: "cnr", relation: null, fetchedAt: "2026-11-04T15:30:12.000Z" },
          ],
        },
        { cnr: "ZZAB010000022024", status: "no_entry_found", reason: null, courtKey: "HC:99:1", dates: [{ date: "2026-11-05", status: "partial", complete: false, fetchedAt: null }], listings: [] },
        { cnr: "ZZAB010000032024", status: "not_watched", reason: null, courtKey: null, dates: [], listings: [] },
      ],
      summary: { listed: 1, noEntryFound: 1, listNotRead: 0, cannotCheck: 0, notWatched: 1 },
      from: "2026-11-05",
      to: "2026-11-06",
    },
    meta: { creditsCharged: 2, metered: true },
  };

  it("posts normalised CNRs with the dates, and returns the statuses unchanged", async () => {
    const { client, calls } = makeClient([{ status: 200, body }]);
    const res = await client.checkCauseLists({ cnrs: ["cnr: zzab-01-000001-2024", "ZZAB010000022024"], from: "2026-11-05", to: "2026-11-06" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/cause-lists/check`);
    expect(calls[0]?.body).toEqual({ cnrs: [CNR, "ZZAB010000022024"], from: "2026-11-05", to: "2026-11-06" });
    expect(res.data.summary.noEntryFound).toBe(1);
    expect(res.data.from).toBe("2026-11-05");
    expect(res.data.to).toBe("2026-11-06");
    expect(res.data.results.map((r) => r.status)).toEqual(["listed", "no_entry_found", "not_watched"]);
    expect(res.meta?.creditsCharged).toBe(2);
  });

  it("omits from and to when not given", async () => {
    const { client, calls } = makeClient([{ status: 200, body }]);
    await client.checkCauseLists({ cnrs: [CNR] });
    expect(calls[0]?.body).toEqual({ cnrs: [CNR] });
  });

  it("sends an Idempotency-Key only when asked or when retryPosts is on", async () => {
    const a = makeClient([{ status: 200, body }]);
    await a.client.checkCauseLists({ cnrs: [CNR] });
    expect(a.calls[0]?.headers["idempotency-key"]).toBeUndefined();
    const b = makeClient([{ status: 200, body }]);
    await b.client.checkCauseLists({ cnrs: [CNR] }, { idempotencyKey: "check-1" });
    expect(b.calls[0]?.headers["idempotency-key"]).toBe("check-1");
  });

  it("refuses 0 CNRs, 101 CNRs, a half range and a range over 7 days before any request", async () => {
    const { client, calls } = makeClient([]);
    const none = await client.checkCauseLists({ cnrs: [] }).catch((e) => e);
    expect(none).toBeInstanceOf(ValidationError);
    expect(none.details).toEqual(["cnrs: send between 1 and 100 CNRs."]);
    const many = await client.checkCauseLists({ cnrs: Array.from({ length: 101 }, () => CNR) }).catch((e) => e);
    expect(many.details).toEqual(["cnrs: send between 1 and 100 CNRs."]);
    const half = await client.checkCauseLists({ cnrs: [CNR], to: "2026-11-06" }).catch((e) => e);
    expect(half.details).toEqual(["Send both from and to, or neither."]);
    const wide = await client.checkCauseLists({ cnrs: [CNR], from: "2026-11-01", to: "2026-11-09" }).catch((e) => e);
    expect(wide.details).toEqual(["from and to can be at most 7 days apart."]);
    expect(calls).toHaveLength(0);
  });

  it("refuses more than 300 CNRs times dates before any request, counting the default range as 2 dates", async () => {
    const { client, calls } = makeClient([]);
    const distinct = (n: number) => Array.from({ length: n }, (_, i) => `ZZAB01${String(i + 1).padStart(6, "0")}2024`);
    // 8 dates (7 days apart, inclusive) times 38 CNRs is 304.
    const wide = await client.checkCauseLists({ cnrs: distinct(38), from: "2026-11-01", to: "2026-11-08" }).catch((e) => e);
    expect(wide).toBeInstanceOf(ValidationError);
    expect(wide.details).toEqual([
      "A call can cover at most 300 CNR and date pairs. This one asks for 38 CNRs over 8 dates; send fewer CNRs or a shorter date range.",
    ]);
    // 4 dates times 76 CNRs is 304.
    const four = await client.checkCauseLists({ cnrs: distinct(76), from: "2026-11-01", to: "2026-11-04" }).catch((e) => e);
    expect(four.details?.[0]).toMatch(/^A call can cover at most 300 CNR and date pairs\. This one asks for 76 CNRs over 4 dates/);
    expect(calls).toHaveLength(0);
  });

  it("allows exactly 300 CNRs times dates, 100 CNRs on the default range, and 7 days", async () => {
    const { client, calls } = makeClient([{ status: 200, body }, { status: 200, body }, { status: 200, body }]);
    await client.checkCauseLists({ cnrs: Array.from({ length: 100 }, () => CNR) });
    await client.checkCauseLists({ cnrs: Array.from({ length: 100 }, () => CNR), from: "2026-11-01", to: "2026-11-03" });
    await client.checkCauseLists({ cnrs: Array.from({ length: 37 }, () => CNR), from: "2026-11-01", to: "2026-11-08" });
    expect(calls).toHaveLength(3);
  });

  it("removes repeats before counting: 38 entries with one repeat over 8 dates passes", async () => {
    const { client, calls } = makeClient([{ status: 200, body }]);
    const cnrs = Array.from({ length: 37 }, (_, i) => `ZZAB01${String(i + 1).padStart(6, "0")}2024`);
    cnrs.push("zzab-01-000001-2024"); // a repeat of the first, in another spelling
    await client.checkCauseLists({ cnrs, from: "2026-11-01", to: "2026-11-08" });
    expect(calls).toHaveLength(1);
  });
});
