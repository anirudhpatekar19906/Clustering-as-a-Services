"use client";

/**
 * File 96 — CaaS editable profile page.
 *
 * Uses the existing, owner-scoped Next.js bridge:
 *   GET   /api/profile
 *   PATCH /api/profile
 *
 * The browser never reads the JWT: it stays in an HttpOnly cookie.
 * Profile data is loaded only after the authenticated API succeeds.
 * The bottom-left account dropdown will link here in File 97.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

type Gender =
  | "woman"
  | "man"
  | "non_binary"
  | "self_described"
  | "prefer_not_to_say";

type AvatarColor =
  | "#305BE8"
  | "#129A8E"
  | "#8B5CF6"
  | "#D97735"
  | "#46627F";

const AVATARS: {
  value: AvatarColor;
  label: string;
}[] = [
  { value: "#305BE8", label: "CaaS blue" },
  { value: "#129A8E", label: "Teal" },
  { value: "#8B5CF6", label: "Violet" },
  { value: "#D97735", label: "Amber" },
  { value: "#46627F", label: "Slate" },
];

const GENDERS: {
  value: Gender | "";
  label: string;
}[] = [
  { value: "", label: "Not specified" },
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
  { value: "non_binary", label: "Non-binary" },
  { value: "self_described", label: "Self-describe" },
  {
    value: "prefer_not_to_say",
    label: "Prefer not to say",
  },
];

type Profile = {
  user_id: string;
  email: string;

  display_name: string | null;
  full_name: string | null;
  bio: string | null;

  age: number | null;
  gender: Gender | null;
  gender_description: string | null;

  occupation: string | null;
  organization: string | null;

  avatar_color: AvatarColor;

  joined_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type ProfileResponse = {
  success: true;
  profile_exists: boolean;
  profile: Profile;
};

type Draft = {
  display_name: string;
  full_name: string;
  bio: string;
  age: string;
  gender: Gender | "";
  gender_description: string;
  occupation: string;
  organization: string;
  avatar_color: AvatarColor;
};

type Patch = Record<string, string | number | null>;

type LoadState = "loading" | "ready" | "error";

/* =====================================================
   API response validation
   ===================================================== */

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseProfile(
  value: unknown
): ProfileResponse | null {
  if (
    !isRecord(value) ||
    value.success !== true ||
    typeof value.profile_exists !== "boolean" ||
    !isRecord(value.profile)
  ) {
    return null;
  }

  const p = value.profile;

  const textOrNull = (v: unknown) =>
    v === null || typeof v === "string";

  const dateOrNull = (v: unknown) =>
    v === null ||
    (
      typeof v === "string" &&
      Number.isFinite(Date.parse(v))
    );

  if (
    typeof p.user_id !== "string" ||
    typeof p.email !== "string" ||
    !textOrNull(p.display_name) ||
    !textOrNull(p.full_name) ||
    !textOrNull(p.bio) ||
    !textOrNull(p.gender_description) ||
    !textOrNull(p.occupation) ||
    !textOrNull(p.organization) ||
    (
      p.age !== null &&
      (
        typeof p.age !== "number" ||
        !Number.isInteger(p.age)
      )
    ) ||
    (
      p.gender !== null &&
      !GENDERS.some(
        (g) => g.value === p.gender
      )
    ) ||
    !AVATARS.some(
      (a) => a.value === p.avatar_color
    ) ||
    !dateOrNull(p.joined_at) ||
    !dateOrNull(p.created_at) ||
    !dateOrNull(p.updated_at)
  ) {
    return null;
  }

  return value as ProfileResponse;
}

/* =====================================================
   Convert database profile into editable form
   ===================================================== */

function makeDraft(profile: Profile): Draft {
  return {
    display_name: profile.display_name ?? "",
    full_name: profile.full_name ?? "",
    bio: profile.bio ?? "",

    age:
      profile.age === null
        ? ""
        : String(profile.age),

    gender: profile.gender ?? "",

    gender_description:
      profile.gender_description ?? "",

    occupation: profile.occupation ?? "",
    organization: profile.organization ?? "",

    avatar_color: profile.avatar_color,
  };
}

/* =====================================================
   Normalize optional fields
   ===================================================== */

function normalized(draft: Draft): Patch {
  const optional = (text: string): string | null =>
    text.trim() || null;

  return {
    display_name: optional(draft.display_name),
    full_name: optional(draft.full_name),

    bio: optional(
      draft.bio.replace(/\r\n/g, "\n")
    ),

    age:
      draft.age.trim() === ""
        ? null
        : Number(draft.age),

    gender: draft.gender || null,

    gender_description:
      draft.gender === "self_described"
        ? optional(draft.gender_description)
        : null,

    occupation: optional(draft.occupation),
    organization: optional(draft.organization),

    avatar_color: draft.avatar_color,
  };
}

