"""Password hashing and signed access tokens for the CaaS backend.

No credentials or signing keys are hard-coded. Authentication endpoints will
use these helpers after user validation and database checks are implemented.
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import jwt
from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError

from configuration.settings import Settings, get_settings


_password_hasher = PasswordHash.recommended()  # Argon2
JWT_ISSUER = "caas-api"
JWT_AUDIENCE = "caas-client"


class InvalidAccessTokenError(ValueError):
    """A supplied access token is invalid, expired, or not for this API."""


def hash_password(password: str) -> str:
    """Hash a password using Argon2; never store or log the original value."""
    if not password:
        raise ValueError("Password cannot be empty")
    return _password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Check a password; unrecognized stored hash formats are rejected."""
    if not password_hash:
        return False
    try:
        return _password_hasher.verify(password, password_hash)
    except UnknownHashError:
        return False


def create_access_token(user_id: UUID, *, settings: Settings | None = None) -> str:
    """Create a short-lived, signed JWT for an authenticated user."""
    config = settings if settings is not None else get_settings()
    signing_key = config.require_jwt_secret_key()
    now = datetime.now(timezone.utc)
    claims = {
        "sub": str(user_id),
        "iat": now,
        "exp": now + timedelta(minutes=config.access_token_expire_minutes),
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "jti": uuid4().hex,
        "token_type": "access",
    }
    return jwt.encode(claims, signing_key, algorithm=config.jwt_algorithm)


def decode_access_token(token: str, *, settings: Settings | None = None) -> UUID:
    """Verify a JWT and return its user UUID (never trust unverified claims)."""
    config = settings if settings is not None else get_settings()
    signing_key = config.require_jwt_secret_key()
    try:
        payload = jwt.decode(
            token,
            signing_key,
            algorithms=[config.jwt_algorithm],
            issuer=JWT_ISSUER,
            audience=JWT_AUDIENCE,
            options={
                "require": ["sub", "iat", "exp", "iss", "aud", "jti", "token_type"],
            },
        )
        if payload.get("token_type") != "access":
            raise InvalidAccessTokenError("Invalid access token")
        return UUID(payload["sub"])
    except (jwt.InvalidTokenError, ValueError, TypeError) as exc:
        raise InvalidAccessTokenError("Invalid or expired access token") from exc
