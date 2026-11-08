/**
 * File 78 — Protected CaaS dashboard with actionable experiment history.
 *
 * - Verifies the account with FastAPI before requesting private resources.
 * - Renders actual dataset/experiment counts from owner-scoped APIs.
 * - Links saved experiments to their results and the full history.
 * - Keeps non-saved entries read-only; no invented job statuses.
 * - Next.js 16: request-time work stays inside Suspense.
 * - Compatible with the persistent dashboard layout.
 */

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import WorkspaceShell from "@/components/workspace-shell";

export const metadata: Metadata = {
  title: "Dashboard | CaaS",
  description: "Your private CaaS clustering workspace.",
  robots: { index: false, follow: false },
};

const COOKIE_NAME = "caas_access_token";
const DEV_API_URL = "http://127.0.0.1:8000";
const RECENT_LIMIT = 5;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HISTORY_PATH = "/dashboard/experiments/history";
const EXPERIMENT_PATH = "/dashboard/experiments";

type CurrentUser = {
  id: string;
  email: string;
};

type ExperimentItem = {
  experiment_id: string;
  name: string | null;
  algorithm: string;
  n_clusters: number;
  created_at: string;
  result_available: boolean;
};

type ExperimentHistory = {
  total: number;
  items: ExperimentItem[];
};

