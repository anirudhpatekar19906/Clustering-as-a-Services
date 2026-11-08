"""Pydantic contracts for CaaS registration, login, and token responses.

Passwords are accepted as SecretStr and never returned in public responses.
Email validation is intentionally dependency-free; it checks common ASCII
mailbox syntax, not every RFC-permitted internationalized address.
"""

import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


# A conservative email format for the initial application release.
_EMAIL_PATTERN = re.compile(
    r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
    r"(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
    r"@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+"
    r"[A-Za-z]{2,63}"
)


class _EmailInput(BaseModel):
    """Normalize email consistently for signup and login."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    email: str = Field(min_length=3, max_length=320)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        email = value.strip().lower()
        if not _EMAIL_PATTERN.fullmatch(email):
            raise ValueError("Enter a valid email address")
        return email


class UserRegistrationRequest(_EmailInput):
    """Request body for account registration."""

    password: SecretStr = Field(min_length=12, max_length=128)
    display_name: str | None = Field(default=None, max_length=120)

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().strip():
            raise ValueError("Password must not contain only whitespace")
        return value

    @field_validator("display_name")
    @classmethod
    def normalize_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        name = value.strip()
        if not name:
            raise ValueError("Display name cannot be blank")
        return name


class UserLoginRequest(_EmailInput):
    """Request body for password-based login."""

    password: SecretStr = Field(min_length=1, max_length=128)


class UserResponse(BaseModel):
    """Public account fields; password hashes are intentionally excluded."""

    model_config = ConfigDict(from_attributes=True, extra="forbid")

    id: UUID
    email: str
    display_name: str | None
    is_active: bool
    created_at: datetime


class TokenResponse(BaseModel):
    """JWT authentication response returned after successful login."""

    model_config = ConfigDict(extra="forbid")

    access_token: str = Field(min_length=1)
    token_type: Literal["bearer"] = "bearer"
    expires_in: int = Field(gt=0, description="Access token lifetime in seconds")
