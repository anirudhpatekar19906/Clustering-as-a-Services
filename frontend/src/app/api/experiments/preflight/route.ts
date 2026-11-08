/**
 * File 65 — Authenticated experiment preflight bridge.
 *
 * POST /api/experiments/preflight (browser -> Next.js -> FastAPI).
 * Checks dataset ownership and saved metadata without creating an experiment
 * or queueing a Redis/RQ job. The JWT remains in the HttpOnly cookie.
 *
 * IMPORTANT: FastAPI's preflight is metadata_only. It does not load CSV
 * numerical data, test feature types, or guarantee clustering will succeed.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEV_API = "http://127.0.0.1:8000";
const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

const ALLOWED_FIELDS = new Set([
  "dataset_id", "n_clusters", "features", "scaling", "missing_values",
  "init", "max_iter", "tolerance", "n_init", "random_state",
  "include_silhouette", "silhouette_sample_size",
]);

const CHOICES: Record<string, readonly string[]> = {
  scaling: ["none", "standardize", "minmax"],
  missing_values: ["error", "median", "mean", "zero"],
  init: ["kmeans++", "random"],
};

const NUMERIC_FIELDS: Record<
  string,
  { min: number; max: number; integer: boolean }
> = {
  max_iter: { min: 1, max: 1000, integer: true },
  tolerance: { min: 0, max: Number.MAX_VALUE, integer: false },
  n_init: { min: 1, max: 20, integer: true },
  random_state: { min: 0, max: 4_294_967_295, integer: true },
  silhouette_sample_size: { min: 2, max: 1500, integer: true },
};

type Validation =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string };

class BodyTooLarge extends Error {}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function fail(status: number, message: string) {
  return NextResponse.json(
    { success: false, message },
    { status, headers: PRIVATE_HEADERS },
  );
}

function backendUrl(): string | null {
  const value =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development" ? DEV_API : "");

  if (!value) return null;

  try {
    const base = new URL(value);

    if (!["http:", "https:"].includes(base.protocol)) {
      return null;
    }

    return new URL(
      "/api/v1/experiments/preflight",
      base
    ).toString();
  } catch {
    return null;
  }
}

async function boundedJson(
  request: NextRequest
): Promise<unknown> {
  if (!request.body) {
    throw new SyntaxError("Empty body");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
  });

  const chunks: string[] = [];
  let bytes = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      bytes += value.byteLength;

      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new BodyTooLarge();
      }

      chunks.push(
        decoder.decode(value, { stream: true })
      );
    }

    chunks.push(decoder.decode());

    return JSON.parse(chunks.join(""));
  } finally {
    reader.releaseLock();
  }
}

/**
 * Validate the same request fields used by
 * File 64's experiment submission route.
 */
function validate(value: unknown): Validation {
  if (!isRecord(value)) {
    return {
      ok: false,
      message: "Send one JSON experiment configuration.",
    };
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return {
        ok: false,
        message: `Unsupported configuration field: ${key.slice(0, 80)}.`,
      };
    }
  }

  if (
    typeof value.dataset_id !== "string" ||
    !UUID.test(value.dataset_id)
  ) {
    return {
      ok: false,
      message: "Choose a valid dataset ID.",
    };
  }

  if (
    typeof value.n_clusters !== "number" ||
    !Number.isInteger(value.n_clusters) ||
    value.n_clusters < 2 ||
    value.n_clusters > 50
  ) {
    return {
      ok: false,
      message: "Number of clusters must be between 2 and 50.",
    };
  }

  const body: Record<string, unknown> = {
    dataset_id: value.dataset_id,
    n_clusters: value.n_clusters,
  };

  if (value.features === null) {
    // Actual numeric feature selection happens during execution.
    body.features = null;
  } else if (value.features !== undefined) {
    if (
      !Array.isArray(value.features) ||
      value.features.length < 1 ||
      value.features.length > 100 ||
      value.features.some(
        (name) =>
          typeof name !== "string" ||
          !name.trim()
      )
    ) {
      return {
        ok: false,
        message: "Choose 1–100 nonempty feature names.",
      };
    }

    const names = (value.features as string[]).map(
      (name) => name.trim()
    );

    if (
      new Set(
        names.map((name) => name.toLocaleLowerCase())
      ).size !== names.length
    ) {
      return {
        ok: false,
        message: "Feature names must be unique.",
      };
    }

    body.features = names;
  }

  for (const [key, options] of Object.entries(CHOICES)) {
    if (value[key] === undefined) continue;

    if (
      typeof value[key] !== "string" ||
      !options.includes(value[key] as string)
    ) {
      return {
        ok: false,
        message: `Invalid ${key} option.`,
      };
    }

    body[key] = value[key];
  }

  for (const [key, range] of Object.entries(NUMERIC_FIELDS)) {
    if (value[key] === undefined) continue;

    const number = value[key];

    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      (range.integer && !Number.isInteger(number)) ||
      number < range.min ||
      number > range.max
    ) {
      return {
        ok: false,
        message: `Invalid ${key} value.`,
      };
    }

    body[key] = number;
  }

  if (value.include_silhouette !== undefined) {
    if (
      typeof value.include_silhouette !== "boolean"
    ) {
      return {
        ok: false,
        message: "include_silhouette must be true or false.",
      };
    }

    body.include_silhouette =
      value.include_silhouette;
  }

  const silhouetteEnabled =
    body.include_silhouette !== false;

  const sampleSize =
    (body.silhouette_sample_size as number | undefined) ??
    1500;

  if (
    silhouetteEnabled &&
    sampleSize < value.n_clusters
  ) {
    return {
      ok: false,
      message:
        "Silhouette sample size must be at least the cluster count.",
    };
  }

  return { ok: true, body };
}

