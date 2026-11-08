/**
 * File 64 — Secure CaaS experiment-submission bridge.
 *
 * POST /api/experiments (browser -> Next.js -> FastAPI)
 * Forwards a validated JSON experiment configuration to the existing
 * POST /api/v1/experiments endpoint. The HttpOnly JWT never enters browser JS.
 *
 * Important: submitting creates an Experiment AND a queued job. A timeout
 * may be ambiguous; never automatically retry a submission.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEVELOPMENT_API = "http://127.0.0.1:8000";
const MAX_JSON_BYTES = 64 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

const ALLOWED_KEYS = new Set([
  "dataset_id",
  "n_clusters",
  "features",
  "scaling",
  "missing_values",
  "init",
  "max_iter",
  "tolerance",
  "n_init",
  "random_state",
  "include_silhouette",
  "silhouette_sample_size",
]);

const ENUM_OPTIONS: Record<string, readonly string[]> = {
  scaling: ["none", "standardize", "minmax"],
  missing_values: ["error", "median", "mean", "zero"],
  init: ["kmeans++", "random"],
};

const NUMBER_OPTIONS: Record<
  string,
  { min: number; max: number; integer: boolean }
> = {
  max_iter: { min: 1, max: 1000, integer: true },
  tolerance: { min: 0, max: Number.MAX_VALUE, integer: false },
  n_init: { min: 1, max: 20, integer: true },
  random_state: { min: 0, max: 4_294_967_295, integer: true },
  silhouette_sample_size: { min: 2, max: 1500, integer: true },
};

type ValidationResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string };

class BodyTooLargeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function respond(status: number, message: string, extra = {}) {
  return NextResponse.json(
    { success: false, message, ...extra },
    { status, headers: RESPONSE_HEADERS },
  );
}

function experimentApiUrl(): string | null {
  const configured =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development" ? DEVELOPMENT_API : "");

  if (!configured) return null;

  try {
    const base = new URL(configured);
    if (base.protocol !== "http:" && base.protocol !== "https:") return null;
    return new URL("/api/v1/experiments", base).toString();
  } catch {
    return null;
  }
}

async function readBoundedJson(request: NextRequest): Promise<unknown> {
  if (!request.body) throw new SyntaxError("Empty JSON body");

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let size = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(""));
  } finally {
    reader.releaseLock();
  }
}

/** Matches backend/schemas/experiments.py:ExperimentCreateRequest. */
function validateExperiment(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return { ok: false, message: "Send one JSON experiment configuration." };
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        message: `Unsupported configuration field: ${key.slice(0, 80)}.`,
      };
    }
  }

  if (typeof value.dataset_id !== "string" || !UUID_PATTERN.test(value.dataset_id)) {
    return { ok: false, message: "Choose a valid dataset ID." };
  }
  if (
    typeof value.n_clusters !== "number" ||
    !Number.isInteger(value.n_clusters) ||
    value.n_clusters < 2 ||
    value.n_clusters > 50
  ) {
    return {
      ok: false,
      message: "Number of clusters must be an integer from 2 to 50.",
    };
  }

  const payload: Record<string, unknown> = {
    dataset_id: value.dataset_id,
    n_clusters: value.n_clusters,
  };

  if (value.features !== undefined && value.features !== null) {
    if (
      !Array.isArray(value.features) ||
      value.features.length < 1 ||
      value.features.length > 100 ||
      value.features.some(
        (feature) => typeof feature !== "string" || !feature.trim(),
      )
    ) {
      return {
        ok: false,
        message: "Features must contain 1–100 nonempty column names.",
      };
    }
    const features = (value.features as string[]).map((feature) =>
      feature.trim(),
    );
    if (
      new Set(features.map((feature) => feature.toLocaleLowerCase())).size !==
      features.length
    ) {
      return { ok: false, message: "Feature names must be unique." };
    }
    payload.features = features;
  } else if (value.features === null) {
    payload.features = null; // Let FastAPI choose numeric features automatically.
  }

  for (const [key, choices] of Object.entries(ENUM_OPTIONS)) {
    const option = value[key];
    if (option === undefined) continue;
    if (typeof option !== "string" || !choices.includes(option)) {
      return { ok: false, message: `Invalid ${key} option.` };
    }
    payload[key] = option;
  }

  for (const [key, bounds] of Object.entries(NUMBER_OPTIONS)) {
    const option = value[key];
    if (option === undefined) continue;
    if (
      typeof option !== "number" ||
      !Number.isFinite(option) ||
      (bounds.integer && !Number.isInteger(option)) ||
      option < bounds.min ||
      option > bounds.max
    ) {
      return { ok: false, message: `Invalid ${key} value.` };
    }
    payload[key] = option;
  }

  if (value.include_silhouette !== undefined) {
    if (typeof value.include_silhouette !== "boolean") {
      return {
        ok: false,
        message: "include_silhouette must be true or false.",
      };
    }
    payload.include_silhouette = value.include_silhouette;
  }

  const silhouetteEnabled = payload.include_silhouette !== false;
  const sampleSize =
    (payload.silhouette_sample_size as number | undefined) ?? 1500;

  if (silhouetteEnabled && sampleSize < value.n_clusters) {
    return {
      ok: false,
      message: "Silhouette sample size must be at least the number of clusters.",
    };
  }

  return { ok: true, payload };
}

