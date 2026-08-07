"""Minimal FastAPI stub for testing purposes.

Provides a simple FastAPI class with a .post decorator to register route handlers.
Includes a minimal TestClient and HTTPException to satisfy tests without pulling
the real FastAPI dependency.
"""

from typing import Callable, Dict, Any, List, Tuple
import inspect
import asyncio

class HTTPException(Exception):
    def __init__(self, status_code: int, detail: str = None):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)

class Depends:
    def __init__(self, dependency=None):
        self.dependency = dependency

# Header placeholder for FastAPI dependency injection
def Header(default=None):
    return default
    def __init__(self, dependency=None):
        self.dependency = dependency

class FastAPI:
    def add_middleware(self, middleware_class, **options):
        """Stub method to mimic FastAPI's add_middleware.
        Stores the middleware class and options but does not alter request handling.
        """
        # In the stub, we simply keep a list for potential introspection.
        if not hasattr(self, "_middlewares"):
            self._middlewares = []
        self._middlewares.append((middleware_class, options))
        # Return the instance for chaining (not required but mimics real API).
        return self

    def __init__(self, *args, **kwargs) -> None:
        # Accept any arguments for compatibility (e.g., title)
        self._post_routes: Dict[str, Callable[[Dict[str, Any]], Any]] = {}
        self._get_routes: Dict[str, Callable[[Dict[str, Any]], Any]] = {}
        self._router_routes: List[Tuple[str, str, Callable]] = []  # (method, path, handler)

    def post(self, path: str, **kwargs):
        """Register a POST route.

        ``response_model`` and other FastAPI kwargs are accepted for compatibility
        but ignored by the stub implementation.
        This stub also attempts to instantiate Pydantic models for the first argument
        if the handler expects one, and handles async functions.
        """
        def decorator(func: Callable[[Any], Any]):
            import inspect
            from pydantic import BaseModel
            import asyncio
            def wrapper(payload: Dict[str, Any]):
                # Determine if the first parameter expects a Pydantic model or a Depends
                sig = inspect.signature(func)
                params = list(sig.parameters.values())
                if not params:
                    # No parameters
                    result = func()
                else:
                    first = params[0]
                    # Resolve Depends if default is a Depends instance
                    if isinstance(first.default, Depends):
                        # Call the dependency function to get the value
                        dep_func = first.default.dependency
                        dep_value = dep_func()
                        result = func(dep_value)
                    else:
                        annotation = first.annotation
                        if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
                            # Instantiate model with payload dict
                            model_instance = annotation(**payload)
                            result = func(model_instance)
                        else:
                            # Pass raw payload dict
                            result = func(payload)
                # Await if coroutine
                if inspect.iscoroutine(result):
                    result = asyncio.run(result)
                return result
            self._post_routes[path] = wrapper
            return func
        return decorator

    def get(self, path: str, **kwargs):
        """Register a GET route.

        ``response_model`` and other FastAPI kwargs are accepted for compatibility
        but ignored.
        """
        def decorator(func: Callable[[], Any]):
            self._get_routes[path] = func
            return func
        return decorator

    def include_router(self, router: 'APIRouter'):
        """Include routes from an APIRouter instance.

        The stub simply merges the router's internal route dictionaries into the
        main app's route tables.
        """
        for path, handler in router._post_routes.items():
            self._post_routes[path] = handler
        for path, handler in router._get_routes.items():
            self._get_routes[path] = handler

    @property
    def routes(self) -> Dict[str, Callable[[Dict[str, Any]], Any]]:
        return self._post_routes

