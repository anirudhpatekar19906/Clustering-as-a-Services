/**
 * File 57 — Authenticated CSV upload bridge (Next.js -> FastAPI).
 *
 * POST /api/datasets/upload
 * The browser sends multipart/form-data to this same-origin endpoint.
 * The JWT stays in an HttpOnly cookie, and only the Next.js server sends
 * it to FastAPI. No token is returned in the upload response.
 *
 * File 58 builds the actual user-facing drag-and-drop upload screen.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEV_API_URL = "http://127.0.0.1:8000";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // Match the backend's 25 MiB limit.
const MAX_BODY_BYTES = MAX_FILE_BYTES + 128 * 1024; // Multipart framing.

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};

function respond(status: number, message: string) {
  return NextResponse.json(
    { success: false, message },
    { status, headers: NO_STORE_HEADERS },
  );
}

function backendUrl(): string | null {
  const configured =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development" ? DEV_API_URL : "");

  if (!configured) return null;

  try {
    const base = new URL(configured);
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      return null;
    }
    return new URL("/api/v1/datasets/upload", base).toString();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bound multipart parsing before calling formData(). Unlike trusting
 * Content-Length, this also limits requests sent with chunked encoding.
 * A 25 MiB maximum is reasonable for our current single-instance proxy;
 * production infrastructure should enforce its own body/concurrency limits.
 */
async function limitedMultipart(request: NextRequest): Promise<FormData | null> {
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const contentType = request.headers.get("content-type") ?? "";
  const boundedRequest = new Request(request.url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  return boundedRequest.formData();
}

export async function POST(request: NextRequest) {
  // Reject cross-origin, cookie-authenticated state changes.
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (
    (origin !== null && origin !== request.nextUrl.origin) ||
    (fetchSite !== null && !["same-origin", "none"].includes(fetchSite))
  ) {
    return respond(403, "Request origin is not allowed.");
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;

  if (!token || token.length < 16 || token.length > 8192 || /\s/.test(token)) {
    return respond(401, "Please sign in before uploading a dataset.");
  }

  const uploadUrl = backendUrl();
  if (!uploadUrl) return respond(503, "Upload service is not configured.");

  const contentType = request.headers.get("content-type") ?? "";

  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    return respond(415, "Send the CSV using multipart/form-data.");
  }

  const declaredLength = request.headers.get("content-length");

  if (declaredLength !== null) {
    const length = Number(declaredLength);

    if (!Number.isSafeInteger(length) || length < 0) {
      return respond(400, "Invalid request size.");
    }

    if (length > MAX_BODY_BYTES) {
      return respond(413, "CSV exceeds the 25 MB upload limit.");
    }
  }

  let form: FormData | null;

  try {
    form = await limitedMultipart(request);
  } catch {
    return respond(400, "Could not read the uploaded CSV.");
  }

  if (!form) return respond(413, "Upload is missing or too large.");

  const files = form.getAll("file");

  if (files.length !== 1 || !(files[0] instanceof File)) {
    return respond(400, "Choose exactly one CSV file.");
  }

  const file = files[0];

  if (!/\.csv$/i.test(file.name) || file.name.length > 255) {
    return respond(400, "Choose a file with a .csv extension.");
  }

  if (file.size === 0) {
    return respond(400, "CSV file cannot be empty.");
  }

  if (file.size > MAX_FILE_BYTES) {
    return respond(413, "CSV exceeds the 25 MB upload limit.");
  }

  // Forward only the file—not additional untrusted form fields.
  const upstreamForm = new FormData();
  upstreamForm.set("file", file, file.name);

  let upstream: Response;

  try {
    upstream = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: upstreamForm,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return respond(503, "Upload service is unavailable. Please try again.");
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return respond(401, "Your session has expired. Please sign in again.");
  }

  if (upstream.status === 413) {
    return respond(413, "CSV exceeds the allowed upload size.");
  }

  if (upstream.status === 429) {
    return respond(429, "Too many requests. Please try again later.");
  }

  if ([400, 409, 415, 422].includes(upstream.status)) {
    return respond(422, "The CSV was rejected. Check its formatting and limits.");
  }

  if (!upstream.ok) {
    return respond(502, "Upload failed. Please try again.");
  }

  let data: unknown;

  try {
    data = await upstream.json();
  } catch {
    return respond(502, "Upload service returned an invalid response.");
  }

  const root = isRecord(data) ? data : {};

  const item = isRecord(root.dataset)
    ? root.dataset
    : isRecord(root.data)
      ? root.data
      : root;

  const id = item.dataset_id ?? item.id;

  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    return respond(502, "Upload service did not return a dataset ID.");
  }

  return NextResponse.json(
    {
      success: true,
      dataset_id: id,
      message: "Dataset uploaded successfully.",
    },
    { status: 201, headers: NO_STORE_HEADERS },
  );
}