type DatasetList = {
  items: unknown[];
  total?: number;
};

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function apiBaseUrl(): URL | null {
  const configured =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development"
      ? DEV_API_URL
      : "");

  if (!configured) return null;

  try {
    const url = new URL(configured);

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

async function backendGet(
  base: URL,
  path: string,
  token: string
): Promise<Response | null> {
  try {
    return await fetch(new URL(path, base), {
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
    return null;
  }
}

async function safeJson(
  response: Response | null
): Promise<unknown> {
  if (response?.status !== 200) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readUser(
  raw: unknown
): CurrentUser | null {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !UUID.test(raw.id) ||
    typeof raw.email !== "string" ||
    !raw.email.trim() ||
    raw.is_active === false
  ) {
    return null;
  }

  return {
    id: raw.id,
    email: raw.email,
  };
}

function readDatasets(
  raw: unknown
): DatasetList | null {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.items)
  ) {
    return null;
  }

  const total = raw.total;

  return {
    items: raw.items,

    ...(typeof total === "number" &&
    Number.isSafeInteger(total) &&
    total >= 0
      ? { total }
      : {}),
  };
}

function readHistory(
  raw: unknown
): ExperimentHistory | null {
  if (
    !isRecord(raw) ||
    typeof raw.total !== "number" ||
    !Number.isSafeInteger(raw.total) ||
    raw.total < 0 ||
    !Array.isArray(raw.items) ||
    raw.items.length > RECENT_LIMIT
  ) {
    return null;
  }

  const items: ExperimentItem[] = [];
  const seen = new Set<string>();

  for (const entry of raw.items) {
    if (
      !isRecord(entry) ||
      typeof entry.experiment_id !== "string" ||
      !UUID.test(entry.experiment_id) ||
      typeof entry.algorithm !== "string" ||
      typeof entry.n_clusters !== "number" ||
      !Number.isSafeInteger(entry.n_clusters) ||
      entry.n_clusters < 2 ||
      typeof entry.created_at !== "string" ||
      !Number.isFinite(
        Date.parse(entry.created_at)
      ) ||
      typeof entry.result_available !== "boolean" ||
      (entry.name !== null &&
        typeof entry.name !== "string")
    ) {
      return null;
    }

    const key =
      entry.experiment_id.toLowerCase();

    if (seen.has(key)) {
      return null;
    }

    seen.add(key);

    items.push({
      experiment_id: entry.experiment_id,
      name: entry.name,
      algorithm: entry.algorithm,
      n_clusters: entry.n_clusters,
      created_at: entry.created_at,
      result_available: entry.result_available,
    });
  }

  return {
    total: raw.total,
    items,
  };
}

function displayDate(
  value: string
): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function Statistic({
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
      <p className="text-[12px] font-medium text-[#6B7A90]">
        {label}
      </p>

      <p className="mt-3 text-[33px] font-semibold leading-none tracking-[-0.05em] text-[#172235]">
        {value}
      </p>

      <p className="mt-3 text-[11px] leading-5 text-[#8491A3]">
        {note}
      </p>
    </div>
  );
}

function ServiceUnavailable({
  message,
}: {
  message?: string;
}) {
  return (
    <div className="mx-auto max-w-[640px] py-16 text-center">
      <span
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[#EDF2FF] text-xl font-semibold text-[#305BE8]"
        aria-hidden="true"
      >
        !
      </span>

      <h1 className="mt-5 text-2xl font-semibold tracking-[-0.04em]">
        Workspace temporarily unavailable
      </h1>

      <p className="mt-3 text-[14px] leading-6 text-[#68788F]">
        {message ||
          "We couldn't verify your session with the CaaS API. Your saved data hasn't been changed. Check that FastAPI is running, then refresh this page."}
      </p>

      <Link
        href="/login"
        className="caas-button caas-button-secondary mt-7"
      >
        Return to sign in
      </Link>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading your workspace"
      className="space-y-6"
    >
      <div className="h-3 w-36 animate-pulse rounded bg-[#DCE4F0]" />

      <div className="h-10 w-80 max-w-full animate-pulse rounded-lg bg-[#E2E8F2]" />

      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((n) => (
          <div
            key={n}
            className="h-36 animate-pulse rounded-xl border border-[#E2E8F1] bg-white"
          />
        ))}
      </div>

      <div className="h-64 animate-pulse rounded-xl border border-[#E2E8F1] bg-white" />
    </div>
  );
}

async function PrivateDashboard() {
  const token = (await cookies()).get(
    COOKIE_NAME
  )?.value;

  if (
    !token ||
    token.length < 16 ||
    token.length > 8192 ||
    /\s/.test(token)
  ) {
    redirect("/login");
  }

  const base = apiBaseUrl();

  if (!base) {
    return (
      <ServiceUnavailable message="The FastAPI service URL is not configured." />
    );
  }

  // Verify identity before requesting private data.
  const verification = await backendGet(
    base,
    "/api/v1/auth/me",
    token
  );

  if (
    verification?.status === 401 ||
    verification?.status === 403
  ) {
    redirect("/login?session=expired");
  }

  const user = readUser(
    await safeJson(verification)
  );

  if (!user) {
    return <ServiceUnavailable />;
  }

  // Request owner-scoped resources only after verification.
  const [
    datasetsResponse,
    historyResponse,
  ] = await Promise.all([
    backendGet(
      base,
      "/api/v1/datasets",
      token
    ),

    backendGet(
      base,
      `/api/v1/experiments/history?limit=${RECENT_LIMIT}&offset=0`,
      token
    ),
  ]);

  if (
    [401, 403].includes(
      datasetsResponse?.status ?? 0
    ) ||
    [401, 403].includes(
      historyResponse?.status ?? 0
    )
  ) {
    redirect("/login?session=expired");
  }

  const datasets = readDatasets(
    await safeJson(datasetsResponse)
  );

  const history = readHistory(
    await safeJson(historyResponse)
  );

  const datasetCount =
    datasets?.total ??
    datasets?.items.length;

  const savedAmongRecent =
    history?.items.filter(
      (item) => item.result_available
    ).length;

  return (
    <WorkspaceShell email={user.email}>
      {/* Dashboard heading */}
      <div className="mb-9 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="caas-eyebrow">
            Workspace overview
          </p>

          <h1 className="mt-2 text-[31px] font-semibold tracking-[-0.055em] sm:text-[38px]">
            Welcome to your workspace.
          </h1>

          <p className="mt-3 max-w-[660px] text-[14px] leading-6 text-[#64748B]">
            Your datasets and clustering experiments,
            together in one place. The figures below
            come from your account—not sample data.
          </p>
        </div>

        <span className="caas-status caas-status-success">
          ● Session verified
        </span>
      </div>

      {/* Account statistics */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Statistic
          label="Datasets"
          value={
            datasetCount === undefined
              ? "—"
              : String(datasetCount)
          }
          note={
            !datasets
              ? "Summary unavailable"
              : datasets.total === undefined
                ? "Datasets returned by the API"
                : "Your uploaded datasets"
          }
        />

        <Statistic
          label="Experiments"
          value={
            history
              ? String(history.total)
              : "—"
          }
          note={
            history
              ? "Your recorded clustering experiments"
              : "Summary unavailable"
          }
        />

        <Statistic
          label="Saved results"
          value={
            savedAmongRecent === undefined
              ? "—"
              : String(savedAmongRecent)
          }
          note={`With saved results among your ${RECENT_LIMIT} latest experiments`}
        />
      </div>

      <div className="mt-7 grid gap-5 xl:grid-cols-[minmax(0,1fr)_285px]">
        {/* Recent experiments */}
        <section
          className="caas-card min-w-0 overflow-hidden"
          aria-labelledby="recent-experiments-heading"
        >
          <div className="caas-card-header flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="recent-experiments-heading"
                className="text-[15px] font-semibold tracking-[-0.02em]"
              >
                Recent experiments
              </h2>

              <p className="mt-1 text-[12px] text-[#728097]">
                Open saved clustering results
                from your latest runs
              </p>
            </div>

            {/* File 78: Direct history link */}
            <Link
              href={HISTORY_PATH}
              className="rounded-lg border border-[#D6DFEF] bg-white px-3 py-2 text-[12px] font-semibold text-[#305BE8] transition-colors hover:bg-[#F0F4FF] focus-visible:outline-2 focus-visible:outline-[#305BE8]"
            >
              View all history →
            </Link>
          </div>

          {!history ? (
            <div className="px-6 py-12 text-[13px] text-[#718097]">
              <p>
                Experiment history is temporarily unavailable.
              </p>

              <Link
                href={HISTORY_PATH}
                className="mt-3 inline-block font-semibold text-[#305BE8] hover:underline"
              >
                Open experiment history →
              </Link>
            </div>
          ) : history.items.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <p className="text-[15px] font-semibold">
                No experiments yet
              </p>

              <p className="mt-2 text-[13px] text-[#718097]">
                Your first clustering run will appear
                here after you submit it.
              </p>

              <Link
                href={EXPERIMENT_PATH}
                className="caas-button caas-button-primary mt-5"
              >
                Create your first experiment →
              </Link>
            </div>
          ) : (
            <div className="caas-table-scroll">
              <table className="caas-table">
                <caption className="sr-only">
                  Your five most recent experiments
                  with links to saved results
                </caption>

                <thead>
                  <tr>
                    <th scope="col">Experiment</th>
                    <th scope="col">Clusters</th>
                    <th scope="col">Created</th>
                    <th scope="col">Result</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>

                <tbody>
                  {history.items.map((item) => {
                    const href =
                      item.result_available
                        ? `/dashboard/experiments/results/${item.experiment_id}`
                        : null;

                    const name =
                      item.name ||
                      "K-Means clustering";

                    return (
                      <tr key={item.experiment_id}>
                        <td>
                          {href ? (
                            <Link
                              href={href}
                              className="block max-w-[205px] truncate font-semibold text-[#2B3B52] hover:text-[#305BE8] hover:underline"
                              title={`Open results: ${name}`}
                            >
                              {name}
                            </Link>
                          ) : (
                            <span
                              className="block max-w-[205px] truncate font-semibold text-[#2B3B52]"
                              title={name}
                            >
                              {name}
                            </span>
                          )}

                          <span
                            className="mt-1 block font-mono text-[10px] text-[#8491A5]"
                            title={item.experiment_id}
                          >
                            {item.experiment_id.slice(
                              0,
                              8
                            )}
                            …
                          </span>
                        </td>

                        <td>
                          {item.n_clusters}
                        </td>

                        <td className="whitespace-nowrap">
                          {displayDate(
                            item.created_at
                          )}
                        </td>

                        <td>
                          <span
                            className={
                              item.result_available
                                ? "caas-status caas-status-success whitespace-nowrap"
                                : "caas-status caas-status-info whitespace-nowrap"
                            }
                          >
                            {item.result_available
                              ? "Result saved"
                              : "No saved result"}
                          </span>
                        </td>

                        <td className="whitespace-nowrap">
                          {href ? (
                            <Link
                              href={href}
                              className="inline-flex rounded-md px-2 py-2 text-[12px] font-semibold text-[#305BE8] hover:bg-[#F0F4FF] hover:underline focus-visible:outline-2 focus-visible:outline-[#305BE8]"
                              aria-label={`View saved results for experiment ${item.experiment_id}`}
                            >
                              View results →
                            </Link>
                          ) : (
                            <span className="text-[12px] text-[#8B98A9]">
                              Not available
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {history &&
            history.total > RECENT_LIMIT && (
              <div className="border-t border-[#E6EAF1] px-5 py-4 text-right">
                <Link
                  href={HISTORY_PATH}
                  className="text-[12px] font-semibold text-[#305BE8] hover:underline"
                >
                  Browse all {history.total} experiments →
                </Link>
              </div>
            )}
        </section>

        {/* Next actions */}
        <aside
          className="caas-card h-fit p-6"
          aria-labelledby="next-step-heading"
        >
          <span
            aria-hidden="true"
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-[#EDF2FF] text-[21px] text-[#305BE8]"
          >
            ◇
          </span>

          <h2
            id="next-step-heading"
            className="mt-5 text-[16px] font-semibold tracking-[-0.03em]"
          >
            Your next experiment
          </h2>

          <p className="mt-3 text-[13px] leading-6 text-[#718097]">
            Your dataset library, CSV uploader,
            K-Means configuration, and saved results
            are ready. Start another run or explore
            previous experiments.
          </p>

          <div className="mt-5 grid gap-2">
            <Link
              href={EXPERIMENT_PATH}
              className="caas-button caas-button-primary w-full"
            >
              New experiment →
            </Link>

            <Link
              href={HISTORY_PATH}
              className="caas-button caas-button-secondary w-full"
            >
              Experiment history
            </Link>

            <Link
              href="/dashboard/datasets"
              className="caas-button caas-button-secondary w-full"
            >
              Dataset library
            </Link>
          </div>

          <div className="mt-5 border-t border-[#E6EAF0] pt-4">
            <p className="text-[11px] font-semibold text-[#52627B]">
              How to explore results
            </p>

            <p className="mt-2 text-[12px] leading-5 text-[#718097]">
              Open a saved run to compare cluster
              sizes, centroids, and K-Means
              quality metrics.
            </p>
          </div>
        </aside>
      </div>

      <p className="mt-6 text-[11px] leading-5 text-[#8B98A9]">
        Saved results are shown only when the backend
        confirms that an experiment has a stored result.
        A missing result does not establish whether the
        associated job is queued, running, or failed.
      </p>
    </WorkspaceShell>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <PrivateDashboard />
    </Suspense>
  );
}
