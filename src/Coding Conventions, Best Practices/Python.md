# Python Best Practices, Guidelines & Conventions

---

## Table of Contents

1. [Coding Conventions](#1-coding-conventions)
   - [1.1 Naming Conventions](#11-naming-conventions)
   - [1.2 Module Structure & Ordering](#12-module-structure--ordering)
   - [1.3 Class Structure Order](#13-class-structure-order)
   - [1.4 Docstring Conventions (Google Style)](#14-docstring-conventions-google-style)
   - [1.5 Formatting & Style Rules](#15-formatting--style-rules)
2. [Type Hints](#2-type-hints)
3. [Pythonic Idioms](#3-pythonic-idioms)
4. [Error Handling](#4-error-handling)
5. [Project Structure](#5-project-structure)
6. [Dependency & Environment Management](#6-dependency--environment-management)
7. [Async Programming](#7-async-programming)
8. [Testing](#8-testing)
9. [Security](#9-security)
10. [Linting & Formatting Tooling](#10-linting--formatting-tooling)

## 1. Coding Conventions

### 1.1 Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Module | snake_case | `user_service.py` |
| Package | short snake_case | `my_package` |
| Class | PascalCase | `UserService` |
| Exception | PascalCase + `Error` | `UserNotFoundError` |
| Function | snake_case (verb-prefixed) | `get_user_by_id()` |
| Method | snake_case | `calculate_total()` |
| Variable | snake_case | `user_name` |
| Constant | UPPER_SNAKE_CASE | `MAX_RETRIES`, `API_URL` |
| Private | `_leading_underscore` | `_internal_method()` |
| Name-mangled | `__double_underscore` | `__private_attr` |
| Dunder | `__name__` | `__init__`, `__str__` |
| Type variable | PascalCase or single letter | `T`, `KT`, `VT`, `UserType` |
| Boolean var/func | `is_`/`has_`/`can_` prefix | `is_active`, `has_permission` |
| Test function | `test_` prefix | `test_get_user_returns_user` |
| Test class | `Test` prefix PascalCase | `TestUserService` |
| Fixture | snake_case (descriptive) | `sample_user`, `mock_repo` |
| Protected (by convention) | `_single_underscore` | `_validate()` |

### 1.2 Module Structure & Ordering

```python
#!/usr/bin/env python3          # 1. Shebang (scripts only)
"""Module docstring.             # 2. Module docstring

This module provides user management functionality.
"""

# 3. Future imports (if needed for compatibility)
from __future__ import annotations

# 4. Standard library imports
import logging
import os
from datetime import datetime
from typing import TYPE_CHECKING

# 5. Third-party imports
import httpx
from pydantic import BaseModel, Field

# 6. Local / project imports
from my_app.config import settings
from my_app.exceptions import UserNotFoundError

# 7. Type-checking-only imports (avoid circular imports)
if TYPE_CHECKING:
    from my_app.repositories import UserRepository

# 8. Module-level constants
MAX_RETRIES = 3
DEFAULT_TIMEOUT = 30.0
logger = logging.getLogger(__name__)

# 9. Module-level type aliases
UserId = str
UserDict = dict[str, str | int | None]

# 10. Classes
class UserService:
    """Service for managing user operations."""
    ...

# 11. Module-level functions
def create_user_service() -> UserService:
    """Factory function for UserService."""
    ...

# 12. Main guard
if __name__ == "__main__":
    main()
```

### 1.3 Class Structure Order

```python
class UserService:
    """Service for managing user operations.

    Attributes:
        repository: The user data repository.
        logger: Logger instance for this service.
    """

    # 1. Class constants
    MAX_BATCH_SIZE = 100
    DEFAULT_ROLE = "user"

    # 2. __init__ (constructor)
    def __init__(
        self,
        repository: UserRepository,
        event_publisher: EventPublisher,
    ) -> None:
        """Initialize UserService.

        Args:
            repository: Data access for users.
            event_publisher: For publishing domain events.
        """
        self._repository = repository
        self._event_publisher = event_publisher
        self._operation_count = 0

    # 3. Class methods / Alternative constructors
    @classmethod
    def from_config(cls, config: Config) -> "UserService":
        """Create a UserService from application configuration."""
        ...

    # 4. Static methods
    @staticmethod
    def validate_email(email: str) -> bool:
        """Check if an email address is valid."""
        ...

    # 5. Properties
    @property
    def operation_count(self) -> int:
        """Number of operations performed."""
        return self._operation_count

    # 6. Public methods
    async def get_user(self, user_id: str) -> User:
        """Retrieve a user by ID.

        Args:
            user_id: The unique user identifier.

        Returns:
            The User object.

        Raises:
            UserNotFoundError: If the user does not exist.
            ValueError: If user_id is empty.
        """
        if not user_id or not user_id.strip():
            raise ValueError("user_id must not be empty")

        user = await self._repository.find_by_id(user_id)
        if user is None:
            raise UserNotFoundError(user_id)
        return user

    # 7. Private methods
    def _increment_counter(self) -> None:
        self._operation_count += 1

    # 8. Dunder methods (repr, str, eq, hash, etc.)
    def __repr__(self) -> str:
        return f"UserService(operations={self._operation_count})"
```

### 1.4 Docstring Conventions (Google Style)

```python
def get_users_by_role(
    role: str,
    *,
    is_active: bool = True,
    limit: int = 100,
) -> list[User]:
    """Retrieve users filtered by role and active status.

    Fetches users from the repository matching the given criteria.
    Results are ordered by creation date (newest first).

    Args:
        role: The user role to filter by (e.g., "admin", "user").
        is_active: If True, only return active users. Defaults to True.
        limit: Maximum number of users to return. Defaults to 100.

    Returns:
        A list of User objects matching the criteria.
        Returns an empty list if no users match.

    Raises:
        ValueError: If role is empty or limit is not positive.
        RepositoryError: If the database query fails.

    Examples:
        >>> users = get_users_by_role("admin", limit=10)
        >>> len(users)
        3
        >>> users[0].role
        'admin'

    Note:
        This function caches results for 5 minutes.
        See `config.CACHE_TTL` for details.
    """
    ...
```

### 1.5 Formatting & Style Rules

```python
# Line length: 79 (PEP 8) or up to 120 (with black)
# Indentation: 4 spaces
# Blank lines:
#   - 2 blank lines before/after top-level functions and classes
#   - 1 blank line between methods in a class
#   - 1 blank line between logical sections in a function

# Trailing commas in multi-line structures
users = [
    "Alice",
    "Bob",
    "Charlie",  # trailing comma
]

config = {
    "host": "localhost",
    "port": 8080,
    "debug": True,  # trailing comma
}

# String formatting: f-strings (preferred)
message = f"Hello, {user.name}! You have {count} items."

# Comprehensions over map/filter
squares = [x ** 2 for x in range(10) if x % 2 == 0]
user_names = {u.id: u.name for u in users}

# Context managers
with open("data.txt") as f:
    content = f.read()

# Unpacking
first, *rest, last = items
name, age = user_tuple

# Walrus operator (Python 3.8+)
if (n := len(items)) > 10:
    print(f"Too many items: {n}")
```

## 2. Type Hints

```python
from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True)
class User:
    id: str
    name: str
    email: str
    created_at: datetime = field(default_factory=datetime.utcnow)
    roles: list[str] = field(default_factory=list)


def get_user_by_id(user_id: str) -> User | None:
    """Retrieve a user by their unique identifier."""
    ...
```

## 3. Pythonic Idioms

```python
# EAFP (Easier to Ask Forgiveness than Permission)
try:
    value = my_dict[key]
except KeyError:
    value = default_value

# Enumerate
for index, item in enumerate(items):
    ...

# zip for parallel iteration
for name, score in zip(names, scores, strict=True):
    ...
```

## 4. Error Handling

```python
class UserNotFoundError(Exception):
    def __init__(self, user_id: str) -> None:
        self.user_id = user_id
        super().__init__(f"User not found: {user_id}")
```

## 5. Project Structure

```
my_project/
├── src/
│   └── my_project/
│       ├── __init__.py
│       ├── models/
│       ├── services/
│       ├── repositories/
│       ├── api/
│       ├── config.py
│       └── exceptions.py
├── tests/
│   ├── unit/
│   ├── integration/
│   └── conftest.py
├── pyproject.toml
├── README.md
└── .pre-commit-config.yaml
```

## 6. Dependency & Environment Management

- Use **`pyproject.toml`** (PEP 621) for project metadata and dependencies.
- Use **virtual environments** (`venv`, `conda`, or `uv`).
- Pin dependencies with **`pip-compile`**, **`poetry.lock`**, or **`uv.lock`**.
- Use **`pre-commit`** hooks for linting and formatting.

## 7. Async Programming

- Use **`asyncio`** for I/O-bound concurrency.
- Use **`async/await`** syntax consistently.
- Use **`asyncio.gather()`** for concurrent coroutine execution.
- Use **`multiprocessing`** for CPU-bound parallelism.

## 8. Testing

```python
import pytest

@pytest.fixture
def sample_user() -> User:
    return User(id="1", name="John", email="john@example.com")


class TestUserService:
    def test_get_user_returns_user_when_found(
        self, sample_user: User, mock_repo: Mock
    ) -> None:
        mock_repo.find_by_id.return_value = sample_user

        result = user_service.get_user("1")

        assert result == sample_user
        mock_repo.find_by_id.assert_called_once_with("1")

    @pytest.mark.parametrize("invalid_id", ["", None, "   "])
    def test_get_user_raises_for_invalid_id(self, invalid_id: str) -> None:
        with pytest.raises(ValueError):
            user_service.get_user(invalid_id)
```

## 9. Security

- **Never use `eval()`** or `exec()` on untrusted input.
- Use the **`secrets`** module (not `random`) for tokens, passwords, and cryptographic values.
- Sanitize and validate **all user input** — use libraries like **Pydantic** for structured validation.
- Store secrets in **environment variables** or secret managers — never hardcode credentials.
- Use **`hashlib`** or **`bcrypt`** for password hashing; never store passwords in plaintext.
- Pin dependencies and audit with **`pip-audit`** or **`safety`**.
- Set **`HttpOnly`**, **`Secure`**, and **`SameSite`** flags on cookies in web frameworks.

```python
import secrets
from hashlib import sha256

# Generate a secure token
token = secrets.token_urlsafe(32)

# Compare strings in constant time (prevents timing attacks)
is_valid = secrets.compare_digest(submitted_token, stored_token)
```

## 10. Linting & Formatting Tooling

| Tool | Purpose |
|---|---|
| **Ruff** | Ultra-fast linter and formatter (replaces flake8, isort, black, and more) |
| **Black** | Opinionated code formatter |
| **isort** | Import sorting (or use Ruff) |
| **mypy** | Static type checker |
| **pyright** | Fast type checker (Microsoft) |
| **Pylint** | Comprehensive linter |
| **Bandit** | Security-focused linter |
| **pre-commit** | Git hook framework for running checks before commit |

```toml
# pyproject.toml — Ruff configuration
[tool.ruff]
target-version = "py312"
line-length = 120

[tool.ruff.lint]
select = ["E", "F", "I", "N", "W", "UP", "B", "SIM", "RUF"]

[tool.ruff.format]
quote-style = "double"

[tool.mypy]
strict = true
warn_return_any = true
warn_unused_configs = true
```

- Run **`ruff check .`** and **`ruff format .`** in CI.
- Run **`mypy .`** for type checking.
- Use **`pre-commit`** to enforce linting, formatting, and type checking on every commit.

---
