"""通过模拟官方客户端验证 HTTPS 部署安全边界，不访问付费接口。"""
from pathlib import Path
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deployment"))
from lan_app import create_lan_app, ORIGIN, LOCAL_ORIGIN


@pytest.fixture
def lan(tmp_path, fake_client):
    application = create_lan_app({"TESTING": True, "DATA_DIR": str(tmp_path)}, fake_client)
    return application.test_client(), fake_client


@pytest.mark.parametrize("origin", [ORIGIN, LOCAL_ORIGIN])
def test_https_login_cookie_and_csrf(lan, origin):
    client, upstream = lan
    base = "https://127.0.0.1:46011"
    response = client.post("/api/session/persistent-token", base_url=base,
                           headers={"Origin": origin}, json={"token": "pst-test-only"})
    assert response.status_code == 200
    cookie = response.headers["Set-Cookie"]
    assert all(part in cookie for part in ("__Host-idlecloud_session=", "Secure", "HttpOnly", "SameSite=Strict", "Path=/"))
    assert "Domain=" not in cookie
    assert "pst-test-only" not in cookie
    denied = client.post("/api/images/generate", base_url=base, headers={"Origin": origin}, json={})
    assert denied.status_code == 403
    assert denied.json["code"] == "CSRF_INVALID"
    assert not any(call[0] == "generate" for call in upstream.calls)
    token = response.json["csrf_token"]
    assert client.delete("/api/session", base_url=base, headers={"Origin": origin, "X-CSRF-Token": token}).status_code == 200
    assert client.get("/api/session", base_url=base).json["authenticated"] is False


@pytest.mark.parametrize("origin", ["http://192.168.31.238:46010", "https://evil.example", ORIGIN + "/fake", "null", "http://localhost:3000", "http://127.0.0.1:46010", "https://127.0.0.1:46012"])
def test_wrong_origin_never_reaches_official_client(lan, origin):
    client, upstream = lan
    response = client.post("/api/session/persistent-token", base_url="https://127.0.0.1:46011", headers={"Origin": origin}, json={"token": "pst-test-only"})
    assert response.status_code == 403
    assert upstream.calls == []


def test_missing_origin_and_wrong_host(lan):
    client, upstream = lan
    assert client.post("/api/session/persistent-token", base_url="https://127.0.0.1:46011", json={}).status_code == 403
    assert client.get("/api/session", base_url="https://evil.example").status_code == 400
    assert client.get("/api/session", base_url="https://127.0.0.1:9999").status_code == 400
    assert upstream.calls == []


@pytest.mark.parametrize("path", ["/login", "/login?studio=1", "/studio/start", "/studio/callback"])
def test_cross_site_entry_documents(lan, path):
    client, upstream = lan
    response = client.get(path, base_url="https://127.0.0.1:46011", headers={
        "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
    })
    assert response.status_code == 200
    assert response.mimetype == "text/html"
    assert upstream.calls == []


@pytest.mark.parametrize("method,path,mode,destination", [
    ("GET", "/api/session", "navigate", "document"),
    ("POST", "/api/studio/start", "navigate", "document"),
    ("GET", "/studio/start", "cors", "empty"),
    ("GET", "/studio/start", "navigate", "iframe"),
    ("GET", "/login", "cors", "empty"),
    ("GET", "/login", "navigate", "iframe"),
    ("POST", "/login", "navigate", "document"),
])
def test_cross_site_entry_exception_does_not_open_api_or_embedding(lan, method, path, mode, destination):
    client, upstream = lan
    response = client.open(path, method=method, base_url="https://127.0.0.1:46011", headers={
        "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": mode, "Sec-Fetch-Dest": destination,
    })
    assert response.status_code == 403
    assert response.json["code"] == "ORIGIN_NOT_ALLOWED"
    assert upstream.calls == []
