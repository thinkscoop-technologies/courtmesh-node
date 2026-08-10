import { describe, expect, it } from "vitest";
import { CourtMeshClient } from "../src/client.js";
import { CourtMeshError } from "../src/errors.js";
import { queueFetch } from "./helpers.js";

const API_KEY = "cm-abcdefghij1234567890abcdefghijkl-wxyz";

function makeClient(entries: Parameters<typeof queueFetch>[0], overrides: Record<string, unknown> = {}) {
  const { fetch, calls } = queueFetch(entries);
  const client = new CourtMeshClient({ apiKey: API_KEY, fetch, maxRetries: 1, ...overrides });
  return { client, calls };
}

describe("auth header", () => {
  it("sends Authorization: Bearer <key> on protected endpoints", async () => {
    const { client, calls } = makeClient([{ status: 200, body: { success: true, data: ["JUSTICE A"] } }]);
    await client.searchJudges({ q: "a" });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("omits Authorization on GET /health", async () => {
    const { client, calls } = makeClient([
      { status: 200, body: { success: true, status: "healthy", version: "1.0.0", timestamp: "2026-08-10T09:00:00.000Z" } },
    ]);
    await client.health();
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });
});

describe("1. searchJudges", () => {
  it("unwraps the envelope and exposes meta", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: ["JUSTICE A B", "JUSTICE C D"],
          meta: { query: "khanna", responseTime: "3ms", totalMatches: 2 },
        },
      },
    ]);
    const result = await client.searchJudges({ q: "khanna" });
    expect(result.data).toEqual(["JUSTICE A B", "JUSTICE C D"]);
    expect(result.meta?.totalMatches).toBe(2);
  });
});

describe("2. searchCases", () => {
  it("unwraps the envelope with the keyword pagination shape", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [{ _id: "abc", _score: 12.3, title: "State v. X" }],
          meta: { query: "murder", filters: { court: "Delhi HC" }, responseTime: "10ms" },
          pagination: { total: 1234, hasMore: true, page: 1, limit: 20, nextCursor: [12.34, "68f0"] },
        },
      },
    ]);
    const result = await client.searchCases({ query: "murder", court: "Delhi HC" });
    expect(result.data[0]?._id).toBe("abc");
    expect(result.pagination.total).toBe(1234);
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.nextCursor).toEqual([12.34, "68f0"]);
    expect("totalPages" in result.pagination).toBe(false);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ query: "murder", court: "Delhi HC" });
  });

  it("walks pages with iterSearchCases until hasMore is false", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [{ _id: "1", _score: 1 }],
          pagination: { total: 2, hasMore: true, page: 1, limit: 1, nextCursor: null },
        },
      },
      {
        status: 200,
        body: {
          success: true,
          data: [{ _id: "2", _score: 1 }],
          pagination: { total: 2, hasMore: false, page: 2, limit: 1, nextCursor: null },
        },
      },
    ]);

    const pages: string[] = [];
    for await (const page of client.iterSearchCases({ query: "x", limit: 1 })) {
      for (const hit of page) pages.push(hit._id);
    }
    expect(pages).toEqual(["1", "2"]);
  });

  it("stops iterSearchCases on an empty page", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: { success: true, data: [], pagination: { total: 0, hasMore: false, page: 1, limit: 20, nextCursor: null } },
      },
    ]);
    const pages = [];
    for await (const page of client.iterSearchCases({ query: "nothing" })) {
      pages.push(page);
    }
    expect(pages).toEqual([]);
  });
});

describe("3. semanticSearch", () => {
  it("unwraps the envelope with the semantic pagination shape", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [{ id: "c1", title: "A v. B", similarity: 0.82 }],
          meta: { query: "breach of contract", appliedFilters: {}, responseTime: "50ms", searchType: "semantic" },
          pagination: { page: 1, limit: 20, total: 41, totalPages: 3, hasMore: true },
        },
      },
    ]);
    const result = await client.semanticSearch({ query: "breach of contract" });
    expect(result.data[0]).toMatchObject({ id: "c1", similarity: 0.82 });
    expect(result.pagination.totalPages).toBe(3);
    expect("nextCursor" in result.pagination).toBe(false);
  });

  it("throws CourtMeshError when the HTTP 200 body has success: false", async () => {
    const { client } = makeClient([
      { status: 200, body: { success: false, error: "Failed to generate query embedding" } },
    ]);
    const error = await client.semanticSearch({ query: "abc" }).catch((e) => e);
    expect(error).toBeInstanceOf(CourtMeshError);
    expect(error.message).toBe("Failed to generate query embedding");
    expect(error.statusCode).toBe(200);
  });

  it("walks pages with iterSemanticSearch until hasMore is false", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [{ id: "1", similarity: 0.9 }],
          pagination: { page: 1, limit: 1, total: 2, totalPages: 2, hasMore: true },
        },
      },
      {
        status: 200,
        body: {
          success: true,
          data: [{ id: "2", similarity: 0.8 }],
          pagination: { page: 2, limit: 1, total: 2, totalPages: 2, hasMore: false },
        },
      },
    ]);
    const ids: string[] = [];
    for await (const page of client.iterSemanticSearch({ query: "x", limit: 1 })) {
      for (const item of page) ids.push((item as { id: string }).id);
    }
    expect(ids).toEqual(["1", "2"]);
  });

  it("sends the free-form filters object separately from the top level fields", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: [],
          meta: { query: "x", responseTime: "1ms", message: "No similar cases found." },
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false },
        },
      },
    ]);
    await client.semanticSearch({ query: "x", court: "ignored", filters: { court: "Delhi HC", caseYear: 2024 } });
    expect(calls[0]?.body).toMatchObject({ court: "ignored", filters: { court: "Delhi HC", caseYear: 2024 } });
  });
});

