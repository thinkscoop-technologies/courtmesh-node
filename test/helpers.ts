import type { FetchLike } from "../src/client.js";

export interface RecordedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeFetchResult {
  fetch: FetchLike;
  calls: RecordedCall[];
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A queue of canned responses, one per call, played back in order. */
export function queueFetch(
  entries: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
): FakeFetchResult {
  const calls: RecordedCall[] = [];
  let index = 0;

  const fetch: FetchLike = async (input, init) => {
    const entry = entries[index];
    index += 1;
    if (!entry) {
      throw new Error(`queueFetch: no more canned responses, call ${index} was not expected`);
    }
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
    }
    calls.push({
      url: input,
      method: init?.method,
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return jsonResponse(entry.status, entry.body, entry.headers);
  };

  return { fetch, calls };
}

export { jsonResponse };
