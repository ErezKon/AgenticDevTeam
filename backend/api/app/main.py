"""FastAPI entry point for Game API Service"""

import os
from enum import Enum
from typing import List

from fastapi import FastAPI, Depends, HTTPException, APIRouter
from pydantic import BaseModel, Field

from backend.domain.game import Ship
from .state import get_state, GameState

app = FastAPI(title="Game API Service")

router = APIRouter()

# Include router unconditionally (needed for test utilities)
app.include_router(router)

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
    # Toggle turn (simplified)
    state.current_turn = 2 if state.current_turn == 1 else 1
    return FireShotResponse(result=result, message=message)
