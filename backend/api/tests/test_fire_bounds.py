import pytest
from fastapi.testclient import TestClient

from backend.api.app.main import app

client = TestClient(app)

@pytest.fixture(autouse=True)
def reset_state():
    # Reset board via API before each test
    client.post("/reset")
    yield
    client.post("/reset")

def test_fire_out_of_bounds():
    # Board default width/height is 10, so index 10 is out of bounds
    response = client.post("/fire", json={"x": 10, "y": 0, "player_id": 1})
    assert response.status_code == 400
    assert response.json()["detail"] == "Coordinates out of bounds"
