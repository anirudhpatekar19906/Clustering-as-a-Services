
/**
 * File 101 — Secure clustered CSV download bridge.
 *
 * Browser:
 * GET /api/experiments/results/{experimentId}/export
 *
 * FastAPI:
 * GET /api/v1/experiments/history/{experimentId}/export.csv
 *
 * The browser sends its HttpOnly session cookie to Next.js.
 * Next.js reads the cookie server-side and forwards the JWT to FastAPI.
 * The JWT is never returned to browser JavaScript.
 *
 * CSV data is streamed rather than loaded entirely into memory.
 *
 * Next.js 16 Cache Components:
 * Do not add an explicit `runtime` or `dynamic` export.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEV_API_URL = "http://127.0.0.1:8000";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Defense-in-depth limit on the generated download.
// This is larger than our 25 MiB upload limit because CSV quoting
// and the appended cluster column can increase output size.
const MAX_EXPORT_BYTES = 128 * 1024 * 1024;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

type RouteContext = {
  params: Promise<{ experimentId: string }>;
};

function fail(status: number, message: string) {
  return NextResponse.json(
    {
      success: false,
      message,
    },
    {
      status,
      headers: PRIVATE_HEADERS,
    },
  );
}

/**
 * Read the authentication token only from the server-side cookie.
 * Reject absent, malformed, or excessively long token values.
 */
function getToken(request: NextRequest): string | null {
  const token = request.cookies.get(COOKIE_NAME)?.value;

  if (
    !token ||
    token.length < 16 ||
    token.length > 8192 ||
    /\s/.test(token)
  ) {
    return null;
  }

  return token;
}

/**
 * Prevent a separate website from triggering authenticated
 * cross-site downloads through this cookie-based endpoint.
 */
function isAllowedOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (origin !== null && origin !== request.nextUrl.origin) {
    return false;
  }

  if (
    fetchSite !== null &&
    fetchSite !== "same-origin" &&
    fetchSite !== "none"
  ) {
    return false;
  }

  return true;
}

/**
 * Build the FastAPI URL without using user-provided paths or hosts.
 * The experiment ID is validated before this function is called.
 */
function backendUrl(experimentId: string): string | null {
  const configured =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development"
      ? DEV_API_URL
      : "");

  if (!configured) {
    return null;
  }

  try {
    const base = new URL(configured);

    if (
      base.protocol !== "http:" &&
      base.protocol !== "https:"
    ) {
      return null;
    }

    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      return null;
    }

    return new URL(
      `/api/v1/experiments/history/${experimentId}/export.csv`,
      base,
    ).toString();
  } catch {
    return null;
  }
}

/**
 * Apply a streaming size limit.
 *
 * This preserves backpressure and avoids buffering the entire CSV
 * in Next.js memory. An unexpectedly oversized stream is terminated
 * rather than forwarded beyond the limit.
 */
function limitedCsvStream(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let totalBytes = 0;

  const limiter = new TransformStream<
    Uint8Array,
    Uint8Array
  >({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength;

      if (totalBytes > MAX_EXPORT_BYTES) {
        controller.error(
          new Error("CSV export exceeded the allowed size"),
        );
        return;
      }

      controller.enqueue(chunk);
    },
  });

  return source.pipeThrough(limiter);
}

export async function GET(
  request: NextRequest,
  { params }: RouteContext,
) {
  const { experimentId } = await params;

  // 1. Validate the experiment identifier.
  if (!UUID.test(experimentId)) {
    return fail(404, "Experiment not found.");
  }

  // 2. Do not accept arbitrary export query options.
  if (request.nextUrl.search !== "") {
    return fail(400, "Unsupported export query parameters.");
  }

  // 3. Restrict cross-origin requests.
  if (!isAllowedOrigin(request)) {
    return fail(403, "Request origin is not allowed.");
  }

  // 4. Verify that the browser has a session cookie.
  const token = getToken(request);

  if (!token) {
    return fail(
      401,
      "Please sign in to download clustering results.",
    );
  }

  // 5. Locate the trusted backend endpoint.
  const url = backendUrl(experimentId);

  if (!url) {
    return fail(
      503,
      "CSV export service is not configured.",
    );
  }

  // 6. Ask FastAPI to authorize and generate the export.
  let upstream: Response;

  try {
    upstream = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/csv",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return fail(
      503,
      "Cannot reach the CSV export service. Please retry.",
    );
  }

  // 7. Convert backend errors into safe frontend messages.
  if (upstream.status === 401 || upstream.status === 403) {
    return fail(
      401,
      "Your session has expired. Please sign in again.",
    );
  }

  if (upstream.status === 404) {
    // Do not reveal whether another user owns this ID.
    return fail(404, "Experiment not found.");
  }

  if (upstream.status === 409) {
    return fail(
      409,
      "This experiment does not have exportable results yet.",
    );
  }

  if (upstream.status === 429) {
    return fail(
      429,
      "Too many export requests. Please try again shortly.",
    );
  }

  if (upstream.status === 503) {
    return fail(
      503,
      "CSV export service is temporarily unavailable.",
    );
  }

  if (upstream.status !== 200) {
    return fail(
      502,
      "Unable to prepare your CSV export.",
    );
  }

  // 8. Verify that the upstream response is a CSV.
  const contentType =
    upstream.headers.get("content-type") ?? "";

  const mediaType = contentType
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (mediaType !== "text/csv") {
    await upstream.body?.cancel().catch(() => undefined);

    return fail(
      502,
      "Export service returned an invalid file type.",
    );
  }

  if (!upstream.body) {
    return fail(
      502,
      "Export service returned an empty response.",
    );
  }

  // 9. Reject oversized declared downloads before streaming.
  const lengthHeader =
    upstream.headers.get("content-length");

  if (lengthHeader !== null) {
    const declaredBytes = Number(lengthHeader);

    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > MAX_EXPORT_BYTES
    ) {
      await upstream.body.cancel().catch(
        () => undefined,
      );

      return fail(
        502,
        "CSV export is too large or has an invalid size.",
      );
    }
  }

  // 10. Choose our own safe filename.
  // Never copy an untrusted upstream Content-Disposition header.
  const safeId = experimentId.toLowerCase();
  const filename = `caas-clusters-${safeId}.csv`;

  // 11. Return a private, downloadable CSV stream.
  return new Response(
    limitedCsvStream(upstream.body),
    {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition":
          `attachment; filename="${filename}"`,
        "X-Robots-Tag": "noindex",
      },
    },
  );
}
