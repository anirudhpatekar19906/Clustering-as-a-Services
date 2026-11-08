"""CaaS profile API (Files 92 and 94).

GET   /api/v1/profile/me — read the current user's optional private profile.
PATCH /api/v1/profile/me — create or partially update that profile.

Both routes require the existing verified JWT. Profile ownership is derived
only from the authenticated account, never from request data. Email and
password changes require separate verification flows and are not supported
here. Profiles are private, and responses are marked no-store.
"""

from __future__ import annotations

import logging
import unicodedata
from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationInfo, field_validator
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models import User
from backend.profile_models import UserProfile
from backend.routers.auth import get_current_user


logger = logging.getLogger("caas.profile")

router = APIRouter(
    prefix="/profile",
    tags=["Profile"],
)

DEFAULT_AVATAR_COLOR = "#305BE8"

Gender = Literal[
    "woman",
    "man",
    "non_binary",
    "self_described",
    "prefer_not_to_say",
]

AvatarColor = Literal[
    "#305BE8",
    "#129A8E",
    "#8B5CF6",
    "#D97735",
    "#46627F",
]


# ============================================================
# Response models
# ============================================================

class ProfileData(BaseModel):
    """Only owner-visible, approved fields. No password or token."""

    model_config = ConfigDict(extra="forbid")

    user_id: UUID
    email: str

    display_name: str | None
    full_name: str | None
    bio: str | None
    age: int | None
    gender: str | None
    gender_description: str | None
    occupation: str | None
    organization: str | None
    avatar_color: str

    joined_at: datetime | None
    created_at: datetime | None
    updated_at: datetime | None


class ProfileResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    success: Literal[True] = True
    profile_exists: bool
    profile: ProfileData


# ============================================================
# File 94 — Validated profile update request
# ============================================================

class ProfilePatch(BaseModel):
    """Editable fields only.

    Omitted fields remain unchanged.

    Send null to clear an optional field.
    Blank text values are also normalized to null.

    Email, password, and user ID cannot be changed here.
    Unknown fields are rejected automatically.
    """

    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(
        default=None,
        max_length=80,
    )

    full_name: str | None = Field(
        default=None,
        max_length=120,
    )

    bio: str | None = Field(
        default=None,
        max_length=500,
    )

    age: StrictInt | None = Field(
        default=None,
        ge=0,
        le=120,
    )

    gender: Gender | None = None

    gender_description: str | None = Field(
        default=None,
        max_length=80,
    )

    occupation: str | None = Field(
        default=None,
        max_length=100,
    )

    organization: str | None = Field(
        default=None,
        max_length=120,
    )

    avatar_color: AvatarColor = DEFAULT_AVATAR_COLOR

    @field_validator(
        "display_name",
        "full_name",
        "bio",
        "gender_description",
        "occupation",
        "organization",
        mode="before",
    )
    @classmethod
    def normalize_text(
        cls,
        value: object,
        info: ValidationInfo,
    ) -> object:
        """Trim text and reject hidden control characters."""

        if value is None or not isinstance(value, str):
            return value

        cleaned = value.replace("\r\n", "\n").strip()

        if not cleaned:
            return None

        for character in cleaned:
            category = unicodedata.category(character)

            if category in ("Cc", "Cf", "Cs") and not (
                info.field_name == "bio"
                and character == "\n"
            ):
                raise ValueError(
                    "Text contains unsupported control characters"
                )

        return cleaned


# ============================================================
# Shared helpers
# ============================================================

def _no_store(response: Response) -> None:
    """Prevent private profile information from being cached."""

    response.headers["Cache-Control"] = (
        "private, no-store, max-age=0"
    )

    response.headers["Vary"] = "Authorization"

    response.headers["X-Content-Type-Options"] = "nosniff"


def _account_joined_at(
    user: User,
) -> datetime | None:
    joined = getattr(
        user,
        "created_at",
        None,
    )

    return (
        joined
        if isinstance(joined, datetime)
        else None
    )


