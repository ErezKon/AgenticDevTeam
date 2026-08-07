"""Minimal stub of pydantic BaseModel for testing purposes.

Provides a BaseModel class that accepts keyword arguments and stores them as attributes.
It performs a very small amount of validation required by the current code:
- Ensures that required fields are present.
- Does not perform type checking.
"""

from typing import Any, Dict

class ValidationError(Exception):
    pass

class BaseModel:
    def __init__(self, **data: Any):
        # Simple validation: ensure all fields defined in subclass are present
        required_fields = getattr(self.__class__, '__fields__', [])
        for field in required_fields:
            if field not in data:
                raise ValidationError(f"field '{field}' required")
        for key, value in data.items():
            setattr(self, key, value)

    def dict(self) -> Dict[str, Any]:
        return self.__dict__
