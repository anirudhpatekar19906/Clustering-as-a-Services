"use client";

/**
 * File 82 — CaaS Saved Results Dashboard + Real Scatter Plot
 *
 * Saved results API:
 * GET /api/experiments/results/[experimentId]
 *
 * Real CSV coordinates API:
 * GET /api/experiments/plots/[experimentId]
 *
 * Both APIs enforce authentication and experiment ownership.
 * The JWT remains in the HttpOnly session cookie.
 *
 * The scatter plot uses real uploaded CSV coordinates
 * and saved K-Means cluster labels. No synthetic points.
 *
 * Compatible with Next.js 16 Cache Components.
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

import WorkspaceShell from "@/components/workspace-shell";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLORS = [
  "#305BE8",
  "#129A8E",
  "#F4A33B",
  "#8B5CF6",
  "#E16B8C",
  "#227FB7",
  "#58A675",
  "#C17CE3",
];

const MAX_POINTS = 1000;

type Experiment = {
  experiment_id: string;
  dataset_id: string;
  name: string | null;
  n_clusters: number;
  created_at: string;
  model_version: string | null;
};

type Result = {
  n_samples: number;
  n_clusters: number;
  model_version: string;
  features: string[];
  centroids: number[][];
  scaled_centroids: number[][];
  iterations: number;
  converged: boolean;
  processing_time_ms: number;

  metrics: {
    sse: number;
    silhouette_score: number | null;
    silhouette_sample_size: number;
    silhouette_is_approximate: boolean;
    cluster_sizes: Record<string, number>;
  };

  preprocessing_config: {
    method: string;
    missing_values: string;
    n_samples_fit: number;
  };

  algorithm_config: {
    init: string;
    max_iter: number;
    n_init: number;
    tolerance: number;
    random_state: number;
  };
};

type Detail = {
  experiment: Experiment;
  result_available: boolean;
  result: Result | null;
};

type PlotPoint = {
  row_index: number;
  x: number;
  y: number;
  cluster: number;
};

type Plot = {
  experiment_id: string;
  dataset_id: string;
  x_feature: string;
  y_feature: string;
  total_rows: number;
  eligible_rows: number;
  omitted_invalid_rows: number;
  returned_points: number;
  sampled: boolean;
  n_clusters: number;
  points: PlotPoint[];
};

type ResultScreen =
  | {
      kind: "loading";
    }
  | {
      kind: "error";
      message: string;
      email: string | null;
    }
  | {
      kind: "ready";
      detail: Detail;
      email: string;
    };

type PlotScreen =
  | {
      kind: "loading";
    }
  | {
      kind: "error";
      message: string;
    }
  | {
      kind: "ready";
      plot: Plot;
    };

/* ============================================================
   Shared validation helpers
   ============================================================ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function whole(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function format(value: number, digits = 4): string {
  if (value !== 0 && Math.abs(value) < 0.0001) {
    return value.toExponential(2);
  }

  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: digits,
  }).format(value);
}

function when(value: string | null): string {
  if (!value) {
    return "Not recorded";
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function apiError(value: unknown, fallback: string): string {
  if (
    isObject(value) &&
    typeof value.message === "string" &&
    value.message.trim()
  ) {
    return value.message.slice(0, 250);
  }

  return fallback;
}

/* ============================================================
   Parse and validate saved experiment results
   ============================================================ */

