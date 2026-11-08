"""Registration, login, and authenticated profile endpoints for CaaS.

Mount this router with app.include_router(router, prefix="/api/v1").
Password hashing and JWT verification are delegated to backend.security.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models import User
from backend.schemas.auth import (
    TokenResponse,
    UserLoginRequest,
    UserRegistrationRequest,
    UserResponse,
)
from backend.security import (
    InvalidAccessTokenError,
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)
from configuration.settings import Settings, get_settings

logger = logging.getLogger("caas.auth")
router = APIRouter(prefix="/auth", tags=["Authentication"])
bearer_scheme = HTTPBearer(auto_error=False)


def ensure_token_signing_available(settings: Settings) -> None:
    """Return 503 instead of exposing configuration details to API clients."""
    try:
        settings.require_jwt_secret_key()
    except RuntimeError as exc:
        logger.error("JWT signing key is not configured")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is temporarily unavailable",
        ) from exc


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    """Validate a bearer token and load its active user from the database."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    ensure_token_signing_available(settings)

    try:
        user_id = decode_access_token(
            credentials.credentials,
            settings=settings,
        )
    except InvalidAccessTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    user = db.get(User, user_id)

    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return user


@router.post(
    "/register",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
)
def register(
    payload: UserRegistrationRequest,
    db: Session = Depends(get_db),
) -> User:
    """Create a user, rejecting duplicate normalized email addresses."""
    existing_id = db.scalar(
        select(User.id).where(User.email == payload.email)
    )

    if existing_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )

    user = User(
        email=payload.email,
        password_hash=hash_password(
            payload.password.get_secret_value()
        ),
        display_name=payload.display_name,
    )

    db.add(user)

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        # Protect against concurrent registrations with the same email.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        ) from exc

    db.refresh(user)
    return user


@router.post("/login", response_model=TokenResponse)
def login(
    payload: UserLoginRequest,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> TokenResponse:
    """Authenticate an active account and issue a short-lived access token."""
    ensure_token_signing_available(settings)

    user = db.scalar(
        select(User).where(User.email == payload.email)
    )

    if (
        user is None
        or not user.is_active
        or not verify_password(
            payload.password.get_secret_value(),
            user.password_hash,
        )
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return TokenResponse(
        access_token=create_access_token(
            user.id,
            settings=settings,
        ),
        expires_in=settings.access_token_expire_minutes * 60,
    )


@router.get("/me", response_model=UserResponse)
def read_my_profile(
    current_user: User = Depends(get_current_user),
) -> User:
    """Return the profile of the active, authenticated user."""
    return current_user
