"""隔离验证生产入口，不启动正式监听、不连接 Studio 或官方服务。"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deployment"))
from production_app import create_production_app, server_options


def test_server_resource_options_preserve_defaults_and_reject_invalid_values():
    assert server_options({}) == {"threads": 8, "connection_limit": 100, "channel_timeout": 120}
    assert server_options({"IDLECLOUD_THREADS": "16"})["threads"] == 16
    for key, value in [("IDLECLOUD_THREADS", "0"), ("IDLECLOUD_THREADS", "65"),
                       ("IDLECLOUD_CONNECTION_LIMIT", "bad"), ("IDLECLOUD_CHANNEL_TIMEOUT", "-1")]:
        with pytest.raises(ValueError, match=key):
            server_options({key: value})


@pytest.fixture
def environment(tmp_path):
    return {"IDLECLOUD_PUBLIC_ORIGIN": "https://idlecloud.example.com",
        "IDLECLOUD_STUDIO_WEB_ORIGIN": "https://studio.example.com",
        "IDLECLOUD_STUDIO_API_BASE": "http://127.0.0.1:8000",
        "IDLECLOUD_DATA_DIR": str(tmp_path / "private-data")}


def test_health_is_local_and_observes_frontend_readiness(environment, tmp_path):
    app = create_production_app(environment)
    app.extensions["novelai_client"] = object()
    assert app.config["ALLOWED_ORIGINS"] == {"https://idlecloud.example.com"}
    assert app.config["STUDIO_WEB_ORIGIN"] == "https://studio.example.com"
    assert app.config["STUDIO_API_BASE"] == "http://127.0.0.1:8000"
    app.config["FRONTEND_OUT_DIR"] = str(tmp_path)
    client = app.test_client()
    assert client.get("/healthz", base_url="http://127.0.0.1:46011").status_code == 503
    (tmp_path / "login.html").write_text("test", encoding="utf-8")
    response = client.get("/healthz", base_url="http://127.0.0.1:46011")
    assert response.json == {"status": "ready", "frontend": True}
    assert client.get("/healthz", base_url="http://127.0.0.1:9999").status_code == 400
    assert client.get("/healthz", base_url="http://127.0.0.1:46011",
                      headers={"Origin": "https://evil.example"}).status_code == 403


@pytest.mark.parametrize("key,value", [
    ("IDLECLOUD_PUBLIC_ORIGIN", "http://idlecloud.example.com"),
    ("IDLECLOUD_PUBLIC_ORIGIN", "https://idlecloud.example.com/path"),
    ("IDLECLOUD_STUDIO_WEB_ORIGIN", "http://studio.example.com"),
    ("IDLECLOUD_STUDIO_API_BASE", "http://external.example"),
    ("IDLECLOUD_DATA_DIR", "relative-data"),
    ("IDLECLOUD_PORT", "0"),
])
def test_invalid_production_boundary_fails_at_startup(environment, key, value):
    with pytest.raises(ValueError):
        create_production_app({**environment, key: value})