/* =====================================================
   Send only fields that were changed
   ===================================================== */

function makePatch(
  draft: Draft,
  original: Profile
): Patch {
  const before = normalized(
    makeDraft(original)
  );

  const after = normalized(draft);

  const patch: Patch = {};

  for (const key of Object.keys(after)) {
    if (
      !Object.is(
        after[key],
        before[key]
      )
    ) {
      patch[key] = after[key];
    }
  }

  return patch;
}

/* =====================================================
   Form validation
   ===================================================== */

function validateDraft(
  draft: Draft
): string | null {
  if (draft.age.trim()) {
    const age = Number(draft.age);

    if (
      !Number.isInteger(age) ||
      age < 0 ||
      age > 120
    ) {
      return (
        "Age must be a whole number between " +
        "0 and 120, or left blank."
      );
    }
  }

  if (
    draft.gender === "self_described" &&
    !draft.gender_description.trim()
  ) {
    return (
      "Please provide a short gender description, " +
      "or choose another option."
    );
  }

  return null;
}

/* =====================================================
   Avatar and date helpers
   ===================================================== */

function initials(
  draft: Draft,
  email: string
): string {
  const source =
    draft.display_name.trim() ||
    draft.full_name.trim();

  if (source) {
    return source
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] ?? "")
      .join("")
      .toUpperCase();
  }

  return (
    email.charAt(0) || "U"
  ).toUpperCase();
}

function readableDate(
  value: string | null
): string {
  if (!value) {
    return "Not available";
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

/* =====================================================
   Reusable form field
   ===================================================== */

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="caas-label">
        {label}
      </span>

      {children}

      {hint && (
        <span className="mt-1.5 block text-[11px] leading-5 text-[#8290A5]">
          {hint}
        </span>
      )}
    </label>
  );
}

/* =====================================================
   Main Profile page
   ===================================================== */

