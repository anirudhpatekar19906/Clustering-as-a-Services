/**
 * File 72 — Authenticated saved clustering-results API.
 *
 * GET /api/experiments/results/{experimentId}
 * GET /api/experiments/results/{experimentId}?include_labels=1
 *
 * Proxies the existing owner-checked FastAPI endpoint:
 * GET /api/v1/experiments/history/{experiment_id}?include_labels=...
 *
 * Read-only. No JWT, raw CSV rows, or internal errors are returned.
 * Label arrays are excluded by default; request them explicitly when needed.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEV_API = "http://127.0.0.1:8000";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

type RouteContext = {
  params: Promise<{ experimentId: string }>;
};

type JsonObject = Record<string, unknown>;

function isRecord(
  value: unknown
): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function finiteNumber(
  value: unknown,
  min = -Infinity,
  max = Infinity
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function timestamp(
  value: unknown,
  nullable = false
): value is string | null {
  return (
    (nullable && value === null) ||
    (
      typeof value === "string" &&
      Number.isFinite(Date.parse(value))
    )
  );
}

function reply(
  status: number,
  body: JsonObject
) {
  return NextResponse.json(body, {
    status,
    headers: PRIVATE_HEADERS,
  });
}

function fail(
  status: number,
  message: string
) {
  return reply(status, {
    success: false,
    message,
  });
}

function apiUrl(
  experimentId: string,
  includeLabels: boolean
): string | null {
  const baseUrl =
    process.env.CAAS_API_BASE_URL ||
    (
      process.env.NODE_ENV === "development"
        ? DEV_API
        : ""
    );

  if (!baseUrl) return null;

  try {
    const base = new URL(baseUrl);

    if (
      base.protocol !== "http:" &&
      base.protocol !== "https:"
    ) {
      return null;
    }

    const url = new URL(
      `/api/v1/experiments/history/${experimentId}`,
      base
    );

    url.searchParams.set(
      "include_labels",
      includeLabels ? "true" : "false"
    );

    return url.toString();
  } catch {
    return null;
  }
}

async function boundedJson(
  response: Response
): Promise<unknown> {
  const declaredLength =
    response.headers.get("content-length");

  if (
    declaredLength !== null &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      "Result response is too large"
    );
  }

  if (!response.body) {
    throw new Error(
      "Missing result response"
    );
  }

  const reader = response.body.getReader();

  const decoder = new TextDecoder("utf-8", {
    fatal: true,
  });

  const chunks: string[] = [];
  let received = 0;

  try {
    while (true) {
      const { done, value } =
        await reader.read();

      if (done) break;

      received += value.byteLength;

      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();

        throw new Error(
          "Result response is too large"
        );
      }

      chunks.push(
        decoder.decode(value, {
          stream: true,
        })
      );
    }

    chunks.push(decoder.decode());

    return JSON.parse(chunks.join(""));
  } finally {
    reader.releaseLock();
  }
}

function numberVector(
  value: unknown,
  length: number
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(
      (n: unknown) => finiteNumber(n)
    )
  );
}

function centroidMatrix(
  value: unknown,
  rows: number,
  columns: number
): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length === rows &&
    value.every(
      (row: unknown) =>
        numberVector(row, columns)
    )
  );
}

function clusterSizes(
  value: unknown,
  k: number,
  n: number
): Record<string, number> | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== k
  ) {
    return null;
  }

  const sizes: Record<string, number> = {};
  let count = 0;

  for (let i = 0; i < k; i++) {
    const size = value[String(i)];

    if (!integer(size, 1)) {
      return null;
    }

    sizes[String(i)] = size;
    count += size;
  }

  return count === n ? sizes : null;
}

/**
 * Keep only validated, chart-useful values
 * from the stored machine-learning result.
 */