function readDetail(raw: unknown, requestedId: string): Detail | null {
  if (!isObject(raw) || raw.success !== true || !isObject(raw.experiment)) {
    return null;
  }

  const experimentRaw = raw.experiment;

  if (
    typeof experimentRaw.experiment_id !== "string" ||
    experimentRaw.experiment_id.toLowerCase() !== requestedId.toLowerCase() ||
    typeof experimentRaw.dataset_id !== "string" ||
    !UUID.test(experimentRaw.dataset_id) ||
    (experimentRaw.name !== null && typeof experimentRaw.name !== "string") ||
    (experimentRaw.model_version !== null &&
      typeof experimentRaw.model_version !== "string") ||
    !whole(experimentRaw.n_clusters, 2) ||
    !iso(experimentRaw.created_at) ||
    typeof raw.result_available !== "boolean"
  ) {
    return null;
  }

  const experiment: Experiment = {
    experiment_id: experimentRaw.experiment_id,
    dataset_id: experimentRaw.dataset_id,
    name: experimentRaw.name,
    n_clusters: experimentRaw.n_clusters,
    created_at: experimentRaw.created_at,
    model_version: experimentRaw.model_version,
  };

  if (raw.result_available === false && raw.result === null) {
    return {
      experiment,
      result_available: false,
      result: null,
    };
  }

  if (raw.result_available !== true || !isObject(raw.result)) {
    return null;
  }

  const resultRaw = raw.result;

  if (
    !isObject(resultRaw.metrics) ||
    !isObject(resultRaw.preprocessing_config) ||
    !isObject(resultRaw.algorithm_config)
  ) {
    return null;
  }

  const metricsRaw = resultRaw.metrics;
  const preprocessingRaw = resultRaw.preprocessing_config;
  const algorithmRaw = resultRaw.algorithm_config;

  const featureCount = Array.isArray(resultRaw.features)
    ? resultRaw.features.length
    : 0;

  if (
    !whole(resultRaw.n_samples, 2) ||
    !whole(resultRaw.n_clusters, 2) ||
    resultRaw.n_clusters !== experimentRaw.n_clusters ||
    resultRaw.n_clusters > resultRaw.n_samples ||
    typeof resultRaw.model_version !== "string" ||
    !resultRaw.model_version ||
    !Array.isArray(resultRaw.features) ||
    resultRaw.features.length < 1 ||
    resultRaw.features.length > 100 ||
    !resultRaw.features.every(
      (feature: unknown) =>
        typeof feature === "string" && feature.trim().length > 0,
    ) ||
    !Array.isArray(resultRaw.centroids) ||
    !Array.isArray(resultRaw.scaled_centroids) ||
    resultRaw.centroids.length !== resultRaw.n_clusters ||
    resultRaw.scaled_centroids.length !== resultRaw.n_clusters ||
    ![resultRaw.centroids, resultRaw.scaled_centroids].every((matrix) =>
      matrix.every(
        (row: unknown) =>
          Array.isArray(row) &&
          row.length === featureCount &&
          row.every(finite),
      ),
    ) ||
    !whole(resultRaw.iterations, 1) ||
    typeof resultRaw.converged !== "boolean" ||
    !finite(resultRaw.processing_time_ms) ||
    resultRaw.processing_time_ms < 0 ||
    !finite(metricsRaw.sse) ||
    metricsRaw.sse < 0 ||
    !(
      metricsRaw.silhouette_score === null ||
      (finite(metricsRaw.silhouette_score) &&
        Math.abs(metricsRaw.silhouette_score) <= 1)
    ) ||
    !whole(metricsRaw.silhouette_sample_size) ||
    typeof metricsRaw.silhouette_is_approximate !== "boolean" ||
    !isObject(metricsRaw.cluster_sizes) ||
    typeof preprocessingRaw.method !== "string" ||
    typeof preprocessingRaw.missing_values !== "string" ||
    !whole(preprocessingRaw.n_samples_fit, 2) ||
    typeof algorithmRaw.init !== "string" ||
    !whole(algorithmRaw.max_iter, 1) ||
    !whole(algorithmRaw.n_init, 1) ||
    !finite(algorithmRaw.tolerance) ||
    !whole(algorithmRaw.random_state)
  ) {
    return null;
  }

  const sizes: Record<string, number> = {};
  let totalAssigned = 0;

  for (let cluster = 0; cluster < resultRaw.n_clusters; cluster++) {
    const count = metricsRaw.cluster_sizes[String(cluster)];

    if (!whole(count, 1)) {
      return null;
    }

    sizes[String(cluster)] = count;
    totalAssigned += count;
  }

  if (totalAssigned !== resultRaw.n_samples) {
    return null;
  }

  const result: Result = {
    n_samples: resultRaw.n_samples,
    n_clusters: resultRaw.n_clusters,
    model_version: resultRaw.model_version,

    features: resultRaw.features as string[],

    centroids: resultRaw.centroids as number[][],

    scaled_centroids: resultRaw.scaled_centroids as number[][],

    iterations: resultRaw.iterations,
    converged: resultRaw.converged,
    processing_time_ms: resultRaw.processing_time_ms,

    metrics: {
      sse: metricsRaw.sse,
      silhouette_score: metricsRaw.silhouette_score,

      silhouette_sample_size: metricsRaw.silhouette_sample_size,

      silhouette_is_approximate: metricsRaw.silhouette_is_approximate,

      cluster_sizes: sizes,
    },

    preprocessing_config: {
      method: preprocessingRaw.method,
      missing_values: preprocessingRaw.missing_values,

      n_samples_fit: preprocessingRaw.n_samples_fit,
    },

    algorithm_config: {
      init: algorithmRaw.init,
      max_iter: algorithmRaw.max_iter,
      n_init: algorithmRaw.n_init,
      tolerance: algorithmRaw.tolerance,
      random_state: algorithmRaw.random_state,
    },
  };

  return {
    experiment,
    result_available: true,
    result,
  };
}

/* ============================================================
   Parse verified scatter-plot responses
   ============================================================ */

function readPlot(
  raw: unknown,
  experimentId: string,
  result: Result,
  datasetId: string,
  xFeature: string,
  yFeature: string,
): Plot | null {
  if (!isObject(raw) || raw.success !== true) {
    return null;
  }

  if (
    raw.experiment_id !== experimentId ||
    raw.dataset_id !== datasetId ||
    raw.x_feature !== xFeature ||
    raw.y_feature !== yFeature ||
    raw.coordinate_space !== "original_csv" ||
    raw.selection !== "evenly_spaced_valid_rows" ||
    raw.n_clusters !== result.n_clusters ||
    raw.total_rows !== result.n_samples ||
    !whole(raw.eligible_rows) ||
    raw.eligible_rows > result.n_samples ||
    !whole(raw.omitted_invalid_rows) ||
    raw.omitted_invalid_rows !== result.n_samples - raw.eligible_rows ||
    !whole(raw.returned_points) ||
    raw.returned_points !== Math.min(raw.eligible_rows, MAX_POINTS) ||
    typeof raw.sampled !== "boolean" ||
    raw.sampled !== raw.eligible_rows > raw.returned_points ||
    !Array.isArray(raw.points) ||
    raw.points.length !== raw.returned_points
  ) {
    return null;
  }

  const points: PlotPoint[] = [];
  let previousIndex = -1;

  for (const point of raw.points) {
    if (
      !isObject(point) ||
      !whole(point.row_index) ||
      point.row_index >= result.n_samples ||
      point.row_index <= previousIndex ||
      !finite(point.x) ||
      !finite(point.y) ||
      !whole(point.cluster) ||
      point.cluster >= result.n_clusters
    ) {
      return null;
    }

    previousIndex = point.row_index;

    points.push({
      row_index: point.row_index,
      x: point.x,
      y: point.y,
      cluster: point.cluster,
    });
  }

  return {
    experiment_id: experimentId,
    dataset_id: datasetId,
    x_feature: xFeature,
    y_feature: yFeature,
    total_rows: result.n_samples,
    eligible_rows: raw.eligible_rows,
    omitted_invalid_rows: raw.omitted_invalid_rows,
    returned_points: raw.returned_points,
    sampled: raw.sampled,
    n_clusters: result.n_clusters,
    points,
  };
}