function backendMessage(
  data: unknown,
  fallback: string
): string {
  if (!isRecord(data)) return fallback;

  if (typeof data.detail === "string") {
    return data.detail.slice(0, 300);
  }

  if (
    isRecord(data.detail) &&
    Array.isArray(data.detail.unknown_features) &&
    data.detail.unknown_features.every(
      (name) => typeof name === "string"
    )
  ) {
    const names = (
      data.detail.unknown_features as string[]
    ).slice(0, 5);

    return `Unknown dataset columns: ${names
      .join(", ")
      .slice(0, 200)}.`;
  }

  return fallback;
}

function readPreflight(
  value: unknown,
  requestBody: Record<string, unknown>
) {
  if (
    !isRecord(value) ||
    typeof value.dataset_id !== "string" ||
    !UUID.test(value.dataset_id) ||
    value.dataset_id.toLowerCase() !==
      (
        requestBody.dataset_id as string
      ).toLowerCase() ||
    value.n_clusters !== requestBody.n_clusters ||
    typeof value.dataset_rows !== "number" ||
    !Number.isSafeInteger(value.dataset_rows) ||
    value.dataset_rows < 2 ||
    !Array.isArray(value.available_columns) ||
    value.available_columns.some(
      (name) => typeof name !== "string"
    ) ||
    (value.selected_features !== null &&
      (!Array.isArray(value.selected_features) ||
        value.selected_features.some(
          (name: unknown) =>
            typeof name !== "string"
        ))) ||
    !["automatic", "explicit"].includes(
      value.feature_selection as string
    ) ||
    value.validation_scope !== "metadata_only"
  ) {
    return null;
  }

  // Ensure the metadata returned by FastAPI is consistent.
  if (
    (value.selected_features === null) !==
    (value.feature_selection === "automatic")
  ) {
    return null;
  }

  return {
    dataset_id: value.dataset_id,
    n_clusters: value.n_clusters,
    dataset_rows: value.dataset_rows,
    available_columns:
      value.available_columns as string[],
    selected_features:
      value.selected_features as string[] | null,
    feature_selection:
      value.feature_selection as "automatic" | "explicit",
    validation_scope: "metadata_only" as const,
    message:
      "Dataset ownership and metadata checks passed. Numeric data will be validated during clustering execution.",
  };
}

export async function POST(
  request: NextRequest
) {
  // Reject cross-origin authenticated requests.
  const origin = request.headers.get("origin");
  const fetchSite =
    request.headers.get("sec-fetch-site");

  if (
    (origin !== null &&
      origin !== request.nextUrl.origin) ||
    (fetchSite !== null &&
      !["same-origin", "none"].includes(fetchSite))
  ) {
    return fail(403, "Request origin is not allowed.");
  }

  const token =
    request.cookies.get(COOKIE_NAME)?.value;

  if (
    !token ||
    token.length < 16 ||
    token.length > 8192 ||
    /\s/.test(token)
  ) {
    return fail(
      401,
      "Please sign in before validating an experiment."
    );
  }

  const contentType =
    request.headers.get("content-type") ?? "";

  if (
    !/^application\/json(?:\s*;|$)/i.test(
      contentType
    )
  ) {
    return fail(
      415,
      "Send the configuration as application/json."
    );
  }

  const declaredLength =
    request.headers.get("content-length");

  if (declaredLength !== null) {
    const size = Number(declaredLength);

    if (
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      return fail(
        400,
        "Invalid request size."
      );
    }

    if (size > MAX_BODY_BYTES) {
      return fail(
        413,
        "Experiment configuration is too large."
      );
    }
  }

  let raw: unknown;

  try {
    raw = await boundedJson(request);
  } catch (error) {
    return error instanceof BodyTooLarge
      ? fail(
          413,
          "Experiment configuration is too large."
        )
      : fail(
          400,
          "Invalid JSON request body."
        );
  }

  const checked = validate(raw);

  if (!checked.ok) {
    return fail(422, checked.message);
  }

  const url = backendUrl();

  if (!url) {
    return fail(
      503,
      "Experiment validation service is not configured."
    );
  }

  let upstream: Response;

  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(checked.body),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return fail(
      503,
      "Couldn't reach the preflight service. Please try again."
    );
  }

  let upstreamBody: unknown = null;

  try {
    upstreamBody = await upstream.json();
  } catch {
    // Invalid responses are handled below.
  }

  if (
    upstream.status === 401 ||
    upstream.status === 403
  ) {
    return fail(
      401,
      "Your session has expired. Please sign in again."
    );
  }

  if (upstream.status === 404) {
    return fail(
      404,
      "Dataset not found in your account."
    );
  }

  if (
    upstream.status === 409 ||
    upstream.status === 422
  ) {
    return fail(
      upstream.status,
      backendMessage(
        upstreamBody,
        "Dataset metadata or clustering settings are invalid."
      )
    );
  }

  if (upstream.status === 429) {
    return fail(
      429,
      "Too many requests. Please try later."
    );
  }

  if (upstream.status === 503) {
    return fail(
      503,
      "Experiment validation service is temporarily unavailable."
    );
  }

  if (upstream.status !== 200) {
    return fail(
      502,
      "Experiment validation service returned an unexpected response."
    );
  }

  const data = readPreflight(
    upstreamBody,
    checked.body
  );

  if (!data) {
    return fail(
      502,
      "Experiment validation service returned invalid metadata."
    );
  }

  return NextResponse.json(
    { success: true, ...data },
    {
      status: 200,
      headers: PRIVATE_HEADERS,
    }
  );
}