function normalizeResult(
  raw: unknown,
  includeLabels: boolean
): JsonObject | null {
  if (
    !isRecord(raw) ||
    !isRecord(raw.metrics) ||
    !isRecord(raw.preprocessing_config) ||
    !isRecord(raw.algorithm_config)
  ) {
    return null;
  }

  const n = raw.n_samples;
  const k = raw.n_clusters;

  const metrics = raw.metrics;
  const preprocessing = raw.preprocessing_config;
  const algorithm = raw.algorithm_config;

  if (
    !integer(n, 2, 100_000) ||
    !integer(k, 2, 50) ||
    k > n ||
    raw.algorithm !== "custom_kmeans" ||
    typeof raw.model_version !== "string" ||
    !raw.model_version ||
    raw.model_version.length > 64 ||
    !Array.isArray(raw.features) ||
    raw.features.length < 1 ||
    raw.features.length > 100 ||
    !raw.features.every(
      (name: unknown) =>
        typeof name === "string" &&
        !!name.trim()
    ) ||
    new Set(raw.features).size !== raw.features.length ||
    !integer(raw.iterations, 1) ||
    typeof raw.converged !== "boolean" ||
    !finiteNumber(raw.processing_time_ms, 0)
  ) {
    return null;
  }

  const features = raw.features as string[];
  const dimension = features.length;

  if (
    !centroidMatrix(
      raw.centroids,
      k,
      dimension
    ) ||
    !centroidMatrix(
      raw.scaled_centroids,
      k,
      dimension
    )
  ) {
    return null;
  }

  const sizes = clusterSizes(
    metrics.cluster_sizes,
    k,
    n
  );

  if (
    sizes === null ||
    !finiteNumber(metrics.sse, 0) ||
    metrics.n_samples !== n ||
    metrics.n_clusters !== k ||
    !integer(
      metrics.silhouette_sample_size,
      0
    ) ||
    typeof metrics.silhouette_is_approximate !== "boolean" ||
    !(
      metrics.silhouette_score === null ||
      finiteNumber(
        metrics.silhouette_score,
        -1,
        1
      )
    )
  ) {
    return null;
  }

  if (
    !Array.isArray(preprocessing.features) ||
    preprocessing.features.length !== dimension ||
    preprocessing.features.some(
      (name: unknown, i: number) =>
        name !== features[i]
    ) ||
    ![
      "none",
      "standardize",
      "minmax",
    ].includes(
      preprocessing.method as string
    ) ||
    ![
      "error",
      "median",
      "mean",
      "zero",
    ].includes(
      preprocessing.missing_values as string
    ) ||
    !numberVector(
      preprocessing.imputation_values,
      dimension
    ) ||
    !numberVector(
      preprocessing.offsets,
      dimension
    ) ||
    !numberVector(
      preprocessing.scales,
      dimension
    ) ||
    !integer(
      preprocessing.n_samples_fit,
      2
    )
  ) {
    return null;
  }

  if (
    algorithm.n_clusters !== k ||
    ![
      "kmeans++",
      "random",
    ].includes(
      algorithm.init as string
    ) ||
    !integer(
      algorithm.max_iter,
      1,
      1000
    ) ||
    !finiteNumber(
      algorithm.tolerance,
      0
    ) ||
    !integer(
      algorithm.n_init,
      1,
      20
    ) ||
    !integer(
      algorithm.random_state,
      0,
      4_294_967_295
    ) ||
    typeof algorithm.include_silhouette !== "boolean" ||
    !integer(
      algorithm.silhouette_sample_size,
      2,
      1500
    )
  ) {
    return null;
  }

  let labels: number[] | null = null;

  if (
    includeLabels &&
    raw.labels !== null &&
    raw.labels !== undefined
  ) {
    if (
      !Array.isArray(raw.labels) ||
      raw.labels.length !== n ||
      !raw.labels.every(
        (label: unknown) =>
          integer(label, 0, k - 1)
      )
    ) {
      return null;
    }

    labels = raw.labels as number[];

    const observed =
      new Array<number>(k).fill(0);

    for (const label of labels) {
      observed[label]++;
    }

    if (
      observed.some(
        (count, i) =>
          count !== sizes[String(i)]
      )
    ) {
      return null;
    }
  }

  return {
    algorithm: raw.algorithm,
    model_version: raw.model_version,
    n_samples: n,
    n_clusters: k,
    features,
    centroids: raw.centroids,
    scaled_centroids: raw.scaled_centroids,
    iterations: raw.iterations,
    converged: raw.converged,
    processing_time_ms: raw.processing_time_ms,

    metrics: {
      sse: metrics.sse,
      cluster_sizes: sizes,
      silhouette_score:
        metrics.silhouette_score,
      n_samples: n,
      n_clusters: k,
      silhouette_sample_size:
        metrics.silhouette_sample_size,
      silhouette_is_approximate:
        metrics.silhouette_is_approximate,
    },

    preprocessing_config: {
      features,
      method: preprocessing.method,
      missing_values:
        preprocessing.missing_values,
      imputation_values:
        preprocessing.imputation_values,
      offsets: preprocessing.offsets,
      scales: preprocessing.scales,
      n_samples_fit:
        preprocessing.n_samples_fit,
    },

    algorithm_config: {
      n_clusters: k,
      init: algorithm.init,
      max_iter: algorithm.max_iter,
      tolerance: algorithm.tolerance,
      n_init: algorithm.n_init,
      random_state:
        algorithm.random_state,
      include_silhouette:
        algorithm.include_silhouette,
      silhouette_sample_size:
        algorithm.silhouette_sample_size,
    },

    ...(
      includeLabels
        ? { labels }
        : {}
    ),
  };
}

