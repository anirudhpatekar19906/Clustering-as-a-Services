"use client";

/**
 * File 74 — CaaS job tracker with saved-results navigation.
 *
 * GET /api/auth/session
 * GET /api/experiments/jobs/[jobId]
 *
 * A saved-results link is shown only when:
 * 1. The job has completed.
 * 2. The backend confirms a saved result is available.
 * 3. A valid experiment ID is returned.
 *
 * The job ID and experiment ID are different identifiers.
 * Job polling and the Next.js 16 Suspense fix are preserved.
 */

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Suspense,
  useEffect,
  useState,
  type ChangeEvent,
} from "react";
import WorkspaceShell from "@/components/workspace-shell";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const POLL_INTERVAL_MS = 5000;

type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

type Screen =
  | { kind: "checking" }
  | { kind: "ready"; email: string }
  | { kind: "error"; message: string };

type ResultSummary = {
  n_samples: number;
  n_clusters: number;
  iterations: number;
  converged: boolean;
  processing_time_ms: number;
  sse: number;
  silhouette_score: number | null;
};

type Job = {
  job_id: string;
  experiment_id: string | null;
  dataset_id: string;
  status: JobStatus;
  status_source: "postgresql" | "redis";
  message: string;
  recorded_at: string | null;
  enqueued_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  result_available: boolean;
  result_summary: ResultSummary | null;
};

const TERMINAL_STATES: readonly JobStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function validDate(
  value: unknown
): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      Number.isFinite(Date.parse(value)))
  );
}

function positiveInteger(
  value: unknown
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function finiteNonnegative(
  value: unknown
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function parseJob(
  value: unknown,
  expectedId: string
): Job | null {
  if (
    !isRecord(value) ||
    value.success !== true
  ) {
    return null;
  }

  const allowed: JobStatus[] = [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
  ];

  const state = value.status;
  const result = value.result_summary;

  if (
    typeof value.job_id !== "string" ||
    !UUID.test(value.job_id) ||
    value.job_id.toLowerCase() !==
      expectedId.toLowerCase() ||
    typeof value.dataset_id !== "string" ||
    !UUID.test(value.dataset_id) ||
    (value.experiment_id !== null &&
      (typeof value.experiment_id !== "string" ||
        !UUID.test(value.experiment_id))) ||
    typeof state !== "string" ||
    !allowed.includes(state as JobStatus) ||
    (value.status_source !== "postgresql" &&
      value.status_source !== "redis") ||
    typeof value.message !== "string" ||
    !validDate(value.recorded_at) ||
    !validDate(value.enqueued_at) ||
    !validDate(value.started_at) ||
    !validDate(value.ended_at) ||
    typeof value.result_available !== "boolean"
  ) {
    return null;
  }

  let summary: ResultSummary | null = null;

  if (result !== null) {
    if (
      !isRecord(result) ||
      !positiveInteger(result.n_samples) ||
      !positiveInteger(result.n_clusters) ||
      !positiveInteger(result.iterations) ||
      typeof result.converged !== "boolean" ||
      !finiteNonnegative(result.processing_time_ms) ||
      !finiteNonnegative(result.sse) ||
      (result.silhouette_score !== null &&
        (typeof result.silhouette_score !== "number" ||
          !Number.isFinite(result.silhouette_score) ||
          result.silhouette_score < -1 ||
          result.silhouette_score > 1))
    ) {
      return null;
    }

    summary = {
      n_samples: result.n_samples,
      n_clusters: result.n_clusters,
      iterations: result.iterations,
      converged: result.converged,
      processing_time_ms: result.processing_time_ms,
      sse: result.sse,
      silhouette_score: result.silhouette_score,
    };
  }

  if (
    value.result_available !== (summary !== null)
  ) {
    return null;
  }

  if (
    state !== "completed" &&
    summary !== null
  ) {
    return null;
  }

  return {
    job_id: value.job_id,
    dataset_id: value.dataset_id,
    experiment_id: value.experiment_id,
    status: state as JobStatus,
    status_source: value.status_source,
    message: value.message,
    recorded_at: value.recorded_at,
    enqueued_at: value.enqueued_at,
    started_at: value.started_at,
    ended_at: value.ended_at,
    result_available: value.result_available,
    result_summary: summary,
  };
}

function errorMessage(
  value: unknown,
  fallback: string
): string {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    value.message.trim()
  )
    ? value.message.slice(0, 300)
    : fallback;
}

function displayTime(
  value: string | null
): string {
  if (!value) return "Not recorded";

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(value));
}

