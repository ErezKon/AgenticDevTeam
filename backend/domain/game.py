"""Core domain models for Battleship game.

This module provides minimal placeholder classes to satisfy the scaffold
requirements. Real game logic will be implemented later.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple, Optional

@dataclass
class Ship:
    """Represents a ship placed on the board.

    Attributes:
        type: Human‑readable ship type (e.g., "Destroyer").
        size: Length of the ship.
        coordinates: List of (x, y) tuples occupied by the ship.
    """
    type: str
    size: int
    coordinates: List[Tuple[int, int]]

@dataclass
class Board:
    """Simple board representation.

    The board is a 2‑dimensional grid of size ``width`` x ``height``.
    ``ships`` holds the ships placed by a player.
    """
    width: int = 10
    height: int = 10
    ships: Optional[List[Ship]] = None

    def __post_init__(self):
        if self.ships is None:
            self.ships = []

    def place_ship(self, ship: Ship) -> None:
        """Add a ship to the board without validation (placeholder)."""
        self.ships.append(ship)
