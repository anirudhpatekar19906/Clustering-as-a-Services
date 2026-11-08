/**
 * File 54 — CaaS secure browser logout.
 *
 * POST /api/auth/logout
 *
 * Deletes the same HttpOnly cookie set by the login route (File 49).
 * A POST and same-origin checks prevent cross-site requests from triggering
 * logout in a browser. The operation is idempotent: logging out twice is safe.
 *
 * IMPORTANT: Removing the browser cookie does NOT revoke a previously issued
 * JWT at FastAPI. Token revocation/short-lived sessions remain production work.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};

export async function POST(request: NextRequest) {
  // Match the public origin of THIS Next.js app, never the FastAPI origin.
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (
    (origin !== null && origin !== request.nextUrl.origin) ||
    (fetchSite !== null &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none")
  ) {
    return NextResponse.json(
      { success: false, message: "Request origin is not allowed." },
      { status: 403, headers: RESPONSE_HEADERS },
    );
  }

  const response = NextResponse.json(
    { success: true, message: "Signed out successfully." },
    { status: 200, headers: RESPONSE_HEADERS },
  );

  // Exactly match the login route's cookie name and path. An expiration in
  // the past removes it even when it is already absent (safe to retry).
  response.cookies.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });

  return response;
}
