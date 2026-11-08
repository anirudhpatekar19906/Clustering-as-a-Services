"use client";

/**
 * File 63 — CaaS dataset upload screen using shared workspace navigation.
 *
 * Uses File 53 to verify the current browser session, then sends ONE CSV
 * through File 57's same-origin, authenticated upload endpoint.
 * No JWT is ever read by client-side JavaScript.
 *
 * File 60 provides the shared navigation, header, and logout.
 * This is a client-side page gate for UX; upload authorization is enforced
 * separately by the Next.js upload endpoint and FastAPI.
 */

import Link from "next/link";
import WorkspaceShell from "@/components/workspace-shell";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 255;

type SessionState = "checking" | "ready" | "unavailable";

type UploadReply = {
  success?: boolean;
  dataset_id?: string;
  message?: string;
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function validateCsv(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(".csv")) {
    return "Please choose a file ending in .csv.";
  }

  if (file.name.length > MAX_FILENAME_LENGTH) {
    return "The filename is too long (maximum 255 characters).";
  }

  if (file.size === 0) {
    return "The selected CSV is empty.";
  }

  if (file.size > MAX_FILE_BYTES) {
    return "This file exceeds the 25 MiB limit. Choose a smaller CSV.";
  }

  return null;
}

function UploadIcon({
  className = "h-6 w-6",
}: {
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 16V3m0 0L7 8m5-5 5 5" />

      <path d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15" />
    </svg>
  );
}

