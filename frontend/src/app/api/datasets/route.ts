/**
 * File 66 — Authenticated dataset-list bridge for the experiment UI.
 *
 * GET /api/datasets -> FastAPI GET /api/v1/datasets
 *
 * Browser JavaScript never reads the JWT: Next.js retrieves the HttpOnly
 * session cookie, forwards the Bearer token to FastAPI, and returns only
 * owner-scoped dataset metadata. The database/files remain in the backend.
 *
 * Do not export `runtime = "nodejs"` in our Next.js 16 Cache Components setup.
 */

import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "caas_access_token";
const DEVELOPMENT_API = "http://127.0.0.1:8000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

type DatasetItem = {
  id: string;
  original_filename: string;
  row_count: number | null;
  column_count: number | null;
  column_names: string[];
  file_size_bytes: number | null;
  created_at: string | null;
};

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function backendUrl(): string | null {
  const configured =
    process.env.CAAS_API_BASE_URL ||
    (process.env.NODE_ENV === "development" ? DEVELOPMENT_API : "");

  if (!configured) return null;

  try {
    const base = new URL(configured);
    if (base.protocol !== "http:" && base.protocol !== "https:") return null;
    return new URL("/api/v1/datasets", base).toString();
  } catch {
    return null;
  }
}

// Limit the response size, including when the backend uses chunked transfer.
async function readJsonWithLimit(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_UPSTREAM_BYTES) {
    throw new Error("Dataset metadata response is too large");
  }

  if (!response.body) throw new Error("Missing dataset response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let received = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      received += value.byteLength;

      if (received > MAX_UPSTREAM_BYTES) {
        await reader.cancel();
        throw new Error("Dataset metadata response is too large");
      }

      parts.push(decoder.decode(value, { stream: true }));
    }

    parts.push(decoder.decode());
    return JSON.parse(parts.join(""));
  } finally {
    reader.releaseLock();
  }
}

function normalizeDatasetList(value: unknown): {
  items: DatasetItem[];
  total: number | null;
} | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;

  const items: DatasetItem[] = [];
  const seen = new Set<string>();

  for (const raw of value.items) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      !UUID.test(raw.id) ||
      typeof raw.original_filename !== "string" ||
      !raw.original_filename
    ) {
      return null;
    }

    const normalizedId = raw.id.toLowerCase();

    if (seen.has(normalizedId)) return null;
    seen.add(normalizedId);

    if (
      raw.column_names !== null &&
      raw.column_names !== undefined &&
      (!Array.isArray(raw.column_names) ||
        raw.column_names.some((name: unknown) => typeof name !== "string"))
    ) {
      return null;
    }

    items.push({
      id: raw.id,
      original_filename: raw.original_filename,
      row_count: nonnegativeInteger(raw.row_count),
      column_count: nonnegativeInteger(raw.column_count),
      column_names: Array.isArray(raw.column_names)
        ? (raw.column_names as string[])
        : [],
      file_size_bytes: nonnegativeInteger(raw.file_size_bytes),
      created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    });
  }

  return { items, total: nonnegativeInteger(value.total) };
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get(COOKIE_NAME)?.value;

  if (!token || token.length < 16 || token.length > 8192 || /\s/.test(token)) {
    return reply(401, {
      success: false,
      message: "Please sign in to view your datasets.",
    });
  }

  const url = backendUrl();

  if (!url) {
    return reply(503, {
      success: false,
      message: "Dataset service is not configured.",
    });
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
    return reply(503, {
      success: false,
      message: "Dataset service is temporarily unavailable. Please retry.",
    });
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return reply(401, {
      success: false,
      message: "Your session has expired. Please sign in again.",
    });
  }

  if (!upstream.ok) {
    return reply(upstream.status === 429 ? 429 : 502, {
      success: false,
      message:
        upstream.status === 429
          ? "Too many requests. Please try again shortly."
          : "Could not load your datasets. Please retry.",
    });
  }

  let raw: unknown;

  try {
    raw = await readJsonWithLimit(upstream);
  } catch {
    return reply(502, {
      success: false,
      message: "Dataset service returned an unreadable or oversized response.",
    });
  }

  const data = normalizeDatasetList(raw);

  if (!data) {
    return reply(502, {
      success: false,
      message: "Dataset service returned invalid metadata.",
    });
  }

  return reply(200, {
    success: true,
    items: data.items,
    total: data.total,
    returned: data.items.length,
  });
}
