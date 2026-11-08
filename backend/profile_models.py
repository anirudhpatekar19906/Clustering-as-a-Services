"""File 90 — Private, optional CaaS user profile data model.

This module adds ONE profile per existing authentication user. It deliberately
lives outside backend/models.py so the established User, Dataset, Experiment,
and job mappings are not edited.

Important integration steps (not performed by importing this file):
- File 91: create the user_profiles table with an Alembic migration.
- Later: import UserProfile when constructing authenticated profile routes.
- Later: expose only owner-scoped, explicitly approved profile fields.

Do not expose this table through a public users listing. Email, credentials,
and authentication status continue to belong to the existing User model.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from backend.models import Base, User


# Optional, user-controlled gender values. No field is mandatory.
# A self-description is stored only if the user voluntarily supplies one.
PROFILE_GENDER_VALUES: tuple[str, ...] = (
    "woman",
    "man",
    "non_binary",
    "self_described",
    "prefer_not_to_say",
)

# Fixed color palette for initials-based avatars. This avoids accepting
# untrusted external avatar URLs or requiring image storage at this stage.
PROFILE_AVATAR_COLORS: tuple[str, ...] = (
    "#305BE8",  # CaaS blue
    "#129A8E",  # teal
    "#8B5CF6",  # violet
    "#D97735",  # warm orange
    "#46627F",  # slate
)


class UserProfile(Base):
    """Private, editable details for exactly one existing CaaS user.

    Profiles are optional: an existing account does not need a profile row.
    Only authenticated APIs may create, read, update, or delete a profile,
    using the user ID from the verified token rather than a supplied owner ID.
    """

    __tablename__ = "user_profiles"

    __table_args__ = (
        CheckConstraint(
            "age IS NULL OR (age >= 0 AND age <= 120)",
            name="ck_user_profiles_age_range",
        ),
        CheckConstraint(
            "gender IS NULL OR gender IN ("
            "'woman', 'man', 'non_binary', 'self_described', 'prefer_not_to_say'"
            ")",
            name="ck_user_profiles_gender",
        ),
        CheckConstraint(
            "avatar_color IN ("
            "'#305BE8', '#129A8E', '#8B5CF6', '#D97735', '#46627F'"
            ")",
            name="ck_user_profiles_avatar_color",
        ),
    )

    # PK + FK makes this a true one-to-one extension of the existing User.
    # The User model does not need a new relationship or column.
    user_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey(f"{User.__tablename__}.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )

    # The display name is what appears in the bottom-left account menu.
    display_name: Mapped[str | None] = mapped_column(
        String(80), nullable=True
    )

    full_name: Mapped[str | None] = mapped_column(
        String(120), nullable=True
    )

    bio: Mapped[str | None] = mapped_column(
        String(500), nullable=True
    )

    # Both fields are OPTIONAL. No age or gender is inferred from the email.
    age: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )

    gender: Mapped[str | None] = mapped_column(
        String(32), nullable=True
    )

    gender_description: Mapped[str | None] = mapped_column(
        String(80), nullable=True
    )

    # Optional professional context for a data-analysis workspace.
    occupation: Mapped[str | None] = mapped_column(
        String(100), nullable=True
    )

    organization: Mapped[str | None] = mapped_column(
        String(120), nullable=True
    )

    # Initials-based avatar. Image uploads will need a separate secure flow.
    avatar_color: Mapped[str] = mapped_column(
        String(7),
        nullable=False,
        default="#305BE8",
        server_default="#305BE8",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
