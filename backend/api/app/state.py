"""In‑memory game state management for the FastAPI service.

This module provides a simple singleton-like state holder that can be injected
as a FastAPI dependency. It stores the board and the current player's turn.
"""

from backend.domain.game import Board, Ship
from typing import List

class GameState:
    """Singleton holder for the current game state.

    In a production system this would be backed by a database or a distributed
    cache. For the prototype we keep everything in memory.
    """

    def __init__(self) -> None:
        self.board: Board = Board()
        self.current_turn: int = 1  # Player 1 starts

    def reset(self) -> None:
        """Reset the board and turn to the initial state."""
        self.board = Board()
        self.current_turn = 1

    def place_ships(self, ships: List[Ship]) -> None:
        """Replace the current ships on the board with the provided list."""
        self.board.ships = []
        for ship in ships:
            self.board.ships.append(ship)

# Create a single instance that will be shared across requests.
_state_instance = GameState()

def get_state() -> GameState:
    """FastAPI dependency that returns the shared game state.

    Using a function rather than the instance directly makes it easier to
    replace with a different implementation in the future (e.g., a DB‑backed
    store) without changing the endpoint signatures.
    """
    return _state_instance