describe("4. getCase", () => {
  it("unwraps the case details envelope", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { id: "abc123", title: "State v. X", hasDocuments: true, hasAnalysis: false },
          meta: { responseTime: "5ms", note: "Use /cases/:id/analysis endpoint to get AI analysis separately" },
        },
      },
    ]);
    const result = await client.getCase("abc123");
    expect(result.data.id).toBe("abc123");
    expect(calls[0]?.url).toContain("/cases/abc123");
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("5. getCaseAnalysis", () => {
  it("unwraps the not-available variant", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { id: "abc123", hasAnalysis: false, message: "AI analysis not available for this case" },
          meta: { responseTime: "2ms", note: "Use POST /cases/:id/analyze to generate AI analysis" },
        },
      },
    ]);
    const result = await client.getCaseAnalysis("abc123");
    expect(result.data.hasAnalysis).toBe(false);
  });

  it("unwraps the available variant", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { id: "abc123", hasAnalysis: true, analysis: { summary: "s", keyFacts: ["a"] } },
          meta: { responseTime: "2ms", note: "" },
        },
      },
    ]);
    const result = await client.getCaseAnalysis("abc123");
    expect(result.data.hasAnalysis).toBe(true);
    if (result.data.hasAnalysis) {
      expect(result.data.analysis.summary).toBe("s");
    }
  });
});

describe("6. getRelated", () => {
  it("unwraps related documents and timeline", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: {
            relatedDocuments: [
              { id: "1", caseNumber: "CN1", decisionDate: "2024-01-01", isCurrent: true },
            ],
            timeline: [{ date: "2024-01-01", status: "Final Judgment", statusLabel: "Final Judgment", documentId: "1" }],
          },
          meta: { responseTime: "4ms", caseNumber: "CN1", totalDocuments: 1, timelineEvents: 1 },
        },
      },
    ]);
    const result = await client.getRelated("1");
    expect(result.data.relatedDocuments).toHaveLength(1);
    expect(result.data.timeline[0]?.status).toBe("Final Judgment");
  });
});

describe("7. getCasePdf", () => {
  it("unwraps the pdf envelope", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { pdfUrl: "cipher-text", expiresIn: 3600, caseId: "1", caseNumber: "CN1", caseTitle: "T" },
          meta: { responseTime: "1ms", note: "The PDF URL is encrypted and expires in 1 hour. Use the decryption key provided in your SDK." },
        },
      },
    ]);
    const result = await client.getCasePdf("1");
    expect(result.data.expiresIn).toBe(3600);
  });
});

describe("8. analyzeCase", () => {
  it("unwraps the processing (202) variant", async () => {
    const { client, calls } = makeClient([
      {
        status: 202,
        body: {
          success: true,
          data: { message: "Analysis has been started", status: "processing" },
          meta: { responseTime: "1ms", note: "You can check the analysis status by calling the GET /cases/:id endpoint in 30-60 seconds." },
        },
      },
    ]);
    const result = await client.analyzeCase("1");
    expect("status" in result.data && result.data.status).toBe("processing");
    expect(calls[0]?.body).toEqual({ force: false });
  });

  it("passes force: true through", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { message: "Analysis already exists", analysis: { summary: "s" }, alreadyExists: true },
          meta: { responseTime: "1ms", note: "" },
        },
      },
    ]);
    await client.analyzeCase("1", { force: true });
    expect(calls[0]?.body).toEqual({ force: true });
  });
});

describe("9. analyzeConsolidated", () => {
  it("unwraps the success status", async () => {
    const { client } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: {
            status: "success",
            consolidatedAnalysis: { summary: "s", outcome: "allowed" },
            message: "done",
          },
          meta: { responseTime: "100ms", relatedCases: 5 },
        },
      },
    ]);
    const result = await client.analyzeConsolidated("1");
    expect(result.data.status).toBe("success");
    expect(result.meta?.relatedCases).toBe(5);
  });
});

describe("10. requestTimeline", () => {
  it("sends case_id and unwraps the job", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { requestId: "job1", status: "pending" },
          meta: { responseTime: "3ms" },
        },
      },
    ]);
    const result = await client.requestTimeline("abc123");
    expect(result.data.requestId).toBe("job1");
    expect(calls[0]?.body).toEqual({ case_id: "abc123" });
  });
});

describe("11. getTimeline", () => {
  it("unwraps the polled job", async () => {
    const { client, calls } = makeClient([
      {
        status: 200,
        body: {
          success: true,
          data: { requestId: "job1", status: "completed", createdAt: "t1", updatedAt: "t2", orderCount: 2, totalOrderCount: 2 },
          meta: { responseTime: "2ms" },
        },
      },
    ]);
    const result = await client.getTimeline("job1");
    expect(result.data.status).toBe("completed");
    expect(calls[0]?.url).toContain("/get-timeline/job1");
  });
});

describe("12. health", () => {
  it("is not enveloped in data", async () => {
    const { client } = makeClient([
      { status: 200, body: { success: true, status: "healthy", version: "1.0.0", timestamp: "2026-08-10T09:00:00.000Z" } },
    ]);
    const result = await client.health();
    expect(result.status).toBe("healthy");
    expect(result.version).toBe("1.0.0");
  });
});
