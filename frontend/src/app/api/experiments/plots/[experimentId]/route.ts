/**
 * File 81 — Private, read-only scatter-data bridge.
 *
 * Browser: GET /api/experiments/plots/{experimentId}
 *          ?x_feature=age&y_feature=income&max_points=1000
 * FastAPI: GET /api/v1/experiments/history/{experiment_id}/plot-data
 *
 * Only the server reads the HttpOnly JWT cookie. FastAPI verifies experiment
 * and dataset ownership, checks CSV integrity, and aligns saved cluster
 * labels with real CSV rows. This route validates the returned plot contract
 * before exposing the bounded points to the signed-in browser.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEVELOPMENT_API = "http://127.0.0.1:8000";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_POINTS = 1000;
const MAX_POINTS = 1500;
const MAX_ROWS = 100_000;
const MAX_CLUSTERS = 50;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

type RouteContext = {
  params: Promise<{ experimentId: string }>;
};

type PlotPoint = {
  row_index: number;
  x: number;
  y: number;
  cluster: number;
};

type PlotData = {
  experiment_id: string;
  dataset_id: string;
  x_feature: string;
  y_feature: string;
  coordinate_space: "original_csv";
  selection: "evenly_spaced_valid_rows";
  total_rows: number;
  eligible_rows: number;
  omitted_invalid_rows: number;
  returned_points: number;
  sampled: boolean;
  n_clusters: number;
  points: PlotPoint[];
};

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function fail(status: number, message: string) {
  return reply(status, { success: false, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function nonemptyFeature(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function parseQuery(searchParams: URLSearchParams):
  | { ok: true; x: string | null; y: string | null; maxPoints: number }
  | { ok: false; message: string } {
  const supported = new Set(["x_feature", "y_feature", "max_points"]);

  for (const key of searchParams.keys()) {
    if (!supported.has(key) || searchParams.getAll(key).length !== 1) {
      return { ok: false, message: "Invalid scatter plot query parameters." };
    }
  }

  const x = searchParams.get("x_feature");
  const y = searchParams.get("y_feature");

  // Either use FastAPI's first two saved features or explicitly choose both.
  if ((x === null) !== (y === null)) {
    return { ok: false, message: "Specify both x_feature and y_feature." };
  }

  if (
    (x !== null && !nonemptyFeature(x)) ||
    (y !== null && !nonemptyFeature(y)) ||
    (x !== null && x === y)
  ) {
    return { ok: false, message: "Choose two distinct valid feature names." };
  }

  const rawMax = searchParams.get("max_points");
  let maxPoints = DEFAULT_MAX_POINTS;

  if (rawMax !== null) {
    if (!/^[1-9]\d{0,3}$/.test(rawMax)) {
      return { ok: false, message: "max_points must be an integer from 2 to 1500." };
    }
    maxPoints = Number(rawMax);
    if (!integer(maxPoints, 2, MAX_POINTS)) {
      return { ok: false, message: "max_points must be an integer from 2 to 1500." };
    }
  }

  return { ok: true, x, y, maxPoints };
}

function backendUrl(
  experimentId: string,
  query: { x: string | null; y: string | null; maxPoints: number }
): string | null {
  const configured =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development" ? DEVELOPMENT_API : "");

  if (!configured) return null;

  try {
    const base = new URL(configured);
    if (base.protocol !== "http:" && base.protocol !== "https:") return null;

    const url = new URL(
      `/api/v1/experiments/history/${experimentId}/plot-data`,
      base
    );

    if (query.x !== null && query.y !== null) {
      url.searchParams.set("x_feature", query.x);
      url.searchParams.set("y_feature", query.y);
    }
    url.searchParams.set("max_points", String(query.maxPoints));
    return url.toString();
  } catch {
    return null;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new Error("Scatter response exceeds limit");
  }
  if (!response.body) throw new Error("Missing scatter response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Scatter response exceeds limit");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } finally {
    reader.releaseLock();
  }
}

/** Validate the row-index alignment contract, including sampling metadata. */
function normalizePlot(
  raw: unknown,
  requestedId: string,
  query: { x: string | null; y: string | null; maxPoints: number }
): PlotData | null {
  if (!isRecord(raw)) return null;

  const total = raw.total_rows;
  const eligible = raw.eligible_rows;
  const omitted = raw.omitted_invalid_rows;
  const returned = raw.returned_points;
  const clusters = raw.n_clusters;

  if (
    typeof raw.experiment_id !== "string" ||
    !UUID.test(raw.experiment_id) ||
    raw.experiment_id.toLowerCase() !== requestedId.toLowerCase() ||
    typeof raw.dataset_id !== "string" ||
    !UUID.test(raw.dataset_id) ||
    !nonemptyFeature(raw.x_feature) ||
    !nonemptyFeature(raw.y_feature) ||
    raw.x_feature === raw.y_feature ||
    (query.x !== null && raw.x_feature !== query.x) ||
    (query.y !== null && raw.y_feature !== query.y) ||
    raw.coordinate_space !== "original_csv" ||
    raw.selection !== "evenly_spaced_valid_rows" ||
    !integer(total, 2, MAX_ROWS) ||
    !integer(eligible, 0, total) ||
    !integer(omitted, 0, total) ||
    omitted !== total - eligible ||
    !integer(clusters, 2, Math.min(total, MAX_CLUSTERS)) ||
    !integer(returned, 0, Math.min(eligible, query.maxPoints)) ||
    returned !== Math.min(eligible, query.maxPoints) ||
    typeof raw.sampled !== "boolean" ||
    raw.sampled !== (eligible > returned) ||
    !Array.isArray(raw.points) ||
    raw.points.length !== returned
  ) {
    return null;
  }

  const points: PlotPoint[] = [];
  let previousRow = -1;

  for (const value of raw.points) {
    if (
      !isRecord(value) ||
      !integer(value.row_index, 0, total - 1) ||
      value.row_index <= previousRow ||
      typeof value.x !== "number" ||
      !Number.isFinite(value.x) ||
      typeof value.y !== "number" ||
      !Number.isFinite(value.y) ||
      !integer(value.cluster, 0, clusters - 1)
    ) {
      return null;
    }

    previousRow = value.row_index;
    points.push({
      row_index: value.row_index,
      x: value.x,
      y: value.y,
      cluster: value.cluster,
    });
  }

  return {
    experiment_id: raw.experiment_id,
    dataset_id: raw.dataset_id,
    x_feature: raw.x_feature,
    y_feature: raw.y_feature,
    coordinate_space: "original_csv",
    selection: "evenly_spaced_valid_rows",
    total_rows: total,
    eligible_rows: eligible,
    omitted_invalid_rows: omitted,
    returned_points: returned,
    sampled: raw.sampled,
    n_clusters: clusters,
    points,
  };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { experimentId } = await params;
  if (!UUID.test(experimentId)) {
    return fail(404, "Experiment not found.");
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token || token.length < 16 || token.length > 8192 || /\s/.test(token)) {
    return fail(401, "Please sign in to view clustering scatter data.");
  }

  const query = parseQuery(request.nextUrl.searchParams);
  if (!query.ok) return fail(400, query.message);

  const url = backendUrl(experimentId, query);
  if (!url) return fail(503, "Scatter-data service is not configured.");

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
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return fail(503, "Scatter-data service is unavailable. Please retry.");
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return fail(401, "Your session has expired. Please sign in again.");
  }
  if (upstream.status === 404) return fail(404, "Experiment not found.");
  if (upstream.status === 409) {
    return fail(409, "Scatter data is not available for this saved experiment.");
  }
  if (upstream.status === 422) {
    return fail(422, "Choose two distinct numeric features used by this experiment.");
  }
  if (upstream.status === 429) {
    return fail(429, "Too many requests. Please try again shortly.");
  }
  if (upstream.status === 503) {
    return fail(503, "Scatter-data service is temporarily unavailable.");
  }
  if (upstream.status !== 200) {
    return fail(502, "Scatter-data service returned an unexpected response.");
  }

  let raw: unknown;
  try {
    raw = await readBoundedJson(upstream);
  } catch {
    return fail(502, "Scatter-data service returned unreadable or oversized data.");
  }

  const data = normalizePlot(raw, experimentId, query);
  if (!data) return fail(502, "Scatter-data service returned invalid plot data.");

  return reply(200, { success: true, ...data });
}
