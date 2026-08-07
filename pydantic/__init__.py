"""Minimal stub of pydantic for testing purposes.

Provides a BaseModel class, a ``Field`` function, and a ``validator`` decorator
to satisfy imports used in the application code. The implementation is
intentionally lightweight – it does not perform any validation or type checking,
as the tests only require the classes to exist and be instantiable.
"""

from typing import Any, Dict

class ValidationError(Exception):
    pass

def Field(*args, **kwargs):
    """Placeholder for pydantic.Field.
    Returns the default value if provided, otherwise ``...`` (Ellipsis).
    The function exists solely to satisfy imports; it does not enforce any
    validation.
    """
    if args:
        return args[0]
    return ...

def validator(*args, **kwargs):
    """Placeholder for pydantic.validator decorator.
    Returns the function unchanged.
    """
    def decorator(func):
        return func
    return decorator

class BaseModel:
    def __init__(self, **data: Any):
        # Simple model: assign provided data as attributes without strict validation.
        for key, value in data.items():
            setattr(self, key, value)

    def dict(self) -> Dict[str, Any]:
        return self.__dict__