/* ============================================================
   Reusable UI components
   ============================================================ */

function MetricCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="caas-card p-5 sm:p-6">
      <p className="text-[12px] text-[#6D7C92]">{label}</p>

      <p className="mt-3 text-[29px] font-semibold tracking-[-0.05em] text-[#172235]">
        {value}
      </p>

      <p className="mt-2 text-[11px] leading-5 text-[#8492A5]">{note}</p>
    </div>
  );
}

function DataRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-1 border-b border-[#E9EDF3] py-3 last:border-0 sm:grid-cols-[128px_minmax(0,1fr)]">
      <dt className="text-[12px] text-[#75849A]">{label}</dt>

      <dd
        className={`break-all text-[12px] font-medium text-[#293B55] ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function Skeleton() {
  return (
    <div
      role="status"
      aria-label="Loading clustering results"
      className="space-y-6"
    >
      <div className="h-3 w-36 animate-pulse rounded bg-[#DFE6F0]" />

      <div className="h-9 w-72 max-w-full animate-pulse rounded bg-[#E3E9F2]" />

      <div className="grid gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="h-32 animate-pulse rounded-xl border border-[#E3E8EF] bg-white"
          />
        ))}
      </div>

      <div className="h-72 animate-pulse rounded-xl border border-[#E3E8EF] bg-white" />
    </div>
  );
}

/* ============================================================
   File 82 — Interactive SVG scatter plot canvas
   ============================================================ */

function PlotCanvas({ plot }: { plot: Plot }) {
  const [active, setActive] = useState<number | null>(null);

  const WIDTH = 780;
  const HEIGHT = 420;

  const left = 94;
  const right = 25;
  const top = 24;
  const bottom = 79;

  const chartWidth = WIDTH - left - right;

  const chartHeight = HEIGHT - top - bottom;

  const geometry = useMemo(() => {
    const xValues = plot.points.map((point) => point.x);

    const yValues = plot.points.map((point) => point.y);

    const rawXMin = Math.min(...xValues);
    const rawXMax = Math.max(...xValues);

    const rawYMin = Math.min(...yValues);
    const rawYMax = Math.max(...yValues);

    function expand(minimum: number, maximum: number): [number, number] {
      const range = maximum - minimum;

      const padding =
        range > 0 ? range * 0.08 : Math.max(Math.abs(minimum) * 0.08, 1);

      return [minimum - padding, maximum + padding];
    }

    const [xMin, xMax] = expand(rawXMin, rawXMax);

    const [yMin, yMax] = expand(rawYMin, rawYMax);

    return {
      ticks: [0, 1, 2, 3, 4].map((index) => ({
        x: xMin + (index / 4) * (xMax - xMin),

        y: yMin + (index / 4) * (yMax - yMin),
      })),

      x: (value: number) =>
        left + ((value - xMin) / (xMax - xMin)) * chartWidth,

      y: (value: number) =>
        top + chartHeight - ((value - yMin) / (yMax - yMin)) * chartHeight,
    };
  }, [plot, chartWidth, chartHeight]);

  useEffect(() => {
    setActive(null);
  }, [plot]);

  const selected =
    plot.points.find((point) => point.row_index === active) ?? null;

  if (plot.points.length === 0) {
    return (
      <div className="rounded-lg bg-[#F6F8FB] px-5 py-12 text-center text-[13px] text-[#687A91]">
        No rows contain valid original coordinates for both selected features.
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-[#E9EDF4] bg-[#FEFEFF]">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="min-w-[560px] w-full"
          role="group"
          aria-label={`Scatter plot: ${plot.x_feature} versus ${plot.y_feature}; ${plot.returned_points} real rows`}
        >
          <rect
            x={left}
            y={top}
            width={chartWidth}
            height={chartHeight}
            fill="#FBFCFF"
          />

          {geometry.ticks.map((tick, index) => {
            const px = left + (index / 4) * chartWidth;

            const py = top + chartHeight - (index / 4) * chartHeight;

            return (
              <g key={index}>
                <line
                  x1={px}
                  y1={top}
                  x2={px}
                  y2={top + chartHeight}
                  stroke="#E7EDF5"
                  strokeDasharray="3 5"
                />

                <line
                  x1={left}
                  y1={py}
                  x2={left + chartWidth}
                  y2={py}
                  stroke="#E7EDF5"
                  strokeDasharray="3 5"
                />

                <text
                  x={px}
                  y={top + chartHeight + 23}
                  textAnchor="middle"
                  fill="#6C7C93"
                  fontSize="11"
                >
                  {format(tick.x, 2)}
                </text>

                <text
                  x={left - 12}
                  y={py + 4}
                  textAnchor="end"
                  fill="#6C7C93"
                  fontSize="11"
                >
                  {format(tick.y, 2)}
                </text>
              </g>
            );
          })}

          <line
            x1={left}
            y1={top + chartHeight}
            x2={left + chartWidth}
            y2={top + chartHeight}
            stroke="#B5C1D3"
          />

          <line
            x1={left}
            y1={top}
            x2={left}
            y2={top + chartHeight}
            stroke="#B5C1D3"
          />

          <text
            x={left + chartWidth / 2}
            y={HEIGHT - 15}
            textAnchor="middle"
            fontSize="13"
            fill="#30435E"
            fontWeight="600"
          >
            {plot.x_feature}
          </text>

          <text
            transform={`translate(21 ${top + chartHeight / 2}) rotate(-90)`}
            textAnchor="middle"
            fontSize="13"
            fill="#30435E"
            fontWeight="600"
          >
            {plot.y_feature}
          </text>

          {plot.points.map((point) => {
            const chosen = point.row_index === active;

            const label =
              `CSV row ${point.row_index + 1}, ` +
              `${plot.x_feature} ${format(point.x)}, ` +
              `${plot.y_feature} ${format(point.y)}, ` +
              `cluster ${point.cluster}`;

            return (
              <circle
                key={point.row_index}
                cx={geometry.x(point.x)}
                cy={geometry.y(point.y)}
                r={chosen ? 8 : plot.points.length > 350 ? 4 : 6}
                fill={COLORS[point.cluster % COLORS.length]}
                fillOpacity={chosen ? 1 : 0.82}
                stroke={chosen ? "#172235" : "#FFFFFF"}
                strokeWidth={chosen ? 2.3 : 1.1}
                role="button"
                tabIndex={0}
                aria-label={label}
                onMouseEnter={() => setActive(point.row_index)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(point.row_index)}
                onBlur={() => setActive(null)}
                onClick={() => setActive(chosen ? null : point.row_index)}
                onKeyDown={(event: KeyboardEvent<SVGCircleElement>) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();

                    setActive(point.row_index);
                  }
                }}
                className="cursor-pointer outline-none focus:stroke-[#172235]"
              >
                <title>{label}</title>
              </circle>
            );
          })}
        </svg>
      </div>

      <div
        aria-live="polite"
        className="mt-4 min-h-14 rounded-lg border border-[#E5EAF1] bg-[#F8FAFD] px-4 py-3 text-[12px] text-[#566A84]"
      >
        {selected ? (
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span className="font-semibold text-[#263B55]">
              CSV row {selected.row_index + 1}
            </span>

            <span>
              {plot.x_feature}: <b>{format(selected.x, 6)}</b>
            </span>

            <span>
              {plot.y_feature}: <b>{format(selected.y, 6)}</b>
            </span>

            <span>
              Cluster <b>{selected.cluster}</b>
            </span>
          </div>
        ) : (
          <p>
            Hover, focus, or tap a point to inspect its actual CSV row and
            cluster.
          </p>
        )}
      </div>
    </>
  );
}

/* ============================================================
   File 82 — Scatter plot data loading and feature controls
   ============================================================ */

function ScatterPlot({
  experimentId,
  datasetId,
  result,
}: {
  experimentId: string;
  datasetId: string;
  result: Result;
}) {
  const router = useRouter();

  const [xFeature, setXFeature] = useState(result.features[0] ?? "");

  const [yFeature, setYFeature] = useState(result.features[1] ?? "");

  const [version, setVersion] = useState(0);

  const [state, setState] = useState<PlotScreen>({
    kind: "loading",
  });

  /**
   * File 83 — Cache verified plot coordinates.
   *
   * Reversing X and Y does not require a new API request.
   * The same original CSV rows can be transposed locally.
   *
   * The cache belongs only to this experiment and dataset.
   */
  const plotCache = useMemo(
    () => new Map<string, Plot>(),
    [experimentId, datasetId],
  );

  useEffect(() => {
    if (!xFeature || !yFeature || xFeature === yFeature) {
      return;
    }

    const key = JSON.stringify([xFeature, yFeature]);

    // 1. Use the exact same feature pair if already loaded.
    const exact = plotCache.get(key);

    if (exact) {
      setState({
        kind: "ready",
        plot: exact,
      });

      return;
    }

    // 2. Check whether the reverse feature pair exists.
    const reverse = plotCache.get(JSON.stringify([yFeature, xFeature]));

    if (reverse) {
      /**
       * This is the main smoothness fix.
       *
       * We already have the verified row coordinates.
       * Swapping x and y locally preserves:
       *
       * - Original CSV row indices
       * - Exact numeric values
       * - Saved cluster assignments
       * - Sampling information
       *
       * No network request.
       * No loading placeholder.
       */
      const swapped: Plot = {
        ...reverse,

        x_feature: xFeature,
        y_feature: yFeature,

        points: reverse.points.map((point) => ({
          row_index: point.row_index,
          x: point.y,
          y: point.x,
          cluster: point.cluster,
        })),
      };

      plotCache.set(key, swapped);

      setState({
        kind: "ready",
        plot: swapped,
      });

      return;
    }

    /**
     * 3. A genuinely different feature pair
     * still requires the authenticated API.
     */
    const controller = new AbortController();

    async function load() {
      setState({
        kind: "loading",
      });

      try {
        const query = new URLSearchParams({
          x_feature: xFeature,
          y_feature: yFeature,
          max_points: String(MAX_POINTS),
        });

        const response = await fetch(
          `/api/experiments/plots/${experimentId}?${query.toString()}`,
          {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          },
        );

        if (response.status === 401 || response.status === 403) {
          router.replace("/login?session=expired");

          return;
        }

        const raw: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(apiError(raw, "Unable to load scatter coordinates."));
        }

        const plot = readPlot(
          raw,
          experimentId,
          result,
          datasetId,
          xFeature,
          yFeature,
        );

        if (!plot) {
          throw new Error(
            "The scatter API returned inconsistent row coordinates.",
          );
        }

        if (!controller.signal.aborted) {
          // Bound memory usage for experiments with many features.
          if (plotCache.size >= 12) {
            const oldest = plotCache.keys().next().value;

            if (oldest !== undefined) {
              plotCache.delete(oldest);
            }
          }

          plotCache.set(key, plot);

          setState({
            kind: "ready",
            plot,
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setState({
            kind: "error",

            message:
              error instanceof Error
                ? error.message
                : "Scatter coordinates unavailable.",
          });
        }
      }
    }

    void load();

    return () => controller.abort();
  }, [
    experimentId,
    datasetId,
    result,
    xFeature,
    yFeature,
    version,
    router,
    plotCache,
  ]);

  function changeX(next: string) {
    if (next === yFeature) {
      setYFeature(xFeature);
    }

    setXFeature(next);
  }

  function changeY(next: string) {
    if (next === xFeature) {
      setXFeature(yFeature);
    }

    setYFeature(next);
  }

  return (
    <section
      className="caas-card overflow-hidden"
      aria-labelledby="scatter-heading"
    >
      <div className="caas-card-header flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2
            id="scatter-heading"
            className="text-[17px] font-semibold text-[#172235]"
          >
            Real data scatter plot
          </h2>

          <p className="mt-1 text-[12px] leading-5 text-[#718097]">
            Original CSV coordinates colored by saved K-Means cluster
          </p>
        </div>

        {result.features.length >= 2 && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[12px] text-[#53667D]">
              <span className="font-semibold">X</span>

              <select
                value={xFeature}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  changeX(event.target.value)
                }
                className="rounded-lg border border-[#D8E0EC] bg-white px-3 py-2 text-[#243750]"
                aria-label="Scatter plot X feature"
              >
                {result.features.map((feature, index) => (
                  <option key={`${feature}-${index}`} value={feature}>
                    {feature}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-[12px] text-[#53667D]">
              <span className="font-semibold">Y</span>

              <select
                value={yFeature}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  changeY(event.target.value)
                }
                className="rounded-lg border border-[#D8E0EC] bg-white px-3 py-2 text-[#243750]"
                aria-label="Scatter plot Y feature"
              >
                {result.features.map((feature, index) => (
                  <option key={`${feature}-${index}`} value={feature}>
                    {feature}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      <div className="p-5 sm:p-6">
        {result.features.length < 2 ? (
          <p className="rounded-lg bg-[#F5F7FA] p-6 text-[13px] text-[#66788F]">
            A 2D scatter plot requires at least two numeric features used in
            this experiment.
          </p>
        ) : state.kind === "loading" ? (
          <div
            role="status"
            className="flex h-[310px] items-center justify-center rounded-xl bg-[#F8FAFD] text-[13px] text-[#6C7D94]"
          >
            Loading verified CSV coordinates…
          </div>
        ) : state.kind === "error" ? (
          <div
            role="alert"
            className="rounded-xl border border-[#F0CDD0] bg-[#FFF7F7] p-5 text-[13px] text-[#9A3A48]"
          >
            <p className="font-semibold">Scatter plot unavailable</p>

            <p className="mt-2 leading-6">{state.message}</p>

            <button
              type="button"
              className="caas-button caas-button-secondary mt-4"
              onClick={() => setVersion((value) => value + 1)}
            >
              Retry plot data
            </button>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-[#5F7189]">
              <span>
                <b className="text-[#223650]">
                  {format(state.plot.returned_points, 0)}
                </b>{" "}
                plotted
              </span>

              <span>
                <b className="text-[#223650]">
                  {format(state.plot.eligible_rows, 0)}
                </b>{" "}
                eligible rows
              </span>

              <span>
                <b className="text-[#223650]">
                  {state.plot.omitted_invalid_rows}
                </b>{" "}
                excluded
              </span>

              {state.plot.sampled && (
                <span className="font-semibold text-[#9A6A2D]">
                  Sampled from {format(state.plot.eligible_rows, 0)} eligible
                  rows
                </span>
              )}
            </div>

            {/* Smooth animation of existing SVG points. */}
            <div className="[&_svg_circle]:transition-[cx,cy] [&_svg_circle]:duration-300 [&_svg_circle]:ease-in-out motion-reduce:[&_svg_circle]:transition-none">
              <PlotCanvas plot={state.plot} />
            </div>

            <div
              className="mt-4 flex flex-wrap gap-3"
              aria-label="Scatter plot legend"
            >
              {Array.from(
                {
                  length: state.plot.n_clusters,
                },
                (_, index) => (
                  <span
                    key={index}
                    className="inline-flex items-center gap-2 rounded-full border border-[#E5EAF2] bg-white px-3 py-1.5 text-[11px] text-[#465A73]"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{
                        background: COLORS[index % COLORS.length],
                      }}
                    />
                    Cluster {index}
                  </span>
                ),
              )}
            </div>

            <p className="mt-4 text-[11px] leading-5 text-[#8492A5]">
              Points retain their real CSV coordinates. No synthetic
              observations or jitter are added. Overlapping rows may appear as a
              single dot. Reversing the same two features uses coordinates
              already loaded in the browser. A new feature pair is verified by
              the API.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/* ============================================================
   Existing feature — Cluster distribution
   ============================================================ */

function Distribution({ result }: { result: Result }) {
  const counts = Array.from(
    {
      length: result.n_clusters,
    },
    (_, index) => ({
      index,
      count: result.metrics.cluster_sizes[String(index)],

      color: COLORS[index % COLORS.length],
    }),
  );

  let running = 0;

  const segments = counts.map((cluster) => {
    const start = running;

    running += (cluster.count / result.n_samples) * 100;

    return `${cluster.color} ${start}% ${running}%`;
  });

  const maximum = Math.max(...counts.map((cluster) => cluster.count));

  return (
    <section
      className="caas-card overflow-hidden"
      aria-labelledby="distribution-title"
    >
      <div className="caas-card-header">
        <h2 id="distribution-title" className="text-[16px] font-semibold">
          Cluster distribution
        </h2>

        <p className="mt-1 text-[12px] text-[#75849A]">
          Actual saved cluster sizes
        </p>
      </div>

      <div className="grid gap-7 p-5 sm:p-6 lg:grid-cols-[190px_minmax(0,1fr)] lg:items-center">
        <div className="flex justify-center">
          <div
            className="flex h-[172px] w-[172px] items-center justify-center rounded-full"
            style={{
              background: `conic-gradient(${segments.join(", ")})`,
            }}
            role="img"
            aria-label={counts
              .map(
                (cluster) =>
                  `Cluster ${cluster.index}: ${cluster.count} samples`,
              )
              .join("; ")}
          >
            <div className="flex h-[109px] w-[109px] flex-col items-center justify-center rounded-full bg-white">
              <span className="text-[30px] font-semibold text-[#192437]">
                {format(result.n_samples, 0)}
              </span>

              <span className="text-[11px] text-[#8391A6]">Samples</span>
            </div>
          </div>
        </div>

        <div className="max-h-[340px] space-y-4 overflow-y-auto">
          {counts.map((cluster) => (
            <div key={cluster.index}>
              <div className="mb-2 flex justify-between text-[12px]">
                <span className="flex items-center gap-2 font-semibold text-[#34475E]">
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{
                      background: cluster.color,
                    }}
                  />
                  Cluster {cluster.index}
                </span>

                <span className="text-[#74839B]">
                  {cluster.count} (
                  {((100 * cluster.count) / result.n_samples).toFixed(1)}
                  %)
                </span>
              </div>

              <div className="h-2.5 rounded-full bg-[#EBEFF5]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(100 * cluster.count) / maximum}%`,
                    background: cluster.color,
                  }}
                />
              </div>
            </div>
          ))}

          <p className="text-[11px] text-[#8391A6]">
            Bars are relative to the largest cluster. Percentages use all saved
            samples.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   Existing feature — Interactive centroid comparison
   ============================================================ */

