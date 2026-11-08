/**
 * File 89 — CaaS Results Library with true saved-only pagination.
 *
 * - Authenticates the server-side request with the HttpOnly session cookie.
 * - Verifies the signed-in account with FastAPI before reading private data.
 * - Reads GET /api/v1/saved-results?limit=20&offset=... (Files 87–88).
 * - Uses the database's saved-result count, not total experiment count.
 * - Displays only persisted analyses; never loads full result JSON here.
 * - Keeps Next.js 16 request-time work inside a Suspense boundary.
 */

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import WorkspaceShell from "@/components/workspace-shell";

export const metadata: Metadata = {
  title: "Saved Results | CaaS",
  description: "Explore your saved clustering analyses.",
  robots: { index: false, follow: false },
};

const COOKIE_NAME = "caas_access_token";
const DEVELOPMENT_API = "http://127.0.0.1:8000";
const PAGE_SIZE = 20;
const MAX_PAGE = 10000;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = {
  searchParams: Promise<{
    page?: string | string[];
  }>;
};

type Experiment = {
  experiment_id: string;
  dataset_id: string;
  name: string | null;
  algorithm: string;
  n_clusters: number;
  model_version: string | null;
  created_at: string;
  result_available: boolean;
};

type SavedResultsPageData = {
  total: number;
  items: Experiment[];
};

/* =====================================================
   Validation
   ===================================================== */

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function nonnegativeInteger(
  value: unknown
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function getPage(
  raw: string | string[] | undefined
): number {
  if (
    typeof raw !== "string" ||
    !/^[1-9]\d{0,4}$/.test(raw)
  ) {
    return 1;
  }

  const page = Number(raw);

  return page <= MAX_PAGE ? page : 1;
}

/* =====================================================
   FastAPI connection
   ===================================================== */

function getApiBase(): URL | null {
  const configured =
    process.env.CAAS_API_BASE_URL ||
    (
      process.env.NODE_ENV === "development"
        ? DEVELOPMENT_API
        : ""
    );

  if (!configured) {
    return null;
  }

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
    return await fetch(
      new URL(path, base),
      {
        method: "GET",

        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },

        cache: "no-store",
        redirect: "manual",

        signal: AbortSignal.timeout(10000),
      }
    );
  } catch {
    return null;
  }
}

async function successfulJson(
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

/* =====================================================
   Authenticated user
   ===================================================== */

function readEmail(
  raw: unknown
): string | null {
  if (
    !isRecord(raw) ||
    typeof raw.email !== "string" ||
    !raw.email.trim()
  ) {
    return null;
  }

  if (raw.is_active === false) {
    return null;
  }

  return raw.email;
}

/* =====================================================
   File 89 — Parse saved-results-only response
   ===================================================== */

function readSavedResults(
  raw: unknown,
  offset: number
): SavedResultsPageData | null {
  if (
    !isRecord(raw) ||
    !nonnegativeInteger(raw.total) ||
    raw.limit !== PAGE_SIZE ||
    raw.offset !== offset ||
    !Array.isArray(raw.items) ||
    raw.items.length > PAGE_SIZE
  ) {
    return null;
  }

  const items: Experiment[] = [];
  const seen = new Set<string>();

  for (const value of raw.items) {
    if (
      !isRecord(value) ||
      typeof value.experiment_id !== "string" ||
      !UUID.test(value.experiment_id) ||
      typeof value.dataset_id !== "string" ||
      !UUID.test(value.dataset_id) ||
      (
        value.name !== null &&
        typeof value.name !== "string"
      ) ||
      typeof value.algorithm !== "string" ||
      !nonnegativeInteger(value.n_clusters) ||
      value.n_clusters < 2 ||
      (
        value.model_version !== null &&
        typeof value.model_version !== "string"
      ) ||
      typeof value.created_at !== "string" ||
      !Number.isFinite(
        Date.parse(value.created_at)
      ) ||
      value.result_available !== true
    ) {
      return null;
    }

    const id =
      value.experiment_id.toLowerCase();

    if (seen.has(id)) {
      return null;
    }

    seen.add(id);

    items.push({
      experiment_id: value.experiment_id,
      dataset_id: value.dataset_id,
      name: value.name,
      algorithm: value.algorithm,
      n_clusters: value.n_clusters,
      model_version: value.model_version,
      created_at: value.created_at,
      result_available: value.result_available,
    });
  }

  // The backend paginates persisted results only.
  // Reject unsaved entries and inconsistent totals.
  if (
    items.length > raw.total ||
    (
      raw.total === 0 &&
      items.length !== 0
    )
  ) {
    return null;
  }

  return {
    total: raw.total,
    items,
  };
}

/* =====================================================
   Date formatting
   ===================================================== */

function displayDate(
  raw: string
): string {
  return (
    new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "UTC",
    }).format(new Date(raw)) + " UTC"
  );
}