# Stub APIRouter class to mimic FastAPI's router functionality
class APIRouter:
    def __init__(self, *args, **kwargs):
        self._post_routes: Dict[str, Callable[[Dict[str, Any]], Any]] = {}
        self._get_routes: Dict[str, Callable[[Dict[str, Any]], Any]] = {}

    def post(self, path: str, **kwargs):
        def decorator(func: Callable[[Any], Any]):
            # Reuse FastAPI's post wrapper logic for consistency
            import inspect
            from pydantic import BaseModel
            import asyncio
            def wrapper(payload: Dict[str, Any]):
                sig = inspect.signature(func)
                params = list(sig.parameters.values())
                if params:
                    annotation = params[0].annotation
                    if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
                        model_instance = annotation(**payload)
                        result = func(model_instance)
                    else:
                        result = func(payload)
                else:
                    result = func(payload)
                if inspect.iscoroutine(result):
                    result = asyncio.run(result)
                return result
            self._post_routes[path] = wrapper
            return func
        return decorator

    def get(self, path: str, **kwargs):
        def decorator(func: Callable[[], Any]):
            self._get_routes[path] = func
            return func
        return decorator
    def __init__(self, *args, **kwargs) -> None:
        # Accept any arguments for compatibility (e.g., title)
        self._post_routes: Dict[str, Callable[[Dict[str, Any]], Any]] = {}
        self._get_routes: Dict[str, Callable[[Dict[str, Any]], Any]] = {}
        self._router_routes: List[Tuple[str, str, Callable]] = []  # (method, path, handler)

    def post(self, path: str, **kwargs):
        """Register a POST route.

        ``response_model`` and other FastAPI kwargs are accepted for compatibility
        but ignored by the stub implementation.
        This stub also attempts to instantiate Pydantic models for the first argument
        if the handler expects one, and handles async functions.
        """
        def decorator(func: Callable[[Any], Any]):
            import inspect
            from pydantic import BaseModel
            import asyncio
            def wrapper(payload: Dict[str, Any]):
                # Determine if the first parameter expects a Pydantic model
                sig = inspect.signature(func)
                params = list(sig.parameters.values())
                if params:
                    annotation = params[0].annotation
                    if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
                        # Instantiate model with payload dict
                        model_instance = annotation(**payload)
                        result = func(model_instance)
                    else:
                        result = func(payload)
                else:
                    result = func(payload)
                # Await if coroutine
                if inspect.iscoroutine(result):
                    result = asyncio.run(result)
                return result
            self._post_routes[path] = wrapper
            return func
        return decorator

    def get(self, path: str, **kwargs):
        """Register a GET route.

        ``response_model`` and other FastAPI kwargs are accepted for compatibility
        but ignored.
        """
        def decorator(func: Callable[[], Any]):
            self._get_routes[path] = func
            return func
        return decorator

    def include_router(self, router: 'APIRouter'):
        """Include routes from an APIRouter instance.

        The stub simply merges the router's internal route dictionaries into the
        main app's route tables.
        """
        for path, handler in router._post_routes.items():
            self._post_routes[path] = handler
        for path, handler in router._get_routes.items():
            self._get_routes[path] = handler

    @property
    def routes(self) -> Dict[str, Callable[[Dict[str, Any]], Any]]:
        return self._post_routes
    def __init__(self, *args, **kwargs) -> None:
        # Accept any arguments for compatibility (e.g., title)
        self._post_routes: Dict[str, Callable[[Dict[str, Any]], Any]] = {}
        self._get_routes: Dict[str, Callable[[Dict[str, Any]], Any]] = {}

    def post(self, path: str, **kwargs):
        """Register a POST route.

        ``response_model`` and other FastAPI kwargs are accepted for compatibility
        but ignored by the stub implementation.
        This stub also attempts to instantiate Pydantic models for the first argument
        if the handler expects one, and handles async functions.
        """
        def decorator(func: Callable[[Any], Any]):
            import inspect
            from pydantic import BaseModel
            import asyncio
            def wrapper(payload: Dict[str, Any]):
                # Determine if the first parameter expects a Pydantic model
                sig = inspect.signature(func)
                params = list(sig.parameters.values())
                if params:
                    annotation = params[0].annotation
                    if inspect.isclass(annotation) and issubclass(annotation, BaseModel):
                        # Instantiate model with payload dict
                        model_instance = annotation(**payload)
                        result = func(model_instance)
                    else:
                        result = func(payload)
                else:
                    result = func(payload)
                # Await if coroutine
                if inspect.iscoroutine(result):
                    result = asyncio.run(result)
                return result
            self._post_routes[path] = wrapper
            return func
        return decorator

    def get(self, path: str, **kwargs):
        """Register a GET route.

        ``response_model`` and other FastAPI kwargs are accepted for compatibility
        but ignored.
        """
        def decorator(func: Callable[[], Any]):
            self._get_routes[path] = func
            return func
        return decorator

    @property
    def routes(self) -> Dict[str, Callable[[Dict[str, Any]], Any]]:
        return self._post_routes

class TestClient:
    """Very small TestClient compatible with our FastAPI stub.
    It calls the registered route handler directly and returns an object
    with ``status_code`` and ``json()`` method.
    """
    def __init__(self, app: FastAPI):
        self.app = app

    def post(self, path: str, json: Dict[str, Any] = None):
        handler = self.app._post_routes.get(path)
        if handler is None:
            raise Exception(f"POST route {path} not found")
        payload = json or {}
        try:
            result = handler(payload)
            # If handler is async, run it
            if inspect.iscoroutine(result):
                result = asyncio.run(result)
        except HTTPException as exc:
            class ErrorResponse:
                def __init__(self, detail, status_code):
                    self._detail = detail
                    self.status_code = status_code
                def json(self):
                    return {'detail': self._detail}
            return ErrorResponse(exc.detail, exc.status_code)
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
            if inspect.iscoroutine(result):
                result = asyncio.run(result)
        except HTTPException as exc:
            class ErrorResponse:
                def __init__(self, detail, status_code):
                    self._detail = detail
                    self.status_code = status_code
                def json(self):
                    return {'detail': self._detail}
            return ErrorResponse(exc.detail, exc.status_code)
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
