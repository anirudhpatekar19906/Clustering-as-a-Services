import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "Create account",
  description:
    "Create your CaaS account to manage datasets and clustering experiments.",
};

const DEV_API_URL = "http://127.0.0.1:8000";

type ErrorCode = "invalid" | "mismatch" | "rejected" | "unavailable";

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  invalid:
    "Enter a valid email and a password with at least 12 characters.",
  mismatch:
    "Your passwords do not match. Please try again.",
  rejected:
    "We couldn't create an account with those details. Check your information or sign in if you already have an account.",
  unavailable:
    "Account registration is temporarily unavailable. Please try again shortly.",
};

async function createAccount(formData: FormData): Promise<void> {
  "use server";

  const rawEmail = formData.get("email");
  const rawPassword = formData.get("password");
  const rawConfirmation = formData.get("confirmPassword");

  const email =
    typeof rawEmail === "string"
      ? rawEmail.trim().toLowerCase()
      : "";

  const password =
    typeof rawPassword === "string" ? rawPassword : "";

  const confirmation =
    typeof rawConfirmation === "string" ? rawConfirmation : "";

  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length < 12 ||
    password.length > 128
  ) {
    redirect("/register?error=invalid");
  }

  if (password !== confirmation) {
    redirect("/register?error=mismatch");
  }

  const configuredBase =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development"
      ? DEV_API_URL
      : "");

  if (!configuredBase) {
    redirect("/register?error=unavailable");
  }

  let endpoint: string;

  try {
    const base = new URL(configuredBase);

    if (
      base.protocol !== "http:" &&
      base.protocol !== "https:"
    ) {
      redirect("/register?error=unavailable");
    }

    endpoint = new URL(
      "/api/v1/auth/register",
      base
    ).toString();
  } catch {
    redirect("/register?error=unavailable");
  }

  let upstream: Response;

  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    redirect("/register?error=unavailable");
  }

  if (
    upstream.status === 200 ||
    upstream.status === 201
  ) {
    redirect("/login?registered=1");
  }

  if ([400, 409, 422].includes(upstream.status)) {
    redirect("/register?error=rejected");
  }

  redirect("/register?error=unavailable");
}