function CenterComparison({ result }: { result: Result }) {
  const [feature, setFeature] = useState(0);

  const selectedIndex = Math.min(feature, result.features.length - 1);

  const values = result.centroids.map((row) => row[selectedIndex]);

  const minimum = Math.min(...values);

  const maximum = Math.max(...values);

  const range = maximum - minimum;

  return (
    <section
      className="caas-card overflow-hidden"
      aria-labelledby="centers-title"
    >
      <div className="caas-card-header flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="centers-title" className="text-[16px] font-semibold">
            Compare cluster centers
          </h2>

          <p className="mt-1 text-[12px] text-[#75849A]">
            Centroids in original feature units
          </p>
        </div>

        <label className="flex items-center gap-2 text-[12px] text-[#52657D]">
          Feature
          <select
            aria-label="Feature for centroid comparison"
            className="rounded-lg border border-[#D4DCE8] bg-white px-3 py-2"
            value={selectedIndex}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              setFeature(Number(event.target.value))
            }
          >
            {result.features.map((featureName, index) => (
              <option key={`${featureName}-${index}`} value={index}>
                {featureName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-5 p-5 sm:p-6">
        <div className="flex justify-between text-[11px] text-[#8492A5]">
          <span>Minimum: {format(minimum)}</span>

          <span>Maximum: {format(maximum)}</span>
        </div>

        {values.map((value, index) => {
          const position = range === 0 ? 50 : (100 * (value - minimum)) / range;

          return (
            <div
              key={index}
              className="grid gap-2 sm:grid-cols-[85px_minmax(0,1fr)_105px] sm:items-center"
            >
              <span className="text-[12px] font-semibold text-[#475A72]">
                Cluster {index}
              </span>

              <div className="relative h-5">
                <div className="absolute inset-x-0 top-1/2 h-[3px] rounded bg-[#EBEFF4]" />

                <span
                  className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-sm"
                  style={{
                    left: `${position}%`,

                    background: COLORS[index % COLORS.length],

                    boxShadow: `0 0 0 2px ${COLORS[index % COLORS.length]}50`,
                  }}
                />
              </div>

              <span className="text-right font-mono text-[12px]">
                {format(value)}
              </span>
            </div>
          );
        })}

        <p className="text-[11px] leading-5 text-[#8492A5]">
          Markers compare saved centroid values. They do not represent
          individual CSV rows.
        </p>
      </div>
    </section>
  );
}

/* ============================================================
   Existing results dashboard + scatter integration
   ============================================================ */

function ResultsView({ detail }: { detail: Detail }) {
  const { experiment, result } = detail;

  const [scaled, setScaled] = useState(false);

  if (!result) {
    return (
      <section className="caas-card p-8">
        <h2 className="text-xl font-semibold">No saved result yet</h2>

        <p className="mt-3 text-[13px] text-[#64748B]">
          This experiment has no persisted result. Check your job tracker or
          experiment history.
        </p>

        <Link
          className="caas-button caas-button-secondary mt-5"
          href="/dashboard/experiments/history"
        >
          View history
        </Link>
      </section>
    );
  }

  const matrix = scaled ? result.scaled_centroids : result.centroids;

  return (
    <div className="space-y-6">
      {/* Existing metric cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Samples clustered"
          value={format(result.n_samples, 0)}
          note="Rows in the saved experiment"
        />

        <MetricCard
          label="Clusters formed"
          value={format(result.n_clusters, 0)}
          note="Custom K-Means"
        />

        <MetricCard
          label="SSE / Inertia"
          value={format(result.metrics.sse)}
          note="Sum of squared distances in training feature space"
        />

        <MetricCard
          label="Silhouette score"
          value={
            result.metrics.silhouette_score === null
              ? "—"
              : result.metrics.silhouette_score.toFixed(4)
          }
          note={
            result.metrics.silhouette_score === null
              ? "Not available"
              : result.metrics.silhouette_is_approximate
                ? "Approximate (sample-based)"
                : "Higher generally indicates better separation"
          }
        />
      </div>

      {/* File 82: New real scatter plot */}
      <ScatterPlot
        experimentId={experiment.experiment_id}
        datasetId={experiment.dataset_id}
        result={result}
      />

      {/* Existing visual results and details */}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_285px]">
        <div className="min-w-0 space-y-5">
          <Distribution result={result} />

          <CenterComparison result={result} />

          {/* Existing centroid table */}
          <section
            className="caas-card overflow-hidden"
            aria-labelledby="table-title"
          >
            <div className="caas-card-header flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="table-title" className="text-[16px] font-semibold">
                  Centroid coordinates
                </h2>

                <p className="mt-1 text-[12px] text-[#76859B]">
                  Saved values for each feature
                </p>
              </div>

              <label className="flex items-center gap-2 text-[12px] text-[#53667F]">
                <input
                  type="checkbox"
                  checked={scaled}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setScaled(event.target.checked)
                  }
                  className="h-4 w-4 accent-[#305BE8]"
                />
                Show scaled values
              </label>
            </div>

            <div className="caas-table-scroll">
              <table className="caas-table">
                <caption className="sr-only">
                  {scaled ? "Scaled" : "Original"} cluster centroid coordinates
                </caption>

                <thead>
                  <tr>
                    <th scope="col">Cluster</th>

                    <th scope="col">Samples</th>

                    {result.features.map((featureName, index) => (
                      <th key={index} scope="col">
                        {featureName}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {matrix.map((row, index) => (
                    <tr key={index}>
                      <td className="whitespace-nowrap font-semibold">
                        <span
                          className="mr-2 inline-block h-2.5 w-2.5 rounded-sm"
                          style={{
                            background: COLORS[index % COLORS.length],
                          }}
                        />
                        Cluster {index}
                      </td>

                      <td>{result.metrics.cluster_sizes[String(index)]}</td>

                      {row.map((value, featureIndex) => (
                        <td
                          key={featureIndex}
                          className="whitespace-nowrap font-mono tabular-nums"
                        >
                          {format(value, 6)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="px-5 py-3 text-[11px] text-[#8391A6]">
              {scaled
                ? "Scaled centroids are in the feature space used by K-Means."
                : "Original-unit centroids are easier to interpret in terms of age, income, and other inputs."}
            </p>
          </section>
        </div>

        {/* Existing details sidebar */}
        <aside className="space-y-5 xl:sticky xl:top-6">
          <section className="caas-card p-5 sm:p-6">
            <h2 className="text-[16px] font-semibold">Run quality</h2>

            <div className="mt-4 rounded-lg bg-[#F5F7FB] p-3">
              <p className="text-[11px] text-[#8592A6]">Convergence</p>

              <p
                className={`mt-1 text-[14px] font-semibold ${
                  result.converged ? "text-[#0E806B]" : "text-[#A26A2B]"
                }`}
              >
                {result.converged ? "Converged" : "Tolerance not reached"}
              </p>
            </div>

            <dl className="mt-3">
              <DataRow
                label="Iterations"
                value={format(result.iterations, 0)}
              />

              <DataRow
                label="Worker time"
                value={`${format(result.processing_time_ms)} ms`}
              />

              <DataRow
                label="Features"
                value={format(result.features.length, 0)}
              />

              <DataRow
                label="Silhouette samples"
                value={format(result.metrics.silhouette_sample_size, 0)}
              />
            </dl>
          </section>

          <section className="caas-card p-5 sm:p-6">
            <h2 className="text-[16px] font-semibold">Preprocessing</h2>

            <dl className="mt-3">
              <DataRow
                label="Scaling"
                value={result.preprocessing_config.method}
              />

              <DataRow
                label="Missing values"
                value={result.preprocessing_config.missing_values}
              />

              <DataRow
                label="Rows fitted"
                value={format(result.preprocessing_config.n_samples_fit, 0)}
              />
            </dl>

            <h3 className="mt-5 text-[12px] font-semibold">
              Algorithm settings
            </h3>

            <dl className="mt-2">
              <DataRow
                label="Initialization"
                value={result.algorithm_config.init}
              />

              <DataRow
                label="n_init"
                value={format(result.algorithm_config.n_init, 0)}
              />

              <DataRow
                label="Max iterations"
                value={format(result.algorithm_config.max_iter, 0)}
              />

              <DataRow
                label="Tolerance"
                value={format(result.algorithm_config.tolerance, 6)}
              />

              <DataRow
                label="Random seed"
                value={format(result.algorithm_config.random_state, 0)}
              />
            </dl>
          </section>

          <section className="caas-card p-5 sm:p-6">
            <h2 className="text-[16px] font-semibold">Experiment record</h2>

            <dl className="mt-3">
              <DataRow
                label="Experiment ID"
                value={experiment.experiment_id}
                mono
              />

              <DataRow label="Dataset ID" value={experiment.dataset_id} mono />

              <DataRow label="Created" value={when(experiment.created_at)} />

              <DataRow label="Model version" value={result.model_version} />
            </dl>

            <div className="mt-5 grid gap-2">
              <Link
                className="caas-button caas-button-secondary w-full"
                href="/dashboard/experiments/history"
              >
                Experiment history
              </Link>

              <Link
                className="caas-button caas-button-primary w-full"
                href="/dashboard/experiments"
              >
                New experiment
              </Link>
            </div>
          </section>
        </aside>
      </div>

      <p className="text-[11px] leading-5 text-[#8391A6]">
        The scatter plot uses verified original CSV coordinates and saved
        cluster labels. Cluster distributions and centroid comparisons use
        values persisted by the K-Means worker.
      </p>
    </div>
  );
}

/* ============================================================
   Authenticated Results Dashboard data loading
   ============================================================ */

function ResultsContent() {
  const { experimentId } = useParams<{
    experimentId: string;
  }>();

  const router = useRouter();

  const [reload, setReload] = useState(0);

  const [state, setState] = useState<ResultScreen>({
    kind: "loading",
  });

  useEffect(() => {
    if (!UUID.test(experimentId)) {
      return;
    }

    const controller = new AbortController();

    async function load() {
      setState({
        kind: "loading",
      });

      let email: string | null = null;

      try {
        const session = await fetch("/api/auth/session", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });

        if (session.status === 401 || session.status === 403) {
          router.replace("/login?session=expired");
          return;
        }

        const auth: unknown = await session.json().catch(() => null);

        if (
          !session.ok ||
          !isObject(auth) ||
          auth.authenticated !== true ||
          !isObject(auth.user) ||
          typeof auth.user.email !== "string"
        ) {
          throw new Error(
            "Cannot verify your session. Check that FastAPI is running.",
          );
        }

        email = auth.user.email;

        const response = await fetch(
          `/api/experiments/results/${experimentId}`,
          {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          },
        );

        if (response.status === 401 || response.status === 403) {
          router.replace("/login?session=expired");
          return;
        }

        const raw: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(apiError(raw, "Could not load the saved result."));
        }

        const detail = readDetail(raw, experimentId);

        if (!detail) {
          throw new Error("Results service returned invalid metadata.");
        }

        if (!controller.signal.aborted) {
          setState({
            kind: "ready",
            detail,
            email,
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setState({
            kind: "error",
            message:
              error instanceof Error ? error.message : "Results unavailable.",
            email,
          });
        }
      }
    }

    void load();

    return () => controller.abort();
  }, [experimentId, reload, router]);

  if (!UUID.test(experimentId)) {
    return (
      <div className="caas-card p-8">
        <h1 className="text-xl font-semibold">Invalid experiment ID</h1>

        <Link
          href="/dashboard/experiments/history"
          className="caas-button caas-button-secondary mt-5"
        >
          Experiment history
        </Link>
      </div>
    );
  }

  if (state.kind === "loading") {
    return <Skeleton />;
  }

  if (state.kind === "error") {
    const errorContent = (
      <div role="alert" className="caas-card p-8">
        <h1 className="text-xl font-semibold">Saved results unavailable</h1>

        <p className="mt-3 text-[13px] text-[#63758D]">{state.message}</p>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            className="caas-button caas-button-primary"
            onClick={() => setReload((value) => value + 1)}
          >
            Retry
          </button>

          <Link
            href="/dashboard/experiments/history"
            className="caas-button caas-button-secondary"
          >
            History
          </Link>
        </div>
      </div>
    );

    return state.email ? (
      <WorkspaceShell email={state.email}>{errorContent}</WorkspaceShell>
    ) : (
      errorContent
    );
  }

  const { experiment, result_available } = state.detail;

  return (
    <WorkspaceShell email={state.email}>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="caas-eyebrow">Experiments / Saved results</p>

          <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.055em] sm:text-[39px]">
            Clustering results.
          </h1>

          <p className="mt-3 text-[14px] leading-6 text-[#64748B]">
            {experiment.name || "K-Means clustering"} · Real, saved analysis
            from your private workspace.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span
            className={
              result_available
                ? "caas-status caas-status-success"
                : "caas-status caas-status-warning"
            }
          >
            {result_available ? "● Result saved" : "● No saved result"}
          </span>

          {/* File 102 — Download real clustering assignments. */}
          {result_available && (
            <a
              href={`/api/experiments/results/${experiment.experiment_id}/export`}
              target="_blank"
              rel="noopener noreferrer"
              className="caas-button caas-button-primary min-h-9"
              aria-label={`Download clustered CSV for ${
                experiment.name || "K-Means clustering"
              }`}
              title="Download your original CSV with cluster assignments"
            >
              <span aria-hidden="true">↓</span>
              Download CSV
            </a>
          )}

          <button
            type="button"
            className="caas-button caas-button-secondary min-h-9"
            onClick={() => setReload((value) => value + 1)}
          >
            Refresh result
          </button>
        </div>
      </div>

      <ResultsView detail={state.detail} />
    </WorkspaceShell>
  );
}

/* ============================================================
   Next.js 16 Suspense boundary for dynamic useParams()
   ============================================================ */

export default function SavedResultsPage() {
  return (
    <Suspense fallback={<Skeleton />}>
      <ResultsContent />
    </Suspense>
  );
}
