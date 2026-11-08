/**
 * File 69 — Private CaaS clustering job-status API.
 *
 * GET /api/experiments/jobs/{jobId}
 *     -> FastAPI GET /api/v1/experiments/{job_id}?include_labels=false
 *
 * FastAPI checks ownership before returning a PostgreSQL-backed job status
 * (or a legacy Redis/RQ status). This route never exposes the HttpOnly JWT,
 * per-row cluster assignments, raw CSV values, or backend error traces.
 *
 * A completed status is the persisted worker state, not a live heartbeat.
 * The next file will use this endpoint to monitor running jobs.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEVELOPMENT_API = "http://127.0.0.1:8000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

type JobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

type JobSource = "postgresql" | "redis";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

type ResultSummary = {
  n_samples: number;
  n_clusters: number;
  iterations: number;
  converged: boolean;
  processing_time_ms: number;
  sse: number;
  silhouette_score: number | null;
};

const JOB_STATES: readonly string[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
];

function reply(
  status: number,
  body: Record<string, unknown>
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

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isFiniteNonnegative(
  value: unknown
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function isPositiveInteger(
  value: unknown
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1
  );
}

function safeDate(
  value: unknown
): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value))
  ) {
    return undefined;
  }

  return value;
}

function backendUrl(jobId: string): string | null {
  const configured =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development"
      ? DEVELOPMENT_API
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
      `/api/v1/experiments/${jobId}`,
      base
    );

    // Never fetch per-row labels during status polling.
    url.searchParams.set("include_labels", "false");

    return url.toString();
  } catch {
    return null;
  }
}

async function readBoundedJson(
  response: Response
): Promise<unknown> {
  const declared = response.headers.get(
    "content-length"
  );

  if (
    declared !== null &&
    Number(declared) > MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      "Upstream response exceeds allowed size"
    );
  }

  if (!response.body) {
    throw new Error("Missing upstream response body");
  }

  const reader = response.body.getReader();

  const decoder = new TextDecoder("utf-8", {
    fatal: true,
  });

  const parts: string[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      size += value.byteLength;

      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();

        throw new Error(
          "Upstream response exceeds allowed size"
        );
      }

      parts.push(
        decoder.decode(value, { stream: true })
      );
    }

    parts.push(decoder.decode());

    return JSON.parse(parts.join(""));
  } finally {
    reader.releaseLock();
  }
}

function resultSummary(
  value: unknown
): ResultSummary | null | undefined {
  if (value === null) return null;

  if (
    !isRecord(value) ||
    !isRecord(value.metrics)
  ) {
    return undefined;
  }

  const metrics = value.metrics;
  const silhouette = metrics.silhouette_score;

  if (
    value.algorithm !== "custom_kmeans" ||
    !isPositiveInteger(value.n_samples) ||
    !isPositiveInteger(value.n_clusters) ||
    value.n_clusters < 2 ||
    !isPositiveInteger(value.iterations) ||
    typeof value.converged !== "boolean" ||
    !isFiniteNonnegative(
      value.processing_time_ms
    ) ||
    !isFiniteNonnegative(metrics.sse) ||
    (
      silhouette !== null &&
      (
        typeof silhouette !== "number" ||
        !Number.isFinite(silhouette) ||
        silhouette < -1 ||
        silhouette > 1
      )
    )
  ) {
    return undefined;
  }

  return {
    n_samples: value.n_samples,
    n_clusters: value.n_clusters,
    iterations: value.iterations,
    converged: value.converged,
    processing_time_ms: value.processing_time_ms,
    sse: metrics.sse,
    silhouette_score: silhouette,
  };
}

function normalizeJob(
  raw: unknown,
  requestedId: string
) {
  if (!isRecord(raw)) return null;

  const status = raw.status;
  const source = raw.status_source;

  const dates = {
    recorded_at: safeDate(raw.recorded_at),
    enqueued_at: safeDate(raw.enqueued_at),
    started_at: safeDate(raw.started_at),
    ended_at: safeDate(raw.ended_at),
  };

  const summary = resultSummary(raw.result);
  const experimentId = raw.experiment_id;

  if (
    typeof raw.job_id !== "string" ||
    !UUID.test(raw.job_id) ||
    raw.job_id.toLowerCase() !==
      requestedId.toLowerCase() ||
    typeof raw.dataset_id !== "string" ||
    !UUID.test(raw.dataset_id) ||
    (
      experimentId !== null &&
      experimentId !== undefined &&
      (
        typeof experimentId !== "string" ||
        !UUID.test(experimentId)
      )
    ) ||
    typeof status !== "string" ||
    !JOB_STATES.includes(status) ||
    (
      source !== "postgresql" &&
      source !== "redis"
    ) ||
    typeof raw.message !== "string" ||
    Object.values(dates).some(
      (value) => value === undefined
    ) ||
    summary === undefined ||
    (
      status !== "completed" &&
      summary !== null
    )
  ) {
    return null;
  }

  return {
    job_id: raw.job_id,
    dataset_id: raw.dataset_id,
    experiment_id:
      (experimentId ?? null) as string | null,
    status: status as JobState,
    status_source: source as JobSource,
    message: raw.message.slice(0, 350),
    ...dates,
    result_available: summary !== null,
    result_summary: summary,
  };
}

export async function GET(
  request: NextRequest,
  { params }: RouteContext
) {
  const { jobId } = await params;

  if (!UUID.test(jobId)) {
    return fail(
      404,
      "Clustering job not found."
    );
  }

  const token = request.cookies.get(
    COOKIE_NAME
  )?.value;

  if (
    !token ||
    token.length < 16 ||
    token.length > 8192 ||
    /\s/.test(token)
  ) {
    return fail(
      401,
      "Please sign in to view your clustering jobs."
    );
  }

  const url = backendUrl(jobId);

  if (!url) {
    return fail(
      503,
      "Clustering status service is not configured."
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
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return fail(
      503,
      "Cannot reach the clustering status service. Try again."
    );
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
      "Clustering job not found."
    );
  }

  if (upstream.status === 429) {
    return fail(
      429,
      "Too many status requests. Please check again shortly."
    );
  }

  if (upstream.status === 503) {
    return fail(
      503,
      "Clustering status service is temporarily unavailable."
    );
  }

  if (upstream.status !== 200) {
    return fail(
      502,
      "Clustering status service returned an unexpected response."
    );
  }

  let upstreamBody: unknown;

  try {
    upstreamBody = await readBoundedJson(
      upstream
    );
  } catch {
    return fail(
      502,
      "Clustering status service returned unreadable data."
    );
  }

  const job = normalizeJob(
    upstreamBody,
    jobId
  );

  if (!job) {
    return fail(
      502,
      "Clustering status service returned invalid job metadata."
    );
  }

  return reply(200, {
    success: true,
    ...job,
  });
}
