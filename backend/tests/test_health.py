from fastapi.testclient import TestClient

from altastata_console.main import app

client = TestClient(app)


def test_health() -> None:
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_files_root() -> None:
    r = client.get("/api/files", params={"path": "/"})
    assert r.status_code == 200
    data = r.json()
    assert data["path"] == "/"
    assert any(e["name"] == "Applications" for e in data["entries"])