export default function UploadDatasetPage() {
  const router = useRouter();

  const inputRef = useRef<HTMLInputElement>(null);

  const [session, setSession] =
    useState<SessionState>("checking");

  const [sessionAttempt, setSessionAttempt] =
    useState(0);

  const [email, setEmail] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [error, setError] =
    useState<string | null>(null);

  const [datasetId, setDatasetId] =
    useState<string | null>(null);

  // Verify the logged-in user through File 53.
  useEffect(() => {
    const controller = new AbortController();

    async function verifySession() {
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
          router.replace("/login?session=expired");
          return;
        }

        if (!response.ok) {
          setSession("unavailable");
          return;
        }

        const body: unknown = await response.json();

        if (
          !isRecord(body) ||
          body.authenticated !== true ||
          !isRecord(body.user) ||
          typeof body.user.email !== "string"
        ) {
          setSession("unavailable");
          return;
        }

        setEmail(body.user.email);
        setSession("ready");
      } catch {
        if (!controller.signal.aborted) {
          setSession("unavailable");
        }
      }
    }

    void verifySession();

    return () => controller.abort();
  }, [router, sessionAttempt]);

  function chooseFile(candidate: File | null) {
    if (!candidate || uploading) return;

    setError(null);
    setDatasetId(null);

    const validationError = validateCsv(candidate);

    if (validationError) {
      setFile(null);
      setError(validationError);

      if (inputRef.current) {
        inputRef.current.value = "";
      }

      return;
    }

    setFile(candidate);
  }

  function onFileInput(
    event: ChangeEvent<HTMLInputElement>
  ) {
    chooseFile(event.target.files?.item(0) ?? null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);

    if (uploading) return;

    if (event.dataTransfer.files.length !== 1) {
      setFile(null);
      setDatasetId(null);
      setError(
        "Please drop exactly one CSV file at a time."
      );
      return;
    }

    chooseFile(event.dataTransfer.files.item(0));
  }

  async function submitUpload(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (
      session !== "ready" ||
      uploading ||
      !file
    ) {
      return;
    }

    const validationError = validateCsv(file);

    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setUploading(true);

    try {
      const form = new FormData();

      form.set("file", file, file.name);

      const response = await fetch(
        "/api/datasets/upload",
        {
          method: "POST",
          body: form,
          credentials: "same-origin",
          cache: "no-store",
        }
      );

      const raw: unknown = await response
        .json()
        .catch(() => null);

      const data: UploadReply = isRecord(raw)
        ? raw
        : {};

      if (response.status === 401) {
        router.replace("/login?session=expired");
        return;
      }

      if (
        !response.ok ||
        data.success !== true ||
        typeof data.dataset_id !== "string"
      ) {
        setError(
          typeof data.message === "string"
            ? data.message
            : "Upload failed. Please check the CSV and try again."
        );

        return;
      }

      setDatasetId(data.dataset_id);
    } catch {
      setError(
        "The upload could not be confirmed. Check your dataset library before trying again."
      );
    } finally {
      setUploading(false);
    }
  }

  function resetUploader() {
    setFile(null);
    setDatasetId(null);
    setError(null);

    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  // Show a safe loading state until the session is verified.
  if (session === "checking") {
    return (
      <div
        className="flex min-h-dvh items-center justify-center bg-[#F7F8FA] p-6 text-[14px] text-[#64748B]"
        role="status"
      >
        Verifying your CaaS session…
      </div>
    );
  }

  if (session === "unavailable") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-[#F7F8FA] px-6 text-center">
        <h1 className="text-2xl font-semibold tracking-[-0.04em]">
          Session service unavailable
        </h1>

        <p className="mt-3 max-w-[450px] text-[14px] leading-6 text-[#64748B]">
          We couldn&apos;t verify your account.
          Check that FastAPI is running, then retry.
        </p>

        <button
          type="button"
          className="caas-button caas-button-primary mt-6"
          onClick={() => {
            setSession("checking");
            setSessionAttempt(
              (current) => current + 1
            );
          }}
        >
          Retry verification
        </button>
      </div>
    );
  }

  return (
    <WorkspaceShell email={email}>
      {/* Page heading */}
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="caas-eyebrow">
            Dataset workspace / Add data
          </p>

          <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.055em] sm:text-[39px]">
            Upload a dataset.
          </h1>

          <p className="mt-3 max-w-[660px] text-[14px] leading-6 text-[#64748B]">
            Bring your CSV into CaaS. We&apos;ll
            validate it and add it to your private
            dataset library, ready for clustering
            experiments.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 self-start">
          <Link
            href="/dashboard/datasets"
            className="caas-button caas-button-secondary min-h-9 px-3 py-2 text-[12px]"
          >
            ← Dataset library
          </Link>

          <span className="caas-status caas-status-success">
            ● Session verified
          </span>
        </div>
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_285px]">
        {/* Main upload card */}
        <section
          className="caas-card min-w-0 overflow-hidden"
          aria-labelledby="upload-title"
        >
          <div className="caas-card-header">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2
                  id="upload-title"
                  className="text-[16px] font-semibold tracking-[-0.025em]"
                >
                  Add CSV file
                </h2>

                <p className="mt-1 text-[12px] text-[#718097]">
                  One file per upload · Maximum 25 MiB
                </p>
              </div>

              <span className="rounded-md bg-[#F1F4FA] px-2.5 py-1.5 font-mono text-[10px] text-[#6D7D95]">
                .CSV
              </span>
            </div>
          </div>

          <div className="p-5 sm:p-7">
            {datasetId ? (
              /* Upload completed */
              <div
                role="status"
                aria-live="polite"
                className="rounded-xl border border-[#BDE5D5] bg-[#F0FAF5] p-6"
              >
                <div
                  className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#D9F1E6] text-2xl text-[#16816C]"
                  aria-hidden="true"
                >
                  ✓
                </div>

                <h3 className="mt-4 text-[20px] font-semibold tracking-[-0.035em] text-[#174D3E]">
                  Dataset uploaded successfully.
                </h3>

                <p className="mt-2 text-[13px] leading-6 text-[#41695D]">
                  <strong>{file?.name}</strong> is
                  now saved to your account. View it
                  in the dataset library to inspect
                  its columns.
                </p>

                <p className="mt-4 break-all font-mono text-[11px] text-[#42665C]">
                  Dataset ID: {datasetId}
                </p>

                <div className="mt-6 flex flex-wrap gap-3">
                  <Link
                    href="/dashboard/datasets"
                    className="caas-button caas-button-primary"
                  >
                    View dataset library →
                  </Link>

                  <button
                    type="button"
                    className="caas-button caas-button-secondary"
                    onClick={resetUploader}
                  >
                    Upload another
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={submitUpload}>
                <input
                  ref={inputRef}
                  id="caas-csv-file"
                  type="file"
                  name="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  disabled={uploading}
                  onChange={onFileInput}
                  aria-describedby="csv-upload-hint"
                />

                {/* Dropzone */}
                <div
                  onDragOver={(event) => {
                    event.preventDefault();

                    if (!uploading) {
                      setDragging(true);
                    }
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    setDragging(false);
                  }}
                  onDrop={onDrop}
                  className={`rounded-xl border-2 border-dashed px-5 py-11 text-center transition-colors sm:px-8 sm:py-14 ${
                    dragging
                      ? "border-[#305BE8] bg-[#EEF2FF]"
                      : "border-[#CAD4E2] bg-[#FBFCFE]"
                  }`}
                >
                  <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#EDF2FF] text-[#305BE8]">
                    <UploadIcon />
                  </span>

                  <h3 className="mt-5 text-[17px] font-semibold tracking-[-0.025em]">
                    Drop your CSV here
                  </h3>

                  <p
                    id="csv-upload-hint"
                    className="mt-2 text-[13px] text-[#718097]"
                  >
                    Or select a file from your computer
                  </p>

                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() =>
                      inputRef.current?.click()
                    }
                    className="caas-button caas-button-secondary mt-5"
                  >
                    Browse files
                  </button>

                  <p className="mt-5 text-[11px] text-[#8794A6]">
                    CSV format only · Up to 25 MiB ·
                    Your files stay private
                  </p>
                </div>

                {/* Selected file */}
                {file && (
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#DCE4EF] bg-white p-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        aria-hidden="true"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#EEF2FF] font-mono text-[11px] font-bold text-[#4162C1]"
                      >
                        CSV
                      </span>

                      <div className="min-w-0">
                        <p
                          className="truncate text-[13px] font-semibold text-[#293950]"
                          title={file.name}
                        >
                          {file.name}
                        </p>

                        <p className="mt-1 text-[11px] text-[#738299]">
                          {formatSize(file.size)} · Ready to upload
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={uploading}
                      onClick={resetUploader}
                      className="rounded-md px-3 py-2 text-[12px] font-semibold text-[#697B93] hover:bg-[#F3F5F9]"
                    >
                      Remove
                    </button>
                  </div>
                )}

                {/* Validation and API errors */}
                {error && (
                  <div
                    role="alert"
                    className="mt-5 rounded-lg border border-[#F0C8CD] bg-[#FFF4F5] px-4 py-3 text-[13px] leading-6 text-[#9A3340]"
                  >
                    {error}
                  </div>
                )}

                <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-[#E7EBF2] pt-6">
                  <p className="max-w-[300px] text-[11px] leading-5 text-[#7E8CA0]">
                    The server verifies CSV format,
                    row limits, and column limits
                    before accepting your upload.
                  </p>

                  <button
                    type="submit"
                    disabled={!file || uploading}
                    className="caas-button caas-button-primary min-w-[176px]"
                  >
                    {uploading ? (
                      <>
                        <span
                          aria-hidden="true"
                          className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                        />
                        Uploading and validating…
                      </>
                    ) : (
                      <>
                        <UploadIcon className="h-4 w-4" />
                        Upload dataset
                      </>
                    )}
                  </button>
                </div>

                {uploading && (
                  <p
                    className="mt-3 text-right text-[11px] text-[#667791]"
                    role="status"
                  >
                    Processing your file. No estimated
                    percentage is shown because actual
                    progress is not available from
                    this endpoint.
                  </p>
                )}
              </form>
            )}
          </div>
        </section>

        {/* Upload guidelines */}
        <aside
          className="caas-card p-6"
          aria-labelledby="upload-guidelines-title"
        >
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#EDF2FF] text-[#305BE8]"
            aria-hidden="true"
          >
            <span className="text-xl">ⓘ</span>
          </div>

          <h2
            id="upload-guidelines-title"
            className="mt-5 text-[16px] font-semibold tracking-[-0.025em]"
          >
            Before you upload
          </h2>

          <p className="mt-2 text-[12px] leading-6 text-[#718097]">
            A well-structured CSV helps you get
            meaningful clustering results.
          </p>

          <ul className="mt-5 space-y-4 text-[12px] leading-5 text-[#52627B]">
            <li className="flex gap-3">
              <span className="font-semibold text-[#305BE8]">01</span>
              <span>Include a header row with column names.</span>
            </li>

            <li className="flex gap-3">
              <span className="font-semibold text-[#305BE8]">02</span>
              <span>
                Keep the file within 25 MiB,
                100,000 rows, and 100 columns.
              </span>
            </li>

            <li className="flex gap-3">
              <span className="font-semibold text-[#305BE8]">03</span>
              <span>
                Use numerical columns for your clustering features.
              </span>
            </li>

            <li className="flex gap-3">
              <span className="font-semibold text-[#305BE8]">04</span>
              <span>
                Choose features and clustering settings after uploading.
              </span>
            </li>
          </ul>

          <div className="mt-6 border-t border-[#E6EAF0] pt-5">
            <p className="text-[11px] font-semibold text-[#455876]">
              Privacy by default
            </p>

            <p className="mt-2 text-[11px] leading-5 text-[#7C8B9E]">
              Upload requests are authenticated.
              Your dataset library is scoped to
              your account through FastAPI.
            </p>
          </div>
        </aside>
      </div>
    </WorkspaceShell>
  );
}
