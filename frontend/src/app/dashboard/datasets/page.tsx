/**
 * File 62 — CaaS dataset library using the shared workspace shell.
 *
 * Real owner-scoped datasets from FastAPI, filename search, metadata details,
 * and direct links to the existing CSV uploader (File 58).
 * The sidebar, header, and sign-out are provided by File 60.
 * Session verification and dataset fetching remain server-side.
 *
 * Cache Components (Next.js 16): request-time cookies and uncached requests
 * belong inside a component wrapped with Suspense.
 */

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import WorkspaceShell from "@/components/workspace-shell";

export const metadata: Metadata = {
  title: "Datasets",
  description: "Manage the datasets in your private CaaS workspace.",
  robots: { index: false, follow: false },
};

const COOKIE_NAME = "caas_access_token";
const LOCAL_API = "http://127.0.0.1:8000";

type Dataset = {
  id: string;
  filename: string;
  rows: number | null;
  columns: number | null;
  bytes: number | null;
  createdAt: string | null;
  columnNames: string[];
};

type DatasetResponse = {
  items: Dataset[];
  total: number | null;
};

type PageProps = {
  searchParams: Promise<{
    q?: string | string[];
  }>;
};

function isObject(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function nonnegativeInteger(
  value: unknown
): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function readDatasets(
  value: unknown
): DatasetResponse | null {
  if (
    !isObject(value) ||
    !Array.isArray(value.items)
  ) {
    return null;
  }

  const items: Dataset[] = [];

  for (const raw of value.items) {
    if (
      !isObject(raw) ||
      typeof raw.id !== "string" ||
      !raw.id
    ) {
      return null;
    }

    items.push({
      id: raw.id,

      filename:
        typeof raw.original_filename === "string" &&
        raw.original_filename
          ? raw.original_filename
          : "Unnamed dataset",

      rows: nonnegativeInteger(raw.row_count),

      columns: nonnegativeInteger(raw.column_count),

      bytes: nonnegativeInteger(raw.file_size_bytes),

      createdAt:
        typeof raw.created_at === "string"
          ? raw.created_at
          : null,

      columnNames: Array.isArray(raw.column_names)
        ? raw.column_names.filter(
            (name): name is string =>
              typeof name === "string"
          )
        : [],
    });
  }

  return {
    items,
    total: nonnegativeInteger(value.total),
  };
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

    return url.protocol === "http:" ||
      url.protocol === "https:"
      ? url
      : null;
  } catch {
    return null;
  }
}

async function fetchFromApi(
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
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
}

