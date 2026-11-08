/**
 * File 75 — Private experiment history and saved-results navigation.
 *
 * Authenticates server-side, then reads the owner-scoped FastAPI history list.
 * Pagination is real (10 records per request), not a frontend-only slice.
 * No browser-accessible JWT, stored labels, or CSV rows are included here.
 *
 * Next.js 16 Cache Components: cookies() and uncached fetch calls are inside
 * a component wrapped by Suspense. The dashboard layout persists around it.
 */

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import WorkspaceShell from "@/components/workspace-shell";

export const metadata: Metadata = {
  title: "Experiment History | CaaS",
  description: "Browse your saved clustering experiments.",
  robots: { index: false, follow: false },
};

const COOKIE_NAME = "caas_access_token";
const LOCAL_API = "http://127.0.0.1:8000";
const PAGE_SIZE = 10;
const MAX_PAGE = 10000;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = {
  searchParams: Promise<{ page?: string | string[] }>;
};

type Experiment = {
  experiment_id: string;
  dataset_id: string;
  name: string | null;
  algorithm: string;
  model_version: string | null;
  n_clusters: number;
  created_at: string;
  result_available: boolean;
};

type History = {
  total: number;
  limit: number;
  offset: number;
  items: Experiment[];
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

function isDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value))
  );
}

function positiveInt(
  value: unknown,
  minimum = 0
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
  );
}

function pageNumber(
  value: string | string[] | undefined
): number {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,4}$/.test(value)
  ) {
    return 1;
  }

  const page = Number(value);

  return page >= 1 && page <= MAX_PAGE ? page : 1;
}

function apiOrigin(): URL | null {
  const configured =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development"
      ? LOCAL_API
      : "");

  if (!configured) return null;

  try {
    const url = new URL(configured);

    return url.protocol === "https:" ||
      url.protocol === "http:"
      ? url
      : null;
  } catch {
    return null;
  }
}

async function backendGet(
  base: URL,
  path: string,
  token: string
) {
  try {
    return await fetch(new URL(path, base), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return null;
  }
}

async function jsonIfOk(
  response: Response | null
): Promise<unknown> {
  if (response?.status !== 200) return null;

  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readEmail(raw: unknown): string | null {
  if (
    !isRecord(raw) ||
    typeof raw.email !== "string" ||
    !raw.email.trim()
  ) {
    return null;
  }

  if (raw.is_active === false) return null;

  return raw.email;
}

function readHistory(
  raw: unknown,
  expectedOffset: number
): History | null {
  if (
    !isRecord(raw) ||
    !positiveInt(raw.total) ||
    raw.limit !== PAGE_SIZE ||
    raw.offset !== expectedOffset ||
    !Array.isArray(raw.items) ||
    raw.items.length > PAGE_SIZE
  ) {
    return null;
  }

  const items: Experiment[] = [];
  const seen = new Set<string>();

  for (const item of raw.items) {
    if (
      !isRecord(item) ||
      typeof item.experiment_id !== "string" ||
      !UUID.test(item.experiment_id) ||
      typeof item.dataset_id !== "string" ||
      !UUID.test(item.dataset_id) ||
      (item.name !== null &&
        typeof item.name !== "string") ||
      typeof item.algorithm !== "string" ||
      (item.model_version !== null &&
        typeof item.model_version !== "string") ||
      !positiveInt(item.n_clusters, 2) ||
      !isDate(item.created_at) ||
      typeof item.result_available !== "boolean"
    ) {
      return null;
    }

    const key = item.experiment_id.toLowerCase();

    if (seen.has(key)) return null;
    seen.add(key);

    items.push({
      experiment_id: item.experiment_id,
      dataset_id: item.dataset_id,
      name: item.name,
      algorithm: item.algorithm,
      model_version: item.model_version,
      n_clusters: item.n_clusters,
      created_at: item.created_at,
      result_available: item.result_available,
    });
  }

  return {
    total: raw.total,
    limit: raw.limit,
    offset: raw.offset,
    items,
  };
}

function displayDate(iso: string): string {
  return (
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "UTC",
    }).format(new Date(iso)) + " UTC"
  );
}

