import pytest
from fastapi.testclient import TestClient

from backend.api.app.main import app
from backend.domain.game import Ship

client = TestClient(app)

@pytest.fixture(autouse=True)
def reset_state():
    # Reset the in‑memory board and turn before each test via API
    client.post("/reset")
    yield
    client.post("/reset")

def test_fire_miss_when_no_ships():
    response = client.post("/fire", json={"x": 0, "y": 0, "player_id": 1})
    assert response.status_code == 200
    json = response.json()
    assert json["result"] == "miss"
    assert json["message"] == "Shot missed"

def test_fire_hit_when_ship_present():
    # Place a ship at (1,1) and (1,2) via API
    ship_payload = [{"type": "Destroyer", "size": 2, "coordinates": [[1, 1], [1, 2]]}]
    client.post("/place_ships", json=ship_payload)
    response = client.post("/fire", json={"x": 1, "y": 2, "player_id": 1})
    assert response.status_code == 200
    json = response.json()
    assert json["result"] == "hit"
    assert json["message"] == "Shot hit a ship"

def test_fire_not_your_turn():
    # Set turn to player 2 via API
    client.post("/set_turn", json={"player_id": 2})
    response = client.post("/fire", json={"x": 0, "y": 0, "player_id": 1})
    assert response.status_code == 400
    assert response.json()["detail"] == "Not your turn"