export default function ProfilePage() {
  const router = useRouter();

  const [loadState, setLoadState] =
    useState<LoadState>("loading");

  const [reload, setReload] = useState(0);

  const [profile, setProfile] =
    useState<Profile | null>(null);

  const [profileExists, setProfileExists] =
    useState(false);

  const [draft, setDraft] =
    useState<Draft | null>(null);

  const [loadError, setLoadError] =
    useState("");

  const [saveError, setSaveError] =
    useState("");

  const [saved, setSaved] =
    useState(false);

  const [saving, setSaving] =
    useState(false);

  /* ---------------------------------------------------
     Load authenticated profile
     --------------------------------------------------- */

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoadState("loading");
      setLoadError("");

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
          router.replace(
            "/login?session=expired"
          );

          return;
        }

        const raw: unknown =
          await response
            .json()
            .catch(() => null);

        if (!response.ok) {
          const message =
            isRecord(raw) &&
            typeof raw.message === "string"
              ? raw.message
              : "Profile service is unavailable. Please retry.";

          throw new Error(message);
        }

        const result = parseProfile(raw);

        if (!result) {
          throw new Error(
            "The profile service returned invalid data."
          );
        }

        if (!controller.signal.aborted) {
          setProfile(result.profile);
          setProfileExists(result.profile_exists);

          setDraft(
            makeDraft(result.profile)
          );

          setSaved(false);
          setSaveError("");
          setLoadState("ready");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Unable to load profile."
          );

          setLoadState("error");
        }
      }
    }

    void load();

    return () => controller.abort();
  }, [reload, router]);

  /* ---------------------------------------------------
     Change an individual form field
     --------------------------------------------------- */

  function change<K extends keyof Draft>(
    key: K,
    value: Draft[K]
  ) {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            [key]: value,
          }
        : previous
    );

    setSaved(false);
    setSaveError("");
  }

  const changed =
    !!profile &&
    !!draft &&
    Object.keys(
      makePatch(draft, profile)
    ).length > 0;

  /* ---------------------------------------------------
     Save changed fields to PostgreSQL
     --------------------------------------------------- */

  async function save(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    if (
      !profile ||
      !draft ||
      saving
    ) {
      return;
    }

    setSaved(false);

    const validationError =
      validateDraft(draft);

    if (validationError) {
      setSaveError(validationError);
      return;
    }

    const patch = makePatch(
      draft,
      profile
    );

    if (
      !Object.keys(patch).length
    ) {
      setSaveError(
        "There are no new changes to save."
      );

      return;
    }

    setSaving(true);
    setSaveError("");

    try {
      const response = await fetch(
        "/api/profile",
        {
          method: "PATCH",
          credentials: "same-origin",
          cache: "no-store",

          headers: {
            "Content-Type": "application/json",
          },

          body: JSON.stringify(patch),
        }
      );

      if (
        response.status === 401 ||
        response.status === 403
      ) {
        router.replace(
          "/login?session=expired"
        );

        return;
      }

      const raw: unknown =
        await response
          .json()
          .catch(() => null);

      if (!response.ok) {
        throw new Error(
          isRecord(raw) &&
          typeof raw.message === "string"
            ? raw.message
            : "Your profile could not be saved. Please retry."
        );
      }

      const result = parseProfile(raw);

      if (
        !result ||
        !result.profile_exists ||
        result.profile.user_id !==
          profile.user_id
      ) {
        throw new Error(
          "Profile service returned an unexpected save response."
        );
      }

      setProfile(result.profile);
      setProfileExists(true);

      setDraft(
        makeDraft(result.profile)
      );

      setSaved(true);

      // Notify the persistent sidebar after PostgreSQL confirms the save.
      window.dispatchEvent(
        new CustomEvent("caas:profile-updated", {
          detail: {
            success: true,
            profile: {
              email: result.profile.email,
              display_name: result.profile.display_name,
              avatar_color: result.profile.avatar_color,
            },
          },
        })
      );
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Unable to save profile."
      );
    } finally {
      setSaving(false);
    }
  }

  /* ===================================================
     Page UI
     =================================================== */

  return (
    <div className="space-y-7">

      {/* Page heading */}

      <div className="flex flex-wrap items-end justify-between gap-4">

        <div>
          <p className="caas-eyebrow">
            Account / Personal profile
          </p>

          <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.055em] text-[#172235] sm:text-[39px]">
            My profile.
          </h1>

          <p className="mt-3 max-w-[670px] text-[14px] leading-6 text-[#697A92]">
            Make this workspace yours. Add a name and
            a little about yourself — all details
            are optional.
          </p>
        </div>

        <Link
          href="/dashboard"
          className="caas-button caas-button-secondary"
        >
          Back to overview
        </Link>

      </div>

      {/* Loading skeleton */}

      {loadState === "loading" && (
        <div
          role="status"
          className="grid animate-pulse gap-5 xl:grid-cols-[minmax(0,1fr)_300px]"
        >
          <div className="caas-card h-[450px]" />
          <div className="caas-card h-[300px]" />

          <span className="sr-only">
            Loading your profile…
          </span>
        </div>
      )}

      {/* Load error */}

      {loadState === "error" && (
        <section
          role="alert"
          className="caas-card max-w-[670px] p-7"
        >
          <h2 className="text-[19px] font-semibold text-[#172235]">
            Profile unavailable
          </h2>

          <p className="mt-3 text-[13px] leading-6 text-[#6B7C94]">
            {loadError}
          </p>

          <button
            type="button"
            className="caas-button caas-button-primary mt-5"
            onClick={() =>
              setReload(
                (value) => value + 1
              )
            }
          >
            Try again
          </button>
        </section>
      )}

      {/* Editable profile */}

      {loadState === "ready" &&
        draft &&
        profile && (

        <form
          onSubmit={save}
          noValidate
          className="space-y-5"
        >

          <fieldset
            disabled={saving}
            className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]"
          >

            {/* Left: editable information */}

            <div className="min-w-0 space-y-5">

              {/* Personal details */}

              <section className="caas-card overflow-hidden">

                <div className="caas-card-header">
                  <h2 className="text-[17px] font-semibold text-[#192437]">
                    Personal details
                  </h2>

                  <p className="mt-1 text-[12px] text-[#75849A]">
                    How you'd like to be known in CaaS.
                  </p>
                </div>

                <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">

                  <Field
                    label="Display name"
                    hint="This name will appear in the account menu."
                  >
                    <input
                      className="caas-input"
                      value={draft.display_name}
                      maxLength={80}
                      placeholder="How should we call you?"
                      onChange={(event) =>
                        change(
                          "display_name",
                          event.target.value
                        )
                      }
                    />
                  </Field>

                  <Field label="Full name (optional)">
                    <input
                      className="caas-input"
                      value={draft.full_name}
                      maxLength={120}
                      autoComplete="name"
                      placeholder="Your full name"
                      onChange={(event) =>
                        change(
                          "full_name",
                          event.target.value
                        )
                      }
                    />
                  </Field>

                  <Field
                    label="Age (optional)"
                    hint="Only add this if you want to."
                  >
                    <input
                      className="caas-input"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={120}
                      step={1}
                      value={draft.age}
                      placeholder="e.g. 24"
                      onChange={(event) =>
                        change(
                          "age",
                          event.target.value
                        )
                      }
                    />
                  </Field>

                  <Field label="Gender (optional)">
                    <select
                      className="caas-input"
                      value={draft.gender}
                      onChange={(event) => {
                        const next =
                          event.target.value as Draft["gender"];

                        setDraft(
                          (previous) =>
                            previous
                              ? {
                                  ...previous,
                                  gender: next,

                                  gender_description:
                                    next === "self_described"
                                      ? previous.gender_description
                                      : "",
                                }
                              : previous
                        );

                        setSaved(false);
                        setSaveError("");
                      }}
                    >
                      {GENDERS.map(
                        (option) => (
                          <option
                            key={option.value}
                            value={option.value}
                          >
                            {option.label}
                          </option>
                        )
                      )}
                    </select>
                  </Field>

                  {draft.gender === "self_described" && (
                    <div className="sm:col-span-2">

                      <Field label="How would you describe your gender?">
                        <input
                          className="caas-input"
                          value={
                            draft.gender_description
                          }
                          maxLength={80}
                          placeholder="Your description"
                          onChange={(event) =>
                            change(
                              "gender_description",
                              event.target.value
                            )
                          }
                        />
                      </Field>

                    </div>
                  )}

                </div>
              </section>

              {/* About you */}

              <section className="caas-card overflow-hidden">

                <div className="caas-card-header">

                  <h2 className="text-[17px] font-semibold text-[#192437]">
                    About you
                  </h2>

                  <p className="mt-1 text-[12px] text-[#75849A]">
                    A few optional details for your
                    personal workspace.
                  </p>

                </div>

                <div className="space-y-5 p-5 sm:p-6">

                  <Field
                    label="Short bio"
                    hint={`${draft.bio.length}/500 characters · Visible only in your private profile.`}
                  >
                    <textarea
                      className="caas-input min-h-[125px] resize-y"
                      rows={4}
                      maxLength={500}
                      value={draft.bio}
                      placeholder="A little about your work, interests, or what you're exploring…"
                      onChange={(event) =>
                        change(
                          "bio",
                          event.target.value
                        )
                      }
                    />
                  </Field>

                  <div className="grid gap-5 sm:grid-cols-2">

                    <Field label="Occupation (optional)">
                      <input
                        className="caas-input"
                        value={draft.occupation}
                        maxLength={100}
                        placeholder="e.g. Data analyst, student"
                        onChange={(event) =>
                          change(
                            "occupation",
                            event.target.value
                          )
                        }
                      />
                    </Field>

                    <Field label="Organization (optional)">
                      <input
                        className="caas-input"
                        value={draft.organization}
                        maxLength={120}
                        placeholder="Company, college, or team"
                        onChange={(event) =>
                          change(
                            "organization",
                            event.target.value
                          )
                        }
                      />
                    </Field>

                  </div>

                </div>
              </section>

            </div>

            {/* Right: profile preview and account details */}

            <aside className="min-w-0 space-y-5">

              {/* Avatar preview */}

              <section className="caas-card overflow-hidden">

                <div className="caas-card-header">

                  <h2 className="text-[17px] font-semibold text-[#192437]">
                    Profile preview
                  </h2>

                  <p className="mt-1 text-[12px] text-[#75849A]">
                    Your initials-based avatar.
                  </p>

                </div>

                <div className="p-5 sm:p-6">

                  <div className="flex flex-col items-center rounded-xl bg-[#F5F7FB] px-4 py-6 text-center">

                    <span
                      aria-hidden="true"
                      className="flex h-[74px] w-[74px] items-center justify-center rounded-[24px] text-[25px] font-semibold text-white shadow-sm"
                      style={{
                        backgroundColor:
                          draft.avatar_color,
                      }}
                    >
                      {initials(
                        draft,
                        profile.email
                      )}
                    </span>

                    <strong className="mt-3 max-w-full break-words text-[16px] text-[#172235]">
                      {draft.display_name.trim() ||
                        draft.full_name.trim() ||
                        "Your profile"}
                    </strong>

                    <p className="mt-1 max-w-full break-all text-[11px] text-[#74839B]">
                      {profile.email}
                    </p>

                    <span className="mt-3 rounded-full bg-white px-3 py-1 text-[11px] font-medium text-[#526681]">
                      {profileExists
                        ? "Profile created"
                        : "Not set up yet"}
                    </span>

                  </div>

                  <p className="mt-5 text-[12px] font-semibold text-[#354963]">
                    Avatar color
                  </p>

                  <div
                    className="mt-3 flex flex-wrap gap-3"
                    role="group"
                    aria-label="Choose avatar color"
                  >

                    {AVATARS.map((color) => (

                      <label
                        key={color.value}
                        className="relative cursor-pointer"
                        title={color.label}
                      >

                        <input
                          type="radio"
                          name="avatar_color"
                          className="peer sr-only"
                          value={color.value}
                          checked={
                            draft.avatar_color ===
                            color.value
                          }
                          onChange={() =>
                            change(
                              "avatar_color",
                              color.value
                            )
                          }
                          aria-label={color.label}
                        />

                        <span
                          className="flex h-10 w-10 items-center justify-center rounded-xl border-[3px] border-white shadow-sm ring-1 ring-[#D5DEEA] transition peer-checked:ring-[3px] peer-checked:ring-[#305BE8] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-[#305BE8]"
                          style={{
                            backgroundColor:
                              color.value,
                          }}
                        >

                          {draft.avatar_color ===
                            color.value && (

                            <svg
                              viewBox="0 0 20 20"
                              aria-hidden="true"
                              className="h-5 w-5 text-white"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="m4 10 4 4 8-8" />
                            </svg>

                          )}

                        </span>

                      </label>
                    ))}

                  </div>

                  <p className="mt-3 text-[11px] leading-5 text-[#8390A5]">
                    Profile photos aren't supported yet.
                    Your avatar uses initials and your
                    selected color.
                  </p>

                </div>
              </section>

              {/* Account metadata */}

              <section className="caas-card p-5 sm:p-6">

                <h2 className="text-[16px] font-semibold text-[#192437]">
                  Account details
                </h2>

                <dl className="mt-4 space-y-4 text-[12px]">

                  <div>
                    <dt className="text-[#7C8BA0]">
                      Email address
                    </dt>

                    <dd className="mt-1 break-all font-medium text-[#253A55]">
                      {profile.email}
                    </dd>
                  </div>

                  <div className="border-t border-[#E8EDF3] pt-3">
                    <dt className="text-[#7C8BA0]">
                      Member since
                    </dt>

                    <dd className="mt-1 font-medium text-[#253A55]">
                      {readableDate(
                        profile.joined_at
                      )}
                    </dd>
                  </div>

                  <div className="border-t border-[#E8EDF3] pt-3">
                    <dt className="text-[#7C8BA0]">
                      Last profile update
                    </dt>

                    <dd className="mt-1 font-medium text-[#253A55]">
                      {readableDate(
                        profile.updated_at
                      )}
                    </dd>
                  </div>

                </dl>

                <p className="mt-5 rounded-lg bg-[#F6F8FC] p-3 text-[11px] leading-5 text-[#72839A]">
                  Email and password changes require
                  separate account verification and
                  cannot be made on this page.
                </p>

              </section>

            </aside>

          </fieldset>

          {/* Save and discard actions */}

          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[#E2E8F1] bg-white px-5 py-4 shadow-sm">

            <div className="min-w-0 flex-1">

              {saveError ? (

                <p
                  role="alert"
                  className="text-[12px] font-medium text-[#B53B49]"
                >
                  {saveError}
                </p>

              ) : saved ? (

                <p
                  role="status"
                  className="text-[12px] font-semibold text-[#12836F]"
                >
                  ✓ Profile saved successfully to
                  your account.
                </p>

              ) : (

                <p className="text-[12px] text-[#75849A]">
                  {changed
                    ? "You have unsaved changes."
                    : "Your profile is up to date."}
                </p>

              )}

              <p className="mt-1 text-[11px] text-[#91A0B1]">
                Changes are saved privately to
                your account.
              </p>

            </div>

            <div className="flex items-center gap-2">

              <button
                type="button"
                className="caas-button caas-button-secondary"
                disabled={!changed || saving}
                onClick={() => {
                  setDraft(
                    makeDraft(profile)
                  );

                  setSaveError("");
                  setSaved(false);
                }}
              >
                Discard
              </button>

              <button
                type="submit"
                className="caas-button caas-button-primary"
                disabled={!changed || saving}
              >
                {saving
                  ? "Saving…"
                  : "Save changes"}
              </button>

            </div>

          </div>

        </form>

      )}

    </div>
  );
}
