
"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type ColumnQuality = {
  name: string;
  inferred_type: "numeric" | "text" | "mixed" | "empty";
  missing_count: number;
  distinct_count: number;
  invalid_numeric_count: number;
  potential_outlier_count: number;
  is_constant: boolean;
};

type QualityReport = {
  sample_scope: "first_rows";
  sample_is_partial: boolean;
  sampled_rows: number;
  missing_cells: number;
  rows_with_missing: number;
  duplicate_rows: number;
  nonnumeric_columns: number;
  mixed_columns: number;
  constant_columns: number;
  potential_outlier_cells: number;
  columns: ColumnQuality[];
  recommendations: string[];
};

type PreviewResponse = {
  success: true;
  dataset_id: string;
  total_rows: number | null;
  sampled_rows: number;
  preview_limit: number;
  rows: Record<string, string | null>[];
  columns: { name: string }[];
  quality: QualityReport;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: PreviewResponse };

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isPreviewResponse(
  value: unknown,
): value is PreviewResponse {
  if (!isRecord(value) || value.success !== true) {
    return false;
  }

  if (
    typeof value.dataset_id !== "string" ||
    typeof value.sampled_rows !== "number" ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.columns) ||
    !isRecord(value.quality)
  ) {
    return false;
  }

  const quality = value.quality;

  return (
    quality.sample_scope === "first_rows" &&
    typeof quality.sample_is_partial === "boolean" &&
    Array.isArray(quality.columns) &&
    Array.isArray(quality.recommendations)
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-IN").format(value);
}

function MetricCard({
  title,
  value,
  description,
}: {
  title: string;
  value: number;
  description: string;
}) {
  return (
    <article className="caas-card p-5 sm:p-6">
      <p className="text-[12px] font-medium text-[#64748B]">
        {title}
      </p>

      <p className="mt-3 text-[30px] font-semibold tracking-[-0.05em] text-[#172235]">
        {formatNumber(value)}
      </p>

      <p className="mt-2 text-[11px] leading-5 text-[#8491A3]">
        {description}
      </p>
    </article>
  );
}

function typeStyle(type: ColumnQuality["inferred_type"]) {
  switch (type) {
    case "numeric":
      return "bg-[#E8F6F1] text-[#137B67]";
    case "mixed":
      return "bg-[#FFF2DB] text-[#926313]";
    case "empty":
      return "bg-[#FFF0F1] text-[#B43745]";
    default:
      return "bg-[#EDF2FF] text-[#3455AE]";
  }
}

function columnFlags(column: ColumnQuality): string {
  const flags: string[] = [];

  if (column.inferred_type === "text") {
    flags.push("Text feature");
  }

  if (column.inferred_type === "mixed") {
    flags.push(
      `${column.invalid_numeric_count} nonnumeric / non-finite values`,
    );
  }

  if (column.inferred_type === "empty") {
    flags.push("Empty column");
  }

  if (column.is_constant) {
    flags.push("Constant values");
  }

  if (column.missing_count > 0) {
    flags.push("Missing values");
  }

  if (column.potential_outlier_count > 0) {
    flags.push("Possible outliers");
  }

  return flags.length > 0 ? flags.join(" · ") : "No flags";
}

