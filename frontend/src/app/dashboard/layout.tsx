"use client";

/**
 * Persistent Dashboard Layout — Navigation Smoothness Fix
 *
 * Keeps one WorkspaceShell mounted when navigating between
 * Dashboard, Datasets, Upload CSV, Experiments, and Job Tracking.
 *
 * The context tells existing page-level WorkspaceShell instances
 * to render only their content, preventing duplicate sidebars.
 *
 * Authentication remains enforced by the backend and protected pages.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import WorkspaceShell, {
  PersistentWorkspaceContext,
} from "@/components/workspace-shell";

type SessionState =
  | { kind: "checking" }
  | { kind: "ready"; email: string }
  | { kind: "error"; message: string };

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function WorkspaceLoading({
  message,
}: {
  message: string;
}) {
  return (
    <div
      className="min-h-dvh bg-[#F7F8FA] text-[#172235] lg:flex"
      role="status"
    >
      <div className="hidden shrink-0 bg-[#192437] lg:block lg:w-[246px]">
        <div className="flex items-center gap-3 px-6 py-7">
          <div className="h-9 w-9 rounded-[11px] bg-[#31405A]" />

          <div className="space-y-2">
            <div className="h-3 w-14 rounded bg-white/20" />
            <div className="h-2 w-24 rounded bg-white/10" />
          </div>
        </div>

        <div className="mt-9 space-y-4 px-7">
          <div className="h-9 rounded-lg bg-white/10" />
          <div className="h-3 w-3/4 rounded bg-white/10" />
          <div className="h-3 w-2/3 rounded bg-white/10" />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="h-[75px] border-b border-[#E4E8EF] bg-white" />

        <div className="mx-auto max-w-[1190px] px-5 py-10 sm:px-8">
          <div className="h-3 w-32 rounded bg-[#DEE5F0]" />
          <div className="mt-5 h-9 w-64 max-w-full rounded bg-[#E7EBF2]" />

          <p className="mt-6 text-[13px] text-[#708198]">
            {message}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const router = useRouter();

  const [session, setSession] = useState<SessionState>({
    kind: "checking",
  });

  const [retry, setRetry] = useState(0);

  /*
   * Verify the session when the dashboard layout mounts.
   * The layout stays mounted during navigation between
   * its child pages, keeping the shared UI in place.
   */
  useEffect(() => {
    const controller = new AbortController();

    async function verifySession() {
      try {
        const response = await fetch("/api/auth/session", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });

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

        if (
          !response.ok ||
          !isRecord(data) ||
          data.authenticated !== true ||
          !isRecord(data.user) ||
          typeof data.user.email !== "string" ||
          !data.user.email.trim()
        ) {
          throw new Error(
            "We couldn't verify your account."
          );
        }

        if (!controller.signal.aborted) {
          setSession({
            kind: "ready",
            email: data.user.email,
          });
        }
      } catch {
        if (!controller.signal.aborted) {
          setSession({
            kind: "error",
            message:
              "Session verification is unavailable. Check FastAPI and try again.",
          });
        }
      }
    }

    void verifySession();

    return () => controller.abort();
  }, [router, retry]);

  if (session.kind === "checking") {
    return (
      <WorkspaceLoading message="Verifying your CaaS workspace…" />
    );
  }

  if (session.kind === "error") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-[#F7F8FA] px-6 text-center text-[#172235]">
        <h1 className="text-[23px] font-semibold tracking-[-0.04em]">
          Workspace temporarily unavailable
        </h1>

        <p className="mt-3 max-w-[450px] text-[13px] leading-6 text-[#68788F]">
          {session.message}
        </p>

        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            className="caas-button caas-button-primary"
            onClick={() => {
              setSession({ kind: "checking" });
              setRetry((value) => value + 1);
            }}
          >
            Retry verification
          </button>

          <Link
            href="/login"
            className="caas-button caas-button-secondary"
          >
            Return to sign in
          </Link>
        </div>
      </div>
    );
  }

  /*
   * This is the one persistent WorkspaceShell.
   *
   * The context below tells the existing WorkspaceShell
   * instances inside each page NOT to render another sidebar.
   *
   * Suspense also protects usePathname() on dynamic routes
   * such as /dashboard/experiments/jobs/[jobId].
   */
  return (
    <Suspense
      fallback={
        <WorkspaceLoading message="Opening your workspace…" />
      }
    >
      <WorkspaceShell email={session.email}>
        <PersistentWorkspaceContext.Provider value={true}>
          {children}
        </PersistentWorkspaceContext.Provider>
      </WorkspaceShell>
    </Suspense>
  );
}