function normalizeDetail(
  value: unknown,
  expectedId: string,
  includeLabels: boolean
) {
  if (
    !isRecord(value) ||
    typeof value.experiment_id !== "string" ||
    !UUID.test(value.experiment_id) ||
    value.experiment_id.toLowerCase() !==
      expectedId.toLowerCase() ||
    typeof value.dataset_id !== "string" ||
    !UUID.test(value.dataset_id) ||
    value.algorithm !== "custom_kmeans" ||
    !integer(
      value.n_clusters,
      2,
      50
    ) ||
    !(
      value.name === null ||
      typeof value.name === "string"
    ) ||
    !(
      value.model_version === null ||
      typeof value.model_version === "string"
    ) ||
    !timestamp(value.created_at) ||
    !timestamp(value.updated_at, true) ||
    typeof value.result_available !== "boolean"
  ) {
    return null;
  }

  const hasResult =
    value.result !== null &&
    value.result !== undefined;

  if (
    value.result_available !== hasResult
  ) {
    return null;
  }

  const result = hasResult
    ? normalizeResult(
        value.result,
        includeLabels
      )
    : null;

  if (
    hasResult &&
    (
      !result ||
      result.n_clusters !==
        value.n_clusters
    )
  ) {
    return null;
  }

  return {
    experiment: {
      experiment_id: value.experiment_id,
      dataset_id: value.dataset_id,
      name: value.name,
      algorithm: value.algorithm,
      model_version: value.model_version,
      n_clusters: value.n_clusters,
      created_at: value.created_at,
      updated_at: value.updated_at,
    },

    result_available:
      value.result_available,

    result,

    labels_included:
      Array.isArray(result?.labels),
  };
}

export async function GET(
  request: NextRequest,
  { params }: RouteContext
) {
  const { experimentId } =
    await params;

  if (!UUID.test(experimentId)) {
    return fail(
      404,
      "Experiment not found."
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
      "Please sign in to view saved experiment results."
    );
  }

  const query =
    request.nextUrl.searchParams;

  const entries =
    Array.from(query.keys());

  if (
    entries.some(
      (key) =>
        key !== "include_labels"
    ) ||
    query.getAll(
      "include_labels"
    ).length > 1
  ) {
    return fail(
      400,
      "Unsupported results query parameters."
    );
  }

  const labelOption =
    query.get("include_labels");

  if (
    labelOption !== null &&
    ![
      "0",
      "1",
      "false",
      "true",
    ].includes(labelOption)
  ) {
    return fail(
      400,
      "include_labels must be 0 or 1."
    );
  }

  const includeLabels =
    labelOption === "1" ||
    labelOption === "true";

  const url = apiUrl(
    experimentId,
    includeLabels
  );

  if (!url) {
    return fail(
      503,
      "Saved results service is not configured."
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

      signal:
        AbortSignal.timeout(15_000),
    });
  } catch {
    return fail(
      503,
      "Saved results service is unavailable. Please retry."
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
      "Experiment not found."
    );
  }

  if (upstream.status === 429) {
    return fail(
      429,
      "Too many requests. Please check again shortly."
    );
  }

  if (upstream.status === 503) {
    return fail(
      503,
      "Saved results service is temporarily unavailable."
    );
  }

  if (upstream.status !== 200) {
    return fail(
      502,
      "Saved results service returned an unexpected response."
    );
  }

  let raw: unknown;

  try {
    raw = await boundedJson(
      upstream
    );
  } catch {
    return fail(
      502,
      "Saved results service returned unreadable or oversized data."
    );
  }

  const detail =
    normalizeDetail(
      raw,
      experimentId,
      includeLabels
    );

  if (!detail) {
    return fail(
      502,
      "Saved results service returned invalid experiment data."
    );
  }

  return reply(200, {
    success: true,
    ...detail,
  });
}
