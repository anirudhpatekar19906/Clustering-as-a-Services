/**
 * File 53 — CaaS authenticated session verification.
 *
 * GET /api/auth/session
 *
 * The browser sends the HttpOnly cookie automatically. This server-side route
 * verifies its JWT with FastAPI's /auth/me endpoint, and exposes only the
 * current user's safe public fields. The token itself never enters JSON.
 *
 * Do not add `export const runtime = "nodejs"`: our Next.js 16 project has
 * Cache Components enabled, which does not accept that route configuration.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEV_API_URL = "http://127.0.0.1:8000";

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};

function jsonResponse(body: object, status: number) {
  return NextResponse.json(body, {
    status,
    headers: RESPONSE_HEADERS,
  });
}

function notAuthenticated(clearCookie = false) {
  const response = jsonResponse(
    { authenticated: false, user: null },
    401,
  );

  if (clearCookie) {
    response.cookies.set({
      name: COOKIE_NAME,
      value: "",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }

  return response;
}

function getBackendUrl(): string | null {
  const baseUrl =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development" ? DEV_API_URL : "");

  if (!baseUrl) return null;

  try {
    const parsed = new URL(baseUrl);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return null;
    }

    return new URL("/api/v1/auth/me", parsed).toString();
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;

  if (!token) {
    return notAuthenticated();
  }

  // Reject obviously invalid or unexpectedly large cookie values.
  if (
    token.length < 16 ||
    token.length > 8192 ||
    /\s/.test(token)
  ) {
    return notAuthenticated(true);
  }

  const url = getBackendUrl();

  if (!url) {
    return jsonResponse(
      {
        authenticated: false,
        message: "Session service is not configured.",
      },
      503,
    );
  }

  let upstream: Response;

  try {
    upstream = await fetch(url, {
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
    // Backend downtime is not the same as an invalid login.
    return jsonResponse(
      {
        authenticated: false,
        message: "Session service is temporarily unavailable.",
      },
      503,
    );
  }

  if (upstream.status === 401 || upstream.status === 403) {
    // Expired token, revoked session, or denied account.
    return notAuthenticated(true);
  }

  if (!upstream.ok) {
    return jsonResponse(
      {
        authenticated: false,
        message: "Could not verify the session.",
      },
      503,
    );
  }

  let profile: unknown;

  try {
    profile = await upstream.json();
  } catch {
    return jsonResponse(
      {
        authenticated: false,
        message: "Invalid session service response.",
      },
      502,
    );
  }

  if (
    typeof profile !== "object" ||
    profile === null ||
    Array.isArray(profile)
  ) {
    return jsonResponse(
      {
        authenticated: false,
        message: "Invalid session service response.",
      },
      502,
    );
  }

  const user = profile as Record<string, unknown>;

  if (
    typeof user.id !== "string" ||
    typeof user.email !== "string"
  ) {
    return jsonResponse(
      {
        authenticated: false,
        message: "Invalid session service response.",
      },
      502,
    );
  }

  if (user.is_active === false) {
    return notAuthenticated(true);
  }

  // Return only approved fields, never JWTs or password hashes.
  return jsonResponse(
    {
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        ...(typeof user.is_active === "boolean"
          ? { is_active: user.is_active }
          : {}),
      },
    },
    200,
  );
}
