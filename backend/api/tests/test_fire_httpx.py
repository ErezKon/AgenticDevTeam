import os
import pytest
import httpx
from fastapi import FastAPI

# Ensure test mode is active for auth bypass
os.environ.setdefault("TEST_MODE", "true")

from backend.api.app.main import app

@pytest.fixture
async def async_client():
    async with httpx.AsyncClient(app=app, base_url="http://testserver") as client:
        # Reset state before each test
        await client.post("/reset")
        yield client
        # Reset after test to avoid bleed‑through
        await client.post("/reset")

@pytest.mark.asyncio
async def test_fire_miss_httpx(async_client: httpx.AsyncClient):
    # No ships placed – should be a miss
    response = await async_client.post("/fire", json={"x": 0, "y": 0, "player_id": 1})
    assert response.status_code == 200
    data = response.json()
    assert data["result"] == "miss"
    assert data["message"] == "Shot missed"

@pytest.mark.asyncio
async def test_fire_hit_httpx(async_client: httpx.AsyncClient):
    # Place a destroyer at (1,1) and (1,2)
    ship_payload = [{
        "type": "Destroyer",
        "size": 2,
        "coordinates": [[1, 1], [1, 2]]
    }]
    place_resp = await async_client.post("/place_ships", json=ship_payload)
    assert place_resp.status_code == 200

    # Fire at a coordinate that hits the ship
    response = await async_client.post("/fire", json={"x": 1, "y": 2, "player_id": 1})
    assert response.status_code == 200
    data = response.json()
    assert data["result"] == "hit"
    assert data["message"] == "Shot hit a ship"

@pytest.mark.asyncio
async def test_fire_not_your_turn_httpx(async_client: httpx.AsyncClient):
    # Set the turn to player 2
    turn_resp = await async_client.post("/set_turn", json={"player_id": 2})
    assert turn_resp.status_code == 200

    # Player 1 attempts to fire – should be rejected
    response = await async_client.post("/fire", json={"x": 0, "y": 0, "player_id": 1})
    assert response.status_code == 400
    assert response.json()["detail"] == "Not your turn"
