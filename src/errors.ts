/**
 * Typed error hierarchy for the CourtMesh SDK.
 *
 * Every error the client throws for an HTTP failure extends CourtMeshError
 * and carries the HTTP status code, the message and the raw parsed response
 * body (or undefined if the body could not be parsed as JSON).
 */

export type CourtMeshErrorCode =
  | "validation_error"
  | "authentication_error"
  | "permission_error"
  | "not_found"
  | "request_timeout"
  | "rate_limit"
  | "server_error"
  | "bad_gateway"
  | "service_unavailable"
  | "network_error"
  | "unknown_error";

/** Base class for every error the SDK throws for a failed request. */
export class CourtMeshError extends Error {
  /** Discriminant usable in a switch or type guard, one value per subclass. */
  readonly code: CourtMeshErrorCode;
  /** The HTTP status code, undefined for network level failures. */
  readonly statusCode: number | undefined;
  /** The raw parsed response body, undefined if it was not valid JSON. */
  readonly body: unknown;

  constructor(message: string, code: CourtMeshErrorCode, statusCode: number | undefined, body: unknown) {
    super(message);
    this.name = "CourtMeshError";
    this.code = code;
    this.statusCode = statusCode;
    this.body = body;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 400, request failed zod validation. `details` mirrors the server's `details` array when present. */
export class ValidationError extends CourtMeshError {
  readonly details?: string[];

  constructor(message: string, body: unknown, details?: string[]) {
    super(message, "validation_error", 400, body);
    this.name = "ValidationError";
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401, missing, malformed, unknown or deactivated API key. */
export class AuthenticationError extends CourtMeshError {
  constructor(message: string, body: unknown) {
    super(message, "authentication_error", 401, body);
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 403, organization or account state prevents the call, or a plan limit was
 * hit. `callsToday` and `maxAllowed` are populated only for the plan limit
 * variant.
 */
export class PermissionError extends CourtMeshError {
  readonly callsToday?: number;
  readonly maxAllowed?: number;

  constructor(message: string, body: unknown, callsToday?: number, maxAllowed?: number) {
    super(message, "permission_error", 403, body);
    this.name = "PermissionError";
    this.callsToday = callsToday;
    this.maxAllowed = maxAllowed;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 404, case, request or job not found. */
export class NotFoundError extends CourtMeshError {
  constructor(message: string, body: unknown) {
    super(message, "not_found", 404, body);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 408, the OpenSearch query took too long, or the SDK's own client side timeout fired. */
export class RequestTimeoutError extends CourtMeshError {
  constructor(message: string, body: unknown) {
    super(message, "request_timeout", 408, body);
    this.name = "RequestTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 429, more than 10 requests per minute for this API key. */
export class RateLimitError extends CourtMeshError {
  /** Seconds to wait before retrying, from the `Retry-After` header or the JSON body's `retryAfter`. */
  readonly retryAfter?: number;
  /** ISO timestamp of when the limit resets. */
  readonly resetTime?: string;

  constructor(message: string, body: unknown, retryAfter?: number, resetTime?: string) {
    super(message, "rate_limit", 429, body);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
    this.resetTime = resetTime;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 500, an unhandled server side error. */
export class ServerError extends CourtMeshError {
  constructor(message: string, body: unknown) {
    super(message, "server_error", 500, body);
    this.name = "ServerError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 502, the API failed to connect to an upstream dependency. */
export class BadGatewayError extends CourtMeshError {
  constructor(message: string, body: unknown) {
    super(message, "bad_gateway", 502, body);
    this.name = "BadGatewayError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 503, account standing could not be verified, or the service is otherwise unavailable. Safe to retry. */
export class ServiceUnavailableError extends CourtMeshError {
  constructor(message: string, body: unknown) {
    super(message, "service_unavailable", 503, body);
    this.name = "ServiceUnavailableError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** No HTTP response was received at all, DNS failure, connection refused, aborted request, and similar. */
export class NetworkError extends CourtMeshError {
  constructor(message: string, cause?: unknown) {
    super(message, "network_error", undefined, cause);
    this.name = "NetworkError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Type guard, and the discriminant to narrow on when you only have `unknown`. */
export function isCourtMeshError(error: unknown): error is CourtMeshError {
  return error instanceof CourtMeshError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Maps an HTTP status code plus a parsed response body to the matching typed error. */
export function mapStatusToError(statusCode: number, message: string, body: unknown): CourtMeshError {
  switch (statusCode) {
    case 400: {
      const details = isRecord(body) && Array.isArray(body.details) ? (body.details as string[]) : undefined;
      return new ValidationError(message, body, details);
    }
    case 401:
      return new AuthenticationError(message, body);
    case 403: {
      const callsToday = isRecord(body) && typeof body.callsToday === "number" ? body.callsToday : undefined;
      const maxAllowed = isRecord(body) && typeof body.maxAllowed === "number" ? body.maxAllowed : undefined;
      return new PermissionError(message, body, callsToday, maxAllowed);
    }
    case 404:
      return new NotFoundError(message, body);
    case 408:
      return new RequestTimeoutError(message, body);
    case 429: {
      const retryAfter = isRecord(body) && typeof body.retryAfter === "number" ? body.retryAfter : undefined;
      const resetTime = isRecord(body) && typeof body.resetTime === "string" ? body.resetTime : undefined;
      return new RateLimitError(message, body, retryAfter, resetTime);
    }
    case 500:
      return new ServerError(message, body);
    case 502:
      return new BadGatewayError(message, body);
    case 503:
      return new ServiceUnavailableError(message, body);
    default:
      return new CourtMeshError(message, "unknown_error", statusCode, body);
  }
}