async function safeJson(
  response: Response | null
): Promise<unknown> {
  if (!response?.ok) return null;

  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readableNumber(
  value: number | null
): string {
  return value === null
    ? "—"
    : new Intl.NumberFormat("en-IN").format(value);
}

function readableSize(
  bytes: number | null
): string {
  if (bytes === null) return "—";

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readableDate(
  value: string | null
): string {
  if (!value) return "—";

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function Unavailable({
  message,
}: {
  message: string;
}) {
  return (
    <div className="mx-auto max-w-[600px] rounded-xl border border-[#E3E8EF] bg-white p-8 text-center">
      <h1 className="text-[22px] font-semibold tracking-[-0.04em]">
        Datasets temporarily unavailable
      </h1>

      <p className="mt-3 text-[13px] leading-6 text-[#64748B]">
        {message}
      </p>

      <Link
        href="/dashboard/datasets"
        className="caas-button caas-button-secondary mt-6"
      >
        Try again
      </Link>
    </div>
  );
}

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
    <div className="caas-card p-5 sm:p-6">
      <p className="text-[12px] font-medium text-[#6B7A90]">
        {label}
      </p>

      <p className="mt-3 text-[29px] font-semibold tracking-[-0.045em]">
        {value}
      </p>

      <p className="mt-2 text-[11px] text-[#8491A3]">
        {note}
      </p>
    </div>
  );
}

async function PrivateDatasets({
  searchParams,
}: PageProps) {
  const token = (
    await cookies()
  ).get(COOKIE_NAME)?.value;

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
      <Unavailable
        message="The API is not configured for this environment."
      />
    );
  }

  // Verify the user before requesting private datasets.
  const verification = await fetchFromApi(
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

  const profile = await safeJson(verification);

  if (
    !isObject(profile) ||
    typeof profile.id !== "string" ||
    typeof profile.email !== "string" ||
    profile.is_active === false
  ) {
    return (
      <Unavailable
        message="We couldn't verify your session. Check FastAPI and refresh."
      />
    );
  }

  const response = await fetchFromApi(
    base,
    "/api/v1/datasets",
    token
  );

  if (
    response?.status === 401 ||
    response?.status === 403
  ) {
    redirect("/login?session=expired");
  }

  const datasets = readDatasets(
    await safeJson(response)
  );

  if (!datasets) {
    return (
      <WorkspaceShell email={profile.email}>
        <Unavailable
          message="We couldn't load your dataset library. Your uploaded files have not been changed."
        />
      </WorkspaceShell>
    );
  }

  const params = await searchParams;

  const query = (
    typeof params.q === "string"
      ? params.q
      : ""
  )
    .trim()
    .slice(0, 80);

  const visible = datasets.items
    .filter((item) =>
      item.filename
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase())
    )
    .sort((a, b) => {
      const aTime = a.createdAt
        ? Date.parse(a.createdAt) || 0
        : 0;

      const bTime = b.createdAt
        ? Date.parse(b.createdAt) || 0
        : 0;

      return bTime - aTime;
    });

  const completeSizes = datasets.items.every(
    (item) => item.bytes !== null
  );

  const totalBytes = completeSizes
    ? datasets.items.reduce(
        (sum, item) =>
          sum + (item.bytes ?? 0),
        0
      )
    : null;

  const completeRows = datasets.items.every(
    (item) => item.rows !== null
  );

  const totalRows = completeRows
    ? datasets.items.reduce(
        (sum, item) =>
          sum + (item.rows ?? 0),
        0
      )
    : null;

  return (
    <WorkspaceShell email={profile.email}>
      {/* Page introduction */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="caas-eyebrow">
            Data library
          </p>

          <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.055em] sm:text-[39px]">
            Your datasets.
          </h1>

          <p className="mt-3 max-w-[650px] text-[14px] leading-6 text-[#64748B]">
            Review the CSV files saved to your account.
            Search by filename and inspect column details
            before creating an experiment.
          </p>
        </div>

        <Link
          href="/dashboard/datasets/upload"
          className="caas-button caas-button-primary shrink-0"
        >
          <span aria-hidden="true">↥</span>
          Upload CSV
        </Link>
      </div>

      {/* Real dataset statistics */}
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Metric
          label="Datasets"
          value={readableNumber(
            datasets.total ??
            datasets.items.length
          )}
          note={
            datasets.total === null
              ? "Entries returned by the API"
              : "Total uploaded datasets"
          }
        />

        <Metric
          label="Rows in listed datasets"
          value={readableNumber(totalRows)}
          note="Only counts known row totals"
        />

        <Metric
          label="Storage in listed datasets"
          value={readableSize(totalBytes)}
          note="Based on uploaded CSV sizes"
        />
      </div>

      {/* Dataset library */}
      <section
        className="caas-card mt-7 overflow-hidden"
        aria-labelledby="dataset-list-title"
      >
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E3E8EF] p-5 sm:p-6">
          <div>
            <h2
              id="dataset-list-title"
              className="text-[16px] font-semibold tracking-[-0.025em]"
            >
              Dataset library
            </h2>

            <p className="mt-1 text-[12px] text-[#718097]">
              {visible.length} matching{" "}
              {visible.length === 1
                ? "dataset"
                : "datasets"}
            </p>
          </div>

          <form
            action="/dashboard/datasets"
            method="get"
            role="search"
            className="flex w-full max-w-[380px] gap-2 sm:w-auto"
          >
            <label
              htmlFor="dataset-search"
              className="sr-only"
            >
              Search datasets by filename
            </label>

            <input
              id="dataset-search"
              name="q"
              type="search"
              maxLength={80}
              defaultValue={query}
              placeholder="Search filenames"
              className="caas-input min-w-0 flex-1 sm:w-[210px]"
            />

            <button
              type="submit"
              className="caas-button caas-button-secondary shrink-0"
            >
              Search
            </button>

            {query && (
              <Link
                href="/dashboard/datasets"
                className="caas-button caas-button-secondary shrink-0"
              >
                Clear
              </Link>
            )}
          </form>
        </div>

        {datasets.items.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <span
              aria-hidden="true"
              className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[#EEF2FF] text-2xl text-[#4165D4]"
            >
              ▤
            </span>

            <h3 className="mt-5 text-[17px] font-semibold">
              No datasets yet
            </h3>

            <p className="mx-auto mt-2 max-w-[430px] text-[13px] leading-6 text-[#718097]">
              Your library is empty. Upload your first CSV
              to start exploring its columns and preparing
              clustering experiments.
            </p>

            <Link
              href="/dashboard/datasets/upload"
              className="caas-button caas-button-primary mt-6"
            >
              <span aria-hidden="true">↥</span>
              Upload your first CSV
            </Link>
          </div>
        ) : visible.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <h3 className="text-[16px] font-semibold">
              No matching filenames
            </h3>

            <p className="mt-2 text-[13px] text-[#718097]">
              Try another search or clear the filter.
            </p>

            <Link
              href="/dashboard/datasets"
              className="caas-button caas-button-secondary mt-5"
            >
              Clear search
            </Link>
          </div>
        ) : (
          <div className="caas-table-scroll">
            <table className="caas-table">
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>Rows</th>
                  <th>Columns</th>
                  <th>File size</th>
                  <th>Uploaded</th>
                </tr>
              </thead>

              <tbody>
                {visible.map((item) => (
                  <tr key={item.id}>
                    <td className="min-w-[230px] max-w-[340px]">
                      <details className="group">
                        <summary className="cursor-pointer rounded-sm font-semibold text-[#253A59] hover:text-[#305BE8]">
                          <span className="break-all">
                            {item.filename}
                          </span>

                          <span className="ml-2 whitespace-nowrap text-[11px] font-normal text-[#6D7D95] group-open:hidden">
                            Details ▾
                          </span>

                          <span className="ml-2 whitespace-nowrap text-[11px] font-normal text-[#6D7D95] hidden group-open:inline">
                            Hide ▴
                          </span>
                        </summary>

                        <div className="mt-3 rounded-lg bg-[#F5F7FA] p-3 text-[11px] leading-5 text-[#64748B]">
                          <p className="font-semibold text-[#465670]">
                            Dataset ID
                          </p>

                          <code className="block break-all font-mono text-[10px]">
                            {item.id}
                          </code>

                          <p className="mt-3 font-semibold text-[#465670]">
                            Columns
                          </p>

                          <p className="mt-1 break-words">
                            {item.columnNames.length
                              ? item.columnNames.join(", ")
                              : "Column names unavailable"}
                          </p>
                        </div>
                      </details>
                      <Link
                        href={`/dashboard/datasets/${item.id}/quality`}
                        className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#305BE8] hover:underline"
                      >
                        View quality report
                        <span aria-hidden="true">→</span>
                      </Link>
                    </td>

                    <td className="whitespace-nowrap">
                      {readableNumber(item.rows)}
                    </td>

                    <td className="whitespace-nowrap">
                      {readableNumber(item.columns)}
                    </td>

                    <td className="whitespace-nowrap">
                      {readableSize(item.bytes)}
                    </td>

                    <td className="whitespace-nowrap">
                      {readableDate(item.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-5 text-[11px] leading-5 text-[#8491A3]">
        Only datasets returned by your authenticated
        FastAPI account are displayed. You can upload
        new CSVs here; dataset deletion will be added
        as a separate, tested workflow.
      </p>
    </WorkspaceShell>
  );
}

export default function DatasetsPage({
  searchParams,
}: PageProps) {
  return (
    <Suspense
      fallback={
        <div
          className="flex min-h-dvh items-center justify-center bg-[#F7F8FA] p-6 text-[14px] text-[#64748B]"
          role="status"
        >
          Verifying your dataset workspace…
        </div>
      }
    >
      <PrivateDatasets searchParams={searchParams} />
    </Suspense>
  );
}
