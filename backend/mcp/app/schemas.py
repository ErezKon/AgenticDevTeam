"""Pydantic schemas for MCP tool endpoints.

These schemas define the request and response models for the
`place_ship` and `fire_shot` actions exposed by the MCP Tool Server.
"""

from __future__ import annotations

from typing import List, Tuple

from pydantic import BaseModel, Field, validator


class PlaceShipRequest(BaseModel):
    """Request model for placing a ship on the board.

    Attributes:
        type: Human‑readable ship type (e.g., "Destroyer").
        size: Length of the ship (must be positive).
        coordinates: List of (x, y) tuples representing the ship cells.
    """

    type: str = Field(..., description="Ship type name")
    size: int = Field(..., gt=0, description="Ship length, must be > 0")
    coordinates: List[Tuple[int, int]] = Field(
        ..., description="List of (x, y) board coordinates for the ship"
    )

    @validator("coordinates")
    def validate_coordinates(cls, v, values):
        # Ensure the number of coordinates matches the declared size
        size = values.get("size")
        if size is not None and len(v) != size:
            raise ValueError("Number of coordinates must equal ship size")
        return v


class PlaceShipResponse(BaseModel):
    """Response model after a ship is placed.

    Returns a simple acknowledgement with the ship type.
    """

    message: str = Field(..., description="Result message")
    ship_type: str = Field(..., description="Type of the placed ship")


class FireShotRequest(BaseModel):
    """Request model for firing a shot.

    Attributes:
        x: X coordinate on the board.
        y: Y coordinate on the board.
    """

    x: int = Field(..., ge=0, description="X coordinate (0‑based)")
    y: int = Field(..., ge=0, description="Y coordinate (0‑based)")


class FireShotResponse(BaseModel):
    """Response model after firing a shot.

    Attributes:
        result: Either "hit" or "miss".
        message: Human readable description.
    """

    result: str = Field(..., description="Result of the shot: 'hit' or 'miss'")
    message: str = Field(..., description="Human readable result message")