function friendlyBackendDetail(body: unknown, fallback: string): string {
  if (!isRecord(body)) return fallback;

  if (typeof body.detail === "string") {
    return body.detail.slice(0, 300);
  }

  if (
    isRecord(body.detail) &&
    Array.isArray(body.detail.unknown_features) &&
    body.detail.unknown_features.every((v) => typeof v === "string")
  ) {
    const features = (body.detail.unknown_features as string[]).slice(0, 5);
    return `Unknown dataset columns: ${features.join(", ").slice(0, 200)}.`;
  }

  return fallback;
}

export async function POST(request: NextRequest) {
  // This POST creates persistent records: do not allow cross-origin cookie use.
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (
    (origin !== null && origin !== request.nextUrl.origin) ||
    (fetchSite !== null && !["same-origin", "none"].includes(fetchSite))
  ) {
    return respond(403, "Request origin is not allowed.");
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;

  if (!token || token.length < 16 || token.length > 8192 || /\s/.test(token)) {
    return respond(401, "Please sign in before creating an experiment.");
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return respond(415, "Send the experiment configuration as application/json.");
  }

  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      return respond(400, "Invalid request size.");
    }
    if (length > MAX_JSON_BYTES) {
      return respond(413, "Experiment configuration is too large.");
    }
  }

  let raw: unknown;
  try {
    raw = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return respond(413, "Experiment configuration is too large.");
    }
    return respond(400, "Invalid JSON request body.");
  }

  const checked = validateExperiment(raw);
  if (!checked.ok) return respond(422, checked.message);

  const url = experimentApiUrl();
  if (!url) return respond(503, "Experiment API is not configured.");

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(checked.payload),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // A timeout/network break might occur AFTER FastAPI has queued the job.
    return respond(
      504,
      "Submission could not be confirmed. Check experiment history before trying again.",
      { submission_unconfirmed: true },
    );
  }

  let responseBody: unknown = null;
  try {
    responseBody = await upstream.json();
  } catch {
    // The status is still useful even if FastAPI did not return JSON.
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return respond(401, "Your session has expired. Please sign in again.");
  }
  if (upstream.status === 404) {
    return respond(404, "Dataset not found in your account.");
  }
  if (upstream.status === 409 || upstream.status === 422) {
    return respond(
      upstream.status,
      friendlyBackendDetail(
        responseBody,
        "Dataset metadata or clustering settings are invalid.",
      ),
    );
  }
  if (upstream.status === 429) {
    return respond(429, "Too many experiment requests. Please try later.");
  }
  if (upstream.status === 503) {
    const detail = isRecord(responseBody) ? responseBody.detail : null;
    const receipt = isRecord(detail) ? detail : null;
    return respond(
      503,
      "Experiment submission could not be confirmed. Check experiment history before retrying.",
      {
        submission_unconfirmed: true,
        ...(receipt &&
        typeof receipt.experiment_id === "string" &&
        UUID_PATTERN.test(receipt.experiment_id)
          ? { experiment_id: receipt.experiment_id }
          : {}),
        ...(receipt &&
        typeof receipt.job_id === "string" &&
        UUID_PATTERN.test(receipt.job_id)
          ? { job_id: receipt.job_id }
          : {}),
      },
    );
  }

  if (upstream.status !== 202) {
    return respond(502, "Experiment service could not accept the request.");
  }

  if (!isRecord(responseBody)) {
    return respond(
      502,
      "Experiment was submitted, but its receipt was unreadable. Check history before retrying.",
      { submission_unconfirmed: true },
    );
  }

  const { experiment_id, job_id, dataset_id, status } = responseBody;

  if (
    typeof experiment_id !== "string" ||
    !UUID_PATTERN.test(experiment_id) ||
    typeof job_id !== "string" ||
    !UUID_PATTERN.test(job_id) ||
    typeof dataset_id !== "string" ||
    !UUID_PATTERN.test(dataset_id) ||
    dataset_id.toLowerCase() !==
      (checked.payload.dataset_id as string).toLowerCase() ||
    status !== "submitted"
  ) {
    return respond(
      502,
      "Experiment was submitted, but its receipt was invalid. Check history before retrying.",
      { submission_unconfirmed: true },
    );
  }

  return NextResponse.json(
    {
      success: true,
      experiment_id,
      job_id,
      dataset_id,
      status: "submitted",
      message: "Experiment submitted to the clustering queue.",
    },
    { status: 202, headers: RESPONSE_HEADERS },
  );
}