function displayNumber(
  value: number
): string {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 4,
  }).format(value);
}

const STATUS_INFO: Record<
  JobStatus,
  {
    title: string;
    description: string;
    pillClass: string;
    icon: string;
  }
> = {
  queued: {
    title: "Waiting for a worker",
    description:
      "FastAPI accepted this experiment. An RQ worker will pick it up when available.",
    pillClass:
      "border-[#D7E2FA] bg-[#F0F4FF] text-[#3D60AE]",
    icon: "◷",
  },

  running: {
    title: "Clustering in progress",
    description:
      "A worker is processing the dataset and K-Means configuration.",
    pillClass:
      "border-[#C6DBF8] bg-[#EDF5FF] text-[#2D67AC]",
    icon: "◌",
  },

  completed: {
    title: "Clustering completed",
    description:
      "The worker finished. Any saved result summary is shown below.",
    pillClass:
      "border-[#BCE5D5] bg-[#EAF8F1] text-[#137659]",
    icon: "✓",
  },

  failed: {
    title: "Experiment failed",
    description:
      "The worker reported a failure. Review its status and settings before creating another experiment.",
    pillClass:
      "border-[#F1C8CE] bg-[#FFF1F2] text-[#A53645]",
    icon: "!",
  },

  cancelled: {
    title: "Experiment cancelled",
    description:
      "This job was cancelled and is no longer being processed.",
    pillClass:
      "border-[#E1E5EA] bg-[#F4F5F7] text-[#64748B]",
    icon: "×",
  },
};

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="caas-card p-5">
      <p className="text-[12px] text-[#6C7C91]">
        {label}
      </p>

      <p className="mt-3 break-words text-[27px] font-semibold tracking-[-0.045em] text-[#172235]">
        {value}
      </p>

      <p className="mt-2 text-[11px] leading-5 text-[#8491A3]">
        {note}
      </p>
    </div>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-2 border-b border-[#E9EDF3] py-3 last:border-b-0 sm:grid-cols-[160px_minmax(0,1fr)]">
      <dt className="text-[12px] text-[#75849A]">
        {label}
      </dt>

      <dd
        className={`break-all text-[12px] text-[#2D3D55] ${
          mono ? "font-mono" : "font-medium"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function Lifecycle({
  status,
}: {
  status: JobStatus;
}) {
  const stages = [
    {
      label: "Accepted",
      detail: "Queued for processing",
    },
    {
      label: "Processing",
      detail: "K-Means worker",
    },
    {
      label: "Finished",
      detail: "Final worker state",
    },
  ];

  const current =
    status === "queued"
      ? 0
      : status === "running"
        ? 1
        : 2;

  return (
    <div
      className="grid gap-3 sm:grid-cols-3"
      aria-label={`Current job state: ${status}`}
    >
      {stages.map((stage, index) => {
        const reached = index <= current;
        const isCurrent = index === current;

        const stopped =
          isCurrent &&
          (status === "failed" ||
            status === "cancelled");

        return (
          <div
            key={stage.label}
            className={`rounded-xl border p-4 ${
              isCurrent
                ? stopped
                  ? "border-[#EAC7CE] bg-[#FFF6F7]"
                  : "border-[#B8C9F8] bg-[#F3F6FF]"
                : reached
                  ? "border-[#D9E8E2] bg-[#F8FCFA]"
                  : "border-[#E5EAF1] bg-[#FAFBFD]"
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-bold ${
                isCurrent && stopped
                  ? "bg-[#FAE2E6] text-[#B23A4A]"
                  : reached
                    ? "bg-[#305BE8] text-white"
                    : "bg-[#E6EBF2] text-[#8A99AC]"
              }`}
            >
              {reached && !isCurrent
                ? "✓"
                : index + 1}
            </span>

            <p className="mt-3 text-[13px] font-semibold text-[#293950]">
              {stage.label}
            </p>

            <p className="mt-1 text-[11px] leading-5 text-[#7A899D]">
              {stage.detail}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function JobTrackingContent() {
  const { jobId } =
    useParams<{ jobId: string }>();

  const router = useRouter();

  const [screen, setScreen] =
    useState<Screen>({ kind: "checking" });

  const [job, setJob] =
    useState<Job | null>(null);

  const [loadingJob, setLoadingJob] =
    useState(true);

  const [statusError, setStatusError] =
    useState("");

  const [lastChecked, setLastChecked] =
    useState<string | null>(null);

  const [autoRefresh, setAutoRefresh] =
    useState(true);

  const [requestVersion, setRequestVersion] =
    useState(0);

  const [verificationVersion, setVerificationVersion] =
    useState(0);

  // Verify the account before displaying private job data.
  useEffect(() => {
    if (!UUID.test(jobId)) return;

    const controller = new AbortController();

    async function verify() {
      try {
        const response = await fetch(
          "/api/auth/session",
          {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          }
        );

        if (response.status === 401) {
          router.replace(
            "/login?session=expired"
          );
          return;
        }

        const data: unknown =
          await response.json().catch(() => null);

        if (
          !response.ok ||
          !isRecord(data) ||
          data.authenticated !== true ||
          !isRecord(data.user) ||
          typeof data.user.email !== "string"
        ) {
          throw new Error(
            "Couldn't verify your session. Check that FastAPI is running."
          );
        }

        if (!controller.signal.aborted) {
          setScreen({
            kind: "ready",
            email: data.user.email,
          });
        }
      } catch {
        if (!controller.signal.aborted) {
          setScreen({
            kind: "error",
            message:
              "Session verification is unavailable. Please retry.",
          });
        }
      }
    }

    void verify();

    return () => controller.abort();
  }, [jobId, router, verificationVersion]);

  /*
   * Status polling:
   * - One request at a time.
   * - Refresh every 5 seconds while active.
   * - Pause when the browser tab is hidden.
   * - Stop on completed, failed, or cancelled.
   * - Stop on API errors until manually retried.
   */
  useEffect(() => {
    if (
      screen.kind !== "ready" ||
      !UUID.test(jobId)
    ) {
      return;
    }

    let disposed = false;
    let stopped = false;

    let timer:
      | ReturnType<typeof setTimeout>
      | null = null;

    let inflight: AbortController | null =
      null;

    function clearTimer() {
      if (timer !== null) {
        clearTimeout(timer);
      }

      timer = null;
    }

    function schedule() {
      clearTimer();

      if (
        disposed ||
        stopped ||
        !autoRefresh ||
        document.hidden
      ) {
        return;
      }

      timer = setTimeout(
        () => void checkStatus(),
        POLL_INTERVAL_MS
      );
    }

    async function checkStatus() {
      if (
        disposed ||
        stopped ||
        inflight !== null
      ) {
        return;
      }

      clearTimer();

      const controller = new AbortController();
      inflight = controller;

      setLoadingJob(true);

      try {
        const response = await fetch(
          `/api/experiments/jobs/${encodeURIComponent(
            jobId
          )}`,
          {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          }
        );

        const data: unknown =
          await response.json().catch(
            () => null
          );

        if (
          controller.signal.aborted ||
          disposed
        ) {
          return;
        }

        if (response.status === 401) {
          stopped = true;

          setJob(null);
          setScreen({
            kind: "checking",
          });

          router.replace(
            "/login?session=expired"
          );
          return;
        }

        if (!response.ok) {
          stopped = true;

          setStatusError(
            errorMessage(
              data,
              "Couldn't load this job. Please retry."
            )
          );

          return;
        }

        const result = parseJob(
          data,
          jobId
        );

        if (!result) {
          stopped = true;

          setStatusError(
            "Job service returned invalid status data. Please retry."
          );

          return;
        }

        setJob(result);
        setStatusError("");
        setLastChecked(
          new Date().toISOString()
        );

        if (
          TERMINAL_STATES.includes(
            result.status
          )
        ) {
          stopped = true;
        }
      } catch {
        if (
          !controller.signal.aborted &&
          !disposed
        ) {
          stopped = true;

          setStatusError(
            "The job status request failed. Your experiment has not been changed. Retry to check again."
          );
        }
      } finally {
        if (inflight === controller) {
          inflight = null;
        }

        if (!disposed) {
          setLoadingJob(false);
          schedule();
        }
      }
    }

    function onVisibilityChange() {
      if (
        disposed ||
        stopped ||
        !autoRefresh
      ) {
        return;
      }

      if (document.hidden) {
        clearTimer();
      } else if (inflight === null) {
        void checkStatus();
      }
    }

    document.addEventListener(
      "visibilitychange",
      onVisibilityChange
    );

    void checkStatus();

    return () => {
      disposed = true;
      clearTimer();
      inflight?.abort();

      document.removeEventListener(
        "visibilitychange",
        onVisibilityChange
      );
    };
  }, [
    screen.kind,
    jobId,
    autoRefresh,
    requestVersion,
    router,
  ]);

  if (!UUID.test(jobId)) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-[#F7F8FA] px-6 text-center">
        <h1 className="text-[24px] font-semibold">
          Invalid job ID
        </h1>

        <p className="mt-3 text-[13px] text-[#64748B]">
          The link must contain a valid clustering job UUID.
        </p>

        <Link
          href="/dashboard"
          className="caas-button caas-button-primary mt-6"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  if (screen.kind === "checking") {
    return (
      <div
        role="status"
        className="flex min-h-dvh items-center justify-center bg-[#F7F8FA] p-6 text-[14px] text-[#64748B]"
      >
        Verifying your session and loading job status…
      </div>
    );
  }

  if (screen.kind === "error") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-[#F7F8FA] px-6 text-center">
        <h1 className="text-[24px] font-semibold">
          Job tracker unavailable
        </h1>

        <p className="mt-3 max-w-[480px] text-[13px] leading-6 text-[#64748B]">
          {screen.message}
        </p>

        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={() => {
              setScreen({
                kind: "checking",
              });

              setVerificationVersion(
                (version) => version + 1
              );
            }}
            className="caas-button caas-button-secondary"
          >
            Retry verification
          </button>

          <Link
            href="/dashboard"
            className="caas-button caas-button-primary"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  const info =
    job ? STATUS_INFO[job.status] : null;

  const terminal =
    job
      ? TERMINAL_STATES.includes(
          job.status
        )
      : false;

  const summary =
    job?.result_summary ?? null;

  const activity =
    !terminal &&
    autoRefresh &&
    !statusError;

  /*
   * A job ID and an experiment ID are different.
   *
   * Use the experiment ID for File 73's results route.
   * Never invent an ID or display this link for an
   * unfinished job.
   */
  const resultsHref =
    job?.status === "completed" &&
    job.result_available &&
    job.experiment_id !== null &&
    UUID.test(job.experiment_id)
      ? `/dashboard/experiments/results/${job.experiment_id}`
      : null;

  return (
    <WorkspaceShell
      email={screen.email}
      headerAction={
        <Link
          href="/dashboard/experiments"
          className="caas-button caas-button-secondary min-h-9 px-3 py-2 text-[12px]"
        >
          New experiment
        </Link>
      }
    >
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="caas-eyebrow">
            Experiments / Job tracking
          </p>

          <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.055em] sm:text-[39px]">
            Clustering job status.
          </h1>

          <p className="mt-3 max-w-[690px] text-[14px] leading-6 text-[#64748B]">
            Follow real worker updates for this experiment.
            Status checks do not create or restart clustering jobs.
          </p>
        </div>

        <span className="caas-status caas-status-success">
          ● Session verified
        </span>
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_295px]">
        <div className="min-w-0 space-y-5">
          {/* Current job state */}
          <section
            className="caas-card overflow-hidden"
            aria-labelledby="job-status-heading"
          >
            <div className="caas-card-header flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2
                  id="job-status-heading"
                  className="text-[16px] font-semibold"
                >
                  Execution status
                </h2>

                <p className="mt-1 text-[12px] text-[#75849A]">
                  From your authenticated FastAPI job record
                </p>
              </div>

              {job && (
                <span
                  className={`inline-flex rounded-full border px-3 py-1.5 text-[12px] font-semibold capitalize ${info?.pillClass}`}
                >
                  {job.status}
                </span>
              )}
            </div>

            <div className="p-5 sm:p-6">
              {statusError && (
                <div
                  role="alert"
                  className="mb-5 rounded-lg border border-[#F0C8CD] bg-[#FFF4F5] p-4 text-[13px] leading-6 text-[#9A3340]"
                >
                  <p className="font-semibold">
                    Status check unavailable
                  </p>

                  <p className="mt-1">
                    {statusError}
                  </p>
                </div>
              )}

              {!job ? (
                <div
                  className="py-10 text-center"
                  role="status"
                >
                  <span className="text-[14px] font-medium text-[#52647C]">
                    {loadingJob
                      ? "Checking your clustering job…"
                      : "No job status available yet."}
                  </span>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-start gap-4">
                    <span
                      aria-hidden="true"
                      className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border text-[28px] font-semibold ${info?.pillClass}`}
                    >
                      {info?.icon}
                    </span>

                    <div className="min-w-0 flex-1">
                      <h3 className="text-[21px] font-semibold tracking-[-0.035em]">
                        {info?.title}
                      </h3>

                      <p className="mt-2 text-[13px] leading-6 text-[#64748B]">
                        {info?.description}
                      </p>

                      {job.message && (
                        <p className="mt-3 rounded-lg bg-[#F6F8FB] px-3 py-2 text-[12px] leading-5 text-[#53657D]">
                          {job.message}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-7">
                    <Lifecycle status={job.status} />
                  </div>

                  {/* File 74 — New saved-results link */}
                  {resultsHref && (
                    <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[#BCE5D5] bg-[#F0FAF5] p-4 sm:p-5">
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-[#175D48]">
                          Saved results are ready
                        </p>

                        <p className="mt-1 text-[12px] leading-5 text-[#477467]">
                          Explore cluster distribution,
                          centroids, and quality metrics
                          from this experiment.
                        </p>
                      </div>

                      <Link
                        href={resultsHref}
                        className="caas-button caas-button-primary shrink-0"
                      >
                        View saved results →
                      </Link>
                    </div>
                  )}

                  {job.status === "completed" &&
                    job.result_available &&
                    !resultsHref && (
                      <p className="mt-5 rounded-lg border border-[#F0DEA7] bg-[#FFFAED] p-3 text-[12px] leading-5 text-[#805F29]">
                        A saved result was reported,
                        but its experiment ID is unavailable.
                        Locate the experiment in dashboard history.
                      </p>
                    )}

                  {job.status === "queued" && (
                    <p className="mt-5 rounded-lg border border-[#E3E9F3] bg-[#F9FAFD] p-3 text-[12px] leading-5 text-[#65758D]">
                      If this job remains queued in your
                      development environment, start the
                      RQ worker from the project root using{" "}
                      <code className="font-mono">
                        python -m backend.worker
                      </code>.
                    </p>
                  )}

                  {job.status === "completed" &&
                    !job.result_available && (
                      <p className="mt-5 rounded-lg border border-[#F0DEA7] bg-[#FFFAED] p-3 text-[12px] text-[#805F29]">
                        The job is marked completed,
                        but no result summary was returned.
                        Check dashboard history for more details.
                      </p>
                    )}
                </>
              )}
            </div>
          </section>

          {/* Saved metrics */}
          {summary && (
            <section
              aria-labelledby="metrics-heading"
              className="space-y-4"
            >
              <div>
                <h2
                  id="metrics-heading"
                  className="text-[18px] font-semibold tracking-[-0.035em]"
                >
                  Saved clustering summary
                </h2>

                <p className="mt-1 text-[12px] text-[#718097]">
                  Actual values reported by the completed
                  worker; not estimated progress.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Metric
                  label="Samples"
                  value={displayNumber(
                    summary.n_samples
                  )}
                  note="Rows used for clustering"
                />

                <Metric
                  label="Clusters"
                  value={displayNumber(
                    summary.n_clusters
                  )}
                  note="K-Means cluster count"
                />

                <Metric
                  label="SSE / Inertia"
                  value={displayNumber(
                    summary.sse
                  )}
                  note="Sum of squared distances"
                />

                <Metric
                  label="Silhouette score"
                  value={
                    summary.silhouette_score === null
                      ? "—"
                      : summary.silhouette_score.toFixed(4)
                  }
                  note={
                    summary.silhouette_score === null
                      ? "Not available for this run"
                      : "Higher generally means better separation"
                  }
                />

                <Metric
                  label="Iterations"
                  value={displayNumber(
                    summary.iterations
                  )}
                  note={
                    summary.converged
                      ? "Algorithm converged"
                      : "Did not meet convergence tolerance"
                  }
                />

                <Metric
                  label="Worker time"
                  value={`${displayNumber(
                    summary.processing_time_ms
                  )} ms`}
                  note="Reported processing duration"
                />
              </div>
            </section>
          )}

          {/* Job metadata */}
          <section
            className="caas-card p-5 sm:p-6"
            aria-labelledby="metadata-heading"
          >
            <h2
              id="metadata-heading"
              className="text-[16px] font-semibold"
            >
              Job details
            </h2>

            <p className="mt-1 text-[12px] text-[#75849A]">
              Read-only IDs and timestamps returned by FastAPI
            </p>

            <dl className="mt-4">
              <Detail
                label="Job ID"
                value={job?.job_id ?? jobId}
                mono
              />

              <Detail
                label="Experiment ID"
                value={
                  job?.experiment_id ??
                  "Not available"
                }
                mono={Boolean(job?.experiment_id)}
              />

              <Detail
                label="Dataset ID"
                value={
                  job?.dataset_id ??
                  "Not available"
                }
                mono={Boolean(job?.dataset_id)}
              />

              <Detail
                label="Status source"
                value={
                  job?.status_source === "postgresql"
                    ? "PostgreSQL (persisted)"
                    : job?.status_source === "redis"
                      ? "Redis/RQ"
                      : "Not available"
                }
              />

              <Detail
                label="Record updated"
                value={
                  job
                    ? displayTime(job.recorded_at)
                    : "—"
                }
              />

              <Detail
                label="Enqueued"
                value={
                  job
                    ? displayTime(job.enqueued_at)
                    : "—"
                }
              />

              <Detail
                label="Started"
                value={
                  job
                    ? displayTime(job.started_at)
                    : "—"
                }
              />

              <Detail
                label="Finished"
                value={
                  job
                    ? displayTime(job.ended_at)
                    : "—"
                }
              />
            </dl>
          </section>
        </div>

        {/* Monitoring sidebar */}
        <aside className="space-y-5 xl:sticky xl:top-6">
          <section
            className="caas-card p-5 sm:p-6"
            aria-labelledby="tracking-heading"
          >
            <h2
              id="tracking-heading"
              className="text-[16px] font-semibold"
            >
              Status monitoring
            </h2>

            <p className="mt-2 text-[12px] leading-6 text-[#718097]">
              {terminal
                ? "This job has reached a final state. Automatic checking has stopped."
                : activity
                  ? "Checking every 5 seconds while this tab is visible."
                  : "Automatic checking is paused or awaiting a manual retry."}
            </p>

            <div className="mt-4 rounded-lg bg-[#F5F7FA] p-3">
              <p className="text-[11px] text-[#8491A3]">
                Last checked
              </p>

              <p className="mt-1 text-[12px] font-semibold text-[#35465E]">
                {lastChecked
                  ? displayTime(lastChecked)
                  : "Not checked yet"}
              </p>

              {loadingJob && (
                <p
                  className="mt-2 text-[11px] text-[#305BE8]"
                  role="status"
                >
                  Checking now…
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() =>
                setRequestVersion(
                  (version) => version + 1
                )
              }
              disabled={loadingJob}
              className="caas-button caas-button-primary mt-4 w-full"
            >
              {loadingJob
                ? "Checking…"
                : "Check status now"}
            </button>

            {!terminal && (
              <label className="mt-4 flex cursor-pointer items-center gap-2 text-[12px] text-[#5D6E86]">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(
                    event: ChangeEvent<HTMLInputElement>
                  ) =>
                    setAutoRefresh(
                      event.target.checked
                    )
                  }
                  className="h-4 w-4 accent-[#305BE8]"
                />

                Auto-refresh while active
              </label>
            )}

            <p className="mt-4 text-[11px] leading-5 text-[#8996A7]">
              No artificial progress percentage is shown.
              Status depends on the worker&apos;s latest update.
            </p>
          </section>

          <section className="caas-card p-5 sm:p-6">
            <h2 className="text-[15px] font-semibold">
              Next steps
            </h2>

            <p className="mt-2 text-[12px] leading-6 text-[#718097]">
              {resultsHref
                ? "Your saved clustering charts and centroid analysis are ready. Use View saved results in the execution card to open them."
                : job?.status === "completed"
                  ? "No result link is available for this job yet. Check dashboard history for the saved experiment."
                  : "You can return to the dashboard or configure another clustering experiment."}
            </p>

            <div className="mt-4 grid gap-2">
              <Link
                href="/dashboard"
                className="caas-button caas-button-secondary w-full"
              >
                View dashboard history
              </Link>

              <Link
                href="/dashboard/experiments"
                className="caas-button caas-button-secondary w-full"
              >
                Configure another experiment
              </Link>
            </div>
          </section>
        </aside>
      </div>
    </WorkspaceShell>
  );
}

/**
 * Next.js 16 Cache Components:
 *
 * useParams() must remain inside a Suspense boundary
 * so the dynamic job route can prerender successfully.
 */
export default function JobTrackingPage() {
  return (
    <Suspense
      fallback={
        <div
          role="status"
          className="flex min-h-dvh items-center justify-center bg-[#F7F8FA] px-6 text-[14px] text-[#64748B]"
        >
          Loading clustering job tracker…
        </div>
      }
    >
      <JobTrackingContent />
    </Suspense>
  );
}