function Stat({
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
      <p className="text-[12px] text-[#6C7C91]">
        {label}
      </p>

      <p className="mt-3 text-[30px] font-semibold tracking-[-0.05em] text-[#172235]">
        {value}
      </p>

      <p className="mt-2 text-[11px] leading-5 text-[#8290A3]">
        {note}
      </p>
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading experiment history"
      className="space-y-5"
    >
      <div className="h-3 w-32 animate-pulse rounded bg-[#DCE4F0]" />

      <div className="h-10 w-72 max-w-full animate-pulse rounded-lg bg-[#E2E8F2]" />

      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-xl border border-[#E2E8F1] bg-white"
          />
        ))}
      </div>

      <div className="h-64 animate-pulse rounded-xl border border-[#E2E8F1] bg-white" />
    </div>
  );
}

function ServiceError({
  message,
}: {
  message: string;
}) {
  return (
    <div className="caas-card mx-auto max-w-[650px] p-8 text-center">
      <h1 className="text-[22px] font-semibold tracking-[-0.04em] text-[#172235]">
        Experiment history unavailable
      </h1>

      <p className="mt-3 text-[13px] leading-6 text-[#64748B]">
        {message}
      </p>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link
          href="/dashboard/experiments"
          className="caas-button caas-button-primary"
        >
          Configure experiment
        </Link>

        <Link
          href="/dashboard"
          className="caas-button caas-button-secondary"
        >
          Dashboard
        </Link>
      </div>
    </div>
  );
}

