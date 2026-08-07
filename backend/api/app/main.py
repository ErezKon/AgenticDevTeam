"""FastAPI entry point for Game API Service"""

from fastapi import FastAPI

app = FastAPI(title="Game API Service")

# Placeholder route
@app.get("/health")
async def health_check():
    return {"status": "ok"}
