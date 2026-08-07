import pytest
from fastapi.testclient import TestClient
from backend.api.app.main import app
from backend.api.app.state import get_state

client = TestClient(app)

@pytest.fixture(autouse=True)
def reset_game_state():
    state = get_state()
    state.reset()
    yield
    state.reset()

def test_own_board_returns_ship_positions():
    # Arrange: place a single ship
    ship_payload = [
        {
            "type": "Cruiser",
            "size": 3,
            "coordinates": [[1, 1], [1, 2], [1, 3]]
        }
    ]
    resp = client.post("/place_ships", json=ship_payload)
    assert resp.status_code == 200

    # Act: retrieve own board view
    board_resp = client.get("/games/1/players/1/board")
    assert board_resp.status_code == 200
    data = board_resp.json()

    # Assert: ships list contains the placed ship with correct coordinates
    assert "ships" in data
    assert len(data["ships"]) == 1
    ship = data["ships"][0]
    assert ship["type"] == "Cruiser"
    assert ship["size"] == 3
    # coordinates should be list of lists matching payload
    assert ship["coordinates"] == [[1, 1], [1, 2], [1, 3]]

    # Ensure no opponent ship data is present (only own ships)
    # In this simplified prototype, the board view only includes own ships, so we just check that the keys are as expected
    expected_keys = {"width", "height", "ships", "hits", "misses"}
    assert set(data.keys()) == expected_keys
