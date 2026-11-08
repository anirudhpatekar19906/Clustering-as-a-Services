"""File 84 — Real HTTP security/ownership regression test for local CaaS.

From the project root, with Docker, FastAPI and the RQ worker running:
    python tests/security_regression.py

Creates TWO disposable test accounts, ONE 12-row CSV, and ONE clustering job.
They remain in the local development database; existing accounts are untouched.
Uses only Python's standard library and File 44's proven HTTP helpers.
Refuses non-local URLs to avoid creating test data in a production service.

Covers anonymous access, cross-account dataset/preflight/job/experiment/plot
isolation, permanent results, and CSV-row / saved-label alignment. This is a
focused regression check, not a complete security audit.
"""

from __future__ import annotations

import argparse
import secrets
import sys
import time
from typing import Any
from urllib.parse import urlencode, urlsplit
from uuid import UUID, uuid4

from smoke_end_to_end import (
    Api,
    SmokeError,
    ROWS,
    _dataset_id,
    _login_body,
    _operation,
    _registration_data,
    _upload_route,
)

PREFIX = "/api/v1"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeError(message)


def unique_user(
    api: Api,
    spec: dict[str, Any],
    role: str,
) -> str:
    """Register and log in a separate test identity."""

    register_path, register_op = _operation(
        spec,
        "/auth/register",
    )

    login_path, login_op = _operation(
        spec,
        "/auth/login",
    )

    unique = secrets.token_hex(7)

    email = (
        f"caas-security-{role}-{unique}@example.com"
    )

    password = (
        f"CaasSecurity!{secrets.token_hex(13)}A9"
    )

    api.call(
        "POST",
        register_path,
        payload=_registration_data(
            spec,
            register_op,
            email,
            password,
        ),
        authenticate=False,
        allowed=(200, 201),
    )

    kind, credentials = _login_body(
        spec,
        login_op,
        email,
        password,
    )

    logged_in = api.call(
        "POST",
        login_path,
        **{kind: credentials},
        authenticate=False,
        allowed=(200, 201),
    )

    token = (
        logged_in.get("access_token")
        or logged_in.get("token")
    )

    require(
        isinstance(token, str) and len(token) >= 16,
        "Login did not issue a usable token",
    )

    api.token = token

    return email


def assert_denied(
    api: Api,
    method: str,
    path: str,
    expected: tuple[int, ...],
    *,
    payload: dict[str, Any] | None = None,
) -> None:
    """Require a denial instead of a successful response."""

    response = api.call(
        method,
        path,
        payload=payload,
        allowed=expected,
    )

    require(
        isinstance(response, dict),
        f"Unexpected denial response for {path}",
    )


def assert_no_leak(
    items: Any,
    field: str,
    forbidden_id: str,
    label: str,
) -> None:
    require(
        isinstance(items, list),
        f"{label} did not return an items list",
    )

    require(
        not any(
            isinstance(item, dict)
            and item.get(field) == forbidden_id
            for item in items
        ),
        (
            f"SECURITY FAILURE: {label} exposed "
            f"another user's {field}"
        ),
    )


def check_plot(
    plot: dict[str, Any],
    *,
    experiment_id: str,
    dataset_id: str,
    labels: list[int],
) -> None:
    """Compare every plotted point to the original CSV row."""

    require(
        plot.get("experiment_id") == experiment_id,
        "Plot experiment ID mismatch",
    )

    require(
        plot.get("dataset_id") == dataset_id,
        "Plot dataset ID mismatch",
    )

    require(
        plot.get("x_feature") == "age",
        "Plot x_feature mismatch",
    )

    require(
        plot.get("y_feature") == "income",
        "Plot y_feature mismatch",
    )

    require(
        plot.get("coordinate_space") == "original_csv",
        "Plot must use original CSV coordinates",
    )

    require(
        plot.get("total_rows") == len(ROWS),
        "Plot original row count mismatch",
    )

    require(
        plot.get("eligible_rows") == len(ROWS),
        "Plot dropped valid CSV rows",
    )

    require(
        plot.get("omitted_invalid_rows") == 0,
        "Plot reported invalid numeric rows",
    )

    require(
        plot.get("returned_points") == len(ROWS),
        "Plot returned an unexpected number of points",
    )

    require(
        plot.get("sampled") is False,
        "Small test CSV should not be sampled",
    )

    points = plot.get("points")

    require(
        isinstance(points, list)
        and len(points) == len(ROWS),
        "Missing scatter points",
    )

    for i, point in enumerate(points):
        require(
            isinstance(point, dict),
            f"Plot point {i} is invalid",
        )

        age, income = ROWS[i]

        require(
            point.get("row_index") == i,
            f"CSV row order changed at index {i}",
        )

        require(
            point.get("x") == age
            and point.get("y") == income,
            f"CSV coordinates changed at row {i}",
        )

        require(
            point.get("cluster") == labels[i],
            f"Cluster label mismatch at row {i}",
        )