async function RegistrationError({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const code =
    typeof params.error === "string"
      ? params.error
      : "";

  const message = Object.hasOwn(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code as ErrorCode]
    : null;

  if (!message) return null;

  return (
    <div
      role="alert"
      className="mb-6 rounded-lg border border-[#F0C8CD] bg-[#FFF4F5] px-4 py-3 text-[13px] leading-6 text-[#9A3340]"
    >
      {message}
    </div>
  );
}

function BrandMark({
  inverse = false,
}: {
  inverse?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
        inverse
          ? "border border-white/15 bg-white/10"
          : "bg-[#172235]"
      }`}
    >
      <svg
        viewBox="0 0 40 40"
        className="h-8 w-8"
        fill="none"
      >
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

function ClusterIllustration() {
  const colors = ["#91A9FF", "#65D8BD", "#E5B267"];

  const groups = [
    [
      [35, 155], [55, 131], [70, 158], [83, 119],
      [97, 144], [115, 126], [125, 163], [146, 141],
    ],
    [
      [173, 113], [189, 88], [203, 117], [217, 75],
      [233, 100], [246, 68], [261, 114], [280, 83],
    ],
    [
      [284, 58], [300, 34], [316, 62], [330, 23],
      [344, 48], [358, 17], [372, 43], [384, 28],
    ],
  ];

  return (
    <div className="mt-11 max-w-[440px] rounded-2xl border border-white/15 bg-white/[0.055] p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-[#E8EFF9]">
          Discover meaningful groups
        </span>

        <span className="font-mono text-[9px] tracking-wide text-[#94A7C4]">
          SAMPLE VIEW
        </span>
      </div>

      <svg
        viewBox="0 0 410 185"
        className="w-full"
        role="img"
        aria-label="Illustration showing three separate groups of data points"
      >
        {[32, 76, 120, 164].map((y) => (
          <line
            key={y}
            x1="12"
            x2="398"
            y1={y}
            y2={y}
            stroke="#62728A"
            strokeOpacity="0.45"
            strokeDasharray="3 7"
          />
        ))}

        {groups.flatMap((group, cluster) =>
          group.map(([x, y], point) => (
            <circle
              key={`${cluster}-${point}`}
              cx={x}
              cy={y}
              r="5"
              fill={colors[cluster]}
            />
          ))
        )}
      </svg>

      <div className="mt-3 flex flex-wrap gap-5 text-[11px] text-[#C3D0E2]">
        {colors.map((color, i) => (
          <span
            key={color}
            className="flex items-center gap-2"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: color }}
            />

            Cluster {String(i + 1).padStart(2, "0")}
          </span>
        ))}
      </div>

      <p className="mt-4 text-[10px] leading-5 text-[#A0B1C9]">
        Illustrative data only. Your workspace will show
        your own datasets and results.
      </p>
    </div>
  );
}

type RegisterPageProps = {
  searchParams: Promise<{
    error?: string | string[];
  }>;
};

export default function RegisterPage({
  searchParams,
}: RegisterPageProps) {
  return (
    <main className="min-h-dvh bg-[#F7F8FA] text-[#172235]">
      <div className="mx-auto grid min-h-dvh max-w-[1600px] lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1fr)]">
        {/* Desktop branding panel */}
        <section className="relative hidden min-h-dvh flex-col overflow-hidden bg-[#172235] px-12 py-11 text-white lg:flex xl:px-16">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.12]"
            style={{
              backgroundImage:
                "linear-gradient(#A3B5D3 1px,transparent 1px),linear-gradient(90deg,#A3B5D3 1px,transparent 1px)",
              backgroundSize: "64px 64px",
            }}
          />

          <Link
            href="/"
            className="relative flex w-fit items-center gap-3 rounded-md"
          >
            <BrandMark inverse />

            <span className="text-[22px] font-semibold tracking-[-0.055em]">
              caas<span className="text-[#91A9FF]">.</span>
            </span>

            <span className="ml-2 border-l border-white/20 pl-4 text-xs text-[#ABBBD0]">
              Clustering workspace
            </span>
          </Link>

          <div className="relative my-auto max-w-[540px] py-16">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-2 text-[11px] font-semibold tracking-[0.08em] text-[#B7C8E7] uppercase">
              <span className="h-1.5 w-1.5 rounded-full bg-[#65D8BD]" />
              Built for a clearer perspective
            </span>

            <h1 className="mt-8 text-[clamp(2.9rem,4.3vw,4.5rem)] leading-[1.09] font-semibold tracking-[-0.065em]">
              Your data has a story.
              <span className="mt-1 block text-[#9AAFF6]">
                Find its structure.
              </span>
            </h1>

            <p className="mt-6 max-w-[430px] text-[15px] leading-7 text-[#B4C2D7]">
              Create a workspace for your datasets,
              clustering experiments, and the insights
              behind every segment.
            </p>

            <ClusterIllustration />
          </div>

          <p className="relative text-[12px] text-[#95A6BE]">
            CaaS · Clustering with clarity
          </p>
        </section>

        {/* Registration form */}
        <section className="flex min-h-dvh flex-col bg-white px-5 py-6 sm:px-10 sm:py-9 lg:px-12 xl:px-20">
          <div className="flex items-center justify-between gap-4">
            <Link
              href="/"
              className="flex items-center gap-2.5 rounded-md font-semibold lg:hidden"
            >
              <BrandMark />
              caas.
            </Link>

            <div className="hidden lg:block" />

            <Link
              href="/"
              className="rounded-md px-2 py-1 text-[13px] font-medium text-[#65758C] hover:text-[#305BE8]"
            >
              ← Back to home
            </Link>
          </div>

          <div className="mx-auto flex w-full max-w-[425px] flex-1 flex-col justify-center py-12 sm:py-16">
            <p className="text-[11px] font-semibold tracking-[0.14em] text-[#4666BF] uppercase">
              Get started
            </p>

            <h2 className="mt-3 text-[36px] leading-tight font-semibold tracking-[-0.055em] sm:text-[42px]">
              Create your account.
            </h2>

            <p className="mt-3 mb-8 text-[14px] leading-6 text-[#718097]">
              One workspace for your datasets, experiments,
              and clustering results.
            </p>

            <Suspense fallback={null}>
              <RegistrationError
                searchParams={searchParams}
              />
            </Suspense>

            <form
              action={createAccount}
              className="space-y-5"
            >
              <div>
                <label
                  htmlFor="register-email"
                  className="caas-label"
                >
                  Email address
                </label>

                <input
                  id="register-email"
                  name="email"
                  type="email"
                  className="caas-input"
                  placeholder="you@example.com"
                  autoComplete="email"
                  maxLength={254}
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="register-password"
                  className="caas-label"
                >
                  Password
                </label>

                <input
                  id="register-password"
                  name="password"
                  type="password"
                  className="caas-input"
                  placeholder="Create a strong password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  aria-describedby="register-password-hint"
                />

                <p
                  id="register-password-hint"
                  className="mt-2 text-[12px] text-[#68788F]"
                >
                  Use at least 12 characters. Avoid reused
                  passwords.
                </p>
              </div>

              <div>
                <label
                  htmlFor="register-confirm"
                  className="caas-label"
                >
                  Confirm password
                </label>

                <input
                  id="register-confirm"
                  name="confirmPassword"
                  type="password"
                  className="caas-input"
                  placeholder="Enter your password again"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                />
              </div>

              <button
                type="submit"
                className="caas-button caas-button-primary mt-3 w-full"
              >
                Create CaaS account
                <span aria-hidden="true">↗</span>
              </button>
            </form>

            <div className="mt-8 border-t border-[#E6EAF0] pt-6 text-center text-[13px] text-[#718097]">
              Already have an account?{" "}
              <Link
                href="/login"
                className="font-semibold text-[#305BE8] hover:underline"
              >
                Sign in
              </Link>
            </div>

            <p className="mt-5 text-center text-[11px] leading-5 text-[#8995A6]">
              Your information is sent to our server over
              the application&apos;s connection. Do not reuse
              another account&apos;s password.
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-[#EDF0F4] pt-5 text-[11px] text-[#8794A6]">
            <span>© 2026 CaaS</span>
            <span>Secure, server-handled registration</span>
          </div>
        </section>
      </div>
    </main>
  );
}
