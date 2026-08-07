"""Minimal FastAPI stub for testing purposes.

Provides a simple FastAPI class with a .post decorator to register route handlers.
Includes a minimal TestClient and HTTPException to satisfy tests without pulling
the real FastAPI dependency.
"""

from typing import Callable, Dict, Any

class HTTPException(Exception):
    def __init__(self, status_code: int, detail: str = None):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)

class FastAPI:
    def __init__(self) -> None:
        self._post_routes: Dict[str, Callable[[Dict[str, Any]], Any]] = {}

    def post(self, path: str):
        """Register a POST route.

        Usage::
            app = FastAPI()
            @app.post('/example')
            def handler(payload: dict):
                ...
        """
        def decorator(func: Callable[[Dict[str, Any]], Any]):
            self._post_routes[path] = func
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
        handler = self.app.routes.get(path)
        if handler is None:
            raise Exception(f"Route {path} not found")
        payload = json or {}
        try:
            result = handler(payload)
        except HTTPException as exc:
            # Return response with appropriate status code and detail
            class ErrorResponse:
                def __init__(self, detail, status_code):
                    self._detail = detail
                    self.status_code = status_code
                def json(self):
                    return {'detail': self._detail}
            return ErrorResponse(exc.detail, exc.status_code)
        # If handler returns a tuple (data, status_code), respect it
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
