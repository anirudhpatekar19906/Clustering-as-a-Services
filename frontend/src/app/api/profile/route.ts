/**
 * File 95 — Private profile bridge for the CaaS website.
 *
 * Browser (same origin)         Next.js server           FastAPI
 * GET  /api/profile       -->  HttpOnly JWT cookie --> GET   /api/v1/profile/me
 * PATCH /api/profile      -->  HttpOnly JWT cookie --> PATCH /api/v1/profile/me
 *
 * The bearer token is never returned to browser JavaScript.
 * Profile changes are allowed only for the authenticated account.
 * No runtime export: Next.js 16 Cache Components is enabled.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEV_API_URL = "http://127.0.0.1:8000";
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLORS = [
  "#305BE8",
  "#129A8E",
  "#8B5CF6",
  "#D97735",
  "#46627F",
] as const;

const GENDERS = [
  "woman",
  "man",
  "non_binary",
  "self_described",
  "prefer_not_to_say",
] as const;

const TEXT_LIMITS = {
  display_name: 80,
  full_name: 120,
  bio: 500,
  gender_description: 80,
  occupation: 100,
  organization: 120,
} as const;

const ALLOWED_KEYS = new Set([
  ...Object.keys(TEXT_LIMITS),
  "age",
  "gender",
  "avatar_color",
]);

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie, Origin",
};

type PatchData =
  Record<string, string | number | null>;

type Profile = {
  user_id: string;
  email: string;

  display_name: string | null;
  full_name: string | null;
  bio: string | null;

  age: number | null;
  gender: string | null;
  gender_description: string | null;

  occupation: string | null;
  organization: string | null;

  avatar_color: string;

  joined_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/* =====================================================
   Private response helpers
   ===================================================== */

function reply(
  status: number,
  body: object
) {
  return NextResponse.json(body, {
    status,
    headers: PRIVATE_HEADERS,
  });
}

function fail(
  status: number,
  message: string
) {
  return reply(status, {
    success: false,
    message,
  });
}

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/* =====================================================
   Retrieve the HttpOnly session token
   ===================================================== */

function getToken(
  request: NextRequest
): string | null {
  const token =
    request.cookies.get(COOKIE_NAME)?.value;

  return (
    token &&
    token.length >= 16 &&
    token.length <= 8192 &&
    !/\s/.test(token)
  )
    ? token
    : null;
}

/* =====================================================
   Resolve FastAPI without exposing its URL as public env
   ===================================================== */

function backendUrl(): string | null {
  const configured =
    process.env.CAAS_API_BASE_URL ||
    (
      process.env.NODE_ENV === "development"
        ? DEV_API_URL
        : ""
    );

  if (!configured) {
    return null;
  }

  try {
    const base = new URL(configured);

    if (
      base.protocol !== "http:" &&
      base.protocol !== "https:"
    ) {
      return null;
    }

    return new URL(
      "/api/v1/profile/me",
      base
    ).toString();

  } catch {
    return null;
  }
}

/* =====================================================
   Limit request and response JSON sizes
   ===================================================== */

class TooLarge extends Error {}

async function readBoundedJson(
  input: Request | Response,
  max: number
): Promise<unknown> {

  const declared =
    input.headers.get("content-length");

  if (
    declared &&
    Number(declared) > max
  ) {
    throw new TooLarge();
  }

  if (!input.body) {
    throw new SyntaxError(
      "Missing JSON body"
    );
  }

  const reader =
    input.body.getReader();

  const decoder = new TextDecoder(
    "utf-8",
    { fatal: true }
  );

  const parts: string[] = [];
  let bytes = 0;

  try {
    while (true) {
      const {
        done,
        value,
      } = await reader.read();

      if (done) {
        break;
      }

      bytes += value.byteLength;

      if (bytes > max) {
        await reader.cancel();
        throw new TooLarge();
      }

      parts.push(
        decoder.decode(value, {
          stream: true,
        })
      );
    }

    parts.push(decoder.decode());

    return JSON.parse(
      parts.join("")
    );

  } finally {
    reader.releaseLock();
  }
}

/* =====================================================
   Validate editable text
   ===================================================== */

function textOrNull(
  value: unknown,
  maxLength: number,
  isBio: boolean
): string | null | undefined {

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const cleaned = value
    .replace(/\r\n/g, "\n")
    .trim();

  if (cleaned.length > maxLength) {
    return undefined;
  }

  // The bio may contain ordinary line breaks.
  // Other hidden control characters are rejected.
  const checkedText = isBio
    ? cleaned.replace(/\n/g, "")
    : cleaned;

  if (
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(
      checkedText
    )
  ) {
    return undefined;
  }

  return cleaned || null;
}

