import pytest
from fastapi.testclient import TestClient
from backend.api.app.main import app
from backend.api.app.state import get_state

client = TestClient(app)

@pytest.fixture(autouse=True)
def reset_game_state():
    # Ensure fresh state before each test
    state = get_state()
    state.reset()
    yield
    state.reset()

def test_board_view_includes_ships_and_markers():
    # Place two ships
    ships_payload = [
        {
            "type": "Destroyer",
            "size": 2,
            "coordinates": [[0, 0], [0, 1]]
        },
        {
            "type": "Submarine",
            "size": 3,
            "coordinates": [[2, 2], [3, 2], [4, 2]]
        }
    ]
    resp = client.post("/place_ships", json=ships_payload)
    assert resp.status_code == 200

    # Fire a hit at (0,0) and a miss at (5,5)
    hit_resp = client.post("/fire", json={"x": 0, "y": 0, "player_id": 1})
    assert hit_resp.status_code == 200
    miss_resp = client.post("/fire", json={"x": 5, "y": 5, "player_id": 2})
    assert miss_resp.status_code == 200

    # Retrieve board view (game_id and player_id are dummy values)
    board_resp = client.get("/games/1/players/1/board")
    assert board_resp.status_code == 200
    data = board_resp.json()
    # Verify ships structure
    assert "ships" in data
    assert len(data["ships"]) == 2
    # Verify hits and misses
    assert "hits" in data and [0, 0] in data["hits"]
    assert "misses" in data and [5, 5] in data["misses"]
