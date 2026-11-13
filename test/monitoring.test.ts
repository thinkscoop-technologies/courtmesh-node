import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CourtMeshClient } from "../src/client.js";
import { NotFoundError, ValidationError } from "../src/errors.js";
import { normalizeCnr, assertCnr, verifyWebhookSignature, WebhookSignatureError } from "../src/monitoring.js";
import { queueFetch } from "./helpers.js";

const API_KEY = "cm-abcdefghij1234567890abcdefghijkl-wxyz";
const BASE = "https://research.courtmesh.ai/api/v1/prod";
const CNR = "ZZAB010000012024";

function makeClient(entries: Parameters<typeof queueFetch>[0], overrides: Record<string, unknown> = {}) {
  const { fetch, calls } = queueFetch(entries);
  const client = new CourtMeshClient({ apiKey: API_KEY, fetch, maxRetries: 1, ...overrides });
  return { client, calls };
}

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ status: 200, body: { success: true, data, ...extra } });
const list = (data: unknown[], nextCursor: string | null, extra: Record<string, unknown> = {}) =>
  ok(data, { pagination: { nextCursor, hasMore: nextCursor !== null }, ...extra });

describe("normalizeCnr", () => {
  it.each([
    ["ZZAB010000012024", CNR],
    ["  zzab010000012024 ", CNR],
    ["CNR: ZZAB-01-000001-2024", CNR],
    ["CNR ZZAB01 000001 2024", CNR],
    ["CNR NO ZZAB010000012024", CNR],
    ["cnr:zzab/01/000001/2024", CNR],
    ["ZZAB.01.000001.2024", CNR],
    ["ZZABCD0000012024", "ZZABCD0000012024"],
  ])("%s", (input, expected) => {
    expect(normalizeCnr(input)).toBe(expected);
  });

  it("rejects things that cannot be a CNR", () => {
    expect(normalizeCnr("")).toBeNull();
    expect(normalizeCnr("ZZAB01000001202")).toBeNull();
    expect(normalizeCnr("ZZAB0100000120241")).toBeNull();
    expect(normalizeCnr("1234567890123456")).toBeNull();
    expect(normalizeCnr(undefined)).toBeNull();
    expect(() => assertCnr("nope")).toThrow(TypeError);
    expect(assertCnr("cnr: zzab010000012024")).toBe(CNR);
  });
});

