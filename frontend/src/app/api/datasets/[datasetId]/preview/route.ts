
/**
 * Private Dataset Health Check API bridge.
 *
 * Browser:
 * GET /api/datasets/{datasetId}/preview
 *
 * FastAPI:
 * GET /api/v1/datasets/{datasetId}/preview
 *
 * The JWT remains in the HttpOnly session cookie.
 * FastAPI handles authentication and dataset ownership.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEV_API = "http://127.0.0.1:8000";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

type RouteContext = {
  params: Promise<{ datasetId: string }>;
};

function reply(
  status: number,
  body: Record<string, unknown>,
) {
  return NextResponse.json(body, {
    status,
    headers: PRIVATE_HEADERS,
  });
}

function fail(status: number, message: string) {
  return reply(status, {
    success: false,
    message,
  });
}

function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function backendUrl(
  datasetId: string,
  limit: number,
): string | null {
  const configured =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development"
      ? DEV_API
      : "");

  if (!configured) return null;

  try {
    const base = new URL(configured);

    if (
      base.protocol !== "http:" &&
      base.protocol !== "https:"
    ) {
      return null;
    }

    const url = new URL(
      `/api/v1/datasets/${datasetId}/preview`,
      base,
    );

    url.searchParams.set("limit", String(limit));

    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Limit the JSON payload, even if FastAPI does not
 * return a Content-Length header.
 */
async function readBoundedJson(
  response: Response,
): Promise<unknown> {
  const declared = response.headers.get("content-length");

  if (declared !== null) {
    const size = Number(declared);

    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_RESPONSE_BYTES
    ) {
      throw new Error("Invalid response size");
    }
  }

  if (!response.body) {
    throw new Error("Empty response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
  });

  let received = 0;
  let content = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      received += value.byteLength;

      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Response too large");
      }

      content += decoder.decode(value, {
        stream: true,
      });
    }

    content += decoder.decode();

    return JSON.parse(content);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Validate the important parts of the FastAPI contract
 * before sending the response to the browser.
 */
function validPreview(
  value: unknown,
  datasetId: string,
): value is Record<string, unknown> {
  if (!isObject(value)) return false;

  if (
    typeof value.dataset_id !== "string" ||
    value.dataset_id.toLowerCase() !==
      datasetId.toLowerCase()
  ) {
    return false;
  }

  if (
    !isCount(value.sampled_rows) ||
    value.sampled_rows > 1000 ||
    !isCount(value.preview_limit) ||
    value.preview_limit > 50
  ) {
    return false;
  }

  if (
    value.total_rows !== null &&
    !isCount(value.total_rows)
  ) {
    return false;
  }

  if (
    !Array.isArray(value.rows) ||
    value.rows.length > value.preview_limit ||
    !value.rows.every(isObject) ||
    !Array.isArray(value.columns) ||
    value.columns.length > 100
  ) {
    return false;
  }

  const quality = value.quality;

  if (!isObject(quality)) return false;

  if (
    quality.sample_scope !== "first_rows" ||
    typeof quality.sample_is_partial !== "boolean" ||
    quality.sampled_rows !== value.sampled_rows
  ) {
    return false;
  }

  const metrics = [
    "missing_cells",
    "rows_with_missing",
    "duplicate_rows",
    "nonnumeric_columns",
    "mixed_columns",
    "constant_columns",
    "potential_outlier_cells",
  ];

  if (!metrics.every((key) => isCount(quality[key]))) {
    return false;
  }

  if (
    !Array.isArray(quality.columns) ||
    quality.columns.length !== value.columns.length ||
    !quality.columns.every(
      (column: unknown) =>
        isObject(column) &&
        typeof column.name === "string" &&
        ["numeric", "text", "mixed", "empty"].includes(
          String(column.inferred_type),
        ) &&
        isCount(column.missing_count) &&
        isCount(column.distinct_count) &&
        isCount(column.invalid_numeric_count) &&
        isCount(column.potential_outlier_count) &&
        typeof column.is_constant === "boolean",
    )
  ) {
    return false;
  }

  return (
    Array.isArray(quality.recommendations) &&
    quality.recommendations.length <= 20 &&
    quality.recommendations.every(
      (message: unknown) =>
        typeof message === "string" &&
        message.length <= 500,
    )
  );
}

export async function GET(
  request: NextRequest,
  context: RouteContext,
) {
  const { datasetId } = await context.params;

  // Validate the dataset ID before contacting FastAPI.
  if (!UUID.test(datasetId)) {
    return fail(400, "Invalid dataset ID.");
  }

  // Only the supported 'limit' query is accepted.
  const params = request.nextUrl.searchParams;

  if (
    Array.from(params.keys()).some(
      (key) => key !== "limit",
    ) ||
    params.getAll("limit").length > 1
  ) {
    return fail(400, "Unsupported query parameters.");
  }

  const rawLimit = params.get("limit") ?? "5";

  if (!/^[1-9]\d?$/.test(rawLimit)) {
    return fail(400, "Limit must be between 1 and 50.");
  }

  const limit = Number(rawLimit);

  if (limit < 1 || limit > 50) {
    return fail(400, "Limit must be between 1 and 50.");
  }

  // Read the private cookie on the Next.js server.
  const token = request.cookies.get(COOKIE_NAME)?.value;

  if (
    !token ||
    token.length < 16 ||
    token.length > 8192 ||
    /\s/.test(token)
  ) {
    return fail(
      401,
      "Please sign in to view dataset quality.",
    );
  }

  const url = backendUrl(datasetId, limit);

  if (!url) {
    return fail(
      503,
      "Dataset quality service is not configured.",
    );
  }

  let upstream: Response;

  try {
    upstream = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return fail(
      503,
      "Dataset quality service is unavailable.",
    );
  }

  // Preserve meaningful backend error statuses.
  if (
    upstream.status === 401 ||
    upstream.status === 403
  ) {
    return fail(
      401,
      "Your session has expired. Please sign in again.",
    );
  }

  if (upstream.status === 404) {
    return fail(404, "Dataset not found.");
  }

  if (upstream.status === 409) {
    return fail(
      409,
      "The stored dataset could not be analyzed.",
    );
  }

  if (upstream.status === 429) {
    return fail(
      429,
      "Too many requests. Please try again later.",
    );
  }

  if (!upstream.ok) {
    return fail(
      502,
      "Could not retrieve dataset quality.",
    );
  }

  let data: unknown;

  try {
    data = await readBoundedJson(upstream);
  } catch {
    return fail(
      502,
      "The dataset service returned an invalid response.",
    );
  }

  if (!validPreview(data, datasetId)) {
    return fail(
      502,
      "The dataset quality response is invalid.",
    );
  }

  return reply(200, {
    success: true,
    dataset_id: data.dataset_id,
    total_rows: data.total_rows,
    sampled_rows: data.sampled_rows,
    preview_limit: data.preview_limit,
    rows: data.rows,
    columns: data.columns,
    quality: data.quality,
  });
}
