"""TestClient stub compatible with our minimal FastAPI implementation.

Provides a simple client that directly calls the registered route handler and
returns an object with `status_code` and `json()` methods, mimicking the
behaviour of `fastapi.testclient.TestClient` used in the test suite.
"""

from typing import Any, Dict

import inspect
import asyncio
from . import FastAPI, HTTPException

class TestClient:
    """Very small TestClient compatible with our FastAPI stub.
    It calls the registered route handler directly and returns an object
    with ``status_code`` and ``json()`` method.
    """
    def __init__(self, app: FastAPI):
        self.app = app

    def _handle_result(self, result):
        # If result is a coroutine, run it
        if inspect.iscoroutine(result):
            result = asyncio.run(result)
        # If result is a Pydantic BaseModel, convert to dict
        if hasattr(result, "dict") and callable(result.dict):
            result = result.dict()
        return result

    def post(self, path: str, json: Dict[str, Any] = None):
        # Look for POST handler first, then any handler (fallback)
        handler = self.app._post_routes.get(path) or self.app.routes.get(path)
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
        handler = self.app._get_routes.get(path) or self.app.routes.get(path)
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
                    return {"detail": self._detail}
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