/* =====================================================
   Saved result card
   ===================================================== */

function ResultCard({
  item,
}: {
  item: Experiment;
}) {
  return (
    <article className="caas-card flex min-w-0 flex-col overflow-hidden">

      <div className="flex flex-1 flex-col p-5 sm:p-6">

        <div className="flex flex-wrap items-center justify-between gap-2">

          <span className="caas-status caas-status-success">
            ● Result saved
          </span>

          <span className="text-[11px] text-[#8290A4]">
            {item.algorithm === "custom_kmeans"
              ? "Custom K-Means"
              : item.algorithm}
          </span>

        </div>

        <h2 className="mt-5 break-words text-[19px] font-semibold tracking-[-0.035em] text-[#172235]">
          {item.name?.trim() || "K-Means clustering"}
        </h2>

        <p
          className="mt-1 font-mono text-[11px] text-[#8794A7]"
          title={item.experiment_id}
        >
          Run {item.experiment_id.slice(0, 8)}…
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3 rounded-xl bg-[#F5F7FB] p-4">

          <div>
            <p className="text-[11px] text-[#74849A]">
              Clusters
            </p>

            <p className="mt-1 text-[24px] font-semibold tracking-[-0.05em] text-[#172235]">
              {item.n_clusters}
            </p>
          </div>

          <div className="min-w-0">
            <p className="text-[11px] text-[#74849A]">
              Dataset
            </p>

            <p
              className="mt-2 truncate font-mono text-[12px] font-medium text-[#334660]"
              title={item.dataset_id}
            >
              {item.dataset_id.slice(0, 8)}…
            </p>
          </div>

        </div>

        <p className="mt-5 text-[12px] text-[#6E7F96]">
          Saved experiment · {displayDate(item.created_at)}
        </p>

        {item.model_version && (
          <p className="mt-1 text-[11px] text-[#8491A4]">
            Model version: {item.model_version}
          </p>
        )}

      </div>

      <div className="border-t border-[#E7EBF2] bg-[#FCFDFE] px-5 py-4 sm:px-6">

        <Link
          href={`/dashboard/experiments/results/${item.experiment_id}`}
          className="caas-button caas-button-primary w-full"
          aria-label={`Open saved clustering results for experiment ${item.experiment_id}`}
        >
          Open analysis →
        </Link>

      </div>

    </article>
  );
}

/* =====================================================
   Loading skeleton
   ===================================================== */

function LoadingResults() {
  return (
    <div
      role="status"
      aria-label="Loading saved results"
      className="space-y-6"
    >

      <div className="h-3 w-36 animate-pulse rounded bg-[#DCE4F0]" />

      <div className="h-10 w-64 animate-pulse rounded-lg bg-[#E2E8F2]" />

      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1, 2, 3].map(
          (index) => (
            <div
              key={index}
              className="h-64 animate-pulse rounded-xl border border-[#E2E8F1] bg-white"
            />
          )
        )}
      </div>

      <span className="sr-only">
        Fetching saved experiment metadata…
      </span>

    </div>
  );
}

/* =====================================================
   API unavailable message
   ===================================================== */

