"use client";

/**
 * File 77 — Login with automatic dashboard redirect.
 *
 * After a successful POST /api/auth/login:
 * 1. The Next.js API route sets the HttpOnly session cookie.
 * 2. Browser JavaScript never receives or stores the JWT.
 * 3. The browser automatically navigates to /dashboard.
 *
 * A direct dashboard link remains as a fallback.
 */

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";

type LoginResponse = {
  success?: boolean;
  message?: string;
};

function BrandMark({
  light = false,
}: {
  light?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
        light
          ? "bg-white/12 ring-1 ring-white/15"
          : "bg-[#172235]"
      }`}
    >
      <svg viewBox="0 0 40 40" className="h-8 w-8" fill="none">
        <rect
          x="8"
          y="7"
          width="9"
          height="9"
          rx="2.2"
          fill="#FFFFFF"
        />
        <rect
          x="23"
          y="13"
          width="9"
          height="9"
          rx="2.2"
          fill="#91A9FF"
        />
        <rect
          x="16"
          y="25"
          width="9"
          height="9"
          rx="2.2"
          fill="#65D8BD"
        />
      </svg>
    </span>
  );
}

function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className="h-4 w-4"
    >
      <path
        d="M4.5 10h10.75m-4.5-4.5L15.25 10l-4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EyeIcon({
  visible,
}: {
  visible: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      className="h-[19px] w-[19px]"
    >
      <path
        d="M2.5 12s3.5-5.75 9.5-5.75S21.5 12 21.5 12s-3.5 5.75-9.5 5.75S2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      <circle
        cx="12"
        cy="12"
        r="2.6"
        stroke="currentColor"
        strokeWidth="1.5"
      />

      {!visible && (
        <path
          d="M4 20 20 4"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [signedIn, setSignedIn] = useState(false);
  const [justRegistered, setJustRegistered] = useState(false);

  // Read the registration redirect after hydration.
  // This avoids depending on browser URL data during prerendering.
  useEffect(() => {
    const params = new URLSearchParams(
      window.location.search
    );

    setJustRegistered(
      params.get("registered") === "1"
    );
  }, []);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (isSubmitting || signedIn) return;

    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(
        "/api/auth/login",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({
            email: email.trim(),
            password,
          }),
        }
      );

      const data = (
        await response.json().catch(() => null)
      ) as LoginResponse | null;

      if (
        !response.ok ||
        data?.success !== true
      ) {
        if (response.status === 401) {
          setError(
            "Incorrect email or password. Please try again."
          );
        } else if (response.status === 429) {
          setError(
            "Too many sign-in attempts. Please try again later."
          );
        } else {
          setError(
            data?.message ||
              "Sign-in is unavailable right now. Please try again."
          );
        }

        return;
      }

      /**
       * LOGIN SUCCESS
       *
       * Our Next.js login API has now set the HttpOnly
       * caas_access_token cookie.
       *
       * Never store the JWT in localStorage or
       * browser JavaScript state.
       *
       * A full navigation ensures that the protected
       * dashboard is requested with the new cookie.
       *
       * replace() also prevents the browser Back button
       * from returning to the completed login form.
       */
      setPassword("");
      setSignedIn(true);

      window.location.replace("/dashboard");
    } catch {
      setError(
        "We could not connect to the sign-in service. Check your connection."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-dvh bg-[#F7F8FA] text-[#172235]">
      <div className="mx-auto grid min-h-dvh max-w-[1600px] lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1fr)]">
        {/* Left branding panel */}
        <section className="relative hidden min-h-dvh flex-col overflow-hidden bg-[#172235] px-12 py-10 text-white lg:flex xl:px-16 xl:py-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.13]"
            style={{
              backgroundImage:
                "linear-gradient(#A3B5D3 1px, transparent 1px), linear-gradient(90deg, #A3B5D3 1px, transparent 1px)",
              backgroundSize: "64px 64px",
              maskImage:
                "linear-gradient(130deg, transparent 9%, black 72%)",
            }}
          />

          <div className="relative flex items-center gap-3">
            <BrandMark light />

            <span className="text-[22px] font-semibold tracking-[-0.055em]">
              caas
              <span className="text-[#91A9FF]">
                .
              </span>
            </span>

            <span className="ml-3 border-l border-white/20 pl-4 text-xs text-[#9BABBF]">
              Clustering workspace
            </span>
          </div>

          <div className="relative my-auto max-w-[520px] py-16">
            <div className="mb-7 flex w-fit items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-2 text-[11px] font-semibold tracking-[0.08em] text-[#B8C8E7] uppercase">
              <span className="h-1.5 w-1.5 rounded-full bg-[#65D8BD]" />
              Your analysis, in focus
            </div>

            <h1 className="max-w-[480px] text-[clamp(2.8rem,4.4vw,4.5rem)] leading-[1.09] font-semibold tracking-[-0.065em]">
              Better insights begin with

              <span className="block text-[#9AAFF6]">
                clearer clusters.
              </span>
            </h1>

            <p className="mt-6 max-w-[405px] text-[15px] leading-7 text-[#ABBCD2]">
              Keep your datasets, experiments, and clustering
              results in a workspace designed for focused analysis.
            </p>

            <div className="mt-12 max-w-[425px] rounded-2xl border border-white/15 bg-white/[0.06] p-5 shadow-[0_25px_65px_rgba(0,0,0,0.12)] backdrop-blur-sm">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-xs font-medium text-[#E5ECF9]">
                  Cluster exploration
                </span>

                <span className="rounded-md border border-white/15 px-2 py-1 font-mono text-[10px] text-[#9AABC5]">
                  WORKSPACE PREVIEW
                </span>
              </div>

              <svg
                viewBox="0 0 408 170"
                className="w-full"
                role="img"
                aria-label="Illustration of three distinct groups of data points"
              >
                {[28, 65, 102, 139].map((y) => (
                  <line
                    key={y}
                    x1="12"
                    x2="396"
                    y1={y}
                    y2={y}
                    stroke="#52627C"
                    strokeWidth="0.7"
                    strokeDasharray="3 6"
                  />
                ))}

                {[
                  [47, 126],
                  [65, 113],
                  [80, 137],
                  [94, 105],
                  [109, 126],
                  [122, 100],
                  [133, 142],
                  [152, 117],
                  [70, 147],
                  [110, 155],
                ].map(([x, y], index) => (
                  <circle
                    key={`a-${index}`}
                    cx={x}
                    cy={y}
                    r="5"
                    fill="#8FA9FF"
                  />
                ))}

                {[
                  [169, 78],
                  [185, 97],
                  [199, 69],
                  [215, 87],
                  [227, 57],
                  [244, 79],
                  [258, 101],
                  [271, 65],
                  [209, 113],
                  [237, 119],
                ].map(([x, y], index) => (
                  <circle
                    key={`b-${index}`}
                    cx={x}
                    cy={y}
                    r="5"
                    fill="#65D8BD"
                  />
                ))}

                {[
                  [287, 46],
                  [301, 27],
                  [313, 56],
                  [328, 39],
                  [344, 19],
                  [356, 47],
                  [372, 24],
                  [385, 56],
                  [338, 72],
                  [365, 78],
                ].map(([x, y], index) => (
                  <circle
                    key={`c-${index}`}
                    cx={x}
                    cy={y}
                    r="5"
                    fill="#E5B267"
                  />
                ))}
              </svg>

              <div className="mt-4 flex flex-wrap gap-5 text-[11px] text-[#C2CDE0]">
                {[
                  {
                    name: "Segment 01",
                    color: "#8FA9FF",
                  },
                  {
                    name: "Segment 02",
                    color: "#65D8BD",
                  },
                  {
                    name: "Segment 03",
                    color: "#E5B267",
                  },
                ].map((segment) => (
                  <span
                    key={segment.name}
                    className="inline-flex items-center gap-2"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{
                        backgroundColor: segment.color,
                      }}
                    />

                    {segment.name}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <p className="relative text-[12px] text-[#8293AC]">
            CaaS · Clustering with clarity
          </p>
        </section>

        {/* Right authentication panel */}
        <section className="flex min-h-dvh flex-col bg-white px-5 py-6 sm:px-10 sm:py-9 lg:px-12 xl:px-20">
          <div className="flex items-center justify-between gap-4">
            <Link
              href="/"
              className="inline-flex items-center gap-2.5 rounded-md text-sm font-semibold tracking-[-0.03em] text-[#172235] lg:hidden"
              aria-label="CaaS home"
            >
              <BrandMark />
              caas.
            </Link>

            <div className="hidden lg:block" />

            <Link
              href="/"
              className="rounded-md px-2 py-1 text-[13px] font-medium text-[#68778E] transition-colors hover:text-[#305BE8]"
            >
              ← Back to home
            </Link>
          </div>

          <div className="mx-auto flex w-full max-w-[425px] flex-1 flex-col justify-start pt-7 pb-10 sm:pt-8 sm:pb-12">
            {signedIn ? (
              <div
                role="status"
                aria-live="polite"
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#E8F6F1] text-[#16816C]">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    className="h-7 w-7"
                    aria-hidden="true"
                  >
                    <path
                      d="m5 12 4.5 4.5L19 7"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>

                <p className="mt-7 text-[11px] font-semibold tracking-[0.14em] text-[#16816C] uppercase">
                  Authentication successful
                </p>

                <h2 className="mt-3 text-[36px] leading-tight font-semibold tracking-[-0.055em]">
                  You&apos;re signed in.
                </h2>

                <p className="mt-4 text-[14px] leading-7 text-[#68778E]">
                  Your session was created successfully.
                  Opening your clustering workspace now…
                </p>

                <Link
                  href="/dashboard"
                  className="caas-button caas-button-primary mt-8 w-full"
                >
                  Open dashboard
                  <ArrowIcon />
                </Link>
              </div>
            ) : (
              <>
                <div className="mb-9">
                  <p className="text-[11px] font-semibold tracking-[0.14em] text-[#4666BF] uppercase">
                    Welcome back
                  </p>

                  <h2 className="mt-3 text-[36px] leading-tight font-semibold tracking-[-0.055em] sm:text-[42px]">
                    Sign in to CaaS.
                  </h2>

                  <p className="mt-3 text-[14px] leading-6 text-[#718097]">
                    Access your datasets, clustering runs,
                    and saved results.
                  </p>
                </div>

                {justRegistered && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="mb-7 flex items-start gap-3 rounded-lg border border-[#BFE7D7] bg-[#ECF8F3] px-4 py-3 text-[13px] leading-5 text-[#196F5A]"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-0.5 text-base font-bold"
                    >
                      ✓
                    </span>

                    <div>
                      <p className="font-semibold">
                        Account created successfully.
                      </p>

                      <p className="mt-1 text-[#376D5D]">
                        Sign in with the email and password
                        you just registered.
                      </p>
                    </div>
                  </div>
                )}

                <form
                  onSubmit={handleSubmit}
                  className="space-y-5"
                >
                  <div>
                    <label
                      htmlFor="login-email"
                      className="caas-label"
                    >
                      Email address
                    </label>

                    <input
                      id="login-email"
                      className="caas-input"
                      type="email"
                      name="email"
                      value={email}
                      onChange={(event) =>
                        setEmail(event.target.value)
                      }
                      placeholder="you@example.com"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={254}
                      disabled={isSubmitting}
                      required
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="login-password"
                      className="caas-label"
                    >
                      Password
                    </label>

                    <div className="relative">
                      <input
                        id="login-password"
                        className="caas-input pr-12"
                        type={
                          showPassword
                            ? "text"
                            : "password"
                        }
                        name="password"
                        value={password}
                        onChange={(event) =>
                          setPassword(event.target.value)
                        }
                        placeholder="Enter your password"
                        autoComplete="current-password"
                        disabled={isSubmitting}
                        required
                      />

                      <button
                        type="button"
                        onClick={() =>
                          setShowPassword(
                            (value) => !value
                          )
                        }
                        className="absolute inset-y-0 right-1 flex w-10 items-center justify-center rounded-md text-[#7C899C] transition-colors hover:text-[#305BE8]"
                        aria-label={
                          showPassword
                            ? "Hide password"
                            : "Show password"
                        }
                        aria-pressed={showPassword}
                        disabled={isSubmitting}
                      >
                        <EyeIcon
                          visible={showPassword}
                        />
                      </button>
                    </div>
                  </div>

                  {error && (
                    <div
                      role="alert"
                      className="rounded-lg border border-[#F2C8CE] bg-[#FFF4F5] px-4 py-3 text-[13px] leading-5 text-[#9F303D]"
                    >
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="caas-button caas-button-primary mt-2 w-full"
                  >
                    {isSubmitting ? (
                      <>
                        <span
                          aria-hidden="true"
                          className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                        />

                        Signing in…
                      </>
                    ) : (
                      <>
                        Sign in to your workspace
                        <ArrowIcon />
                      </>
                    )}
                  </button>
                </form>

                <div className="mt-8 border-t border-[#E6EAF0] pt-6">
                  <p className="text-center text-[13px] text-[#718097]">
                    New to CaaS?{" "}

                    <Link
                      href="/register"
                      className="rounded-sm font-semibold text-[#305BE8] transition-colors hover:text-[#244CD6] hover:underline"
                    >
                      Create an account
                    </Link>
                  </p>
                </div>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#EDF0F4] pt-5 text-[11px] text-[#8794A6]">
            <span>© 2026 CaaS</span>

            <span className="inline-flex items-center gap-1.5">
              <svg
                viewBox="0 0 20 20"
                fill="none"
                className="h-3.5 w-3.5"
                aria-hidden="true"
              >
                <rect
                  x="4.5"
                  y="8.5"
                  width="11"
                  height="9"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />

                <path
                  d="M7 8.5V6a3 3 0 0 1 6 0v2.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>

              Secure session cookie
            </span>
          </div>
        </section>
      </div>
    </main>
  );
}
