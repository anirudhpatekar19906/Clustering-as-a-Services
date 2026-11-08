"use client";

/**
 * File 71 — K-Means configuration with direct job-tracking navigation.
 *
 * GET  /api/auth/session             → verify current user
 * GET  /api/datasets                 → owner-scoped dataset metadata
 * POST /api/experiments/preflight    → metadata-only validation (no job)
 * POST /api/experiments              → create real experiment + RQ job
 * /dashboard/experiments/jobs/{jobId} → track accepted jobs (File 70)
 *
 * Authentication and ownership are enforced by the API routes and FastAPI;
 * this client-side session check provides a friendly navigation experience.
 * No JWT is exposed to browser JavaScript.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import WorkspaceShell from "@/components/workspace-shell";

type LoadState = "loading" | "ready" | "error";
type SelectionMode = "automatic" | "explicit";
type Scaling = "standardize" | "minmax" | "none";
type MissingValues = "median" | "mean" | "zero" | "error";
type Initialization = "kmeans++" | "random";

type Dataset = {
  id: string;
  original_filename: string;
  row_count: number | null;
  column_count: number | null;
  column_names: string[];
  file_size_bytes: number | null;
};

type ExperimentRequest = {
  dataset_id: string;
  n_clusters: number;
  features: string[] | null;
  scaling: Scaling;
  missing_values: MissingValues;
  init: Initialization;
  max_iter: number;
  tolerance: number;
  n_init: number;
  random_state: number;
  include_silhouette: boolean;
  silhouette_sample_size: number;
};

type Validation = {
  key: string;
  status: "checking" | "passed" | "failed";
  message: string;
  rows?: number;
  scope?: string;
};

type Receipt = {
  experiment_id: string;
  job_id: string;
  dataset_id: string;
};

type Unconfirmed = {
  message: string;
  experiment_id?: string;
  job_id?: string;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function integerField(
  input: string,
  minimum: number,
  maximum: number
): number | null {
  if (!/^\d+$/.test(input.trim())) return null;

  const number = Number(input);

  return Number.isSafeInteger(number) &&
    number >= minimum &&
    number <= maximum
    ? number
    : null;
}

function fileSize(bytes: number | null): string {
  if (bytes === null) return "Not available";

  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function backendError(
  body: unknown,
  fallback: string
): string {
  if (!isRecord(body)) return fallback;

  return typeof body.message === "string" &&
    body.message.trim()
    ? body.message.slice(0, 350)
    : fallback;
}

function parseDatasets(
  body: unknown
): Dataset[] | null {
  if (
    !isRecord(body) ||
    body.success !== true ||
    !Array.isArray(body.items)
  ) {
    return null;
  }

  const seen = new Set<string>();
  const datasets: Dataset[] = [];

  for (const item of body.items) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !UUID.test(item.id) ||
      typeof item.original_filename !== "string" ||
      !Array.isArray(item.column_names) ||
      !item.column_names.every(
        (name: unknown) => typeof name === "string"
      )
    ) {
      return null;
    }

    if (seen.has(item.id.toLowerCase())) {
      return null;
    }

    seen.add(item.id.toLowerCase());

    datasets.push({
      id: item.id,
      original_filename: item.original_filename,
      row_count:
        typeof item.row_count === "number"
          ? item.row_count
          : null,
      column_count:
        typeof item.column_count === "number"
          ? item.column_count
          : null,
      column_names: item.column_names as string[],
      file_size_bytes:
        typeof item.file_size_bytes === "number"
          ? item.file_size_bytes
          : null,
    });
  }

  return datasets;
}

function SectionHeading({
  number,
  title,
  subtitle,
  id,
}: {
  number: string;
  title: string;
  subtitle: string;
  id: string;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-[#E6EBF2] px-5 py-5 sm:px-6">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#EDF2FF] text-[12px] font-bold text-[#305BE8]">
        {number}
      </span>

      <div>
        <h2
          id={id}
          className="text-[16px] font-semibold tracking-[-0.03em] text-[#172235]"
        >
          {title}
        </h2>

        <p className="mt-1 text-[12px] leading-5 text-[#718097]">
          {subtitle}
        </p>
      </div>
    </div>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step = "1",
  disabled,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max?: number;
  step?: string;
  disabled: boolean;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="caas-label">{label}</span>

      <input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="caas-input"
      />

      {hint && (
        <span className="mt-1.5 block text-[11px] leading-4 text-[#8090A5]">
          {hint}
        </span>
      )}
    </label>
  );
}

export default function ExperimentsPage() {
  const router = useRouter();

  const [loadState, setLoadState] =
    useState<LoadState>("loading");

  const [loadError, setLoadError] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const [email, setEmail] = useState("");

  const [datasets, setDatasets] =
    useState<Dataset[]>([]);

  const [datasetId, setDatasetId] = useState("");

  const [selectionMode, setSelectionMode] =
    useState<SelectionMode>("automatic");

  const [features, setFeatures] =
    useState<string[]>([]);

  const [clustersInput, setClustersInput] =
    useState("2");

  const [scaling, setScaling] =
    useState<Scaling>("standardize");

  const [missingValues, setMissingValues] =
    useState<MissingValues>("median");

  const [init, setInit] =
    useState<Initialization>("kmeans++");

  const [maxIterations, setMaxIterations] =
    useState("300");

  const [initializations, setInitializations] =
    useState("3");

  const [toleranceInput, setToleranceInput] =
    useState("0.0001");

  const [randomSeed, setRandomSeed] =
    useState("42");

  const [silhouette, setSilhouette] =
    useState(true);

  const [sampleSizeInput, setSampleSizeInput] =
    useState("1500");

  const [validation, setValidation] =
    useState<Validation | null>(null);

  const [submitting, setSubmitting] =
    useState(false);

  const submittingLock = useRef(false);

  const [submitError, setSubmitError] =
    useState("");

  const [receipt, setReceipt] =
    useState<Receipt | null>(null);

  const [unconfirmed, setUnconfirmed] =
    useState<Unconfirmed | null>(null);

  // Both APIs enforce auth. This initial check provides
  // the login navigation experience.
  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const session = await fetch(
          "/api/auth/session",
          {
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
          }
        );

        if (session.status === 401) {
          router.replace("/login?session=expired");
          return;
        }

        const sessionBody: unknown =
          await session.json().catch(() => null);

        if (
          !session.ok ||
          !isRecord(sessionBody) ||
          sessionBody.authenticated !== true ||
          !isRecord(sessionBody.user) ||
          typeof sessionBody.user.email !== "string"
        ) {
          throw new Error(
            "Couldn't verify your session. Check that FastAPI is running."
          );
        }

        const response = await fetch(
          "/api/datasets",
          {
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
          }
        );

        if (response.status === 401) {
          router.replace("/login?session=expired");
          return;
        }

        const body: unknown =
          await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(
            backendError(
              body,
              "Couldn't load your datasets."
            )
          );
        }

        const found = parseDatasets(body);

        if (!found) {
          throw new Error(
            "The dataset service returned invalid metadata."
          );
        }

        if (controller.signal.aborted) return;

        setEmail(sessionBody.user.email);
        setDatasets(found);
        setDatasetId(found[0]?.id ?? "");
        setLoadState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;

        setLoadError(
          error instanceof Error
            ? error.message
            : "Workspace unavailable."
        );

        setLoadState("error");
      }
    }

    void load();

    return () => controller.abort();
  }, [router, retryCount]);

  const dataset =
    datasets.find(
      (item) => item.id === datasetId
    ) ?? null;

  const maximumClusters = Math.min(
    50,
    dataset?.row_count ?? 50
  );

  /*
   * A preflight pass only permits submission of the
   * exact configuration that was validated.
   */
  const configuration = useMemo(
    (): {
      body: ExperimentRequest | null;
      error: string;
    } => {
      if (!dataset) {
        return {
          body: null,
          error: "Choose a dataset.",
        };
      }

      if (
        dataset.row_count !== null &&
        dataset.row_count < 2
      ) {
        return {
          body: null,
          error:
            "This dataset needs at least two data rows.",
        };
      }

      const clusters = integerField(
        clustersInput,
        2,
        maximumClusters
      );

      if (clusters === null) {
        return {
          body: null,
          error:
            `Choose 2–${maximumClusters} clusters for this dataset.`,
        };
      }

      if (selectionMode === "explicit") {
        if (features.length === 0) {
          return {
            body: null,
            error:
              "Select at least one feature column.",
          };
        }

        if (
          features.some(
            (name) =>
              !dataset.column_names.includes(name)
          )
        ) {
          return {
            body: null,
            error:
              "Selected columns no longer match this dataset.",
          };
        }
      }

      const maxIter = integerField(
        maxIterations,
        1,
        1000
      );

      const nInit = integerField(
        initializations,
        1,
        20
      );

      const seed = integerField(
        randomSeed,
        0,
        4294967295
      );

      const sampleSize = integerField(
        sampleSizeInput,
        2,
        1500
      );

      const tolerance =
        Number(toleranceInput);

      if (maxIter === null) {
        return {
          body: null,
          error:
            "Maximum iterations must be between 1 and 1000.",
        };
      }

      if (nInit === null) {
        return {
          body: null,
          error:
            "Initializations must be between 1 and 20.",
        };
      }

      if (seed === null) {
        return {
          body: null,
          error:
            "Random seed must be an integer between 0 and 4294967295.",
        };
      }

      if (
        toleranceInput.trim() === "" ||
        !Number.isFinite(tolerance) ||
        tolerance < 0
      ) {
        return {
          body: null,
          error:
            "Tolerance must be a finite number of zero or greater.",
        };
      }

      if (sampleSize === null) {
        return {
          body: null,
          error:
            "Silhouette sample size must be between 2 and 1500.",
        };
      }

      if (
        silhouette &&
        sampleSize < clusters
      ) {
        return {
          body: null,
          error:
            "Silhouette sample size must be at least the number of clusters.",
        };
      }

      return {
        error: "",
        body: {
          dataset_id: dataset.id,
          n_clusters: clusters,
          features:
            selectionMode === "explicit"
              ? [...features].sort()
              : null,
          scaling,
          missing_values: missingValues,
          init,
          max_iter: maxIter,
          tolerance,
          n_init: nInit,
          random_state: seed,
          include_silhouette: silhouette,
          silhouette_sample_size: sampleSize,
        },
      };
    },
    [
      dataset,
      clustersInput,
      maximumClusters,
      selectionMode,
      features,
      scaling,
      missingValues,
      init,
      maxIterations,
      initializations,
      randomSeed,
      toleranceInput,
      silhouette,
      sampleSizeInput,
    ]
  );

  const configurationKey = configuration.body
    ? JSON.stringify(configuration.body)
    : "";

  const currentValidation =
    validation?.key === configurationKey &&
    configurationKey
      ? validation
      : null;

  const validated =
    currentValidation?.status === "passed";

  const locked =
    submitting ||
    receipt !== null ||
    unconfirmed !== null;

  function changeDataset(id: string) {
    if (locked) return;

    setDatasetId(id);
    setFeatures([]);
    setSelectionMode("automatic");
    setSubmitError("");
  }

  function toggleFeature(name: string) {
    if (locked) return;

    setFeatures((current) =>
      current.includes(name)
        ? current.filter(
            (item) => item !== name
          )
        : [...current, name]
    );
  }

  async function runPreflight() {
    if (
      !configuration.body ||
      locked ||
      currentValidation?.status === "checking"
    ) {
      return;
    }

    const body = configuration.body;
    const key = configurationKey;

    setSubmitError("");

    setValidation({
      key,
      status: "checking",
      message: "Checking dataset metadata…",
    });

    try {
      const response = await fetch(
        "/api/experiments/preflight",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          credentials: "same-origin",
          cache: "no-store",
        }
      );

      const result: unknown =
        await response.json().catch(() => null);

      if (response.status === 401) {
        router.replace("/login?session=expired");
        return;
      }

      if (
        response.ok &&
        isRecord(result) &&
        result.success === true &&
        result.validation_scope === "metadata_only" &&
        result.dataset_id === body.dataset_id &&
        result.n_clusters === body.n_clusters &&
        typeof result.dataset_rows === "number"
      ) {
        setValidation({
          key,
          status: "passed",
          message:
            "Ownership and dataset metadata checks passed. CSV numeric values are checked when the job runs.",
          rows: result.dataset_rows,
          scope: "metadata_only",
        });
      } else {
        setValidation({
          key,
          status: "failed",
          message: backendError(
            result,
            "Preflight failed. Review the configuration and try again."
          ),
        });
      }
    } catch {
      setValidation({
        key,
        status: "failed",
        message:
          "Couldn't contact preflight. Check the API and try again.",
      });
    }
  }

  async function submitExperiment(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (
      !configuration.body ||
      !validated ||
      locked ||
      submittingLock.current
    ) {
      return;
    }

    const body = configuration.body;

    submittingLock.current = true;
    setSubmitting(true);
    setSubmitError("");

    try {
      const response = await fetch(
        "/api/experiments",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify(body),
        }
      );

      const result: unknown =
        await response.json().catch(() => null);

      if (response.status === 401) {
        router.replace("/login?session=expired");
        return;
      }

      if (
        response.status === 202 &&
        isRecord(result) &&
        result.success === true &&
        result.dataset_id === body.dataset_id &&
        typeof result.experiment_id === "string" &&
        UUID.test(result.experiment_id) &&
        typeof result.job_id === "string" &&
        UUID.test(result.job_id)
      ) {
        setReceipt({
          experiment_id: result.experiment_id,
          job_id: result.job_id,
          dataset_id: result.dataset_id,
        });
      } else if (
        isRecord(result) &&
        result.submission_unconfirmed === true
      ) {
        setUnconfirmed({
          message: backendError(
            result,
            "Submission could not be confirmed. Check experiment history before retrying."
          ),
          experiment_id:
            typeof result.experiment_id === "string"
              ? result.experiment_id
              : undefined,
          job_id:
            typeof result.job_id === "string"
              ? result.job_id
              : undefined,
        });
      } else {
        setSubmitError(
          backendError(
            result,
            "The experiment could not be submitted."
          )
        );

        // Run preflight again before another attempt.
        setValidation(null);
      }
    } catch {
      // A lost connection does not prove that FastAPI
      // failed to create the experiment.
      setUnconfirmed({
        message:
          "The request outcome is unknown. Check experiment history before creating another job.",
      });
    } finally {
      submittingLock.current = false;
      setSubmitting(false);
    }
  }

  if (loadState === "loading") {
    return (
      <div
        className="flex min-h-dvh items-center justify-center bg-[#F7F8FA] p-6 text-[14px] text-[#64748B]"
        role="status"
      >
        Verifying your session and loading datasets…
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-[#F7F8FA] px-6 text-center">
        <h1 className="text-[24px] font-semibold tracking-[-0.04em]">
          Experiment workspace unavailable
        </h1>

        <p className="mt-3 max-w-[460px] text-[13px] leading-6 text-[#64748B]">
          {loadError}
        </p>

        <button
          type="button"
          className="caas-button caas-button-primary mt-6"
          onClick={() => {
            setLoadState("loading");
            setRetryCount(
              (count) => count + 1
            );
          }}
        >
          Retry loading
        </button>
      </div>
    );
  }

  return (
    <WorkspaceShell email={email}>
      <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="caas-eyebrow">
            Experiments / K-Means
          </p>

          <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.055em] sm:text-[39px]">
            Configure clustering.
          </h1>

          <p className="mt-3 max-w-[740px] text-[14px] leading-6 text-[#64748B]">
            Choose one of your uploaded datasets, select features and
            K-Means settings, validate the configuration, then submit
            a real clustering job.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 self-start">
          <Link
            href="/dashboard/datasets"
            className="caas-button caas-button-secondary min-h-9 px-3 py-2 text-[12px]"
          >
            View datasets
          </Link>

          <span className="caas-status caas-status-success">
            ● Session verified
          </span>
        </div>
      </div>

      {datasets.length === 0 ? (
        <section className="caas-card px-6 py-14 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[#EDF2FF] text-xl text-[#305BE8]">
            ▤
          </div>

          <h2 className="mt-5 text-[19px] font-semibold">
            Upload a dataset first
          </h2>

          <p className="mx-auto mt-2 max-w-[430px] text-[13px] leading-6 text-[#718097]">
            Your account has no CSV datasets yet. Upload one to enable
            K-Means configuration.
          </p>

          <Link
            href="/dashboard/datasets/upload"
            className="caas-button caas-button-primary mt-6"
          >
            Upload CSV →
          </Link>
        </section>
      ) : (
        <form onSubmit={submitExperiment} noValidate>
          <fieldset
            disabled={locked}
            className="min-w-0 disabled:opacity-90"
          >
            <legend className="sr-only">
              Configure K-Means clustering
            </legend>

            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_310px]">
              <div className="min-w-0 space-y-5">
                {/* Dataset selection */}
                <section
                  className="caas-card overflow-hidden"
                  aria-labelledby="dataset-step"
                >
                  <SectionHeading
                    id="dataset-step"
                    number="01"
                    title="Choose a dataset"
                    subtitle="Only datasets uploaded to your account are available."
                  />

                  <div className="p-5 sm:p-6">
                    <label
                      htmlFor="experiment-dataset"
                      className="caas-label"
                    >
                      Dataset
                    </label>

                    <select
                      id="experiment-dataset"
                      className="caas-input"
                      value={datasetId}
                      onChange={(event) =>
                        changeDataset(event.target.value)
                      }
                    >
                      {datasets.map((item) => (
                        <option
                          key={item.id}
                          value={item.id}
                        >
                          {item.original_filename} ·{" "}
                          {item.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>

                    {dataset && (
                      <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg border border-[#E7EBF2] bg-[#F8FAFD] p-4 sm:grid-cols-4">
                        <div>
                          <p className="text-[11px] text-[#8491A3]">
                            Rows
                          </p>
                          <p className="mt-1 text-[14px] font-semibold">
                            {dataset.row_count ?? "—"}
                          </p>
                        </div>

                        <div>
                          <p className="text-[11px] text-[#8491A3]">
                            Columns
                          </p>
                          <p className="mt-1 text-[14px] font-semibold">
                            {dataset.column_count ?? "—"}
                          </p>
                        </div>

                        <div>
                          <p className="text-[11px] text-[#8491A3]">
                            File size
                          </p>
                          <p className="mt-1 text-[14px] font-semibold">
                            {fileSize(dataset.file_size_bytes)}
                          </p>
                        </div>

                        <div>
                          <p className="text-[11px] text-[#8491A3]">
                            Dataset ID
                          </p>
                          <p className="mt-1 text-[12px] font-semibold">
                            {dataset.id.slice(0, 8)}…
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                {/* Feature selection */}
                <section
                  className="caas-card overflow-hidden"
                  aria-labelledby="features-step"
                >
                  <SectionHeading
                    id="features-step"
                    number="02"
                    title="Select feature columns"
                    subtitle="Column names come from CSV metadata; numeric types are checked when the job runs."
                  />

                  <div className="p-5 sm:p-6">
                    <p className="caas-label">
                      Feature selection
                    </p>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label
                        className={`flex cursor-pointer gap-3 rounded-lg border p-4 ${
                          selectionMode === "automatic"
                            ? "border-[#AABCFB] bg-[#F1F5FF]"
                            : "border-[#E3E8EF]"
                        }`}
                      >
                        <input
                          type="radio"
                          name="feature-mode"
                          checked={
                            selectionMode === "automatic"
                          }
                          onChange={() =>
                            setSelectionMode("automatic")
                          }
                          className="mt-1 accent-[#305BE8]"
                        />

                        <span>
                          <span className="block text-[13px] font-semibold">
                            Automatic
                          </span>

                          <span className="mt-1 block text-[11px] leading-5 text-[#6F7F95]">
                            Let the worker find numeric columns.
                          </span>
                        </span>
                      </label>

                      <label
                        className={`flex cursor-pointer gap-3 rounded-lg border p-4 ${
                          selectionMode === "explicit"
                            ? "border-[#AABCFB] bg-[#F1F5FF]"
                            : "border-[#E3E8EF]"
                        }`}
                      >
                        <input
                          type="radio"
                          name="feature-mode"
                          checked={
                            selectionMode === "explicit"
                          }
                          onChange={() =>
                            setSelectionMode("explicit")
                          }
                          className="mt-1 accent-[#305BE8]"
                        />

                        <span>
                          <span className="block text-[13px] font-semibold">
                            Choose columns
                          </span>

                          <span className="mt-1 block text-[11px] leading-5 text-[#6F7F95]">
                            Select columns you expect to be numeric.
                          </span>
                        </span>
                      </label>
                    </div>

                    {selectionMode === "explicit" && (
                      <div className="mt-4 rounded-lg border border-[#E3E8EF] p-4">
                        <p className="mb-3 text-[12px] font-semibold text-[#42536D]">
                          Available columns (
                          {dataset?.column_names.length ?? 0})
                        </p>

                        {!dataset?.column_names.length ? (
                          <p className="text-[12px] text-[#718097]">
                            Column metadata is unavailable for this dataset.
                          </p>
                        ) : (
                          <div className="grid gap-3 sm:grid-cols-2">
                            {dataset.column_names.map(
                              (name, index) => (
                                <label
                                  key={`${name}-${index}`}
                                  className="flex min-w-0 items-center gap-2 text-[13px] text-[#34445B]"
                                >
                                  <input
                                    type="checkbox"
                                    checked={features.includes(name)}
                                    onChange={() =>
                                      toggleFeature(name)
                                    }
                                    className="h-4 w-4 accent-[#305BE8]"
                                  />

                                  <span className="break-all">
                                    {name}
                                  </span>
                                </label>
                              )
                            )}
                          </div>
                        )}

                        <p className="mt-3 text-[11px] text-[#8290A4]">
                          {features.length} selected · Select at least one
                        </p>
                      </div>
                    )}
                  </div>
                </section>

                {/* K-Means settings */}
                <section
                  className="caas-card overflow-hidden"
                  aria-labelledby="settings-step"
                >
                  <SectionHeading
                    id="settings-step"
                    number="03"
                    title="K-Means settings"
                    subtitle="Start with the defaults, or customize preprocessing and training."
                  />

                  <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
                    <div>
                      <NumberInput
                        label="Number of clusters (K)"
                        value={clustersInput}
                        onChange={setClustersInput}
                        min={2}
                        max={maximumClusters}
                        disabled={locked}
                        hint={`From 2 to ${maximumClusters} for the selected dataset.`}
                      />
                    </div>

                    <label className="block">
                      <span className="caas-label">
                        Feature scaling
                      </span>

                      <select
                        value={scaling}
                        onChange={(event) =>
                          setScaling(
                            event.target.value as Scaling
                          )
                        }
                        className="caas-input"
                      >
                        <option value="standardize">
                          Standardize (recommended)
                        </option>

                        <option value="minmax">
                          Min-max (0 to 1)
                        </option>

                        <option value="none">
                          No scaling
                        </option>
                      </select>

                      <span className="mt-1.5 block text-[11px] text-[#8090A5]">
                        Useful when numeric features have different units.
                      </span>
                    </label>

                    <label className="block">
                      <span className="caas-label">
                        Missing values
                      </span>

                      <select
                        value={missingValues}
                        onChange={(event) =>
                          setMissingValues(
                            event.target.value as MissingValues
                          )
                        }
                        className="caas-input"
                      >
                        <option value="median">
                          Fill with median (recommended)
                        </option>

                        <option value="mean">
                          Fill with mean
                        </option>

                        <option value="zero">
                          Fill with zero
                        </option>

                        <option value="error">
                          Reject missing values
                        </option>
                      </select>
                    </label>

                    <label className="block">
                      <span className="caas-label">
                        Initialization
                      </span>

                      <select
                        value={init}
                        onChange={(event) =>
                          setInit(
                            event.target.value as Initialization
                          )
                        }
                        className="caas-input"
                      >
                        <option value="kmeans++">
                          K-Means++ (recommended)
                        </option>

                        <option value="random">
                          Random
                        </option>
                      </select>
                    </label>
                  </div>

                  <details className="border-t border-[#E6EBF2] px-5 py-4 sm:px-6">
                    <summary className="cursor-pointer text-[13px] font-semibold text-[#305BE8]">
                      Advanced settings
                    </summary>

                    <div className="mt-5 grid gap-5 sm:grid-cols-2">
                      <NumberInput
                        label="Maximum iterations"
                        value={maxIterations}
                        onChange={setMaxIterations}
                        min={1}
                        max={1000}
                        disabled={locked}
                      />

                      <NumberInput
                        label="Initialization runs (n_init)"
                        value={initializations}
                        onChange={setInitializations}
                        min={1}
                        max={20}
                        disabled={locked}
                      />

                      <NumberInput
                        label="Convergence tolerance"
                        value={toleranceInput}
                        onChange={setToleranceInput}
                        min={0}
                        step="any"
                        disabled={locked}
                      />

                      <NumberInput
                        label="Random seed"
                        value={randomSeed}
                        onChange={setRandomSeed}
                        min={0}
                        max={4294967295}
                        disabled={locked}
                      />

                      <label className="flex items-start gap-3 rounded-lg border border-[#E5EAF2] bg-[#FBFCFE] p-3 sm:col-span-2">
                        <input
                          type="checkbox"
                          checked={silhouette}
                          onChange={(event) =>
                            setSilhouette(event.target.checked)
                          }
                          className="mt-1 h-4 w-4 accent-[#305BE8]"
                        />

                        <span>
                          <span className="block text-[13px] font-semibold">
                            Calculate silhouette score
                          </span>

                          <span className="mt-1 block text-[11px] leading-5 text-[#7B8A9F]">
                            Adds a cluster-separation metric when feasible.
                          </span>
                        </span>
                      </label>

                      {silhouette && (
                        <NumberInput
                          label="Silhouette sample size"
                          value={sampleSizeInput}
                          onChange={setSampleSizeInput}
                          min={2}
                          max={1500}
                          disabled={locked}
                          hint="2–1500; at least the number of clusters."
                        />
                      )}
                    </div>
                  </details>
                </section>
              </div>

              {/* Review and actions */}
              <div className="space-y-5 xl:sticky xl:top-6">
                <section
                  className="caas-card p-5 sm:p-6"
                  aria-labelledby="review-heading"
                >
                  <h2
                    id="review-heading"
                    className="text-[16px] font-semibold tracking-[-0.03em]"
                  >
                    Review &amp; run
                  </h2>

                  <p className="mt-2 text-[12px] leading-5 text-[#718097]">
                    Preflight validates metadata without starting a job.
                  </p>

                  <dl className="mt-5 space-y-3 border-y border-[#E5EAF1] py-4 text-[12px]">
                    <div className="flex justify-between gap-3">
                      <dt className="text-[#76869A]">
                        Algorithm
                      </dt>
                      <dd className="font-semibold">
                        Custom K-Means
                      </dd>
                    </div>

                    <div className="flex justify-between gap-3">
                      <dt className="text-[#76869A]">
                        Dataset
                      </dt>
                      <dd
                        className="max-w-[145px] truncate text-right font-semibold"
                        title={dataset?.original_filename}
                      >
                        {dataset?.original_filename ?? "—"}
                      </dd>
                    </div>

                    <div className="flex justify-between gap-3">
                      <dt className="text-[#76869A]">
                        Clusters
                      </dt>
                      <dd className="font-semibold">
                        {configuration.body?.n_clusters ?? "—"}
                      </dd>
                    </div>

                    <div className="flex justify-between gap-3">
                      <dt className="text-[#76869A]">
                        Features
                      </dt>
                      <dd className="text-right font-semibold">
                        {selectionMode === "automatic"
                          ? "Auto numeric"
                          : `${features.length} selected`}
                      </dd>
                    </div>

                    <div className="flex justify-between gap-3">
                      <dt className="text-[#76869A]">
                        Scaling
                      </dt>
                      <dd className="font-semibold">
                        {scaling}
                      </dd>
                    </div>
                  </dl>

                  {configuration.error && (
                    <p
                      role="alert"
                      className="mt-4 rounded-lg border border-[#F1CBD0] bg-[#FFF3F4] px-3 py-3 text-[12px] leading-5 text-[#A33545]"
                    >
                      {configuration.error}
                    </p>
                  )}

                  {currentValidation && (
                    <div
                      role="status"
                      aria-live="polite"
                      className={`mt-4 rounded-lg border p-3 text-[12px] leading-5 ${
                        currentValidation.status === "passed"
                          ? "border-[#BDE6D6] bg-[#F0FAF5] text-[#1D7057]"
                          : currentValidation.status === "failed"
                            ? "border-[#F1CBD0] bg-[#FFF3F4] text-[#A33545]"
                            : "border-[#CAD8FC] bg-[#F2F5FF] text-[#385ABC]"
                      }`}
                    >
                      <p className="font-semibold">
                        {currentValidation.status === "passed"
                          ? "✓ Preflight passed"
                          : currentValidation.status === "failed"
                            ? "Preflight failed"
                            : "Validating…"}
                      </p>

                      <p className="mt-1">
                        {currentValidation.message}
                      </p>
                    </div>
                  )}

                  {!currentValidation &&
                    !configuration.error && (
                      <p className="mt-4 rounded-lg bg-[#F4F6FA] px-3 py-3 text-[12px] text-[#61718A]">
                        Not validated yet. Run preflight before creating a job.
                      </p>
                    )}

                  {submitError && (
                    <p
                      role="alert"
                      className="mt-3 rounded-lg border border-[#F1CBD0] bg-[#FFF3F4] p-3 text-[12px] leading-5 text-[#A33545]"
                    >
                      {submitError}
                    </p>
                  )}

                  {!receipt && !unconfirmed && (
                    <div className="mt-5 space-y-3">
                      <button
                        type="button"
                        onClick={() =>
                          void runPreflight()
                        }
                        disabled={
                          !configuration.body ||
                          locked ||
                          currentValidation?.status === "checking"
                        }
                        className="caas-button caas-button-secondary w-full"
                      >
                        {currentValidation?.status === "checking"
                          ? "Validating…"
                          : validated
                            ? "Validate again"
                            : "Validate configuration"}
                      </button>

                      <button
                        type="submit"
                        disabled={
                          !validated ||
                          locked ||
                          currentValidation?.status === "checking"
                        }
                        className="caas-button caas-button-primary w-full"
                      >
                        {submitting
                          ? "Submitting experiment…"
                          : "Run clustering →"}
                      </button>
                    </div>
                  )}

                  <p className="mt-4 text-[11px] leading-5 text-[#8895A8]">
                    Submission creates a real experiment and queues a
                    background job. Preflight does not guarantee numerical
                    execution will succeed.
                  </p>
                </section>

                <div className="rounded-xl border border-[#DFE7F3] bg-[#F0F4FB] p-5">
                  <p className="text-[12px] font-semibold text-[#344E7C]">
                    How it works
                  </p>

                  <ol className="mt-3 space-y-3 text-[12px] leading-5 text-[#61718C]">
                    <li>
                      <span className="font-bold text-[#305BE8]">
                        1.
                      </span>{" "}
                      Select dataset &amp; features
                    </li>

                    <li>
                      <span className="font-bold text-[#305BE8]">
                        2.
                      </span>{" "}
                      Validate stored metadata
                    </li>

                    <li>
                      <span className="font-bold text-[#305BE8]">
                        3.
                      </span>{" "}
                      Submit K-Means to Redis/RQ
                    </li>

                    <li>
                      <span className="font-bold text-[#305BE8]">
                        4.
                      </span>{" "}
                      Track job status on the live tracker
                    </li>
                  </ol>
                </div>
              </div>
            </div>
          </fieldset>

          {/* Success — direct link to File 70 */}
          {receipt && (
            <section
              role="status"
              aria-live="polite"
              className="mt-6 rounded-xl border border-[#B6DEC9] bg-[#F0FAF5] p-6"
            >
              <p className="text-[13px] font-semibold text-[#15745B]">
                ✓ Experiment submitted successfully
              </p>

              <h2 className="mt-2 text-[22px] font-semibold tracking-[-0.04em] text-[#174D3E]">
                Your clustering job was accepted.
              </h2>

              <p className="mt-2 text-[13px] leading-6 text-[#487366]">
                FastAPI accepted your experiment (HTTP 202).
                Choose Track job to check its current state;
                it may be queued, running, or already completed.
              </p>

              <dl className="mt-4 space-y-2 text-[12px] text-[#385F55]">
                <div>
                  <dt className="font-semibold">
                    Experiment ID
                  </dt>
                  <dd className="mt-1 break-all font-mono">
                    {receipt.experiment_id}
                  </dd>
                </div>

                <div>
                  <dt className="font-semibold">
                    Job ID
                  </dt>
                  <dd className="mt-1 break-all font-mono">
                    {receipt.job_id}
                  </dd>
                </div>
              </dl>

              <div className="mt-5 flex flex-wrap gap-3">
                <Link
                  href={`/dashboard/experiments/jobs/${receipt.job_id}`}
                  className="caas-button caas-button-primary"
                >
                  Track job →
                </Link>

                <Link
                  href="/dashboard"
                  className="caas-button caas-button-secondary"
                >
                  View dashboard
                </Link>

                <button
                  type="button"
                  className="caas-button caas-button-secondary"
                  onClick={() => {
                    setReceipt(null);
                    setValidation(null);
                  }}
                >
                  Configure another experiment
                </button>
              </div>
            </section>
          )}

          {/* Unconfirmed submission — do not automatically retry */}
          {unconfirmed && (
            <section
              role="alert"
              className="mt-6 rounded-xl border border-[#F1D5A1] bg-[#FFF8E8] p-6 text-[#805B20]"
            >
              <h2 className="text-[18px] font-semibold">
                Submission status is unconfirmed
              </h2>

              <p className="mt-2 text-[13px] leading-6">
                {unconfirmed.message}
              </p>

              <p className="mt-2 text-[12px] leading-5">
                Do not immediately submit again: the experiment may
                already exist. Check recent experiment history on the
                dashboard first.
              </p>

              {unconfirmed.experiment_id && (
                <p className="mt-3 break-all font-mono text-[11px]">
                  Experiment: {unconfirmed.experiment_id}
                </p>
              )}

              {unconfirmed.job_id && (
                <p className="mt-1 break-all font-mono text-[11px]">
                  Job: {unconfirmed.job_id}
                </p>
              )}

              <div className="mt-5 flex flex-wrap gap-3">
                {unconfirmed.job_id &&
                  UUID.test(unconfirmed.job_id) && (
                    <Link
                      href={`/dashboard/experiments/jobs/${unconfirmed.job_id}`}
                      className="caas-button caas-button-secondary"
                    >
                      Check known job ID
                    </Link>
                  )}

                <Link
                  href="/dashboard"
                  className="caas-button caas-button-secondary"
                >
                  Check dashboard history
                </Link>
              </div>
            </section>
          )}
        </form>
      )}
    </WorkspaceShell>
  );
}
