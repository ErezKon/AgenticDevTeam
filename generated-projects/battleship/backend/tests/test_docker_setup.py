import os
import pathlib


def test_backend_dockerfile_exists_and_contains_uvicorn():
    """[US-005#1] Ensure backend Dockerfile exists and runs uvicorn with correct app path."""
    dockerfile_path = pathlib.Path(__file__).resolve().parents[2] / "backend" / "Dockerfile"
    assert dockerfile_path.is_file(), "Backend Dockerfile should exist"
    content = dockerfile_path.read_text()
    assert "uvicorn" in content, "Dockerfile should contain uvicorn command"
    assert "app.main:app" in content, "Dockerfile should reference app.main:app"


def test_docker_compose_file_defines_services():
    """[US-005#2] Ensure docker-compose.yml defines backend and frontend services with correct ports."""
    compose_path = pathlib.Path(__file__).resolve().parents[2] / "docker-compose.yml"
    assert compose_path.is_file(), "docker-compose.yml should exist"
    content = compose_path.read_text()
    assert "backend:" in content, "Compose file should define backend service"
    assert "frontend:" in content, "Compose file should define frontend service"
    assert "8000:8000" in content, "Backend service should map port 8000"
    assert "80:80" in content, "Frontend service should map port 80"