/* =====================================================
   Validate profile PATCH requests
   ===================================================== */

function validatePatch(
  raw: unknown
):
  | { ok: true; fields: PatchData }
  | { ok: false; message: string } {

  if (!isRecord(raw)) {
    return {
      ok: false,
      message:
        "Send a JSON object with profile fields.",
    };
  }

  const entries = Object.entries(raw);

  if (!entries.length) {
    return {
      ok: false,
      message:
        "Provide at least one profile field.",
    };
  }

  const fields: PatchData = {};

  for (const [key, value] of entries) {

    if (!ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        message:
          "Unsupported profile field. Email and passwords cannot be changed here.",
      };
    }

    if (
      Object.prototype.hasOwnProperty.call(
        TEXT_LIMITS,
        key
      )
    ) {
      const limit =
        TEXT_LIMITS[
          key as keyof typeof TEXT_LIMITS
        ];

      const text = textOrNull(
        value,
        limit,
        key === "bio"
      );

      if (text === undefined) {
        return {
          ok: false,
          message:
            `Invalid ${key.replace(/_/g, " ")} (maximum ${limit} characters).`,
        };
      }

      fields[key] = text;

    } else if (key === "age") {

      if (
        value !== null &&
        (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 120
        )
      ) {
        return {
          ok: false,
          message:
            "Age must be a whole number from 0 to 120, or null.",
        };
      }

      fields.age = value as number | null;

    } else if (key === "gender") {

      if (
        value !== null &&
        (
          typeof value !== "string" ||
          !GENDERS.includes(
            value as typeof GENDERS[number]
          )
        )
      ) {
        return {
          ok: false,
          message:
            "Choose a supported gender option, or null.",
        };
      }

      fields.gender =
        value as string | null;

    } else if (key === "avatar_color") {

      if (
        typeof value !== "string" ||
        !COLORS.includes(
          value as typeof COLORS[number]
        )
      ) {
        return {
          ok: false,
          message:
            "Choose one of the available avatar colors.",
        };
      }

      fields.avatar_color = value;
    }
  }

  return {
    ok: true,
    fields,
  };
}

/* =====================================================
   Validate FastAPI response fields
   ===================================================== */

function nullableText(
  value: unknown,
  limit: number
): value is string | null {
  return (
    value === null ||
    (
      typeof value === "string" &&
      value.length <= limit
    )
  );
}

function nullableDate(
  value: unknown
): value is string | null {
  return (
    value === null ||
    (
      typeof value === "string" &&
      Number.isFinite(
        Date.parse(value)
      )
    )
  );
}

function normalizeProfile(
  raw: unknown
): {
  success: true;
  profile_exists: boolean;
  profile: Profile;
} | null {

  if (
    !isRecord(raw) ||
    raw.success !== true ||
    typeof raw.profile_exists !== "boolean" ||
    !isRecord(raw.profile)
  ) {
    return null;
  }

  const p = raw.profile;

  if (
    typeof p.user_id !== "string" ||
    !UUID.test(p.user_id) ||

    typeof p.email !== "string" ||
    p.email.length < 3 ||
    p.email.length > 254 ||
    !p.email.includes("@") ||

    !nullableText(p.display_name, 80) ||
    !nullableText(p.full_name, 120) ||
    !nullableText(p.bio, 500) ||
    !nullableText(p.gender_description, 80) ||
    !nullableText(p.occupation, 100) ||
    !nullableText(p.organization, 120) ||

    (
      p.age !== null &&
      (
        typeof p.age !== "number" ||
        !Number.isInteger(p.age) ||
        p.age < 0 ||
        p.age > 120
      )
    ) ||

    (
      p.gender !== null &&
      (
        typeof p.gender !== "string" ||
        !GENDERS.includes(
          p.gender as typeof GENDERS[number]
        )
      )
    ) ||

    typeof p.avatar_color !== "string" ||
    !COLORS.includes(
      p.avatar_color as typeof COLORS[number]
    ) ||

    !nullableDate(p.joined_at) ||
    !nullableDate(p.created_at) ||
    !nullableDate(p.updated_at)
  ) {
    return null;
  }

  // Explicitly select safe fields.
  // Never return password hashes, tokens,
  // or unrecognized backend information.
  return {
    success: true,

    profile_exists:
      raw.profile_exists,

    profile: {
      user_id: p.user_id as string,
      email: p.email as string,

      display_name:
        p.display_name as string | null,

      full_name:
        p.full_name as string | null,

      bio:
        p.bio as string | null,

      age:
        p.age as number | null,

      gender:
        p.gender as string | null,

      gender_description:
        p.gender_description as string | null,

      occupation:
        p.occupation as string | null,

      organization:
        p.organization as string | null,

      avatar_color:
        p.avatar_color as string,

      joined_at:
        p.joined_at as string | null,

      created_at:
        p.created_at as string | null,

      updated_at:
        p.updated_at as string | null,
    },
  };
}

