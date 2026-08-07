"""FastAPI entry point for Game API Service"""

import os
from enum import Enum
from typing import List

from fastapi import FastAPI, Depends, HTTPException, APIRouter, Header
from pydantic import BaseModel, Field

from backend.domain.game import Ship
from .state import get_state, GameState

app = FastAPI(title="Game API Service")

# Add CORS middleware to allow only the UI origin
from fastapi.middleware.cors import CORSMiddleware

# UI origin (adjust as needed for deployment)
_ALLOWED_ORIGINS = ["http://localhost:8080"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_api_key(x_api_key: str = Header(None)):
    """Simple API key authentication.
    Bypasses auth when TEST_MODE env var is set (used for automated tests).
    In production, expects an 'x-api-key' header matching the API_KEY env var.
    """
    if os.getenv("TEST_MODE") == "true":
        # Skip auth in test mode, default to testkey if not provided
        return x_api_key or "testkey"
    expected = os.getenv("API_KEY", "testkey")
    if x_api_key != expected:
        raise HTTPException(status_code=403, detail="Invalid API Key")
    return x_api_key

router = APIRouter(dependencies=[Depends(get_api_key)])

# Include router unconditionally (needed for test utilities)
# Include router after defining routes
# (FastAPI stub merges routes at call time, so we include after route definitions)

# Placeholder route
@app.get("/health")
async def health_check():
    return {"status": "ok"}

class ShipInput(BaseModel):
    type: str
    size: int
    # Accept list of coordinate pairs as lists (e.g., [[1,1],[1,2]])
    coordinates: List[List[int]]

class SetTurnInput(BaseModel):
    player_id: int

@router.post("/reset")
async def reset_state(state: GameState = Depends(get_state)):
    state.reset()
    return {"status": "reset"}

@router.post("/place_ships")
async def place_ships(ships: List[ShipInput], state: GameState = Depends(get_state)):
    # Validation
    all_coords = set()
    for s in ships:
        # Size matches coordinates length
        if s.size != len(s.coordinates):
            raise HTTPException(status_code=400, detail=f"Ship size mismatch for {s.type}")
        # Coordinates within board bounds
        for coord in s.coordinates:
            x, y = coord
            if x < 0 or y < 0 or x >= state.board.width or y >= state.board.height:
                raise HTTPException(status_code=400, detail="Ship coordinates out of bounds")
        # Orientation: all x same or all y same
        xs = {c[0] for c in s.coordinates}
        ys = {c[1] for c in s.coordinates}
        if not (len(xs) == 1 or len(ys) == 1):
            raise HTTPException(status_code=400, detail="Ship must be placed horizontally or vertically")
        # Overlap detection
        for coord in s.coordinates:
            if tuple(coord) in all_coords:
                raise HTTPException(status_code=400, detail="Ships cannot overlap")
            all_coords.add(tuple(coord))
    # Convert inner lists to tuples for the domain model if needed
    ship_objs = [
        Ship(
            type=s.type,
            size=s.size,
            coordinates=[tuple(coord) for coord in s.coordinates],
        )
        for s in ships
    ]
    state.place_ships(ship_objs)
    return {"status": "ships placed"}

@router.post("/set_turn")
async def set_turn(payload: SetTurnInput, state: GameState = Depends(get_state)):
    state.current_turn = payload.player_id
    return {"status": "turn set", "current_turn": state.current_turn}

class ShotResult(str, Enum):
    HIT = "hit"
    MISS = "miss"

class FireShotRequest(BaseModel):
    x: int = Field(..., ge=0, description="X coordinate (0‑based)")
    y: int = Field(..., ge=0, description="Y coordinate (0‑based)")
    player_id: int = Field(1, description="Identifier of the player making the shot")

class FireShotResponse(BaseModel):
    result: ShotResult = Field(..., description="Result of the shot: 'hit' or 'miss'")
    message: str = Field(..., description="Human readable result message")

@app.post("/fire", response_model=FireShotResponse)
async def fire_shot(
    request: FireShotRequest,
    state: GameState = Depends(get_state),
):
    # Enforce turn order based on provided player_id
    if request.player_id != state.current_turn:
        raise HTTPException(status_code=400, detail="Not your turn")
    # Validate coordinates are within board bounds
    if (
        request.x < 0
        or request.y < 0
        or request.x >= state.board.width
        or request.y >= state.board.height
    ):
        raise HTTPException(status_code=400, detail="Coordinates out of bounds")
    # Determine hit or miss
    hit = any((request.x, request.y) in ship.coordinates for ship in state.board.ships)
    result = ShotResult.HIT if hit else ShotResult.MISS
    message = "Shot hit a ship" if hit else "Shot missed"
    # Record shot
    shot_record = {
        "x": request.x,
        "y": request.y,
        "player_id": request.player_id,
        "result": result.value,
    }
    state.shots.append(shot_record)
    if hit:
        state.hits.add((request.x, request.y))
        # Check win condition: all ship cells hit
        all_coords = {coord for ship in state.board.ships for coord in ship.coordinates}
        if all_coords.issubset(state.hits):
            state.winner = request.player_id
            message = "You win! All opponent ships sunk."
    # Toggle turn only if game not over
    if state.winner is None:
        state.current_turn = 2 if state.current_turn == 1 else 1
    return FireShotResponse(result=result, message=message)

# Include router after all route definitions
app.include_router(router)
