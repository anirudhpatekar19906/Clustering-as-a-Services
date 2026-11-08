"use client";

/**
 * File 97 — Persistent CaaS workspace with an account menu.
 *
 * The bottom-left trigger uses the authenticated GET /api/profile bridge to
 * display the user's saved name and avatar color. It never reads the JWT.
 * Profile data is presentation only: server pages and FastAPI remain the
 * authorization boundaries.
 *
 * dashboard/layout.tsx owns the persistent shell. Nested WorkspaceShell
 * calls render only children, preventing duplicate sidebars and API requests.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

export const PersistentWorkspaceContext = createContext(false);

type WorkspaceShellProps = {
  email: string;
  children: ReactNode;
  headerAction?: ReactNode;
};

type NavIconName =
  | "overview"
  | "datasets"
  | "upload"
  | "experiments"
  | "history"
  | "results";

type AvatarColor =
  | "#305BE8"
  | "#129A8E"
  | "#8B5CF6"
  | "#D97735"
  | "#46627F";

type AccountAppearance = {
  displayName: string | null;
  avatarColor: AvatarColor;
};

const DEFAULT_COLOR: AvatarColor = "#305BE8";

const AVATAR_COLORS: readonly string[] = [
  "#305BE8",
  "#129A8E",
  "#8B5CF6",
  "#D97735",
  "#46627F",
];

const activeLinks: {
  href: string;
  label: string;
  icon: NavIconName;
}[] = [
  {
    href: "/dashboard",
    label: "Overview",
    icon: "overview",
  },
  {
    href: "/dashboard/datasets",
    label: "Datasets",
    icon: "datasets",
  },
  {
    href: "/dashboard/datasets/upload",
    label: "Upload CSV",
    icon: "upload",
  },
  {
    href: "/dashboard/experiments",
    label: "Experiments",
    icon: "experiments",
  },
  {
    href: "/dashboard/experiments/history",
    label: "Experiment History",
    icon: "history",
  },
  {
    href: "/dashboard/results",
    label: "Results",
    icon: "results",
  },
];

function isActiveLink(
  href: string,
  pathname: string
): boolean {
  if (href === "/dashboard/results") {
    return (
      pathname === href ||
      pathname.startsWith(`${href}/`) ||
      pathname.startsWith(
        "/dashboard/experiments/results/"
      )
    );
  }

  if (href === "/dashboard/experiments/history") {
    return (
      pathname === href ||
      pathname.startsWith(`${href}/`)
    );
  }

  if (href === "/dashboard/experiments") {
    return (
      pathname === href ||
      (pathname.startsWith(`${href}/`) &&
        !pathname.startsWith(`${href}/history`) &&
        !pathname.startsWith(`${href}/results/`))
    );
  }

  return pathname === href;
}

function NavIcon({
  name,
}: {
  name: NavIconName;
}) {
  let shape: ReactNode;

  switch (name) {
    case "overview":
      shape = (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1.3" />
          <rect x="14" y="3" width="7" height="7" rx="1.3" />
          <rect x="3" y="14" width="7" height="7" rx="1.3" />
          <rect x="14" y="14" width="7" height="7" rx="1.3" />
        </>
      );
      break;

    case "datasets":
      shape = (
        <>
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
          <path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
        </>
      );
      break;

    case "upload":
      shape = (
        <>
          <path d="M12 16V3m0 0L7.5 7.5M12 3l4.5 4.5" />
          <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
        </>
      );
      break;

    case "experiments":
      shape = (
        <>
          <path d="M9 3v7l-5.5 8.5A2 2 0 0 0 5.2 21h13.6a2 2 0 0 0 1.7-2.5L15 10V3" />
          <path d="M7 3h10M7 15h10" />
        </>
      );
      break;

    case "history":
      shape = (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.5 2" />
        </>
      );
      break;

    case "results":
      shape = (
        <>
          <path d="M3 3v18h18" />
          <path d="m6 16 5-6 4 3 5-8" />
          <circle
            cx="11"
            cy="10"
            r="1"
            fill="currentColor"
            stroke="none"
          />
          <circle
            cx="20"
            cy="5"
            r="1"
            fill="currentColor"
            stroke="none"
          />
        </>
      );
      break;
  }

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[17px] w-[17px] shrink-0"
    >
      {shape}
    </svg>
  );
}

function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-[#31405A] ring-1 ring-white/10"
    >
      <svg
        viewBox="0 0 40 40"
        className="h-7 w-7"
        fill="none"
      >
        <rect
          x="8"
          y="7"
          width="9"
          height="9"
          rx="2"
          fill="#FFFFFF"
        />
        <rect
          x="23"
          y="13"
          width="9"
          height="9"
          rx="2"
          fill="#91A9FF"
        />
        <rect
          x="16"
          y="25"
          width="9"
          height="9"
          rx="2"
          fill="#65D8BD"
        />
      </svg>
    </span>
  );
}

function ChevronIcon({
  open,
}: {
  open: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 shrink-0 transition-transform duration-200 ${
        open ? "rotate-180" : ""
      }`}
    >
      <path d="m7 10 5 5 5-5" />
    </svg>
  );
}

function AccountAvatar({
  name,
  color,
  size = "md",
}: {
  name: string;
  color: AvatarColor;
  size?: "md" | "lg";
}) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word.charAt(0))
      .join("")
      .toUpperCase() || "U";

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-xl font-semibold text-white shadow-sm ${
        size === "lg"
          ? "h-11 w-11 text-[16px]"
          : "h-9 w-9 text-[13px]"
      }`}
      style={{
        backgroundColor: color,
      }}
    >
      {initials}
    </span>
  );
}

function readAppearance(
  value: unknown,
  email: string
): AccountAppearance | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  const root = value as Record<string, unknown>;
  const profile = root.profile;

  if (
    root.success !== true ||
    !profile ||
    typeof profile !== "object" ||
    Array.isArray(profile)
  ) {
    return null;
  }

  const p = profile as Record<string, unknown>;

  if (
    typeof p.email !== "string" ||
    p.email.toLowerCase() !== email.toLowerCase() ||
    typeof p.avatar_color !== "string" ||
    !AVATAR_COLORS.includes(p.avatar_color) ||
    (p.display_name !== null &&
      typeof p.display_name !== "string")
  ) {
    return null;
  }

  return {
    displayName:
      typeof p.display_name === "string"
        ? p.display_name.trim().slice(0, 80) || null
        : null,

    avatarColor: p.avatar_color as AvatarColor,
  };
}

function pageHeading(
  pathname: string
): {
  breadcrumb: string;
  title: string;
} {
  if (pathname === "/dashboard/profile") {
    return {
      breadcrumb: "Workspace / Account / Profile",
      title: "My profile",
    };
  }

  if (pathname === "/dashboard/datasets/upload") {
    return {
      breadcrumb: "Workspace / Datasets / Upload",
      title: "Add a dataset",
    };
  }

  if (pathname === "/dashboard/datasets") {
    return {
      breadcrumb: "Workspace / Datasets",
      title: "Your data library",
    };
  }

  if (
    pathname === "/dashboard/experiments/history" ||
    pathname.startsWith(
      "/dashboard/experiments/history/"
    )
  ) {
    return {
      breadcrumb: "Workspace / Experiments / History",
      title: "Previous clustering runs",
    };
  }

  if (
    pathname === "/dashboard/results" ||
    pathname.startsWith("/dashboard/results/")
  ) {
    return {
      breadcrumb: "Workspace / Results",
      title: "Your saved results",
    };
  }

  if (
    pathname.startsWith(
      "/dashboard/experiments/results/"
    )
  ) {
    return {
      breadcrumb: "Workspace / Results / Analysis",
      title: "Saved clustering results",
    };
  }

  if (
    pathname.startsWith(
      "/dashboard/experiments/jobs/"
    )
  ) {
    return {
      breadcrumb: "Workspace / Experiments / Jobs",
      title: "Clustering job tracking",
    };
  }

  if (pathname === "/dashboard/experiments") {
    return {
      breadcrumb: "Workspace / Experiments",
      title: "Configure clustering",
    };
  }

  if (pathname === "/dashboard") {
    return {
      breadcrumb: "Workspace / Overview",
      title: "Your personal workspace",
    };
  }

  return {
    breadcrumb: "Workspace",
    title: "Clustering workspace",
  };
}

/* =====================================================
   Shared workspace component
   ===================================================== */