async function PrivateHistory({
  searchParams,
}: Props) {
  const query = await searchParams;
  const page = pageNumber(query.page);
  const offset = (page - 1) * PAGE_SIZE;

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

  const base = apiOrigin();

  if (!base) {
    return (
      <ServiceError message="The FastAPI service URL is not configured." />
    );
  }

  // Verify the session before requesting any owner-scoped history.
  const identityResponse = await backendGet(
    base,
    "/api/v1/auth/me",
    token
  );

  if (
    identityResponse?.status === 401 ||
    identityResponse?.status === 403
  ) {
    redirect("/login?session=expired");
  }

  const email = readEmail(
    await jsonIfOk(identityResponse)
  );

  if (!email) {
    return (
      <ServiceError message="Could not verify your session. Check that FastAPI is running." />
    );
  }

  const historyResponse = await backendGet(
    base,
    `/api/v1/experiments/history?limit=${PAGE_SIZE}&offset=${offset}`,
    token
  );

  if (
    historyResponse?.status === 401 ||
    historyResponse?.status === 403
  ) {
    redirect("/login?session=expired");
  }

  const history = readHistory(
    await jsonIfOk(historyResponse),
    offset
  );

  if (!history) {
    return (
      <WorkspaceShell email={email}>
        <ServiceError
          message="Could not load your saved experiments. Your records have not been changed. Refresh the page after checking the API."
        />
      </WorkspaceShell>
    );
  }

  const totalPages = Math.max(
    1,
    Math.ceil(history.total / PAGE_SIZE)
  );

  if (page > totalPages) {
    redirect(
      `/dashboard/experiments/history?page=${totalPages}`
    );
  }

  const savedOnPage = history.items.filter(
    (item) => item.result_available
  ).length;

  const first =
    history.items.length === 0
      ? 0
      : offset + 1;

  const last = offset + history.items.length;

  return (
    <WorkspaceShell email={email}>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="caas-eyebrow">
            Experiments / History
          </p>

          <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.055em] text-[#172235] sm:text-[39px]">
            Experiment history.
          </h1>

          <p className="mt-3 max-w-[760px] text-[14px] leading-6 text-[#64748B]">
            Revisit your previous clustering runs and
            open their saved results. Only experiments
            belonging to your signed-in account
            appear here.
          </p>
        </div>

        <Link
          href="/dashboard/experiments"
          className="caas-button caas-button-primary"
        >
          New experiment →
        </Link>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat
          label="Total experiments"
          value={String(history.total)}
          note="Your account's recorded experiments"
        />

        <Stat
          label="Saved results on page"
          value={String(savedOnPage)}
          note="Of the experiments displayed below"
        />

        <Stat
          label="Records shown"
          value={String(history.items.length)}
          note={`Page ${page} of ${totalPages} · ${PAGE_SIZE} per page`}
        />
      </div>

      <section
        className="caas-card min-w-0 overflow-hidden"
        aria-labelledby="history-table-heading"
      >
        <div className="caas-card-header flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2
              id="history-table-heading"
              className="text-[16px] font-semibold text-[#172235]"
            >
              Previous experiments
            </h2>

            <p className="mt-1 text-[12px] text-[#728097]">
              {history.total === 0
                ? "No experiments created yet"
                : `Showing ${first}–${last} of ${history.total} experiments`}
            </p>
          </div>

          <span className="rounded-md bg-[#F2F5FA] px-3 py-2 font-mono text-[11px] text-[#66768D]">
            NEWEST FIRST
          </span>
        </div>

        {history.items.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="text-[16px] font-semibold text-[#22334A]">
              No experiments yet
            </p>

            <p className="mt-2 text-[13px] text-[#718097]">
              Create your first K-Means experiment to
              start building your history.
            </p>

            <Link
              href="/dashboard/experiments"
              className="caas-button caas-button-primary mt-6"
            >
              Configure clustering →
            </Link>
          </div>
        ) : (
          <div className="caas-table-scroll">
            <table className="caas-table">
              <caption className="sr-only">
                Your saved experiment history,
                newest first
              </caption>

              <thead>
                <tr>
                  <th scope="col">Experiment</th>
                  <th scope="col">Dataset ID</th>
                  <th scope="col">Clusters</th>
                  <th scope="col">Created</th>
                  <th scope="col">Result</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>

              <tbody>
                {history.items.map((item) => (
                  <tr key={item.experiment_id}>
                    <td>
                      <span
                        className="block max-w-[210px] truncate font-semibold text-[#273A53]"
                        title={
                          item.name ||
                          "K-Means clustering"
                        }
                      >
                        {item.name ||
                          "K-Means clustering"}
                      </span>

                      <span
                        className="mt-1 block font-mono text-[10px] text-[#7E8EA5]"
                        title={item.experiment_id}
                      >
                        {item.experiment_id.slice(0, 8)}…
                      </span>
                    </td>

                    <td
                      className="font-mono text-[11px] text-[#64748B]"
                      title={item.dataset_id}
                    >
                      {item.dataset_id.slice(0, 8)}…
                    </td>

                    <td>{item.n_clusters}</td>

                    <td className="whitespace-nowrap text-[12px]">
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
                      {item.result_available ? (
                        <Link
                          href={`/dashboard/experiments/results/${item.experiment_id}`}
                          className="inline-flex items-center rounded-md px-2 py-2 text-[12px] font-semibold text-[#305BE8] hover:bg-[#F0F4FF] hover:underline focus-visible:outline-2 focus-visible:outline-[#305BE8]"
                          aria-label={`View saved results for experiment ${item.experiment_id}`}
                        >
                          View results →
                        </Link>
                      ) : (
                        <span className="text-[12px] text-[#8996A8]">
                          Not available
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {history.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E7EBF2] px-5 py-4 sm:px-6">
            <p className="text-[12px] text-[#6C7D94]">
              Page{" "}
              <span className="font-semibold text-[#263951]">
                {page}
              </span>{" "}
              of {totalPages}
            </p>

            <nav
              aria-label="Experiment history pages"
              className="flex items-center gap-2"
            >
              {page > 1 ? (
                <Link
                  href={`/dashboard/experiments/history?page=${page - 1}`}
                  className="caas-button caas-button-secondary min-h-9 px-3 text-[12px]"
                >
                  ← Previous
                </Link>
              ) : (
                <span
                  className="caas-button caas-button-secondary min-h-9 cursor-not-allowed px-3 text-[12px] opacity-45"
                  aria-disabled="true"
                >
                  ← Previous
                </span>
              )}

              {page < totalPages ? (
                <Link
                  href={`/dashboard/experiments/history?page=${page + 1}`}
                  className="caas-button caas-button-secondary min-h-9 px-3 text-[12px]"
                >
                  Next →
                </Link>
              ) : (
                <span
                  className="caas-button caas-button-secondary min-h-9 cursor-not-allowed px-3 text-[12px] opacity-45"
                  aria-disabled="true"
                >
                  Next →
                </span>
              )}
            </nav>
          </div>
        )}
      </section>

      <p className="mt-5 text-[12px] leading-6 text-[#7E8DA2]">
        History contains stored experiment metadata and
        whether a result exists. It does not report
        current RQ job status, so “No saved result”
        does not necessarily mean a job failed.
        Dataset IDs are shown because the history API
        does not include dataset filenames.
      </p>
    </WorkspaceShell>
  );
}

export default function ExperimentHistoryPage({
  searchParams,
}: Props) {
  return (
    <Suspense fallback={<HistorySkeleton />}>
      <PrivateHistory searchParams={searchParams} />
    </Suspense>
  );
}