describe("case depth and refresh", () => {
  it("sends include on getCase and getCaseByCnr, and nothing without it", async () => {
    const { client, calls } = makeClient([ok({ id: "c1" }), ok({ id: "c1" }), ok({ cnr: CNR, status: "found" }), ok({ cnr: CNR, status: "found" })]);
    await client.getCase("c1");
    await client.getCase("c1", { include: ["hearings", "advocates"] });
    await client.getCaseByCnr(CNR, { include: ["hearings"] });
    await client.getCaseByCnr(CNR, { fetch: true, include: ["advocates"] });
    expect(calls[0]?.url).toBe(`${BASE}/cases/c1`);
    expect(decodeURIComponent(calls[1]?.url ?? "")).toBe(`${BASE}/cases/c1?include=hearings,advocates`);
    expect(calls[2]?.url).toBe(`${BASE}/cases/by-cnr/${CNR}?include=hearings`);
    expect(calls[3]?.url).toBe(`${BASE}/cases/by-cnr/${CNR}?fetch=true&include=advocates`);
  });

  it("reads the orders and text of a case", async () => {
    const { client, calls } = makeClient([
      ok({ caseId: "c1", documents: [] }),
      ok({ caseId: "c1", documentId: "d1", textAvailable: false, text: null }),
    ]);
    await client.listCaseOrders("c1");
    const text = await client.getCaseDocumentText("c1", "d1");
    expect(calls[0]?.url).toBe(`${BASE}/cases/c1/orders`);
    expect(calls[1]?.url).toBe(`${BASE}/cases/c1/orders/d1/text`);
    expect(text.data.textAvailable).toBe(false);
  });

  it("refreshes by CNR, reads the state and sends a normalised batch", async () => {
    const { client, calls } = makeClient([
      { status: 202, body: { success: true, data: { input: CNR, cnr: CNR, status: "queued", caseId: "c1", lastRefreshedAt: null } } },
      ok({ cnr: CNR, state: "running", lastRefreshedAt: null }),
      ok({ results: [], summary: { requested: 1, started: 0 } }),
    ]);
    const res = await client.refreshCaseByCnr("cnr: zzab-01-000001-2024");
    await client.getCaseRefreshState(CNR);
    await client.refreshCasesBatch(["zzab-01-000001-2024", "junk"]);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/cases/by-cnr/${CNR}/refresh`);
    expect(res.data.status).toBe("queued");
    expect(calls[1]?.method).toBe("GET");
    expect(calls[2]?.url).toBe(`${BASE}/cases/refresh/batch`);
    expect(calls[2]?.body).toEqual({ cnrs: [CNR, "junk"] });
  });
});

describe("getCaseByCnr", () => {
  it("normalises the CNR and returns a found record", async () => {
    const { client, calls } = makeClient([ok({ cnr: CNR, status: "found", case: { id: "c1" }, requestId: null })]);
    const res = await client.getCaseByCnr("CNR: ZZAB-01-000001-2024");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${BASE}/cases/by-cnr/${CNR}`);
    expect(res.data.status).toBe("found");
  });

  it("sends fetch=true and accepts a 202 pending", async () => {
    const { client, calls } = makeClient([
      { status: 202, body: { success: true, data: { cnr: CNR, status: "pending", case: null, requestId: "req_1" } } },
    ]);
    const res = await client.getCaseByCnr(CNR, { fetch: true });
    expect(calls[0]?.url).toBe(`${BASE}/cases/by-cnr/${CNR}?fetch=true`);
    expect(res.data.status).toBe("pending");
    expect(res.data.requestId).toBe("req_1");
  });

  it("throws NotFoundError for a 404 CASE_NOT_FOUND", async () => {
    const { client } = makeClient([{ status: 404, body: { success: false, error: "No such case", code: "CASE_NOT_FOUND" } }]);
    const err = await client.getCaseByCnr(CNR).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.apiCode).toBe("CASE_NOT_FOUND");
  });

  it("passes an invalid CNR through so the server answers INVALID_CNR", async () => {
    const { client, calls } = makeClient([{ status: 400, body: { success: false, error: "Invalid CNR", code: "INVALID_CNR" } }]);
    const err = await client.getCaseByCnr("nope").catch((e) => e);
    expect(err.apiCode).toBe("INVALID_CNR");
    expect(calls[0]?.url).toBe(`${BASE}/cases/by-cnr/nope`);
  });
});

describe("searchCases with cnr", () => {
  it("normalises cnr and does not require query", async () => {
    const { client, calls } = makeClient([
      { status: 200, body: { success: true, data: [], meta: {}, pagination: { hasMore: false, nextCursor: null } } },
    ]);
    await client.searchCases({ cnr: "cnr: zzab010000012024" });
    expect(calls[0]?.body).toEqual({ cnr: CNR });
  });
});

