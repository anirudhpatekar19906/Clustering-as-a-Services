"""File 98 — CaaS profile security and integration regression.

Run from the CaaS project root on your LOCAL development backend:
    python tests/profile_security_regression.py

Prerequisites: PostgreSQL, the current Alembic migrations, and FastAPI.
No Redis worker, CSV upload, or frontend is needed for this test.

Creates two unique test accounts and their profiles in the local database.
Does NOT modify or delete any existing account. Test records are retained.
Uses only Python's standard library and the existing File 84 test helpers.
This is focused regression coverage, not a complete production security audit.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import UUID

from security_regression import require, unique_user
from smoke_end_to_end import Api, SmokeError

PROFILE_PATH = "/api/v1/profile/me"
DEFAULT_COLOR = "#305BE8"

ALLOWED_RESPONSE_KEYS = {
    "user_id",
    "email",
    "display_name",
    "full_name",
    "bio",
    "age",
    "gender",
    "gender_description",
    "occupation",
    "organization",
    "avatar_color",
    "joined_at",
    "created_at",
    "updated_at",
}


def profile_from(
    body: dict[str, Any],
    *,
    exists: bool,
) -> dict[str, Any]:
    require(
        body.get("success") is True,
        "Profile response does not report success",
    )

    require(
        body.get("profile_exists") is exists,
        "Unexpected profile_exists state",
    )

    profile = body.get("profile")

    require(
        isinstance(profile, dict),
        "Profile response is missing profile data",
    )

    require(
        set(profile) == ALLOWED_RESPONSE_KEYS,
        "Profile response has unexpected or missing keys",
    )

    for secret in (
        "password",
        "password_hash",
        "hashed_password",
        "access_token",
        "token",
    ):
        require(
            secret not in str(profile.keys()).lower(),
            f"Sensitive property exposed: {secret}",
        )

    try:
        UUID(str(profile["user_id"]))
    except (TypeError, ValueError, KeyError) as exc:
        raise SmokeError(
            "Profile user_id is not a valid UUID"
        ) from exc

    return profile


def read_profile(
    api: Api,
    *,
    exists: bool = True,
) -> dict[str, Any]:
    return profile_from(
        api.call("GET", PROFILE_PATH),
        exists=exists,
    )


def expect_rejected(
    api: Api,
    payload: dict[str, Any],
    *,
    status: int = 422,
) -> None:
    result = api.call(
        "PATCH",
        PROFILE_PATH,
        payload=payload,
        allowed=(status,),
    )

    require(
        "detail" in result,
        f"Rejected request returned no error detail: {payload.keys()}",
    )


def verify_private_response_headers(api: Api) -> None:
    """Confirm authenticated profile reads are not cacheable."""

    require(
        api.token is not None,
        "No bearer token available for header check",
    )

    request = Request(
        api.base_url.rstrip("/") + PROFILE_PATH,
        headers={
            "Authorization": f"Bearer {api.token}",
            "Accept": "application/json",
        },
        method="GET",
    )

    try:
        with urlopen(request, timeout=20) as response:
            require(
                response.status == 200,
                "Profile header check did not return HTTP 200",
            )

            cache = response.headers.get(
                "Cache-Control", ""
            ).lower()

            vary = response.headers.get(
                "Vary", ""
            ).lower()

            nosniff = response.headers.get(
                "X-Content-Type-Options", ""
            ).lower()

    except HTTPError as exc:
        raise SmokeError(
            f"Profile header check returned HTTP {exc.code}"
        ) from exc

    except (URLError, TimeoutError, OSError) as exc:
        raise SmokeError(
            f"Cannot perform profile header check: {exc}"
        ) from exc

    require(
        "no-store" in cache,
        "Profile GET is missing Cache-Control: no-store",
    )

    require(
        "authorization" in vary,
        "Profile GET is missing Vary: Authorization",
    )

    require(
        nosniff == "nosniff",
        "Profile GET is missing X-Content-Type-Options: nosniff",
    )


def run(base_url: str) -> None:
    owner = Api(base_url)
    other = Api(base_url)
    anonymous = Api(base_url)

    print("[1/8] Verifying local API and profile routes")

    spec = anonymous.call(
        "GET",
        "/openapi.json",
        authenticate=False,
    )

    operations = spec.get(
        "paths", {}
    ).get(PROFILE_PATH, {})

    require(
        "get" in operations and "patch" in operations,
        "Profile GET/PATCH routes are missing",
    )

    print("  PASS: Profile GET and PATCH registered")

    print(
        "[2/8] Creating two independent test users; "
        "checking empty profiles"
    )

    owner_email = unique_user(
        owner,
        spec,
        "profile-owner",
    )

    other_email = unique_user(
        other,
        spec,
        "profile-other",
    )

    require(
        owner.token != other.token,
        "Two users received the same token",
    )

    first_owner = read_profile(
        owner,
        exists=False,
    )

    first_other = read_profile(
        other,
        exists=False,
    )

    require(
        first_owner["email"] == owner_email,
        "Owner profile has incorrect email",
    )

    require(
        first_other["email"] == other_email,
        "Other profile has incorrect email",
    )

    require(
        first_owner["user_id"] != first_other["user_id"],
        "User IDs are not isolated",
    )

    require(
        first_owner["avatar_color"] == DEFAULT_COLOR,
        "Wrong default avatar color",
    )

    require(
        first_owner["created_at"] is None,
        "GET unexpectedly created a profile record",
    )

    print(
        "  PASS: Fresh GET creates no row; "
        "accounts and identities are distinct"
    )

    print(
        "[3/8] Creating private profiles "
        "and checking input normalization"
    )

    created = profile_from(
        owner.call(
            "PATCH",
            PROFILE_PATH,
            payload={
                "display_name": "  Profile Owner  ",
                "full_name": "  Owner Example  ",
                "bio": "  First line\r\nSecond line  ",
                "age": 29,
                "gender": "self_described",
                "gender_description": "  Researcher  ",
                "occupation": "  Analyst  ",
                "organization": "  Example Lab  ",
                "avatar_color": "#129A8E",
            },
        ),
        exists=True,
    )

    require(
        created["user_id"] == first_owner["user_id"],
        "New profile owner changed",
    )

    require(
        created["display_name"] == "Profile Owner",
        "Display name was not trimmed",
    )

    require(
        created["bio"] == "First line\nSecond line",
        "Bio was not normalized",
    )

    require(
        created["gender_description"] == "Researcher",
        "Custom gender text was not trimmed",
    )

    require(
        created["avatar_color"] == "#129A8E",
        "Avatar color was not saved",
    )

    require(
        created["created_at"] is not None,
        "New profile has no creation timestamp",
    )

    second_created = profile_from(
        other.call(
            "PATCH",
            PROFILE_PATH,
            payload={
                "display_name": "Second Account",
                "avatar_color": "#D97735",
            },
        ),
        exists=True,
    )

    require(
        second_created["user_id"] == first_other["user_id"],
        "Second account owner changed",
    )

    require(
        second_created["display_name"] == "Second Account",
        "Second profile save failed",
    )

    print(
        "  PASS: First writes create the correct rows "
        "and normalize approved fields"
    )

    print(
        "[4/8] Testing partial updates, clears, "
        "and persistence across GETs"
    )

    partial = profile_from(
        owner.call(
            "PATCH",
            PROFILE_PATH,
            payload={
                "display_name": "  Updated Owner  ",
                "avatar_color": "#8B5CF6",
            },
        ),
        exists=True,
    )

    require(
        partial["display_name"] == "Updated Owner",
        "Partial name update failed",
    )

    require(
        partial["age"] == 29
        and partial["occupation"] == "Analyst",
        "Partial PATCH erased fields",
    )

    require(
        partial["gender_description"] == "Researcher",
        "Partial PATCH erased gender details",
    )

    cleared = profile_from(
        owner.call(
            "PATCH",
            PROFILE_PATH,
            payload={
                "gender": "prefer_not_to_say",
                "bio": None,
                "age": None,
            },
        ),
        exists=True,
    )

    require(
        cleared["gender_description"] is None,
        "Changing gender did not clear custom text",
    )

    require(
        cleared["bio"] is None
        and cleared["age"] is None,
        "Null clear did not work",
    )

    saved_owner = read_profile(owner)

    require(
        saved_owner == cleared,
        "Owner's saved profile changed between requests",
    )

    require(
        read_profile(other) == second_created,
        "Owner updates modified the other account",
    )

    print(
        "  PASS: PATCH is partial; null clears work; "
        "subsequent GETs retain saved values"
    )

    print(
        "[5/8] Rejecting anonymous "
        "and invalid-token profile access"
    )

    for method, payload in (
        ("GET", None),
        ("PATCH", {"display_name": "Intruder"}),
    ):
        denied = anonymous.call(
            method,
            PROFILE_PATH,
            payload=payload,
            allowed=(401, 403),
        )

        require(
            "detail" in denied,
            "Anonymous request did not return a denial detail",
        )

    forged = Api(base_url)
    forged.token = "not.a.valid.jwt"

    for method, payload in (
        ("GET", None),
        ("PATCH", {"display_name": "Intruder"}),
    ):
        denied = forged.call(
            method,
            PROFILE_PATH,
            payload=payload,
            allowed=(401, 403),
        )

        require(
            "detail" in denied,
            "Invalid bearer token was not rejected",
        )

    print(
        "  PASS: Both reads and writes reject "
        "anonymous and invalid bearer tokens"
    )

    print(
        "[6/8] Rejecting privileged fields "
        "and invalid input without changing data"
    )

    invalid_payloads: list[dict[str, Any]] = [
        {},
        {"email": other_email},
        {"user_id": first_other["user_id"]},
        {"password": "InjectedPassword123!"},
        {"is_admin": True},
        {"avatar_color": "#FF0000"},
        {"avatar_color": None},
        {"age": -1},
        {"age": 121},
        {"age": True},
        {"age": "29"},
        {"display_name": "X" * 81},
        {"bio": "Y" * 501},
        {"display_name": "Invalid\x00Name"},
        {"gender": "invalid_gender"},
        {"gender": "self_described"},
        {"gender_description": "not allowed alone"},
        {
            "gender": "man",
            "gender_description": "not allowed",
        },
    ]

    for i, payload in enumerate(
        invalid_payloads,
        start=1,
    ):
        try:
            expect_rejected(owner, payload)
        except SmokeError as exc:
            raise SmokeError(
                f"Validation case {i} failed "
                f"({list(payload)}): {exc}"
            ) from exc

    require(
        read_profile(owner) == saved_owner,
        "A rejected PATCH modified the owner profile",
    )

    require(
        read_profile(other) == second_created,
        "A rejected PATCH modified the other profile",
    )

    print(
        f"  PASS: {len(invalid_payloads)} "
        "invalid/forbidden updates rejected with HTTP 422"
    )

    print(
        "[7/8] Testing account isolation "
        "against query/body owner spoofing"
    )

    spoofed_read = profile_from(
        owner.call(
            "GET",
            f"{PROFILE_PATH}?user_id={first_other['user_id']}",
        ),
        exists=True,
    )

    require(
        spoofed_read["user_id"] == first_owner["user_id"],
        "Query parameter exposed another user",
    )

    spoofed_write = profile_from(
        owner.call(
            "PATCH",
            f"{PROFILE_PATH}?user_id={first_other['user_id']}",
            payload={
                "organization": "Owner Only Organization"
            },
        ),
        exists=True,
    )

    require(
        spoofed_write["user_id"] == first_owner["user_id"],
        "Query parameter rewrote owner",
    )

    require(
        read_profile(other) == second_created,
        "Owner spoofing changed another user's profile",
    )

    updated_other = profile_from(
        other.call(
            "PATCH",
            PROFILE_PATH,
            payload={
                "display_name": "Second Updated"
            },
        ),
        exists=True,
    )

    require(
        updated_other["display_name"] == "Second Updated",
        "Other user cannot update own profile",
    )

    require(
        read_profile(owner) == spoofed_write,
        "Second user updated the owner's profile",
    )

    print(
        "  PASS: Body owner injection rejected; "
        "query owner spoofing cannot redirect GET/PATCH"
    )

    print(
        "[8/8] Verifying private response headers "
        "and final data consistency"
    )

    verify_private_response_headers(owner)
    verify_private_response_headers(other)

    require(
        read_profile(owner)["email"] == owner_email,
        "Owner email changed unexpectedly",
    )

    require(
        read_profile(other)["email"] == other_email,
        "Other account email changed unexpectedly",
    )

    print(
        "  PASS: Private no-store headers; "
        "emails remain immutable"
    )

    print(
        "\nALL FILE 98 PROFILE SECURITY "
        "AND INTEGRATION CHECKS PASSED!"
    )

    print(
        "Two disposable accounts and their profiles "
        "remain in the LOCAL database."
    )

    print(
        "Note: This checks the FastAPI/backend API, "
        "not the Next.js cookie bridge."
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="CaaS local profile security regression"
    )

    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8000",
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
        or target.username is not None
        or target.password is not None
        or target.query
        or target.fragment
        or target.path not in ("", "/")
    ):
        parser.error(
            "This test creates records "
            "and must target a local HTTP API root"
        )

    print(
        "CAAS FILE 98: local-only profile "
        "security and integration regression"
    )

    print(
        "Creates two disposable accounts; "
        "existing user data will not be changed.\n"
    )

    try:
        run(args.base_url)
    except SmokeError as exc:
        print(
            f"\nFILE 98 FAILED: {exc}",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
