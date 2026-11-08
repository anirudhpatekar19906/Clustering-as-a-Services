"""Add optional, private user profiles without changing existing accounts.

Revision ID: 0003
Revises: 0002

Each profile is a one-to-one extension of an existing user:
user_id is both the primary key and a foreign key.

Existing users do not need a profile row.

This migration creates the database schema only.
Profile records will be created through authenticated APIs
in the next implementation files.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


# Alembic revision identifiers
revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    """Create the optional user_profiles table."""

    op.create_table(
        "user_profiles",

        # One-to-one relationship with an existing account.
        # Deleting the parent user also deletes their profile.
        sa.Column(
            "user_id",
            sa.Uuid(as_uuid=True),
            sa.ForeignKey(
                "users.id",
                ondelete="CASCADE",
            ),
            primary_key=True,
            nullable=False,
        ),

        # Personal information — all optional.
        sa.Column(
            "display_name",
            sa.String(length=80),
            nullable=True,
        ),

        sa.Column(
            "full_name",
            sa.String(length=120),
            nullable=True,
        ),

        sa.Column(
            "bio",
            sa.String(length=500),
            nullable=True,
        ),

        sa.Column(
            "age",
            sa.Integer(),
            nullable=True,
        ),

        sa.Column(
            "gender",
            sa.String(length=32),
            nullable=True,
        ),

        sa.Column(
            "gender_description",
            sa.String(length=80),
            nullable=True,
        ),

        # Optional professional information.
        sa.Column(
            "occupation",
            sa.String(length=100),
            nullable=True,
        ),

        sa.Column(
            "organization",
            sa.String(length=120),
            nullable=True,
        ),

        # Default initials-based avatar color.
        sa.Column(
            "avatar_color",
            sa.String(length=7),
            nullable=False,
            server_default=sa.text("'#305BE8'"),
        ),

        # Profile creation date.
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),

        # Last modification date.
        # Later profile-update APIs will use the ORM's
        # onupdate behavior to change this timestamp.
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),

        # Database-level age validation.
        sa.CheckConstraint(
            "age IS NULL OR (age >= 0 AND age <= 120)",
            name="ck_user_profiles_age_range",
        ),

        # Accepted optional gender values.
        sa.CheckConstraint(
            "gender IS NULL OR gender IN ("
            "'woman', 'man', 'non_binary', "
            "'self_described', 'prefer_not_to_say'"
            ")",
            name="ck_user_profiles_gender",
        ),

        # Allowed initials-avatar colors.
        sa.CheckConstraint(
            "avatar_color IN ("
            "'#305BE8', '#129A8E', '#8B5CF6', "
            "'#D97735', '#46627F'"
            ")",
            name="ck_user_profiles_avatar_color",
        ),
    )


def downgrade() -> None:
    """Remove the user_profiles table.

    WARNING:
    Running this downgrade deletes stored profile data.
    Do not downgrade a database containing valuable
    user profiles without a verified backup.
    """

    op.drop_table("user_profiles")
