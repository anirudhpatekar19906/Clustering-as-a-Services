
"""
File 103 - CaaS CSV Export Regression Tests

Tests:
1. Owner can download CSV.
2. CSV contains clustering assignments.
3. Anonymous requests are rejected.
4. Invalid experiment IDs are rejected.
5. Another user cannot download the owner's CSV.
6. Optional SHA-256 and row-count checks.

No external Python packages required.
"""

import csv
import hashlib
import os
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import (
    HTTPRedirectHandler,
    Request,
    build_opener,
)


BASE_URL = os.getenv(
    "CAAS_BASE_URL",
    "http://127.0.0.1:8000",
).rstrip("/")

EXPORT_ROUTE = os.getenv(
    "CAAS_EXPORT_ROUTE",
    "/api/v1/experiments/results/{id}/export",
)

EXPERIMENT_ID = os.getenv("CAAS_EXPERIMENT_ID", "").strip()

OWNER_TOKEN = os.getenv("CAAS_OWNER_TOKEN", "").strip()
OWNER_COOKIE = os.getenv("CAAS_OWNER_COOKIE", "").strip()

OTHER_TOKEN = os.getenv("CAAS_OTHER_TOKEN", "").strip()
OTHER_COOKIE = os.getenv("CAAS_OTHER_COOKIE", "").strip()

EXPECTED_SHA256 = os.getenv(
    "CAAS_EXPECTED_SHA256", ""
).strip().lower()

EXPECTED_ROWS = os.getenv(
    "CAAS_EXPECTED_ROWS", ""
).strip()

CLUSTER_COLUMN = os.getenv(
    "CAAS_CLUSTER_COLUMN", ""
).strip()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(
        self, req, fp, code, msg, headers, newurl
    ):
        return None


opener = build_opener(NoRedirect)


def export_url(experiment_id):
    safe_id = quote(experiment_id, safe="")
    path = EXPORT_ROUTE.replace("{id}", safe_id)
    return BASE_URL + "/" + path.lstrip("/")


def credentials(token="", cookie=""):
    headers = {"Accept": "text/csv"}

    if token:
        headers["Authorization"] = f"Bearer {token}"

    if cookie:
        headers["Cookie"] = cookie

    return headers


def request_export(experiment_id, headers, destination=None):
    request = Request(
        export_url(experiment_id),
        headers=headers,
        method="GET",
    )

    try:
        with opener.open(request, timeout=30) as response:
            status = response.status
            response_headers = response.headers
            digest = hashlib.sha256()
            byte_count = 0

            while True:
                chunk = response.read(65536)

                if not chunk:
                    break

                digest.update(chunk)
                byte_count += len(chunk)

                if destination is not None:
                    destination.write(chunk)

            return (
                status,
                response_headers,
                digest.hexdigest(),
                byte_count,
            )

    except HTTPError as error:
        error.close()

        return (
            error.code,
            error.headers,
            None,
            0,
        )


def check(condition, message):
    if not condition:
        raise AssertionError(message)

    print(f"PASS: {message}")


def test_owner_download():
    print("\n[1/4] Testing owner CSV download")

    with tempfile.TemporaryFile(mode="w+b") as file:
        status, headers, digest, size = request_export(
            EXPERIMENT_ID,
            credentials(OWNER_TOKEN, OWNER_COOKIE),
            destination=file,
        )

        check(
            status == 200,
            f"Owner download returns HTTP 200 (got {status})",
        )

        check(size > 0, "Downloaded CSV is not empty")

        disposition = headers.get(
            "Content-Disposition", ""
        )

        check(
            "attachment" in disposition.lower()
            and ".csv" in disposition.lower(),
            "Response has a CSV attachment filename",
        )

        file.seek(0)

        import io

        wrapper = io.TextIOWrapper(
            file, encoding="utf-8-sig", newline=""
        )

        reader = csv.DictReader(wrapper)
        columns = reader.fieldnames or []

        check(bool(columns), "CSV contains column headers")

        recognized = {
            "cluster",
            "cluster_id",
            "cluster_label",
            "cluster_assignment",
            "assigned_cluster",
            "kmeans_cluster",
            "k_means_cluster",
        }

        normalized = {
            column.strip().lower().replace(" ", "_")
            for column in columns
        }

        if CLUSTER_COLUMN:
            has_clusters = CLUSTER_COLUMN in columns
        else:
            has_clusters = bool(normalized & recognized)

        check(
            has_clusters,
            "CSV contains a cluster assignment column",
        )

        row_count = sum(1 for _ in reader)

        check(row_count > 0, "CSV contains dataset rows")

        if EXPECTED_ROWS:
            check(
                row_count == int(EXPECTED_ROWS),
                "CSV row count matches expected count",
            )

        if EXPECTED_SHA256:
            check(
                digest == EXPECTED_SHA256,
                "CSV matches expected SHA-256",
            )

    print(f"INFO: Rows exported: {row_count}")
    print(f"INFO: CSV SHA-256: {digest}")


def test_anonymous():
    print("\n[2/4] Testing anonymous access")

    status, _, _, _ = request_export(
        EXPERIMENT_ID, credentials()
    )

    check(
        status in (401, 403),
        f"Anonymous download rejected (HTTP {status})",
    )


def test_invalid_id():
    print("\n[3/4] Testing invalid experiment ID")

    status, _, _, _ = request_export(
        "not-a-valid-experiment-id",
        credentials(OWNER_TOKEN, OWNER_COOKIE),
    )

    check(
        status in (400, 404, 422),
        f"Invalid experiment ID rejected (HTTP {status})",
    )


def test_account_isolation():
    print("\n[4/4] Testing account isolation")

    if not OTHER_TOKEN and not OTHER_COOKIE:
        print(
            "SKIP: Set CAAS_OTHER_TOKEN or CAAS_OTHER_COOKIE "
            "to test another user's access."
        )
        return

    status, _, _, _ = request_export(
        EXPERIMENT_ID,
        credentials(OTHER_TOKEN, OTHER_COOKIE),
    )

    check(
        status in (403, 404),
        f"Other user cannot export CSV (HTTP {status})",
    )


def main():
    if not EXPERIMENT_ID:
        print("ERROR: Set CAAS_EXPERIMENT_ID first.")
        sys.exit(2)

    if not OWNER_TOKEN and not OWNER_COOKIE:
        print(
            "ERROR: Set CAAS_OWNER_TOKEN or "
            "CAAS_OWNER_COOKIE first."
        )
        sys.exit(2)

    print("=" * 55)
    print("CaaS - File 103 CSV Export Regression Tests")
    print("=" * 55)

    try:
        test_owner_download()
        test_anonymous()
        test_invalid_id()
        test_account_isolation()

    except (AssertionError, URLError, ValueError) as error:
        print(f"\nFAILED: {error}")
        sys.exit(1)

    print("\nALL EXECUTED FILE 103 CHECKS PASSED!")


if __name__ == "__main__":
    main()
