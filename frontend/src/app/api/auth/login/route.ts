/**
 * File 49 — CaaS secure login bridge.
 *
 * Browser -> same-origin Next.js -> FastAPI.
 * The FastAPI bearer token is kept in an HttpOnly cookie, never returned to JS.
 * This route is a foundation; the login page and authenticated API proxy follow.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEV_API_URL = "http://127.0.0.1:8000";
const MAX_BODY_LENGTH = 8_192;

function reply(message: string, status: number) {
  return NextResponse.json(
    { success: false, message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

type LoginReply = {
  access_token?: unknown;
  token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
};

async function contactFastAPI(
  url: string,
  contentType: string,
  body: string,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Accept: "application/json",
    },
    body,
    cache: "no-store",
    redirect: "manual", // Never forward a password to a redirected host.
    signal: AbortSignal.timeout(10_000),
  });
}

export async function POST(request: NextRequest) {
  // A browser sending a cross-origin POST must not create a login cookie.
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    return reply("Request origin is not allowed.", 403);
  }

  if (!request.headers.get("content-type")?.includes("application/json")) {
    return reply("Send credentials as JSON.", 415);
  }

  let credentials: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_LENGTH) {
      return reply("Request is too large.", 413);
    }
    credentials = JSON.parse(text);
  } catch {
    return reply("Invalid JSON request.", 400);
  }

  if (typeof credentials !== "object" || credentials === null) {
    return reply("Email and password are required.", 400);
  }

  const fields = credentials as Record<string, unknown>;
  const email = typeof fields.email === "string" ? fields.email.trim() : "";
  const password = fields.password;

  if (
    email.length < 3 ||
    email.length > 254 ||
    !email.includes("@") ||
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > 1024
  ) {
    return reply("Enter a valid email and password.", 400);
  }

  // In deployment, set CAAS_API_BASE_URL to the server-accessible API origin.
  // Do not expose this as NEXT_PUBLIC_*. A missing production setting fails shut.
  const apiBase =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development" ? DEV_API_URL : "");

  if (!apiBase) {
    return reply("Authentication service is not configured.", 503);
  }

  let loginUrl: string;
  try {
    const base = new URL(apiBase);
    if (!["http:", "https:"].includes(base.protocol)) {
      return reply("Authentication service is misconfigured.", 503);
    }
    loginUrl = new URL("/api/v1/auth/login", base).toString();
  } catch {
    return reply("Authentication service is misconfigured.", 503);
  }

  let upstream: Response;
  try {
    // FastAPI OAuth2 login uses form data (username=email, password).
    upstream = await contactFastAPI(
      loginUrl,
      "application/x-www-form-urlencoded",
      new URLSearchParams({ username: email, password }).toString(),
    );

    // Some FastAPI projects declare JSON login schemas instead. Only retry
    // when the form shape itself was rejected, never on a bad password (401).
    if (upstream.status === 415 || upstream.status === 422) {
      upstream = await contactFastAPI(
        loginUrl,
        "application/json",
        JSON.stringify({ email, password }),
      );
    }
    if (upstream.status === 422) {
      upstream = await contactFastAPI(
        loginUrl,
        "application/json",
        JSON.stringify({ username: email, password }),
      );
    }
  } catch {
    return reply("Authentication service is unreachable. Try again.", 503);
  }

  if (upstream.status === 400 || upstream.status === 401) {
    return reply("Incorrect email or password.", 401);
  }
  if (upstream.status === 429) {
    return reply("Too many attempts. Please try again later.", 429);
  }
  if (!upstream.ok) {
    return reply("Unable to sign in right now. Please try again.", 503);
  }

  let data: LoginReply;
  try {
    data = (await upstream.json()) as LoginReply;
  } catch {
    return reply("Authentication service returned an invalid response.", 502);
  }

  const token = data.access_token ?? data.token;
  if (typeof token !== "string" || token.length < 16) {
    return reply("Authentication service returned an invalid response.", 502);
  }

  const duration =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
      ? Math.max(1, Math.min(Math.floor(data.expires_in), 30 * 60))
      : 30 * 60;

  const response = NextResponse.json(
    { success: true },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );

  response.cookies.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: duration,
  });

  return response;
}