/* =====================================================
   Forward authenticated requests to FastAPI
   ===================================================== */

async function forward(
  method: "GET" | "PATCH",
  token: string,
  fields?: PatchData
) {

  const url = backendUrl();

  if (!url) {
    return fail(
      503,
      "Profile service is not configured."
    );
  }

  let upstream: Response;

  try {
    upstream = await fetch(url, {
      method,

      headers: {
        Accept: "application/json",

        Authorization:
          `Bearer ${token}`,

        ...(method === "PATCH"
          ? {
              "Content-Type":
                "application/json",
            }
          : {}),
      },

      ...(method === "PATCH"
        ? {
            body: JSON.stringify(
              fields
            ),
          }
        : {}),

      cache: "no-store",

      redirect: "manual",

      signal:
        AbortSignal.timeout(12_000),
    });

  } catch {
    return fail(
      503,
      "Profile service is temporarily unavailable. Please retry."
    );
  }

  if (
    upstream.status === 401 ||
    upstream.status === 403
  ) {
    return fail(
      401,
      "Your session has expired. Please sign in again."
    );
  }

  if (
    upstream.status === 422 ||
    upstream.status === 400
  ) {
    return fail(
      422,
      "Profile details are invalid. Review the fields and try again."
    );
  }

  if (upstream.status === 409) {
    return fail(
      409,
      "Profile update conflicted. Please retry."
    );
  }

  if (upstream.status === 429) {
    return fail(
      429,
      "Too many requests. Try again shortly."
    );
  }

  if (upstream.status === 503) {
    return fail(
      503,
      "Profile service is temporarily unavailable."
    );
  }

  if (upstream.status !== 200) {
    return fail(
      502,
      "Profile service returned an unexpected response."
    );
  }

  let raw: unknown;

  try {
    raw = await readBoundedJson(
      upstream,
      MAX_RESPONSE_BYTES
    );

  } catch {
    return fail(
      502,
      "Profile service returned unreadable or oversized data."
    );
  }

  const data =
    normalizeProfile(raw);

  if (!data) {
    return fail(
      502,
      "Profile service returned invalid profile data."
    );
  }

  return reply(200, data);
}

/* =====================================================
   GET /api/profile
   ===================================================== */

export async function GET(
  request: NextRequest
) {

  const token =
    getToken(request);

  if (!token) {
    return fail(
      401,
      "Please sign in to view your profile."
    );
  }

  return forward(
    "GET",
    token
  );
}

/* =====================================================
   PATCH /api/profile
   ===================================================== */

export async function PATCH(
  request: NextRequest
) {

  // Same-origin protection for cookie-backed updates.
  const origin =
    request.headers.get("origin");

  if (
    !origin ||
    origin !== request.nextUrl.origin ||
    request.headers.get("sec-fetch-site") ===
      "cross-site"
  ) {
    return fail(
      403,
      "Request origin is not allowed."
    );
  }

  const token =
    getToken(request);

  if (!token) {
    return fail(
      401,
      "Please sign in to update your profile."
    );
  }

  const contentType =
    request.headers.get(
      "content-type"
    ) ?? "";

  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      contentType
    )
  ) {
    return fail(
      415,
      "Send profile changes as JSON."
    );
  }

  let raw: unknown;

  try {
    raw = await readBoundedJson(
      request,
      MAX_REQUEST_BYTES
    );

  } catch (error) {
    return error instanceof TooLarge
      ? fail(
          413,
          "Profile update is too large."
        )
      : fail(
          400,
          "Invalid JSON profile update."
        );
  }

  const validation =
    validatePatch(raw);

  if (!validation.ok) {
    return fail(
      400,
      validation.message
    );
  }

  return forward(
    "PATCH",
    token,
    validation.fields
  );
}