def run(
    base_url: str,
    timeout: int,
    interval: float,
    skip_worker: bool,
) -> None:
    owner = Api(base_url)
    other = Api(base_url)
    anonymous = Api(base_url)

    print("[1/8] Checking local FastAPI and required routes")

    spec = anonymous.call(
        "GET",
        "/openapi.json",
        authenticate=False,
    )

    upload_path, upload_field = _upload_route(spec)

    paths = spec.get("paths", {})

    plot_route = (
        f"{PREFIX}/experiments/history/"
        "{experiment_id}/plot-data"
    )

    require(
        plot_route in paths
        and "get" in paths[plot_route],
        "File 80 scatter endpoint is missing",
    )

    require(
        f"{PREFIX}/experiments/history/"
        "{experiment_id}" in paths,
        "Saved-results endpoint is missing",
    )

    print(
        "  PASS: API, dataset upload and "
        "scatter route detected"
    )

    print("[2/8] Creating two separate disposable test accounts")

    owner_email = unique_user(
        owner,
        spec,
        "owner",
    )

    unique_user(
        other,
        spec,
        "other",
    )

    require(
        owner.token != other.token,
        "Accounts unexpectedly received the same token",
    )

    require(
        owner.call(
            "GET",
            f"{PREFIX}/auth/me",
        ).get("email") == owner_email,
        "Owner session mismatch",
    )

    print(
        "  PASS: Two different authenticated identities"
    )

    print(
        "[3/8] Uploading owner CSV; "
        "checking dataset-list isolation"
    )

    content = (
        "age,income\n"
        + "".join(
            f"{age},{income}\n"
            for age, income in ROWS
        )
    ).encode("utf-8")

    uploaded = owner.call(
        "POST",
        upload_path,
        upload=(
            upload_field,
            f"caas_security_{uuid4().hex[:12]}.csv",
            content,
        ),
        allowed=(200, 201),
    )

    dataset_id = _dataset_id(uploaded)

    owner_list = owner.call(
        "GET",
        f"{PREFIX}/datasets",
    )

    require(
        any(
            isinstance(item, dict)
            and item.get("id") == dataset_id
            for item in owner_list.get("items", [])
        ),
        "Owner cannot see their newly uploaded dataset",
    )

    other_list = other.call(
        "GET",
        f"{PREFIX}/datasets",
    )

    assert_no_leak(
        other_list.get("items"),
        "id",
        dataset_id,
        "Other user's datasets",
    )

    print(
        "  PASS: Dataset visible to owner "
        "but absent from the second account"
    )

    print("[4/8] Checking anonymous access is blocked")

    for path in (
        f"{PREFIX}/auth/me",
        f"{PREFIX}/datasets",
        f"{PREFIX}/experiments/history",
    ):
        assert_denied(
            anonymous,
            "GET",
            path,
            (401, 403),
        )

    print(
        "  PASS: Anonymous session, dataset "
        "and history requests rejected"
    )

    print(
        "[5/8] Checking foreign dataset "
        "cannot be used for clustering"
    )

    request: dict[str, Any] = {
        "dataset_id": dataset_id,
        "n_clusters": 2,
        "features": ["age", "income"],
        "random_state": 42,
        "include_silhouette": True,
    }

    preflight = owner.call(
        "POST",
        f"{PREFIX}/experiments/preflight",
        payload=request,
    )

    require(
        preflight.get("dataset_id") == dataset_id,
        "Owner preflight failed",
    )

    assert_denied(
        other,
        "POST",
        f"{PREFIX}/experiments/preflight",
        (404,),
        payload=request,
    )

    assert_denied(
        anonymous,
        "POST",
        f"{PREFIX}/experiments/preflight",
        (401, 403),
        payload=request,
    )

    print(
        "  PASS: Cross-account dataset "
        "preflight rejected"
    )

    print(
        "[6/8] Submitting one job; "
        "checking private IDs across both accounts"
    )

    submitted = owner.call(
        "POST",
        f"{PREFIX}/experiments",
        payload=request,
        allowed=(202,),
    )

    try:
        experiment_id = str(
            UUID(str(submitted["experiment_id"]))
        )

        job_id = str(
            UUID(str(submitted["job_id"]))
        )

    except (KeyError, ValueError, TypeError) as exc:
        raise SmokeError(
            "Submission returned invalid experiment/job IDs"
        ) from exc

    require(
        submitted.get("dataset_id") == dataset_id,
        "Submitted dataset ID mismatch",
    )

    owner_history = owner.call(
        "GET",
        (
            f"{PREFIX}/experiments/history"
            "?limit=100&offset=0"
        ),
    )

    require(
        any(
            isinstance(row, dict)
            and row.get("experiment_id") == experiment_id
            for row in owner_history.get("items", [])
        ),
        "Owner's experiment is missing from their history",
    )

    other_history = other.call(
        "GET",
        (
            f"{PREFIX}/experiments/history"
            "?limit=100&offset=0"
        ),
    )

    assert_no_leak(
        other_history.get("items"),
        "experiment_id",
        experiment_id,
        "Other user's history",
    )

    detail = (
        f"{PREFIX}/experiments/history/{experiment_id}"
    )

    job_path = (
        f"{PREFIX}/experiments/{job_id}"
    )

    plot_query = urlencode({
        "x_feature": "age",
        "y_feature": "income",
        "max_points": 1000,
    })

    plot = (
        f"{detail}/plot-data?{plot_query}"
    )

    for path in (detail, job_path, plot):
        assert_denied(
            other,
            "GET",
            path,
            (404,),
        )

        assert_denied(
            anonymous,
            "GET",
            path,
            (401, 403),
        )

    print(
        "  PASS: Other account gets 404; "
        "anonymous gets 401/403 for job, results and plot"
    )

    if skip_worker:
        print(
            "[7/8] SKIPPED worker completion "
            "(--skip-worker)"
        )

        print(
            "[8/8] SKIPPED owner plot alignment "
            "(--skip-worker)"
        )

        print(
            "\nBASIC OWNERSHIP REGRESSIONS PASSED "
            "(completed-result checks skipped)."
        )

        return

    print(
        "[7/8] Waiting for owner's "
        "worker result in PostgreSQL"
    )

    deadline = time.monotonic() + timeout
    previous = None

    while True:
        status = owner.call(
            "GET",
            job_path,
        )

        state = status.get("status")

        if state != previous:
            print(f"  Job state: {state}")
            previous = state

        if state == "completed":
            require(
                status.get("status_source") == "postgresql",
                "Job completion was not persisted",
            )
            break

        if state in ("failed", "cancelled"):
            raise SmokeError(
                f"Test job reached '{state}'. "
                "Check the worker terminal"
            )

        require(
            state in ("queued", "running"),
            f"Unexpected job state: {state!r}",
        )

        if time.monotonic() >= deadline:
            raise SmokeError(
                "Worker timeout: verify "
                "`python -m backend.worker` is running"
            )

        time.sleep(interval)

    print(
        "  PASS: Completed clustering result persisted"
    )

    print(
        "[8/8] Checking original CSV positions, "
        "saved labels and ongoing privacy"
    )

    saved = owner.call(
        "GET",
        f"{detail}?include_labels=true",
    )

    require(
        saved.get("result_available") is True,
        "Owner result is not saved",
    )

    result = saved.get("result")

    require(
        isinstance(result, dict),
        "Saved result is missing",
    )

    labels = result.get("labels")

    require(
        isinstance(labels, list)
        and len(labels) == len(ROWS)
        and all(
            type(label) is int
            and 0 <= label < 2
            for label in labels
        ),
        "Saved labels are invalid",
    )

    verified_plot = owner.call(
        "GET",
        plot,
    )

    check_plot(
        verified_plot,
        experiment_id=experiment_id,
        dataset_id=dataset_id,
        labels=labels,
    )

    # Verify privacy again after the result is saved.
    for path in (detail, job_path, plot):
        assert_denied(
            other,
            "GET",
            path,
            (404,),
        )

    print(
        "  PASS: All 12 plot coordinates "
        "and labels match original rows"
    )

    print(
        "  PASS: Cross-account access remains "
        "blocked after completion"
    )

    print(
        "\nALL FILE 84 SECURITY REGRESSION CHECKS PASSED!"
    )

    print(
        "Test accounts/dataset/experiment remain "
        "in your LOCAL development database."
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Local CaaS ownership / security regression checks"
        )
    )

    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8000",
    )

    parser.add_argument(
        "--timeout",
        type=int,
        default=180,
        help="RQ worker wait time in seconds",
    )

    parser.add_argument(
        "--interval",
        type=float,
        default=2.0,
        help="Worker poll interval in seconds",
    )

    parser.add_argument(
        "--skip-worker",
        action="store_true",
        help=(
            "Check isolation without waiting for clustering"
        ),
    )

    args = parser.parse_args()
    target = urlsplit(args.base_url)

    if (
        target.scheme != "http"
        or target.hostname not in (
            "127.0.0.1",
            "localhost",
            "::1",
        )
    ):
        parser.error(
            "This test can create records and may run "
            "ONLY on a local HTTP server"
        )

    if args.timeout < 1 or args.interval <= 0:
        parser.error(
            "--timeout and --interval must be positive"
        )

    print(
        "CAAS SECURITY TEST: creates two local accounts, "
        "one CSV, and one job."
    )

    print(
        "Do not run against a production database "
        "or shared development environment.\n"
    )

    try:
        run(
            args.base_url,
            args.timeout,
            args.interval,
            args.skip_worker,
        )

    except (
        SmokeError,
        KeyError,
        TypeError,
        ValueError,
    ) as exc:
        print(
            f"\nFILE 84 FAILED: {exc}",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