def _serialize(
    user: User,
    profile: UserProfile | None,
) -> ProfileResponse:
    """Return approved fields, never the full database objects."""

    return ProfileResponse(
        profile_exists=profile is not None,

        profile=ProfileData(
            user_id=user.id,
            email=user.email,

            display_name=(
                profile.display_name
                if profile
                else None
            ),

            full_name=(
                profile.full_name
                if profile
                else None
            ),

            bio=(
                profile.bio
                if profile
                else None
            ),

            age=(
                profile.age
                if profile
                else None
            ),

            gender=(
                profile.gender
                if profile
                else None
            ),

            gender_description=(
                profile.gender_description
                if profile
                else None
            ),

            occupation=(
                profile.occupation
                if profile
                else None
            ),

            organization=(
                profile.organization
                if profile
                else None
            ),

            avatar_color=(
                profile.avatar_color
                if profile
                else DEFAULT_AVATAR_COLOR
            ),

            joined_at=_account_joined_at(user),

            created_at=(
                profile.created_at
                if profile
                else None
            ),

            updated_at=(
                profile.updated_at
                if profile
                else None
            ),
        ),
    )


# ============================================================
# Existing GET /api/v1/profile/me
# ============================================================

@router.get(
    "/me",
    response_model=ProfileResponse,
    status_code=status.HTTP_200_OK,
    summary="Read the signed-in user's private profile",
)
def get_my_profile(
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProfileResponse:
    """Read the authenticated user's profile without modifying it."""

    _no_store(response)

    try:
        profile = db.get(
            UserProfile,
            current_user.id,
        )

    except SQLAlchemyError as exc:
        logger.exception(
            "Unable to load authenticated profile"
        )

        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Profile service is temporarily unavailable",
        ) from exc

    return _serialize(
        current_user,
        profile,
    )


# ============================================================
# File 94 — PATCH /api/v1/profile/me
# ============================================================

@router.patch(
    "/me",
    response_model=ProfileResponse,
    status_code=status.HTTP_200_OK,
    summary="Create or update the signed-in user's private profile",
)
def update_my_profile(
    changes: ProfilePatch,
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProfileResponse:
    """Update only fields explicitly submitted by the authenticated user.

    A first update creates the profile row.

    Existing fields are preserved when omitted.

    Ownership comes from the verified JWT, not the request body.

    Concurrent first-time profile creation is protected by the
    user_id primary key.
    """

    _no_store(response)

    # --------------------------------------------------------
    # Step 1 — Extract only supplied and validated fields
    # --------------------------------------------------------

    updates = changes.model_dump(
        exclude_unset=True
    )

    if not updates:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Provide at least one profile field to update",
        )

    # --------------------------------------------------------
    # Step 2 — Find the signed-in user's profile
    # --------------------------------------------------------

    try:
        profile = db.get(
            UserProfile,
            current_user.id,
        )

    except SQLAlchemyError as exc:
        logger.exception(
            "Unable to load profile for update"
        )

        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Profile service is temporarily unavailable",
        ) from exc

    # --------------------------------------------------------
    # Step 3 — Validate gender and self-description together
    # --------------------------------------------------------

    next_gender = updates.get(
        "gender",
        profile.gender
        if profile is not None
        else None,
    )

    next_description = updates.get(
        "gender_description",
        profile.gender_description
        if profile is not None
        else None,
    )

    if next_gender == "self_described":

        if not next_description:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    "Provide gender_description "
                    "when gender is self_described"
                ),
            )

    elif next_description is not None:

        if "gender_description" in updates:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    "gender_description is only used "
                    "with self_described"
                ),
            )

        # Clear an old custom description if gender changes.
        updates["gender_description"] = None

    # --------------------------------------------------------
    # Step 4 — Create a profile if this is the first update
    # --------------------------------------------------------

    if profile is None:
        profile = UserProfile(
            user_id=current_user.id,
        )

        db.add(profile)

    # --------------------------------------------------------
    # Step 5 — Apply only allowed submitted values
    # --------------------------------------------------------

    for key, value in updates.items():
        setattr(
            profile,
            key,
            value,
        )

    # --------------------------------------------------------
    # Step 6 — Save changes permanently in PostgreSQL
    # --------------------------------------------------------

    try:
        db.commit()
        db.refresh(profile)

    except IntegrityError as exc:
        db.rollback()

        logger.warning(
            "Profile write conflicted for authenticated account"
        )

        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Profile update conflicted; please retry",
        ) from exc

    except SQLAlchemyError as exc:
        db.rollback()

        logger.exception(
            "Unable to save authenticated profile"
        )

        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Profile could not be saved; please retry",
        ) from exc

    # --------------------------------------------------------
    # Step 7 — Return updated private profile
    # --------------------------------------------------------

    return _serialize(
        current_user,
        profile,
    )