function ServiceUnavailable({
  message,
}: {
  message: string;
}) {
  return (
    <section className="caas-card mx-auto max-w-[660px] p-8 text-center">

      <h1 className="text-[22px] font-semibold tracking-[-0.04em] text-[#172235]">
        Results library unavailable
      </h1>

      <p className="mt-3 text-[13px] leading-6 text-[#68788F]">
        {message}
      </p>

      <div className="mt-6 flex flex-wrap justify-center gap-3">

        <Link
          href="/dashboard"
          className="caas-button caas-button-secondary"
        >
          Dashboard
        </Link>

        <Link
          href="/dashboard/experiments/history"
          className="caas-button caas-button-primary"
        >
          Experiment history
        </Link>

      </div>

    </section>
  );
}

/* =====================================================
   Protected Results Library
   ===================================================== */

async function PrivateResultsLibrary({
  searchParams,
}: Props) {
  const query = await searchParams;

  const page = getPage(query.page);

  const offset =
    (page - 1) * PAGE_SIZE;

  const token = (await cookies()).get(
    COOKIE_NAME
  )?.value;

  /* Step 1 — Require an authenticated session */

  if (
    !token ||
    token.length < 16 ||
    token.length > 8192 ||
    /\s/.test(token)
  ) {
    redirect("/login");
  }

  /* Step 2 — Locate FastAPI */

  const base = getApiBase();

  if (!base) {
    return (
      <ServiceUnavailable
        message="FastAPI is not configured for this environment. Set CAAS_API_BASE_URL on the Next.js server."
      />
    );
  }

  /* Step 3 — Verify the current user */

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
    await successfulJson(identityResponse)
  );

  if (!email) {
    return (
      <ServiceUnavailable
        message="Couldn't verify your session. Make sure FastAPI is running, then try again."
      />
    );
  }

  /* ===================================================
     File 89 — Query saved results only
     =================================================== */

  const savedResponse = await backendGet(
    base,

    `/api/v1/saved-results?limit=${PAGE_SIZE}&offset=${offset}`,

    token
  );

  if (
    savedResponse?.status === 401 ||
    savedResponse?.status === 403
  ) {
    redirect("/login?session=expired");
  }

  const savedPage = readSavedResults(
    await successfulJson(savedResponse),
    offset
  );

  if (!savedPage) {
    return (
      <WorkspaceShell email={email}>

        <ServiceUnavailable
          message="The saved results list could not be loaded. Your analyses have not been changed; check FastAPI and refresh."
        />

      </WorkspaceShell>
    );
  }

  /* ===================================================
     Accurate saved-only pagination
     =================================================== */

  const totalPages = Math.max(
    1,
    Math.ceil(savedPage.total / PAGE_SIZE)
  );

  if (page > totalPages) {
    redirect(
      `/dashboard/results?page=${totalPages}`
    );
  }

  const first =
    savedPage.items.length > 0
      ? offset + 1
      : 0;

  const last =
    offset + savedPage.items.length;

  const previousHref =
    page > 1
      ? `/dashboard/results?page=${page - 1}`
      : null;

  const nextHref =
    page < totalPages
      ? `/dashboard/results?page=${page + 1}`
      : null;

  return (
    <WorkspaceShell email={email}>

      {/* Page heading */}

      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">

        <div>
          <p className="caas-eyebrow">
            Workspace / Results library
          </p>

          <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.055em] text-[#172235] sm:text-[39px]">
            Your saved results.
          </h1>

          <p className="mt-3 max-w-[730px] text-[14px] leading-6 text-[#64748B]">
            Reopen your clustering analyses, inspect real
            scatter plots, and compare saved centroids and
            quality metrics. Only results associated with your
            account are displayed.
          </p>
        </div>

        <Link
          href="/dashboard/experiments"
          className="caas-button caas-button-primary"
        >
          New experiment →
        </Link>

      </div>

      {/* Accurate result statistics */}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">

        <div className="caas-card p-5 sm:p-6">

          <p className="text-[12px] text-[#718097]">
            Total saved results
          </p>

          <p className="mt-3 text-[30px] font-semibold tracking-[-0.05em]">
            {savedPage.total}
          </p>

          <p className="mt-2 text-[11px] text-[#8390A4]">
            Persisted analyses in your account
          </p>

        </div>

        <div className="caas-card p-5 sm:p-6">

          <p className="text-[12px] text-[#718097]">
            Results on this page
          </p>

          <p className="mt-3 text-[30px] font-semibold tracking-[-0.05em]">
            {savedPage.items.length}
          </p>

          <p className="mt-2 text-[11px] text-[#8390A4]">
            Up to {PAGE_SIZE} saved analyses per page
          </p>

        </div>

        <div className="caas-card p-5 sm:p-6">

          <p className="text-[12px] text-[#718097]">
            Results page
          </p>

          <p className="mt-3 text-[30px] font-semibold tracking-[-0.05em]">

            {page}{" "}

            <span className="text-[15px] font-normal text-[#8290A4]">
              / {totalPages}
            </span>

          </p>

          <p className="mt-2 text-[11px] text-[#8390A4]">
            Saved-results-only pagination
          </p>

        </div>

      </div>

      {/* Results collection */}

      <section aria-labelledby="saved-results-list-heading">

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">

          <div>
            <h2
              id="saved-results-list-heading"
              className="text-[17px] font-semibold text-[#24354E]"
            >
              Completed analyses
            </h2>

            <p className="mt-1 text-[12px] text-[#7B899E]">
              {savedPage.total === 0
                ? "No saved analyses yet"
                : `Showing saved results ${first}–${last} of ${savedPage.total}`}
            </p>
          </div>

          <Link
            href="/dashboard/experiments/history"
            className="text-[12px] font-semibold text-[#305BE8] hover:underline"
          >
            Browse full experiment history →
          </Link>

        </div>

        {savedPage.items.length > 0 ? (

          <div className="grid gap-4 md:grid-cols-2">

            {savedPage.items.map(
              (item) => (
                <ResultCard
                  key={item.experiment_id}
                  item={item}
                />
              )
            )}

          </div>

        ) : (

          <div className="caas-card px-6 py-14 text-center">

            <p className="text-[17px] font-semibold text-[#273850]">
              No saved results yet
            </p>

            <p className="mx-auto mt-3 max-w-[560px] text-[13px] leading-6 text-[#718097]">
              Upload a dataset and complete your first
              clustering experiment. After the worker
              persists its result, you can reopen the
              analysis here.
            </p>

            <Link
              href="/dashboard/experiments"
              className="caas-button caas-button-primary mt-6"
            >
              Create experiment →
            </Link>

          </div>

        )}

      </section>

      {/* Pagination */}

      {savedPage.total > 0 && (

        <nav
          aria-label="Saved results pages"
          className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#E3E8EF] bg-white px-5 py-4"
        >

          <p className="text-[12px] text-[#687A91]">
            Results page {page} of {totalPages}
          </p>

          <div className="flex items-center gap-2">

            {previousHref ? (

              <Link
                href={previousHref}
                className="caas-button caas-button-secondary min-h-9 px-3 text-[12px]"
              >
                ← Previous
              </Link>

            ) : (

              <span
                aria-disabled="true"
                className="caas-button caas-button-secondary min-h-9 cursor-not-allowed px-3 text-[12px] opacity-45"
              >
                ← Previous
              </span>

            )}

            {nextHref ? (

              <Link
                href={nextHref}
                className="caas-button caas-button-secondary min-h-9 px-3 text-[12px]"
              >
                Next →
              </Link>

            ) : (

              <span
                aria-disabled="true"
                className="caas-button caas-button-secondary min-h-9 cursor-not-allowed px-3 text-[12px] opacity-45"
              >
                Next →
              </span>

            )}

          </div>

        </nav>

      )}

      <p className="mt-5 text-[11px] leading-5 text-[#8793A5]">
        Only analyses with a persisted clustering result
        appear in this library. Counts and pagination
        come from the owner-scoped PostgreSQL saved-results
        query. Individual analysis pages load their full
        results separately.
      </p>

    </WorkspaceShell>
  );
}

/* =====================================================
   Next.js 16 Suspense boundary
   ===================================================== */

export default function ResultsLibraryPage({
  searchParams,
}: Props) {
  return (
    <Suspense fallback={<LoadingResults />}>
      <PrivateResultsLibrary
        searchParams={searchParams}
      />
    </Suspense>
  );
}
