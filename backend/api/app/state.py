"""In‑memory game state management for the FastAPI service.

This module provides a simple singleton-like state holder that can be injected
as a FastAPI dependency. It stores the board and the current player's turn.
"""

from backend.domain.game import Board, Ship
from typing import List

class GameState:
    def get_board_view(self) -> dict:
        """Return a dictionary representing the player's board state.
        Includes ship placements and markers for hits and misses.
        """
        # Hits are coordinates where a shot hit a ship (already stored in self.hits)
        hits = [list(coord) for coord in self.hits]
        # Misses are shots where result was 'miss'
        misses = [
            [shot["x"], shot["y"]]
            for shot in self.shots
            if shot.get("result") == "miss"
        ]
        board_dict = self.board.to_dict()
        board_dict.update({"hits": hits, "misses": misses})
        return board_dict

    """Singleton holder for the current game state.

    In a production system this would be backed by a database or a distributed
    cache. For the prototype we keep everything in memory.
    """

    def __init__(self) -> None:
        self.board: Board = Board()
        self.current_turn: int = 1  # Player 1 starts
        self.hits: set[tuple[int, int]] = set()
        self.shots: List[dict] = []  # Store shot records for potential audit
        self.winner: int | None = None

    def reset(self) -> None:
        """Reset the board and turn to the initial state."""
        self.board = Board()
        self.current_turn = 1
        self.hits.clear()
        self.shots.clear()
        self.winner = None

    def place_ships(self, ships: List[Ship]) -> None:
        """Replace the current ships on the board with the provided list."""
        self.board.ships = []
        for ship in ships:
            self.board.ships.append(ship)
        # Reset hits and winner when new ships placed
        self.hits.clear()
        self.winner = None

# Create a single instance that will be shared across requests.
_state_instance = GameState()

def get_state() -> GameState:
    """FastAPI dependency that returns the shared game state.

    Using a function rather than the instance directly makes it easier to
    replace with a different implementation in the future (e.g., a DB‑backed
    store) without changing the endpoint signatures.
    """
    return _state_instance
