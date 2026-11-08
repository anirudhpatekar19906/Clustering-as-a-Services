
"""File 44: real HTTP + RQ + PostgreSQL end-to-end backend smoke test.

Run from project root after starting Docker, FastAPI and the RQ worker:
    python tests/smoke_end_to_end.py

Creates a uniquely named TEST account, uploaded CSV, experiment and job.
These records are retained for inspection; existing records are untouched.
Uses Python's standard library only (no new dependencies).
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen
from uuid import UUID, uuid4


ROWS = [
    (21, 31000), (22, 32000), (23, 33500), (24, 35000),
    (25, 36500), (26, 38000), (61, 88000), (62, 89500),
    (63, 91000), (64, 93000), (65, 95000), (66, 97000),
]
API_PREFIX = "/api/v1"


class SmokeError(RuntimeError):
    """Readable, actionable smoke-test failure."""


class Api:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.token: str | None = None

    def call(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        form: dict[str, str] | None = None,
        upload: tuple[str, str, bytes] | None = None,
        allowed: tuple[int, ...] = (200,),
        authenticate: bool = True,
    ) -> dict[str, Any]:
        """Perform an HTTP request and require a declared response code."""
        if sum(
            part is not None
            for part in (payload, form, upload)
        ) > 1:
            raise ValueError(
                "Only one HTTP body format is allowed"
            )

        headers: dict[str, str] = {
            "Accept": "application/json"
        }

        if self.token is not None and authenticate:
            headers["Authorization"] = (
                f"Bearer {self.token}"
            )

        data: bytes | None = None

        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        elif form is not None:
            data = urlencode(form).encode("utf-8")
            headers["Content-Type"] = (
                "application/x-www-form-urlencoded"
            )

        elif upload is not None:
            field_name, filename, csv_bytes = upload
            boundary = f"caas-smoke-{uuid4().hex}"

            data = (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{field_name}"; '
                f'filename="{filename}"\r\n'
                "Content-Type: text/csv\r\n\r\n"
            ).encode("ascii")

            data += csv_bytes

            data += (
                f"\r\n--{boundary}--\r\n"
            ).encode("ascii")

            headers["Content-Type"] = (
                f"multipart/form-data; boundary={boundary}"
            )

        request = Request(
            urljoin(
                self.base_url,
                path.lstrip("/"),
            ),
            data=data,
            headers=headers,
            method=method,
        )

        try:
            with urlopen(request, timeout=20) as response:
                code = response.status
                raw = response.read()

        except HTTPError as exc:
            code = exc.code
            raw = exc.read()

        except (URLError, TimeoutError, OSError) as exc:
            raise SmokeError(
                f"Cannot reach FastAPI at {self.base_url} ({exc}). "
                "Start the API in a separate terminal."
            ) from exc

        try:
            body = json.loads(raw) if raw else {}

        except ValueError as exc:
            raise SmokeError(
                f"{method} {path}: server returned non-JSON output"
            ) from exc

        if code not in allowed:
            detail = (
                body.get("detail", body)
                if isinstance(body, dict)
                else body
            )

            raise SmokeError(
                f"{method} {path} returned HTTP {code}: "
                f"{str(detail)[:500]}"
            )

        if not isinstance(body, dict):
            raise SmokeError(
                f"{method} {path}: expected a JSON object"
            )

        return body


def _resolve_schema(
    spec: dict[str, Any],
    schema: dict[str, Any],
) -> dict[str, Any]:
    """Resolve standard OpenAPI references and simple allOf wrappers."""
    if "$ref" in schema:
        ref = schema["$ref"]

        if not ref.startswith("#/components/schemas/"):
            raise SmokeError(
                f"Unexpected OpenAPI reference: {ref}"
            )

        return _resolve_schema(
            spec,
            spec["components"]["schemas"][
                ref.rsplit("/", 1)[1]
            ],
        )

    if "allOf" in schema:
        result: dict[str, Any] = {
            "properties": {},
            "required": [],
        }

        for item in schema["allOf"]:
            part = _resolve_schema(spec, item)

            result["properties"].update(
                part.get("properties", {})
            )

            result["required"].extend(
                part.get("required", [])
            )

        return result

    return schema


def _operation(
    spec: dict[str, Any],
    suffix: str,
    method: str = "post",
) -> tuple[str, dict[str, Any]]:
    matches = [
        (path, operations[method])
        for path, operations in spec.get("paths", {}).items()
        if path.rstrip("/").endswith(suffix)
        and method in operations
    ]

    if len(matches) != 1:
        raise SmokeError(
            f"Expected one {method.upper()} *{suffix} route; "
            f"found {len(matches)}"
        )

    return matches[0]


def _input_schema(
    spec: dict[str, Any],
    operation: dict[str, Any],
    content_type: str,
) -> dict[str, Any]:
    body = operation.get("requestBody", {})

    if "$ref" in body:
        raise SmokeError(
            "Request-body OpenAPI $ref is not supported "
            "in this smoke test"
        )

    media = body.get("content", {}).get(content_type)

    if media is None:
        raise SmokeError(
            f"Endpoint does not accept {content_type}"
        )

    return _resolve_schema(
        spec,
        media.get("schema", {}),
    )


def _registration_data(
    spec: dict[str, Any],
    operation: dict[str, Any],
    email: str,
    password: str,
) -> dict[str, str]:
    schema = _input_schema(
        spec,
        operation,
        "application/json",
    )

    props = schema.get("properties", {})

    candidates = {
        "email": email,
        "password": password,
        "username": email,
        "name": "CaaS E2E Smoke Test",
        "full_name": "CaaS E2E Smoke Test",
        "display_name": "CaaS E2E Smoke Test",
        "confirm_password": password,
        "password_confirmation": password,
        "password_confirm": password,
    }

    missing = [
        name
        for name in schema.get("required", [])
        if name not in candidates
    ]

    if missing:
        raise SmokeError(
            "Unknown required registration fields: "
            f"{missing}; inspect /docs"
        )

    data = {
        key: candidates[key]
        for key in ("email", "password")
        if key in props
    }

    data.update({
        key: candidates[key]
        for key in schema.get("required", [])
        if key in props
    })

    if not {"email", "password"}.issubset(data):
        raise SmokeError(
            "Registration schema must expose email and password"
        )

    return data


def _login_body(
    spec: dict[str, Any],
    operation: dict[str, Any],
    email: str,
    password: str,
) -> tuple[str, dict[str, str]]:
    contents = (
        operation.get("requestBody", {})
        .get("content", {})
    )

    if "application/x-www-form-urlencoded" in contents:
        return "form", {
            "username": email,
            "password": password,
        }

    if "application/json" in contents:
        schema = _input_schema(
            spec,
            operation,
            "application/json",
        )

        props = schema.get("properties", {})

        user_field = (
            "email"
            if "email" in props
            else "username"
        )

        return "payload", {
            user_field: email,
            "password": password,
        }

    raise SmokeError(
        "Login requires unsupported HTTP request format"
    )


def _is_binary_upload_field(
    spec: dict[str, Any],
    definition: dict[str, Any],
) -> bool:
    """Recognize binary fields, including nullable anyOf wrappers."""
    resolved = _resolve_schema(spec, definition)

    if resolved.get("format") == "binary":
        return True

    for variant in ("anyOf", "oneOf", "allOf"):
        for item in resolved.get(variant, []):
            if _is_binary_upload_field(spec, item):
                return True

    return False


def _upload_route(
    spec: dict[str, Any],
) -> tuple[str, str]:
    """Find the actual CSV upload endpoint and its file form field.

    Handles FastAPI's referenced request-body schemas, nullable
    binary fields, and common single-file multipart definitions.
    """
    path = f"{API_PREFIX}/datasets/upload"

    operation = (
        spec.get("paths", {})
        .get(path, {})
        .get("post")
    )

    if operation is None:
        raise SmokeError(
            f"POST {path} is missing from /openapi.json"
        )

    schema = _input_schema(
        spec,
        operation,
        "multipart/form-data",
    )

    properties = schema.get("properties", {})
    required = set(schema.get("required", []))

    binary_names = [
        name
        for name, definition in properties.items()
        if _is_binary_upload_field(spec, definition)
    ]

    if len(binary_names) == 1:
        field_name = binary_names[0]

    elif "file" in properties:
        field_name = "file"

    elif len(properties) == 1:
        field_name = next(iter(properties))

    elif (
        len(required) == 1
        and next(iter(required)) in properties
    ):
        field_name = next(iter(required))

    else:
        raise SmokeError(
            f"Could not identify CSV form field for {path}. "
            f"Fields={list(properties)}, "
            f"required={sorted(required)}"
        )

    extra_required = required - {field_name}

    if extra_required:
        raise SmokeError(
            "CSV upload also requires form fields "
            f"{sorted(extra_required)}; "
            "check the upload endpoint in /docs"
        )

    return path, field_name


def _dataset_id(
    body: dict[str, Any],
) -> str:
    """Extract the UUID dataset ID from an upload response."""
    for candidate in (
        body,
        body.get("dataset"),
        body.get("data"),
    ):
        if isinstance(candidate, dict):
            raw = (
                candidate.get("dataset_id")
                or candidate.get("id")
            )

            if raw is not None:
                try:
                    return str(UUID(str(raw)))
                except ValueError:
                    pass

    raise SmokeError(
        "Upload response does not contain a UUID dataset ID: "
        f"{sorted(body)}"
    )


def _check_result(
    result: Any,
    expected_rows: int,
) -> None:
    if not isinstance(result, dict):
        raise SmokeError(
            "Job completed without a stored result. "
            "Check worker logs."
        )

    if (
        result.get("n_samples") != expected_rows
        or result.get("n_clusters") != 2
    ):
        raise SmokeError(
            "Result row/cluster counts do not match "
            "submitted data"
        )

    if len(result.get("centroids", [])) != 2:
        raise SmokeError(
            "Expected two cluster centroids"
        )

    metrics = result.get("metrics", {})
    cluster_sizes = metrics.get("cluster_sizes", {})

    if sum(
        int(n)
        for n in cluster_sizes.values()
    ) != expected_rows:
        raise SmokeError(
            "Saved cluster sizes do not match input row count"
        )


def run(
    base_url: str,
    timeout: int,
    interval: float,
) -> None:
    api = Api(base_url)

    print("[1/8] Checking FastAPI and OpenAPI routes")

    spec = api.call(
        "GET",
        "/openapi.json",
        authenticate=False,
    )

    register_path, register_op = _operation(
        spec,
        "/auth/register",
    )

    login_path, login_op = _operation(
        spec,
        "/auth/login",
    )

    upload_path, upload_field = _upload_route(spec)

    print(
        f"  Upload endpoint: {upload_path}; "
        f"file field: {upload_field}"
    )

    print(
        "[2/8] Registering a unique test user and logging in"
    )

    unique = secrets.token_hex(6)

    email = (
        f"caas-smoke-{unique}@example.com"
    )

    password = (
        f"CaasSmoke!{secrets.token_hex(12)}A9"
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
        allowed=(200, 201),
        authenticate=False,
    )

    login_kind, login_body = _login_body(
        spec,
        login_op,
        email,
        password,
    )

    response = api.call(
        "POST",
        login_path,
        **{login_kind: login_body},
        allowed=(200, 201),
        authenticate=False,
    )

    token = (
        response.get("access_token")
        or response.get("token")
    )

    if not isinstance(token, str) or not token:
        raise SmokeError(
            "Login response has no access_token or token"
        )

    api.token = token

    print(
        "  PASS: Authenticated test account created"
    )

    print("[3/8] Uploading a 12-row numeric CSV")

    csv_bytes = (
        "age,income\n"
        + "".join(
            f"{age},{income}\n"
            for age, income in ROWS
        )
    ).encode("utf-8")

    filename = (
        f"caas_smoke_{unique}.csv"
    )

    uploaded = api.call(
        "POST",
        upload_path,
        upload=(
            upload_field,
            filename,
            csv_bytes,
        ),
        allowed=(200, 201),
    )

    dataset_id = _dataset_id(uploaded)

    print("  PASS: Dataset ID:", dataset_id)

    experiment_request: dict[str, Any] = {
        "dataset_id": dataset_id,
        "n_clusters": 2,
        "features": [
            "age",
            "income",
        ],
        "random_state": 42,
        "include_silhouette": True,
    }

    print("[4/8] Checking experiment preflight")

    preflight = api.call(
        "POST",
        f"{API_PREFIX}/experiments/preflight",
        payload=experiment_request,
    )

    if preflight.get("dataset_id") != dataset_id:
        raise SmokeError(
            "Preflight returned a different dataset"
        )

    print(
        "  PASS: Preflight accepted the configuration"
    )

    print(
        "[5/8] Submitting the experiment "
        "to PostgreSQL and Redis"
    )

    submitted = api.call(
        "POST",
        f"{API_PREFIX}/experiments",
        payload=experiment_request,
        allowed=(202,),
    )

    try:
        job_id = str(
            UUID(str(submitted["job_id"]))
        )

        experiment_id = str(
            UUID(str(submitted["experiment_id"]))
        )

    except (KeyError, TypeError, ValueError) as exc:
        raise SmokeError(
            "Submission must return job_id "
            "and experiment_id UUIDs"
        ) from exc

    if submitted.get("dataset_id") != dataset_id:
        raise SmokeError(
            "Submission returned a mismatched dataset_id"
        )

    print(
        "  PASS: Experiment:",
        experiment_id,
    )

    print(
        "  PASS: RQ job:    ",
        job_id,
    )

    print(
        "[6/8] Waiting for the worker "
        "to process the job"
    )

    deadline = (
        time.monotonic() + timeout
    )

    previous = None

    while True:
        status_response = api.call(
            "GET",
            f"{API_PREFIX}/experiments/{job_id}",
        )

        state = status_response.get("status")

        if state != previous:
            source = status_response.get(
                "status_source"
            )

            print(
                f"  Job state: {state} "
                f"(source: {source})"
            )

            previous = state

        if state == "completed":
            if (
                status_response.get("status_source")
                != "postgresql"
            ):
                raise SmokeError(
                    "Completed job was not reported "
                    "from PostgreSQL"
                )

            _check_result(
                status_response.get("result"),
                len(ROWS),
            )

            break

        if state in (
            "failed",
            "cancelled",
        ):
            raise SmokeError(
                f"Job reached {state!r}. "
                "Check the RQ worker's terminal "
                "for the root cause."
            )

        if state not in (
            "queued",
            "running",
        ):
            raise SmokeError(
                f"Unknown job state: {state!r}"
            )

        if time.monotonic() >= deadline:
            raise SmokeError(
                "Timed out waiting for worker. "
                "Verify `python -m backend.worker` "
                "is running and inspect both terminal logs."
            )

        time.sleep(interval)

    print(
        "  PASS: PostgreSQL reports a completed "
        "job with valid metrics"
    )

    print(
        "[7/8] Reading permanent experiment "
        "history and cluster labels"
    )

    detail = api.call(
        "GET",
        (
            f"{API_PREFIX}/experiments/history/"
            f"{experiment_id}?include_labels=true"
        ),
    )

    if (
        not detail.get("result_available")
        or detail.get("experiment_id") != experiment_id
    ):
        raise SmokeError(
            "Experiment history did not return "
            "its permanent result"
        )

    _check_result(
        detail.get("result"),
        len(ROWS),
    )

    labels = detail["result"].get("labels")

    if (
        not isinstance(labels, list)
        or len(labels) != len(ROWS)
    ):
        raise SmokeError(
            "Persistent experiment has missing row labels"
        )

    history = api.call(
        "GET",
        (
            f"{API_PREFIX}/experiments/history"
            "?limit=100&offset=0"
        ),
    )

    found = any(
        item.get("experiment_id") == experiment_id
        for item in history.get("items", [])
    )

    if not found:
        raise SmokeError(
            "New experiment is missing "
            "from the history list"
        )

    print(
        "  PASS: Saved experiment, centroids, "
        "and all row labels retrieved"
    )

    print(
        "[8/8] Verifying experiment history "
        "rejects anonymous access"
    )

    api.call(
        "GET",
        f"{API_PREFIX}/experiments/history",
        allowed=(401, 403),
        authenticate=False,
    )

    print(
        "  PASS: Anonymous access rejected"
    )

    print(
        "\nALL FILE 44 END-TO-END TESTS PASSED!"
    )

    print(
        "This run created test records; "
        "they remain in PostgreSQL for inspection."
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "CaaS full backend end-to-end smoke test"
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
        help="Worker polling timeout in seconds",
    )

    parser.add_argument(
        "--interval",
        type=float,
        default=2,
        help="Polling interval in seconds",
    )

    args = parser.parse_args()

    if (
        args.timeout < 1
        or args.interval <= 0
    ):
        parser.error(
            "--timeout and --interval must be positive"
        )

    try:
        run(
            args.base_url,
            args.timeout,
            args.interval,
        )

    except SmokeError as exc:
        print(
            f"\nFILE 44 FAILED: {exc}",
            file=sys.stderr,
        )

        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