export default function WorkspaceShell({
  email,
  children,
  headerAction,
}: WorkspaceShellProps) {
  const insidePersistentLayout = useContext(
    PersistentWorkspaceContext
  );

  if (insidePersistentLayout) {
    return (
      <>
        {headerAction && (
          <div className="mb-5 flex flex-wrap justify-end gap-3">
            {headerAction}
          </div>
        )}

        {children}
      </>
    );
  }

  return (
    <FullWorkspaceShell
      email={email}
      headerAction={headerAction}
    >
      {children}
    </FullWorkspaceShell>
  );
}

/* =====================================================
   Persistent sidebar, account menu and header
   ===================================================== */

function FullWorkspaceShell({
  email,
  children,
  headerAction,
}: WorkspaceShellProps) {
  const pathname = usePathname();
  const heading = pageHeading(pathname);

  const menuId = useId();

  const menuAreaRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const [menuOpen, setMenuOpen] = useState(false);

  const [profileRefresh, setProfileRefresh] =
    useState(0);

  const [appearance, setAppearance] =
    useState<AccountAppearance>({
      displayName: null,
      avatarColor: DEFAULT_COLOR,
    });

  const [signingOut, setSigningOut] =
    useState(false);

  const [signOutError, setSignOutError] =
    useState<string | null>(null);

  /* ---------------------------------------------------
     Load name and avatar from the authenticated API
     --------------------------------------------------- */

  useEffect(() => {
    const controller = new AbortController();

    async function loadAccountAppearance() {
      try {
        const response = await fetch(
          "/api/profile",
          {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          }
        );

        if (
          response.status === 401 ||
          response.status === 403
        ) {
          if (!controller.signal.aborted) {
            window.location.replace(
              "/login?session=expired"
            );
          }

          return;
        }

        if (!response.ok) {
          return;
        }

        const data: unknown = await response
          .json()
          .catch(() => null);

        const next = readAppearance(data, email);

        if (
          !controller.signal.aborted &&
          next
        ) {
          setAppearance(next);
        }
      } catch {
        // A temporary profile API failure must not
        // break navigation or the entire workspace.
      }
    }

    void loadAccountAppearance();

    return () => controller.abort();
  }, [email, pathname, profileRefresh]);

  // Update the sidebar immediately after a successful profile save.
  useEffect(() => {
    function onProfileUpdated(event: Event) {
      const detail = (event as CustomEvent<unknown>).detail;

      const next = readAppearance(detail, email);

      if (!next) return;

      // Update avatar color and display name instantly.
      setAppearance(next);

      // Refresh from PostgreSQL to keep everything synchronized.
      setProfileRefresh((value) => value + 1);
    }

    window.addEventListener(
      "caas:profile-updated",
      onProfileUpdated
    );

    return () => {
      window.removeEventListener(
        "caas:profile-updated",
        onProfileUpdated
      );
    };
  }, [email]);
  
  /* ---------------------------------------------------
     Close dropdown on outside clicks or Escape
     --------------------------------------------------- */

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function closeOutside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !menuAreaRef.current?.contains(
          event.target
        )
      ) {
        setMenuOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener(
      "pointerdown",
      closeOutside
    );

    document.addEventListener(
      "keydown",
      closeOnEscape
    );

    return () => {
      document.removeEventListener(
        "pointerdown",
        closeOutside
      );

      document.removeEventListener(
        "keydown",
        closeOnEscape
      );
    };
  }, [menuOpen]);

  /* ---------------------------------------------------
     Profile menu controls
     --------------------------------------------------- */

  function toggleAccountMenu() {
    if (!menuOpen) {
      setProfileRefresh(
        (value) => value + 1
      );
    }

    setMenuOpen(
      (value) => !value
    );
  }

  /* ---------------------------------------------------
     Secure sign-out
     --------------------------------------------------- */

  async function handleSignOut() {
    if (signingOut) {
      return;
    }

    setMenuOpen(false);
    setSigningOut(true);
    setSignOutError(null);

    try {
      const response = await fetch(
        "/api/auth/logout",
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
        }
      );

      if (!response.ok) {
        throw new Error(
          "Logout request was not confirmed"
        );
      }

      window.location.replace("/login");
    } catch {
      setSignOutError(
        "Could not sign out. Please try again."
      );

      setSigningOut(false);
    }
  }

  const displayName =
    appearance.displayName ||
    email.split("@")[0] ||
    "Your account";

  /* ===================================================
     Workspace UI
     =================================================== */

  return (
    <div className="min-h-dvh bg-[#F7F8FA] text-[#172235] lg:flex">

      <a
        href="#workspace-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-3 focus:text-[#172235] focus:shadow-lg"
      >
        Skip to main content
      </a>

      {/* Sidebar */}

      <aside className="flex w-full shrink-0 flex-col bg-[#192437] text-white lg:sticky lg:top-0 lg:h-dvh lg:w-[246px]">

        {/* Brand */}

        <Link
          href="/dashboard"
          className="flex w-fit items-center gap-3 rounded-lg px-5 py-5 lg:px-6 lg:py-7"
          aria-label="CaaS workspace overview"
        >
          <BrandMark />

          <span>
            <span className="block text-[18px] font-semibold leading-5 tracking-[-0.05em]">
              caas
              <span className="text-[#91A9FF]">
                .
              </span>
            </span>

            <span className="mt-1 block text-[11px] text-[#A1B0C6]">
              Clustering workspace
            </span>
          </span>
        </Link>

        {/* Navigation */}

        <div className="border-t border-white/10 px-5 py-4 lg:mt-5 lg:flex-1 lg:px-4 lg:py-5">

          <p className="mb-4 hidden px-3 text-[10px] font-bold uppercase tracking-[0.15em] text-[#8B9BB4] lg:block">
            Workspace
          </p>

          <nav
            aria-label="Workspace navigation"
            className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0"
          >
            {activeLinks.map(
              (item) => {
                const active =
                  isActiveLink(
                    item.href,
                    pathname
                  );

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={
                      active ? "page" : undefined
                    }
                    className={`flex min-h-10 shrink-0 items-center gap-3 rounded-lg px-3 text-[13px] transition-colors lg:w-full ${
                      active
                        ? "bg-[#33445F] font-semibold text-white"
                        : "text-[#B7C6DA] hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    <span
                      className={
                        active
                          ? "text-[#A7BFFF]"
                          : "text-[#91A7C4]"
                      }
                    >
                      <NavIcon
                        name={item.icon}
                      />
                    </span>

                    {item.label}
                  </Link>
                );
              }
            )}
          </nav>

        </div>

        {/* File 97 — Bottom-left clickable account */}

        <div className="border-t border-white/10 px-3 py-3 lg:mt-auto lg:px-3 lg:py-4">

          <div
            ref={menuAreaRef}
            className="relative"
          >

            <button
              ref={triggerRef}
              type="button"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              aria-haspopup="true"
              onClick={toggleAccountMenu}
              disabled={signingOut}
              className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#91A9FF] ${
                menuOpen ||
                pathname === "/dashboard/profile"
                  ? "bg-[#33445F]"
                  : "hover:bg-white/10"
              }`}
            >
              <AccountAvatar
                name={displayName}
                color={appearance.avatarColor}
              />

              <span className="min-w-0 flex-1">

                <span
                  className="block truncate text-[12px] font-semibold text-white"
                  title={displayName}
                >
                  {displayName}
                </span>

                <span
                  className="mt-0.5 block truncate text-[10px] text-[#A8B7CD]"
                  title={email}
                >
                  {email}
                </span>

              </span>

              <span className="text-[#9DAFC7]">
                <ChevronIcon
                  open={menuOpen}
                />
              </span>

            </button>

            {/* Dropdown menu */}

            {menuOpen && (

              <div
                id={menuId}
                aria-label="Account options"
                className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-[#DDE4EF] bg-white p-1.5 text-[#192437] shadow-[0_18px_45px_rgba(15,29,49,0.22)] lg:bottom-full lg:top-auto lg:mb-3 lg:mt-0"
              >

                {/* Account summary */}

                <div className="flex items-center gap-3 border-b border-[#E7ECF3] px-2.5 py-3">

                  <AccountAvatar
                    name={displayName}
                    color={appearance.avatarColor}
                    size="lg"
                  />

                  <div className="min-w-0 flex-1">

                    <p
                      className="truncate text-[12px] font-semibold"
                      title={displayName}
                    >
                      {displayName}
                    </p>

                    <p
                      className="mt-1 truncate text-[10px] text-[#72839A]"
                      title={email}
                    >
                      {email}
                    </p>

                  </div>

                </div>

                {/* My Profile */}

                <Link
                  href="/dashboard/profile"
                  onClick={() =>
                    setMenuOpen(false)
                  }
                  className="mt-1 flex min-h-10 items-center gap-3 rounded-lg px-3 text-[12px] font-medium text-[#2A3A52] transition-colors hover:bg-[#F1F5FD] focus-visible:outline-2 focus-visible:outline-[#305BE8]"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4 text-[#536A86]"
                  >
                    <circle
                      cx="12"
                      cy="8"
                      r="4"
                    />
                    <path d="M4 21a8 8 0 0 1 16 0" />
                  </svg>

                  My profile
                </Link>

                <div className="my-1 border-t border-[#E7ECF3]" />

                {/* Sign out */}

                <button
                  type="button"
                  onClick={handleSignOut}
                  disabled={signingOut}
                  className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[12px] font-medium text-[#B33A4A] transition-colors hover:bg-[#FFF2F4] focus-visible:outline-2 focus-visible:outline-[#B33A4A] disabled:opacity-60"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                  >
                    <path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5" />
                    <path d="M14 8l4 4-4 4M8 12h10" />
                  </svg>

                  {signingOut
                    ? "Signing out…"
                    : "Sign out"}
                </button>

              </div>
            )}

          </div>
        </div>

      </aside>

      {/* Main workspace */}

      <div className="min-w-0 flex-1">

        {/* Persistent top header */}

        <header className="flex min-h-[75px] flex-wrap items-center justify-between gap-3 border-b border-[#E4E8EF] bg-white px-5 py-4 sm:px-8">

          <div>
            <p className="text-[11px] font-medium text-[#738299]">
              {heading.breadcrumb}
            </p>

            <p className="mt-1 text-[13px] font-semibold text-[#2A3950]">
              {heading.title}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">

            {headerAction}

            <span
              className="hidden max-w-[220px] truncate text-[12px] text-[#65748B] sm:block"
              title={email}
            >
              {email}
            </span>

            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="caas-button caas-button-secondary min-h-9 px-3 py-2 text-[12px]"
            >
              {signingOut
                ? "Signing out…"
                : "Sign out"}
            </button>

          </div>

          {signOutError && (
            <p
              role="alert"
              className="w-full text-right text-[12px] text-[#B43745]"
            >
              {signOutError}
            </p>
          )}

        </header>

        {/* Page content */}

        <main
          id="workspace-main"
          className="mx-auto max-w-[1190px] px-5 py-9 sm:px-8 sm:py-11"
        >
          {children}
        </main>

      </div>

    </div>
  );
}
