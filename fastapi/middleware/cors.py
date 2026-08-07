"""Stub CORSMiddleware for FastAPI tests.

The real FastAPI provides a middleware class that integrates with ASGI.
For our unit tests we only need the class to be importable and callable
with the same signature. The middleware does not need to modify request
handling because the FastAPI stub does not implement a full ASGI stack.
"""

class CORSMiddleware:
    def __init__(self, app, allow_origins=None, allow_credentials=False,
                 allow_methods=None, allow_headers=None, **kwargs):
        # Store parameters for potential introspection; no functional effect.
        self.app = app
        self.allow_origins = allow_origins or []
        self.allow_credentials = allow_credentials
        self.allow_methods = allow_methods or []
        self.allow_headers = allow_headers or []
        # Additional kwargs are ignored in the stub.
        # In a real FastAPI app this would wrap the ASGI app.
        # Here we simply keep a reference to the original app.
        # No further action required.
        pass