describe("watchlists", () => {
  it("createWatchlist posts normalised items", async () => {
    const { client, calls } = makeClient([
      ok({ id: "wl_1", name: "Loans", itemCount: 1, createdAt: "t", updatedAt: "t", results: [{ cnr: CNR, result: "watching" }] }),
    ]);
    const res = await client.createWatchlist({ name: "Loans", items: [{ cnr: "zzab-010000-012024", reference: "LOAN-42" }] });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/watchlists`);
    expect(calls[0]?.body).toEqual({ name: "Loans", items: [{ cnr: CNR, reference: "LOAN-42" }] });
    expect(res.data.results[0]?.result).toBe("watching");
  });

  it("listWatchlists sends cursor and limit", async () => {
    const { client, calls } = makeClient([list([{ id: "wl_1" }], "c2")]);
    const res = await client.listWatchlists({ cursor: "c1", limit: 10 });
    expect(calls[0]?.url).toBe(`${BASE}/watchlists?cursor=c1&limit=10`);
    expect(res.pagination.nextCursor).toBe("c2");
  });

  it("iterWatchlists follows nextCursor until it is null", async () => {
    const { client, calls } = makeClient([list([{ id: "wl_1" }], "c2"), list([{ id: "wl_2" }], null)]);
    const pages: unknown[] = [];
    for await (const page of client.iterWatchlists()) pages.push(page);
    expect(pages).toHaveLength(2);
    expect(calls[1]?.url).toContain("cursor=c2");
  });

  it("getWatchlist, updateWatchlist (PATCH) and deleteWatchlist (DELETE)", async () => {
    const { client, calls } = makeClient([
      ok({ id: "wl_1", name: "A" }),
      ok({ id: "wl_1", name: "B" }),
      { status: 200, body: { success: true, data: { deleted: true } } },
    ]);
    await client.getWatchlist("wl_1");
    const updated = await client.updateWatchlist("wl_1", { name: "B", metadata: { team: "x" } });
    const deleted = await client.deleteWatchlist("wl_1");
    expect(calls[0]?.url).toBe(`${BASE}/watchlists/wl_1`);
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({ name: "B", metadata: { team: "x" } });
    expect(updated.data.name).toBe("B");
    expect(calls[2]?.method).toBe("DELETE");
    expect(calls[2]?.headers["content-type"]).toBeUndefined();
    expect(deleted.data.deleted).toBe(true);
  });

  it("deleteWatchlist tolerates an empty 204", async () => {
    const { client } = makeClient([{ status: 204 }]);
    // Response with status 204 must have a null body; the helper passes undefined.
    const res = await client.deleteWatchlist("wl_1");
    expect(res.data.deleted).toBe(true);
  });

  it("addWatchlistItems posts items with a per item outcome", async () => {
    const { client, calls } = makeClient([
      ok({ results: [{ cnr: CNR, result: "pending" }, { cnr: "BAD", result: "invalid", message: "x" }] }),
    ]);
    const res = await client.addWatchlistItems("wl_1", [{ cnr: "ZZAB010000012024" }, { cnr: "BAD" }]);
    expect(calls[0]?.url).toBe(`${BASE}/watchlists/wl_1/items`);
    expect(calls[0]?.body).toEqual({ items: [{ cnr: CNR }, { cnr: "BAD" }] });
    expect(res.data.results[1]?.result).toBe("invalid");
  });

  it("listWatchlistItems sends status filter; iterator walks pages", async () => {
    const { client, calls } = makeClient([list([{ cnr: CNR }], "n1"), list([{ cnr: "X" }], null)]);
    const pages: unknown[][] = [];
    for await (const page of client.iterWatchlistItems("wl_1", { status: "pending", limit: 50 })) pages.push(page);
    expect(pages).toHaveLength(2);
    expect(calls[0]?.url).toBe(`${BASE}/watchlists/wl_1/items?limit=50&status=pending`);
    expect(calls[1]?.url).toContain("cursor=n1");
  });

  it("removeWatchlistItem deletes by normalised CNR", async () => {
    const { client, calls } = makeClient([ok({ deleted: true })]);
    await client.removeWatchlistItem("wl_1", "cnr zzab010000012024");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`${BASE}/watchlists/wl_1/items/${CNR}`);
  });

  it("sends an Idempotency-Key only when retryPosts is in effect or given", async () => {
    const a = makeClient([ok({ id: "wl_1" })]);
    await a.client.createWatchlist({ name: "x" });
    expect(a.calls[0]?.headers["idempotency-key"]).toBeUndefined();
    const b = makeClient([ok({ id: "wl_1" })]);
    await b.client.createWatchlist({ name: "x" }, { idempotencyKey: "my-key" });
    expect(b.calls[0]?.headers["idempotency-key"]).toBe("my-key");
    const c = makeClient([ok({ id: "wl_1" })], { retryPosts: true });
    await c.client.createWatchlist({ name: "x" });
    expect(c.calls[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("change feed", () => {
  const evt = (id: string) => ({ id, type: "case.order_added", createdAt: "t", cnr: CNR, watchlists: [], data: {} });

  it("listChanges maps options to the query string", async () => {
    const { client, calls } = makeClient([list([evt("evt_1")], "cur1")]);
    const res = await client.listChanges({
      since: "2026-11-01T00:00:00Z",
      types: ["case.order_added", "case.disposed"],
      cnr: "zzab010000012024",
      limit: 100,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/prod/changes");
    expect(url.searchParams.get("since")).toBe("2026-11-01T00:00:00Z");
    expect(url.searchParams.get("types")).toBe("case.order_added,case.disposed");
    expect(url.searchParams.get("cnr")).toBe(CNR);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(res.pagination.nextCursor).toBe("cur1");
  });

  it("iterChanges stops at the first empty page", async () => {
    const { client, calls } = makeClient([
      list([evt("evt_1"), evt("evt_2")], "cur1"),
      list([evt("evt_3")], "cur2"),
      list([], "cur3"),
    ]);
    const ids: string[] = [];
    for await (const page of client.iterChanges()) for (const e of page) ids.push(e.id);
    expect(ids).toEqual(["evt_1", "evt_2", "evt_3"]);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.url).toContain("cursor=cur2");
  });

  it("iterChanges stops if the cursor does not advance", async () => {
    const { client } = makeClient([list([evt("evt_1")], "cur1"), list([evt("evt_2")], "cur1")]);
    const pages: unknown[] = [];
    for await (const page of client.iterChanges()) pages.push(page);
    expect(pages).toHaveLength(2);
  });

  it("listWatchlistEvents and iterWatchlistEvents hit the watchlist path", async () => {
    const { client, calls } = makeClient([list([evt("evt_1")], "c1"), list([], "c2")]);
    const pages: unknown[] = [];
    for await (const page of client.iterWatchlistEvents("wl_9", { types: "case.disposed" })) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v1/prod/watchlists/wl_9/events");
    expect(new URL(calls[0]!.url).searchParams.get("types")).toBe("case.disposed");
    const one = makeClient([list([], "c")]);
    const r = await one.client.listWatchlistEvents("wl_9");
    expect(r.data).toEqual([]);
  });
});

describe("webhooks", () => {
  it("createWebhook returns the secret", async () => {
    const { client, calls } = makeClient([ok({ id: "wh_1", url: "https://e.com/h", secret: "whsec_abc" })]);
    const res = await client.createWebhook({ url: "https://e.com/h", events: ["case.disposed"], watchlistIds: ["wl_1"], description: "d" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/webhooks`);
    expect(calls[0]?.body).toEqual({ url: "https://e.com/h", events: ["case.disposed"], watchlistIds: ["wl_1"], description: "d" });
    expect(res.data.secret).toBe("whsec_abc");
  });

  it("listWebhooks, getWebhook, updateWebhook, deleteWebhook", async () => {
    const { client, calls } = makeClient([
      list([{ id: "wh_1" }], null),
      ok({ id: "wh_1" }),
      ok({ id: "wh_1", enabled: true }),
      ok({ deleted: true }),
    ]);
    const l = await client.listWebhooks({ limit: 5 });
    await client.getWebhook("wh_1");
    const u = await client.updateWebhook("wh_1", { enabled: true, url: "https://e.com/new" });
    await client.deleteWebhook("wh_1");
    expect(l.data).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/webhooks?limit=5`);
    expect(calls[2]?.method).toBe("PATCH");
    expect(calls[2]?.body).toEqual({ enabled: true, url: "https://e.com/new" });
    expect(u.data.enabled).toBe(true);
    expect(calls[3]?.method).toBe("DELETE");
    expect(calls[3]?.url).toBe(`${BASE}/webhooks/wh_1`);
  });

  it("iterWebhooks walks pages", async () => {
    const { client } = makeClient([list([{ id: "wh_1" }], "x"), list([{ id: "wh_2" }], null)]);
    const ids: string[] = [];
    for await (const page of client.iterWebhooks()) for (const w of page) ids.push(w.id);
    expect(ids).toEqual(["wh_1", "wh_2"]);
  });

  it("rotateWebhookSecret and testWebhook POST with no body", async () => {
    const { client, calls } = makeClient([ok({ id: "wh_1", secret: "whsec_new" }), ok({ id: "whd_1", status: "succeeded" })]);
    const rotated = await client.rotateWebhookSecret("wh_1");
    const tested = await client.testWebhook("wh_1");
    expect(calls[0]?.url).toBe(`${BASE}/webhooks/wh_1/rotate-secret`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBeUndefined();
    expect(rotated.data.secret).toBe("whsec_new");
    expect(calls[1]?.url).toBe(`${BASE}/webhooks/wh_1/test`);
    expect(tested.data.status).toBe("succeeded");
  });

  it("listWebhookDeliveries, iterator and retryWebhookDelivery", async () => {
    const { client, calls } = makeClient([
      list([{ id: "whd_1" }], "d2"),
      list([{ id: "whd_2" }], null),
      ok({ id: "whd_1", status: "pending" }),
    ]);
    const ids: string[] = [];
    for await (const page of client.iterWebhookDeliveries("wh_1", { limit: 1 })) for (const d of page) ids.push(d.id);
    expect(ids).toEqual(["whd_1", "whd_2"]);
    expect(calls[0]?.url).toBe(`${BASE}/webhooks/wh_1/deliveries?limit=1`);
    const retried = await client.retryWebhookDelivery("wh_1", "whd_1");
    expect(calls[2]?.url).toBe(`${BASE}/webhooks/wh_1/deliveries/whd_1/retry`);
    expect(calls[2]?.method).toBe("POST");
    expect(retried.data.status).toBe("pending");
  });

  it("surfaces new error codes as typed errors", async () => {
    const { client } = makeClient([
      { status: 400, body: { success: false, error: "bad", code: "INVALID_WEBHOOK_URL" } },
      { status: 403, body: { success: false, error: "cap", code: "WEBHOOK_LIMIT_REACHED" } },
    ]);
    const a = await client.createWebhook({ url: "http://x" }).catch((e) => e);
    expect(a.apiCode).toBe("INVALID_WEBHOOK_URL");
    const b = await client.createWebhook({ url: "https://x" }).catch((e) => e);
    expect(b.apiCode).toBe("WEBHOOK_LIMIT_REACHED");
  });
});

describe("HTTP layer", () => {
  it("retries a DELETE on 503 by default but not a PATCH", async () => {
    const del = makeClient([{ status: 503, body: { success: false, error: "x" } }, ok({ deleted: true })]);
    await del.client.deleteWebhook("wh_1");
    expect(del.calls).toHaveLength(2);
    const patch = makeClient([{ status: 503, body: { success: false, error: "x" } }, ok({ id: "wh_1" })]);
    await expect(patch.client.updateWebhook("wh_1", { enabled: false })).rejects.toBeTruthy();
    expect(patch.calls).toHaveLength(1);
  });

  it("sends the 0.6.0 user agent", async () => {
    const { client, calls } = makeClient([ok({ id: "wh_1" })]);
    await client.getWebhook("wh_1");
    expect(calls[0]?.headers["user-agent"]).toBe("courtmesh-node/0.6.0");
  });
});

describe("verifyWebhookSignature", () => {
  const vector = JSON.parse(readFileSync(new URL("./fixtures/webhook-vector.json", import.meta.url), "utf8")) as {
    secret: string;
    rotatedSecret: string;
    timestamp: number;
    rawBody: string;
    signature: string;
    rotatedSignature: string;
  };
  const header = `t=${vector.timestamp},v1=${vector.signature}`;
  const now = vector.timestamp + 10;

  it("accepts the known test vector and returns the parsed event", () => {
    const event = verifyWebhookSignature(vector.rawBody, header, vector.secret, { now });
    expect(event.id).toBe("evt_01HTESTVECTOR");
    expect(event.type).toBe("case.hearing_date_changed");
    expect(event.cnr).toBe(CNR);
  });

  it("accepts a Buffer body", () => {
    const event = verifyWebhookSignature(Buffer.from(vector.rawBody), header, vector.secret, { now });
    expect(event.cnr).toBe(CNR);
  });

  it("rejects a tampered body", () => {
    expect(() => verifyWebhookSignature(vector.rawBody.replace("2026-12-04", "2026-12-05"), header, vector.secret, { now })).toThrow(
      WebhookSignatureError,
    );
  });

  it("rejects a wrong secret and a tampered signature", () => {
    expect(() => verifyWebhookSignature(vector.rawBody, header, "whsec_wrong", { now })).toThrow(/does not match/);
    const bad = `t=${vector.timestamp},v1=${vector.signature.replace(/.$/, "0")}`;
    expect(() => verifyWebhookSignature(vector.rawBody, bad, vector.secret, { now })).toThrow(WebhookSignatureError);
  });

  it("rejects a tampered timestamp (signature covers it)", () => {
    const h = `t=${vector.timestamp + 1},v1=${vector.signature}`;
    expect(() => verifyWebhookSignature(vector.rawBody, h, vector.secret, { now })).toThrow(/does not match/);
  });

  it("rejects an expired or future timestamp, honouring toleranceSeconds", () => {
    const err = (() => {
      try {
        verifyWebhookSignature(vector.rawBody, header, vector.secret, { now: vector.timestamp + 301 });
      } catch (e) {
        return e as WebhookSignatureError;
      }
    })();
    expect(err).toBeInstanceOf(WebhookSignatureError);
    expect(err?.reason).toBe("timestamp_out_of_tolerance");
    expect(() => verifyWebhookSignature(vector.rawBody, header, vector.secret, { now: vector.timestamp - 301 })).toThrow(WebhookSignatureError);
    expect(verifyWebhookSignature(vector.rawBody, header, vector.secret, { now: vector.timestamp + 301, toleranceSeconds: 400 }).id).toBe(
      "evt_01HTESTVECTOR",
    );
    expect(verifyWebhookSignature(vector.rawBody, header, vector.secret, { now: vector.timestamp + 300 }).id).toBe("evt_01HTESTVECTOR");
  });

  it("accepts either signature during rotation (two v1 values)", () => {
    const dual = `t=${vector.timestamp},v1=${vector.rotatedSignature},v1=${vector.signature}`;
    expect(verifyWebhookSignature(vector.rawBody, dual, vector.secret, { now }).id).toBe("evt_01HTESTVECTOR");
    expect(verifyWebhookSignature(vector.rawBody, dual, vector.rotatedSecret, { now }).id).toBe("evt_01HTESTVECTOR");
    expect(verifyWebhookSignature(vector.rawBody, dual, [vector.rotatedSecret, vector.secret], { now }).id).toBe("evt_01HTESTVECTOR");
    expect(() => verifyWebhookSignature(vector.rawBody, dual, "whsec_other", { now })).toThrow(WebhookSignatureError);
  });

  it("rejects missing and malformed headers", () => {
    expect(() => verifyWebhookSignature(vector.rawBody, undefined, vector.secret, { now })).toThrow(/Missing/);
    expect(() => verifyWebhookSignature(vector.rawBody, "", vector.secret, { now })).toThrow(WebhookSignatureError);
    expect(() => verifyWebhookSignature(vector.rawBody, "garbage", vector.secret, { now })).toThrow(/Malformed/);
    expect(() => verifyWebhookSignature(vector.rawBody, `t=${vector.timestamp}`, vector.secret, { now })).toThrow(/Malformed/);
    expect(() => verifyWebhookSignature(vector.rawBody, `v1=${vector.signature}`, vector.secret, { now })).toThrow(/Malformed/);
    expect(() => verifyWebhookSignature(vector.rawBody, `t=abc,v1=${vector.signature}`, vector.secret, { now })).toThrow(/Malformed/);
  });

  it("uses the system clock by default", async () => {
    const { createHmac } = await import("node:crypto");
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id: "evt_1", type: "webhook.test" });
    const sig = createHmac("sha256", "whsec_x").update(`${t}.${body}`).digest("hex");
    expect(verifyWebhookSignature(body, `t=${t},v1=${sig}`, "whsec_x").id).toBe("evt_1");
    expect(() => verifyWebhookSignature(vector.rawBody, header, vector.secret)).toThrow(/tolerance/);
  });
});

describe("final server behaviour", () => {
  it("lists an unavailable item with null case fields", async () => {
    const item = {
      cnr: CNR, reference: "R1", label: null, status: "unavailable",
      caseId: null, court: null, title: null, lastCheckedAt: null, lastChangedAt: null, snapshot: null, addedAt: "2026-11-02T00:00:00.000Z",
    };
    const { client, calls } = makeClient([list([item], null)]);
    const res = await client.listWatchlistItems("wl_1", { status: "unavailable" });
    expect(calls[0]?.url).toBe(`${BASE}/watchlists/wl_1/items?status=unavailable`);
    expect(res.data[0]?.status).toBe("unavailable");
    expect(res.data[0]?.snapshot).toBeNull();
  });

  it("returns cap_exceeded and not_found results as data, not errors", async () => {
    const { client } = makeClient([
      ok({
        results: [
          { cnr: CNR, result: "cap_exceeded", message: "The daily limit for adding case numbers has been reached. It resets at midnight IST." },
          { cnr: "ZZAB010000022024", result: "not_found", message: "eCourts had no such case when we last looked. Try again tomorrow." },
        ],
        itemCount: 3,
      }),
    ]);
    const res = await client.addWatchlistItems("wl_1", [{ cnr: CNR }, { cnr: "ZZAB010000022024" }]);
    expect(res.data.results.map((r) => r.result)).toEqual(["cap_exceeded", "not_found"]);
  });

  it("fetch=true in the cooldown throws NotFoundError", async () => {
    const { client } = makeClient([{ status: 404, body: { success: false, error: "No case with this CNR was found.", code: "CASE_NOT_FOUND", cnr: CNR, status: "not_found" } }]);
    const err: any = await client.getCaseByCnr(CNR, { fetch: true }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.apiCode).toBe("CASE_NOT_FOUND");
  });

  it("keeps query validation details as path: message strings", async () => {
    const details = ["limit: limit cannot exceed 100."];
    const { client } = makeClient([{ status: 400, body: { success: false, error: "Validation failed. Please check your request and try again.", code: "VALIDATION_ERROR", details } }]);
    const err: any = await client.listChanges({ limit: 500 }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual(details);
  });
});
