import pytest
try:
    from fastapi.testclient import TestClient
except ImportError:
    from starlette.testclient import TestClient
from backend.app import app, _validate_coordinates

def test_validate_coordinates_success():
    coords = [{'x': 0, 'y': 0}, {'x': 1, 'y': 0}, {'x': 2, 'y': 0}]
    assert _validate_coordinates(coords) == coords

def test_validate_coordinates_not_aligned():
    coords = [{'x': 0, 'y': 0}, {'x': 1, 'y': 1}]
    with pytest.raises(ValueError, match='aligned'):
        _validate_coordinates(coords)

def test_place_ship_endpoint_success():
    client = TestClient(app)
    payload = {'coordinates': [{'x': 0, 'y': 0}, {'x': 1, 'y': 0}]}
    response = client.post('/place_ship', json=payload)
    assert response.status_code == 200
    json_resp = response.json()
    assert json_resp['status'] == 'ok'
    assert json_resp['placed'] == payload['coordinates']

def test_place_ship_endpoint_out_of_bounds():
    client = TestClient(app)
    payload = {'coordinates': [{'x': -1, 'y': 0}, {'x': 0, 'y': 0}]}
    response = client.post('/place_ship', json=payload)
    assert response.status_code == 422
    json_resp = response.json()
    assert 'detail' in json_resp
    assert 'out of bounds' in json_resp['detail']

def test_place_ship_endpoint_duplicate():
    client = TestClient(app)
    payload = {'coordinates': [{'x': 0, 'y': 0}, {'x': 0, 'y': 0}]}
    response = client.post('/place_ship', json=payload)
    assert response.status_code == 422
    json_resp = response.json()
    assert 'detail' in json_resp
    assert 'duplicate' in json_resp['detail']

def test_place_ship_endpoint_not_aligned():
    client = TestClient(app)
    payload = {'coordinates': [{'x': 0, 'y': 0}, {'x': 1, 'y': 1}]}
    response = client.post('/place_ship', json=payload)
    assert response.status_code == 422
    json_resp = response.json()
    assert 'detail' in json_resp
    assert 'aligned' in json_resp['detail']
