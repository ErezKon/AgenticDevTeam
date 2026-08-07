"""FastAPI entry point for MCP Tool Server

Exposes MCP tool endpoints `place_ship` and `fire_shot` using the
Model Context Protocol (MCP) SDK schema definitions.
"""

from fastapi import FastAPI, HTTPException
from pydantic import ValidationError

from .schemas import (
    PlaceShipRequest,
    PlaceShipResponse,
    FireShotRequest,
    FireShotResponse,
)
from backend.domain.game import Board, Ship

app = FastAPI(title="MCP Tool Server")

# In‑memory game board shared across requests (simplified)
_game_board = Board()

@app.get("/health")
async def health_check():
    return {"status": "ok"}

@app.post("/place_ship", response_model=PlaceShipResponse)
async def place_ship(request: PlaceShipRequest):
    try:
        ship = Ship(type=request.type, size=request.size, coordinates=request.coordinates)
        _game_board.place_ship(ship)
        return PlaceShipResponse(message="Ship placed successfully", ship_type=ship.type)
    except ValidationError as ve:
        raise HTTPException(status_code=422, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/fire_shot", response_model=FireShotResponse)
async def fire_shot(request: FireShotRequest):
    # Placeholder logic: always miss
    # Real implementation would check against opponent board state
    return FireShotResponse(result="miss", message="Shot missed")
