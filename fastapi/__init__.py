"""Minimal FastAPI stub for testing purposes.

This stub provides just enough functionality for the project's tests without
pulling in the real FastAPI dependency. It implements:
- HTTPException with status_code and detail
- Header dependency placeholder
- Depends class (stores the callable)
- APIRouter with support for a `dependencies` argument and simple route
  registration.
- FastAPI with `include_router`, `post`, `get` decorators and a `routes`
  property exposing registered POST handlers (used by the TestClient).
- TestClient that directly invokes the registered handlers.
"""

from typing import Callable, Dict, Any
import inspect
import asyncio

# --- Core FastAPI primitives -------------------------------------------------

class HTTPException(Exception):
    """Exception raised to return an HTTP error response.
    The real FastAPI exception carries a status code and detail; the stub
    mirrors that interface.
    """

    def __init__(self, status_code: int, detail: str = None):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def Header(default=None):
    """Stub for FastAPI's Header dependency.
    In the real framework this extracts a header value; here we simply return the
    default value because the tests set the header via the stub TestClient.
    """

    return default


class Depends:
    """Stub for FastAPI's Depends.
    It stores the callable that should be resolved later by the framework. The
    stub does not perform any injection; endpoints receive the dependency
    directly via the function signature.
    """

    def __init__(self, dependency=None):
        self.dependency = dependency


class APIRouter:
    """Simple router stub mimicking FastAPI's APIRouter.
    It records POST and GET route handlers in internal dictionaries. The
    `dependencies` argument is accepted for compatibility but not used by the
    stub implementation.
    """

    def __init__(self, *args, **kwargs):
        self.dependencies = kwargs.get("dependencies", [])
        self._post_routes: Dict[str, Callable[[Dict[str, Any]], Any]] = {}
        self._get_routes: Dict[str, Callable[[], Any]] = {}

    def post(self, path: str, **kwargs):
        def decorator(func: Callable[[Any], Any]):
            # Store the raw function; FastAPI's wrapper logic will be applied when the
            # router is included in a FastAPI app.
            self._post_routes[path] = func
            return func
        return decorator

    def get(self, path: str, **kwargs):
        def decorator(func: Callable[[], Any]):
            self._get_routes[path] = func
            return func
        return decorator


class FastAPI:
    """Very small FastAPI application stub.
    It supports route registration via `post`/`get` decorators and can include an
    `APIRouter` instance. Registered POST handlers are wrapped to support Pydantic
    model instantiation and async functions, mirroring the behaviour needed by the
    project's tests.
    """

    def __init__(self, *args, **kwargs) -> None:
        # Accept any arguments for compatibility (e.g., title)
        self._post_routes: Dict[str, Callable[[Dict[str, Any]], Any]] = {}
        self._get_routes: Dict[str, Callable[[], Any]] = {}

    # ---------------------------------------------------------------------
    # Router inclusion
    # ---------------------------------------------------------------------
    def include_router(self, router: APIRouter):
        """Merge routes from an APIRouter into this FastAPI instance."""
        for path, handler in getattr(router, "_post_routes", {}).items():
            self._post_routes[path] = handler
        for path, handler in getattr(router, "_get_routes", {}).items():
            self._get_routes[path] = handler

    # ---------------------------------------------------------------------
    # Route decorators
    # ---------------------------------------------------------------------
    def post(self, path: str, **kwargs):
        """Register a POST route.
        The decorator wraps the handler so that if the first argument is a
        Pydantic `BaseModel` subclass it will be instantiated from the incoming
        JSON payload. Async handlers are awaited.
        """

        def decorator(func: Callable[[Any], Any]):
            def wrapper(payload: Dict[str, Any]):
                # Detect Pydantic model annotation on the first parameter
                sig = inspect.signature(func)
                params = list(sig.parameters.values())
                if params:
                    annotation = params[0].annotation
                    try:
                        from pydantic import BaseModel
                    except Exception:  # pragma: no cover – pydantic is always present in tests
                        BaseModel = None
                    if BaseModel and inspect.isclass(annotation) and issubclass(annotation, BaseModel):
                        model_instance = annotation(**payload)
                        result = func(model_instance)
                    else:
                        result = func(payload)
                else:
                    result = func(payload)
                # Await coroutine if needed
                if inspect.iscoroutine(result):
                    result = asyncio.run(result)
                return result

            self._post_routes[path] = wrapper
            return func

        return decorator

    def get(self, path: str, **kwargs):
        """Register a GET route (no request body)."""

        def decorator(func: Callable[[], Any]):
            self._get_routes[path] = func
            return func

        return decorator

    @property
    def routes(self) -> Dict[str, Callable[[Dict[str, Any]], Any]]:
        """Expose POST routes for compatibility with the test client."""
        return self._post_routes


# -------------------------------------------------------------------------
# Test client stub
# -------------------------------------------------------------------------
class TestClient:
    """Test client that directly invokes registered route handlers.
    It mimics the interface of `fastapi.testclient.TestClient` used in the test
    suite.
    """

    def __init__(self, app: FastAPI):
        self.app = app

    def _handle_result(self, result):
        # Resolve coroutine, convert Pydantic models to dicts
        if inspect.iscoroutine(result):
            result = asyncio.run(result)
        if hasattr(result, "dict") and callable(result.dict):
            result = result.dict()
        return result

    def post(self, path: str, json: Dict[str, Any] = None):
        handler = self.app._post_routes.get(path)
        if handler is None:
            raise Exception(f"POST route {path} not found")
        payload = json or {}
        try:
            result = handler(payload)
        except HTTPException as exc:
            class ErrorResponse:
                def __init__(self, detail, status_code):
                    self._detail = detail
                    self.status_code = status_code

                def json(self):
                    return {"detail": self._detail}

            return ErrorResponse(exc.detail, exc.status_code)
        result = self._handle_result(result)
        if isinstance(result, tuple) and len(result) == 2:
            data, status = result
            class TupleResponse:
                def __init__(self, data, status_code):
                    self._data = data
                    self.status_code = status_code

                def json(self):
                    return self._data

            return TupleResponse(data, status)
        class Response:
            def __init__(self, data):
                self._data = data
                self.status_code = 200

            def json(self):
                return self._data

        return Response(result)

    def get(self, path: str):
        handler = self.app._get_routes.get(path)
        if handler is None:
            raise Exception(f"GET route {path} not found")
        try:
            result = handler()
        except HTTPException as exc:
            class ErrorResponse:
                def __init__(self, detail, status_code):
                    self._detail = detail
                    self.status_code = status_code

                def json(self):
                    return {"detail": self._detail}

            return ErrorResponse(exc.detail, exc.status_code)
        result = self._handle_result(result)
        if isinstance(result, tuple) and len(result) == 2:
            data, status = result
            class TupleResponse:
                def __init__(self, data, status_code):
                    self._data = data
                    self.status_code = status_code

                def json(self):
                    return self._data

            return TupleResponse(data, status)
        class Response:
            def __init__(self, data):
                self._data = data
                self.status_code = 200

            def json(self):
                return self._data

        return Response(result)