export default function DatasetQualityPage() {
  const params = useParams<{ datasetId: string }>();
  const router = useRouter();

  const datasetId = params.datasetId;

  const [state, setState] = useState<LoadState>({
    kind: "loading",
  });

  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function loadQuality() {
      try {
        const response = await fetch(
          `/api/datasets/${encodeURIComponent(datasetId)}/preview?limit=5`,
          {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          },
        );

        if (controller.signal.aborted) return;

        if (
          response.status === 401 ||
          response.status === 403
        ) {
          router.replace("/login?session=expired");
          return;
        }

        const data: unknown = await response
          .json()
          .catch(() => null);

        if (controller.signal.aborted) return;

        if (!response.ok) {
          const message =
            isRecord(data) &&
            typeof data.message === "string"
              ? data.message
              : "Unable to load dataset quality.";

          setState({
            kind: "error",
            message,
          });

          return;
        }

        if (!isPreviewResponse(data)) {
          throw new Error(
            "Dataset quality response is invalid.",
          );
        }

        setState({
          kind: "ready",
          data,
        });
      } catch {
        if (!controller.signal.aborted) {
          setState({
            kind: "error",
            message:
              "Unable to load the report. Check your connection and try again.",
          });
        }
      }
    }

    void loadQuality();

    return () => controller.abort();
  }, [datasetId, retry, router]);

  function refresh() {
    setState({ kind: "loading" });
    setRetry((value) => value + 1);
  }

  return (
    <main className="space-y-7 pb-12">
      {/* Header */}
      <header>
        <Link
          href="/dashboard/datasets"
          className="text-[13px] font-medium text-[#305BE8] hover:underline"
        >
          ← Back to datasets
        </Link>

        <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="caas-eyebrow">
              Dataset intelligence
            </p>

            <h1 className="mt-2 text-[30px] font-semibold tracking-[-0.05em] text-[#172235] sm:text-[38px]">
              Dataset health check
            </h1>

            <p className="mt-3 max-w-[680px] text-[14px] leading-6 text-[#64748B]">
              Understand potential data-quality issues
              before running a clustering experiment.
            </p>
          </div>

          <button
            type="button"
            onClick={refresh}
            disabled={state.kind === "loading"}
            className="caas-button caas-button-secondary"
          >
            Refresh analysis
          </button>
        </div>

        <p className="mt-4 break-all font-mono text-[11px] text-[#8491A3]">
          Dataset ID: {datasetId}
        </p>
      </header>

      {/* Loading */}
      {state.kind === "loading" && (
        <div
          className="caas-card p-10 text-center"
          role="status"
        >
          <div className="mx-auto h-9 w-9 animate-spin rounded-full border-[3px] border-[#DCE5FA] border-t-[#305BE8]" />

          <p className="mt-5 text-[14px] font-medium">
            Analyzing your dataset...
          </p>

          <p className="mt-2 text-[12px] text-[#64748B]">
            Reading the stored CSV sample and preparing
            the quality report.
          </p>
        </div>
      )}

      {/* Error */}
      {state.kind === "error" && (
        <div className="caas-card p-8" role="alert">
          <h2 className="text-[18px] font-semibold">
            Quality report unavailable
          </h2>

          <p className="mt-3 text-[13px] text-[#64748B]">
            {state.message}
          </p>

          <button
            type="button"
            onClick={refresh}
            className="caas-button caas-button-primary mt-5"
          >
            Try again
          </button>
        </div>
      )}

      {/* Actual dataset quality results */}
      {state.kind === "ready" && (() => {
        const data = state.data;
        const quality = data.quality;

        const scopeMessage = quality.sample_is_partial
          ? `The first ${formatNumber(quality.sampled_rows)} of ${
              data.total_rows === null
                ? "an unknown total number of"
                : formatNumber(data.total_rows)
            } rows were analyzed. Issues outside this sample may not be detected.`
          : data.total_rows === quality.sampled_rows
            ? `All ${formatNumber(quality.sampled_rows)} rows were analyzed.`
            : `The first ${formatNumber(quality.sampled_rows)} rows were analyzed.`;

        return (
          <>
            {/* Sample coverage */}
            <section
              className="rounded-xl border border-[#D9E4FA] bg-[#F0F5FF] p-5 sm:p-6"
              aria-label="Analysis coverage"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-[14px] font-semibold text-[#244A9A]">
                  Sample-based quality analysis
                </h2>

                <span className="caas-status caas-status-info">
                  {quality.sample_is_partial
                    ? "Partial dataset"
                    : "Sample reviewed"}
                </span>
              </div>

              <p className="mt-3 text-[13px] leading-6 text-[#526887]">
                {scopeMessage}
              </p>

              <p className="mt-2 text-[12px] leading-5 text-[#64748B]">
                This report is read-only and does not
                modify your uploaded data.
              </p>
            </section>

            {/* Summary cards */}
            <section aria-labelledby="quality-overview">
              <div className="mb-5">
                <h2
                  id="quality-overview"
                  className="text-[20px] font-semibold tracking-[-0.035em]"
                >
                  Quality overview
                </h2>

                <p className="mt-2 text-[13px] text-[#64748B]">
                  Findings within the analyzed sample.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                <MetricCard
                  title="Missing cells"
                  value={quality.missing_cells}
                  description="Empty or whitespace-only values"
                />

                <MetricCard
                  title="Rows with missing values"
                  value={quality.rows_with_missing}
                  description="Sampled rows containing an empty cell"
                />

                <MetricCard
                  title="Duplicate rows"
                  value={quality.duplicate_rows}
                  description="Exact repeated CSV rows in the sample"
                />

                <MetricCard
                  title="Nonnumeric columns"
                  value={quality.nonnumeric_columns}
                  description="Text or mixed-type columns"
                />

                <MetricCard
                  title="Constant columns"
                  value={quality.constant_columns}
                  description="Columns with no observed variation"
                />

                <MetricCard
                  title="Potential outlier cells"
                  value={quality.potential_outlier_cells}
                  description="Numeric values flagged using IQR"
                />
              </div>

              {quality.mixed_columns > 0 && (
                <p className="mt-4 text-[12px] text-[#926313]">
                  {formatNumber(quality.mixed_columns)} mixed-type
                  column(s) need additional inspection.
                </p>
              )}
            </section>

            {/* Recommendations */}
            <section
              className="caas-card overflow-hidden"
              aria-labelledby="quality-recommendations"
            >
              <div className="caas-card-header">
                <h2
                  id="quality-recommendations"
                  className="text-[17px] font-semibold"
                >
                  Recommended checks
                </h2>

                <p className="mt-1 text-[12px] text-[#718097]">
                  Suggestions based on the detected issues.
                </p>
              </div>

              <ol className="space-y-4 p-5 sm:p-6">
                {quality.recommendations.map(
                  (recommendation, index) => (
                    <li
                      key={index}
                      className="flex items-start gap-3"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#EDF2FF] text-[12px] font-semibold text-[#3455AE]">
                        {index + 1}
                      </span>

                      <p className="pt-1 text-[13px] leading-6 text-[#465670]">
                        {recommendation}
                      </p>
                    </li>
                  ),
                )}
              </ol>
            </section>

            {/* Column diagnostics */}
            <section
              className="caas-card overflow-hidden"
              aria-labelledby="column-diagnostics"
            >
              <div className="caas-card-header">
                <h2
                  id="column-diagnostics"
                  className="text-[17px] font-semibold"
                >
                  Column diagnostics
                </h2>

                <p className="mt-1 text-[12px] text-[#718097]">
                  Statistics for each uploaded column,
                  calculated from the sampled rows.
                </p>
              </div>

              <div className="caas-table-scroll">
                <table className="caas-table">
                  <thead>
                    <tr>
                      <th>Column</th>
                      <th>Type</th>
                      <th>Missing</th>
                      <th>Distinct</th>
                      <th>Outliers</th>
                      <th>Findings</th>
                    </tr>
                  </thead>

                  <tbody>
                    {quality.columns.map((column, index) => (
                      <tr key={`${column.name}-${index}`}>
                        <td className="max-w-[220px] break-words font-semibold">
                          {column.name}
                        </td>

                        <td>
                          <span
                            className={`inline-flex rounded-md px-2.5 py-1 text-[11px] font-semibold ${typeStyle(
                              column.inferred_type,
                            )}`}
                          >
                            {column.inferred_type}
                          </span>
                        </td>

                        <td>
                          {formatNumber(column.missing_count)}
                        </td>

                        <td>
                          {formatNumber(column.distinct_count)}
                        </td>

                        <td>
                          {formatNumber(
                            column.potential_outlier_count,
                          )}
                        </td>

                        <td className="min-w-[190px] text-[12px] text-[#64748B]">
                          {columnFlags(column)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Existing preview data */}
            <section
              className="caas-card overflow-hidden"
              aria-labelledby="data-preview"
            >
              <div className="caas-card-header">
                <h2
                  id="data-preview"
                  className="text-[17px] font-semibold"
                >
                  Dataset preview
                </h2>

                <p className="mt-1 text-[12px] text-[#718097]">
                  First {formatNumber(data.rows.length)} visible
                  rows from the uploaded CSV.
                </p>
              </div>

              <div className="caas-table-scroll">
                <table className="caas-table">
                  <thead>
                    <tr>
                      {data.columns.map((column, index) => (
                        <th key={`${column.name}-${index}`}>
                          {column.name}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {data.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {data.columns.map(
                          (column, columnIndex) => {
                            const value = row[column.name];

                            return (
                              <td
                                key={`${column.name}-${columnIndex}`}
                                className="max-w-[250px] break-words"
                              >
                                {value === null ||
                                value === undefined ||
                                value === "" ? (
                                  <span className="text-[#A0AABB]">
                                    —
                                  </span>
                                ) : (
                                  value
                                )}
                              </td>
                            );
                          },
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="text-[12px] leading-6 text-[#8491A3]">
              Potential outliers are statistical flags, not
              necessarily data errors. Exact duplicates
              are detected within the sample only.
              Review the relevance of individual features
              before running K-Means.
            </p>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/dashboard/datasets"
                className="caas-button caas-button-secondary"
              >
                Back to datasets
              </Link>

              <Link
                href="/dashboard/experiments"
                className="caas-button caas-button-primary"
              >
                Create experiment →
              </Link>
            </div>
          </>
        );
      })()}
    </main>
  );
}
