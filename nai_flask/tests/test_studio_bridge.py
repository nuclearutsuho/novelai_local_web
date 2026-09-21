"""使用受控 Studio 边界验证浏览器会话绑定，不接触真实账号。"""
from urllib.parse import parse_qs, urlsplit
from datetime import datetime, timezone, timedelta
import pytest
from app import create_app
from api_utils.studio_bridge import install_studio_bridge, BridgeError, StudioTransport

ORIGIN = "https://localhost:5000"


@pytest.mark.parametrize("path", ["tasks/1/results/2", "tasks/1/results/2/thumbnail"])
def test_image_stream_is_lazy_and_closes_on_disconnect(monkeypatch, path):
    from unittest.mock import MagicMock
    response = MagicMock(status_code=200, headers={"Content-Type": "image/png", "Content-Length": "6", "X-Image-Seed": "0"})
    response.iter_content.return_value = iter([b"abc", b"def"])
    session = MagicMock()
    session.get.return_value = response
    monkeypatch.setattr("api_utils.studio_bridge.requests.Session", lambda: session)
    result = StudioTransport("http://127.0.0.1:46005").stream_image(path, token="synthetic")
    response.iter_content.assert_not_called()
    assert next(iter(result.response)) == b"abc"
    result.close()
    response.close.assert_called()
    session.close.assert_called()
    response.json.assert_not_called()
    assert result.headers["X-Image-Seed"] == "0"
    assert session.get.call_args.kwargs["stream"] is True
    assert session.get.call_args.kwargs["allow_redirects"] is False


def test_image_stream_rejects_redirects_and_preserves_expiration(monkeypatch):
    from unittest.mock import MagicMock
    response = MagicMock(status_code=410, headers={})
    response.raw.read.return_value = b'{"detail":{"code":"idlecloud_result_expired"}}'
    session = MagicMock()
    session.get.return_value = response
    monkeypatch.setattr("api_utils.studio_bridge.requests.Session", lambda: session)
    transport = StudioTransport("http://127.0.0.1:46005")
    with pytest.raises(BridgeError) as caught:
        transport.stream_image("tasks/1/result", token="synthetic")
    assert caught.value.status == 410 and caught.value.code == "idlecloud_result_expired"
    response.close.assert_called()
    response.status_code = 302
    with pytest.raises(BridgeError) as caught:
        transport.stream_image("tasks/1/result", token="synthetic")
    assert caught.value.status == 502
    with pytest.raises(BridgeError):
        transport.stream_image("tasks/../accounts", token="synthetic")


@pytest.mark.parametrize("suffix", ["", "/thumbnail"])
def test_binary_result_keeps_session_and_identity_guards(bridge, monkeypatch, suffix):
    from flask import Response
    client, fake, _ = bridge
    calls = []
    def stream(path, *, token):
        calls.append(path)
        return Response(b"synthetic-image", content_type="image/png")
    monkeypatch.setattr(fake, "stream_image", stream, raising=False)
    url = "/api/studio/tasks/7/results/8" + suffix
    assert client.get(url, base_url=ORIGIN, headers={"Accept": "image/*"}).status_code == 401
    complete(client, start(client))
    result = client.get(url, base_url=ORIGIN, headers={"Accept": "image/*", "X-Idlecloud-User": "1"})
    assert result.data == b"synthetic-image" and calls == ["tasks/7/results/8" + suffix]
    assert client.get(url, base_url=ORIGIN, headers={"Accept": "image/*", "X-Idlecloud-User": "2"}).status_code == 409
    assert len(calls) == 1


def test_tool_transport_preserves_binary_encoding_and_rejects_unknown_path(monkeypatch):
    import base64
    from unittest.mock import MagicMock
    response = MagicMock(status_code=200, content=b"\x00\xffraw-encoding\x00", headers={"Content-Type": "application/octet-stream"})
    session = MagicMock()
    session.__enter__.return_value = session
    session.request.return_value = response
    monkeypatch.setattr("api_utils.studio_bridge.requests.Session", lambda: session)
    transport = StudioTransport("http://127.0.0.1:46005")
    result = transport.call("GET", "tools/7/result", token="synthetic-only")
    assert base64.b64decode(result["encoding"]) == response.content
    response.json.assert_not_called()
    assert session.request.call_args.kwargs["allow_redirects"] is False
    with pytest.raises(BridgeError):
        transport.call("GET", "tools/../accounts", token="synthetic-only")
    session.request.assert_called_once()


def test_media_transport_preserves_bytes_and_storage_errors(monkeypatch):
    from unittest.mock import MagicMock
    response = MagicMock(status_code=202)
    response.json.return_value = {"media_id": 7, "status": "processing"}
    session = MagicMock()
    session.__enter__.return_value = session
    session.request.return_value = response
    monkeypatch.setattr("api_utils.studio_bridge.requests.Session", lambda: session)
    transport = StudioTransport("http://127.0.0.1:46005")
    body = b"\x00\xfffinal-image\x00"
    result = transport.call("POST", "media", token="synthetic-only", raw_body=body,
        content_type="image/png", request_id="library-request-001")
    assert result == {"media_id": 7, "status": "processing"}
    sent = session.request.call_args.kwargs
    assert sent["data"] == body and "json" not in sent
    assert sent["headers"]["Idempotency-Key"] == "library-request-001"
    assert sent["allow_redirects"] is False
    response.status_code = 403
    response.json.return_value = {"detail": {"code": "storage_limit_exceeded", "message": "private diagnostic"}}
    with pytest.raises(BridgeError) as caught:
        transport.call("POST", "media", token="synthetic-only", raw_body=body)
    assert caught.value.status == 403 and caught.value.code == "storage_limit_exceeded"
    with pytest.raises(BridgeError):
        transport.call("POST", "accounts", raw_body=body)


def test_tool_transport_preserves_upscale_json_result(monkeypatch):
    from unittest.mock import MagicMock
    payload = {"images": [{"data": "base64-result", "width": 1024, "height": 1024, "seed": 42}]}
    response = MagicMock(status_code=200, headers={"Content-Type": "application/json"})
    response.json.return_value = payload
    session = MagicMock()
    session.__enter__.return_value = session
    session.request.return_value = response
    monkeypatch.setattr("api_utils.studio_bridge.requests.Session", lambda: session)
    assert StudioTransport("http://127.0.0.1:46005").call("GET", "tools/7/result", token="synthetic-only") == payload


class FakeStudio:
    def __init__(self):
        self.calls = []
        self.rejected = False
        self.user_id = 1
        self.users = {}
        self.expires_at = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()

    def call(self, method, path, *, token=None, payload=None):
        self.calls.append((method, path, token, payload))
        if self.rejected:
            raise BridgeError("STUDIO_REQUEST_REJECTED", 401)
        if path == "exchange":
            token = "ic_" + str(self.user_id).ljust(64, "x")
            self.users[token] = self.user_id
            return {"access_token": token}
        if path == "session":
            return {"user": {"id": self.users[token], "username": "test-admin"}, "capabilities": {"generation": False}, "expires_at": self.expires_at}
        if path == "tags":
            return {"tags": [{"tag": "blue hair", "confidence": 0.9}]}
        return {"items": []}


@pytest.fixture
def bridge(tmp_path):
    app = create_app({"TESTING": True, "DATA_DIR": str(tmp_path), "STUDIO_ENABLED": True,
                      "STUDIO_WEB_ORIGIN": "http://127.0.0.1:3000", "SESSION_COOKIE_SECURE": True})
    app.config["ALLOWED_ORIGINS"] = {ORIGIN}
    fake = FakeStudio()
    install_studio_bridge(app, transport=fake)
    return app.test_client(), fake, app


def start(client):
    response = client.post("/api/studio/start", base_url=ORIGIN, headers={"Origin": ORIGIN})
    assert response.status_code == 200
    assert "Secure" in response.headers["Set-Cookie"]
    return parse_qs(urlsplit(response.json["authorize_url"]).query)


def complete(client, params):
    return client.post("/api/studio/complete", base_url=ORIGIN, headers={"Origin": ORIGIN},
                       json={"state": params["state"][0], "code": "c" * 43})


def test_flow_is_bound_to_browser_and_consumed_once(bridge):
    client, fake, app = bridge
    params = start(client)
    assert complete(app.test_client(), params).status_code == 403
    assert fake.calls == []
    response = complete(client, params)
    assert response.status_code == 200
    assert "ic_" not in response.get_data(as_text=True)
    assert "ic_" not in str(response.headers)
    assert complete(client, params).status_code == 403
    assert fake.calls[0][3]["redirect_uri"] == ORIGIN + "/studio/callback"
    assert "code_verifier" not in params
    assert client.get("/api/studio/session", base_url=ORIGIN).json["user"]["id"] == 1
    # 应用授权不会悄悄创建官方直连会话。
    assert client.get("/api/session", base_url=ORIGIN).json["authenticated"] is False


def test_tags_use_bound_studio_session_and_preserve_native_query(bridge):
    client, fake, _ = bridge
    url = "/api/studio/tags?prompt=blue+hair&model=nai-diffusion-4-5-full&account_id=999"
    assert client.get(url, base_url=ORIGIN).status_code == 401
    complete(client, start(client))
    response = client.get(url, base_url=ORIGIN, headers={"X-Idlecloud-User": "1"})
    assert response.json == {"tags": [{"tag": "blue hair", "confidence": 0.9}]}
    assert response.headers["Cache-Control"] == "no-store"
    assert fake.calls[-1][:2] == ("POST", "tags")
    assert fake.calls[-1][3] == {"prompt": "blue hair", "model": "nai-diffusion-4-5-full"}
    before = len(fake.calls)
    assert client.get(url, base_url=ORIGIN, headers={"X-Idlecloud-User": "2"}).status_code == 409
    assert len(fake.calls) == before
    fake.rejected = True
    assert client.get(url, base_url=ORIGIN).status_code == 401


def test_media_upload_requires_csrf_and_bound_identity_without_logging_out_on_quota(bridge, monkeypatch):
    client, fake, _ = bridge
    login = complete(client, start(client)).json
    body = b"final-composited-pixels"
    calls = []
    original_call = fake.call
    def media_call(method, path, **kwargs):
        if path == "media":
            calls.append(kwargs)
            if len(calls) > 1:
                raise BridgeError("storage_limit_exceeded", 403)
            return {"media_id": 7, "status": "processing"}
        if path == "media/7":
            return {"media_id": 7, "status": "ready"}
        return original_call(method, path, **kwargs)
    monkeypatch.setattr(fake, "call", media_call)
    headers = {"Origin": ORIGIN, "Content-Type": "image/png", "Idempotency-Key": "library-request-001"}
    assert client.post("/api/studio/media", base_url=ORIGIN, data=body, headers=headers).status_code == 403
    assert not calls
    headers.update({"X-CSRF-Token": login["csrf_token"], "X-Idlecloud-User": "1"})
    response = client.post("/api/studio/media", base_url=ORIGIN, data=body, headers=headers)
    assert response.status_code == 202
    assert calls[0]["raw_body"] == body and calls[0]["request_id"] == "library-request-001"
    assert client.get("/api/studio/media/7", base_url=ORIGIN).json["status"] == "ready"
    headers["X-Idlecloud-User"] = "2"
    assert client.post("/api/studio/media", base_url=ORIGIN, data=body, headers=headers).status_code == 409
    assert len(calls) == 1
    headers["X-Idlecloud-User"] = "1"
    assert client.post("/api/studio/media", base_url=ORIGIN, data=body, headers=headers).json["code"] == "storage_limit_exceeded"
    assert client.get("/api/studio/session", base_url=ORIGIN).status_code == 200


def test_logout_requires_own_csrf_and_revokes_remote_session(bridge):
    client, fake, _ = bridge
    response = complete(client, start(client))
    headers = {"Origin": ORIGIN}
    assert client.delete("/api/studio/session", base_url=ORIGIN, headers=headers).status_code == 403
    headers["X-CSRF-Token"] = response.json["csrf_token"]
    assert client.delete("/api/studio/session", base_url=ORIGIN, headers=headers).status_code == 200
    assert fake.calls[-1][:2] == ("DELETE", "session")
    assert client.get("/api/studio/session", base_url=ORIGIN).status_code == 401


def test_remote_revocation_invalidates_local_session(bridge):
    client, fake, _ = bridge
    complete(client, start(client))
    fake.rejected = True
    response = client.get("/api/studio/session", base_url=ORIGIN)
    assert response.status_code == 401
    before = len(fake.calls)
    assert client.get("/api/studio/session", base_url=ORIGIN).status_code == 401
    assert len(fake.calls) == before


def test_wrong_state_and_cross_origin_cannot_exchange(bridge):
    client, fake, _ = bridge
    params = start(client)
    params["state"] = ["z" * 43]
    assert complete(client, params).status_code == 403
    assert client.post("/api/studio/start", base_url=ORIGIN, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/studio/complete", base_url=ORIGIN, headers={"Origin": ORIGIN}, json=[1]).status_code == 400
    assert fake.calls == []


def test_tasks_keep_original_native_parameters_and_require_studio_csrf(bridge):
    client, fake, _ = bridge
    login = complete(client, start(client)).json
    body = {"request_id": "task-000000000001", "task_count": 8, "parameters": {
        "model": "nai-diffusion-4-5-full", "prompt": "1girl", "negativePrompt": "low quality",
        "width": 512, "height": 512, "steps": 20, "seed": 42, "scale": 5,
        "noise_schedule": "karras", "sampler": "k_euler_ancestral",
        "v4_prompt": {"caption": {"base_caption": "1girl", "char_captions": []}, "use_coords": True, "use_order": True},
    }}
    before = len(fake.calls)
    assert client.post("/api/studio/tasks", base_url=ORIGIN, headers={"Origin": ORIGIN}, json=body).status_code == 403
    assert len(fake.calls) == before
    response = client.post("/api/studio/tasks", base_url=ORIGIN,
        headers={"Origin": ORIGIN, "X-CSRF-Token": login["csrf_token"]}, json=body)
    assert response.status_code == 200
    forwarded = fake.calls[-1]
    assert forwarded[:2] == ("POST", "tasks")
    assert forwarded[3]["task_count"] == 8
    native = forwarded[3]["request"]
    assert native["parameters"]["n_samples"] == 1
    assert native["input"] == "1girl"
    assert native["parameters"]["extra_noise_seed"] == 42
    assert native["parameters"]["ucPreset"] == 4
    assert native["parameters"]["negative_prompt"] == "low quality"


def test_plan_forwarding_accepts_64_and_guards_resume_and_result_identity(bridge):
    client, fake, _ = bridge
    login = complete(client, start(client)).json
    headers = {"Origin": ORIGIN, "X-CSRF-Token": login["csrf_token"], "X-Idlecloud-User": "1"}
    body = {"request_id": "plan-000000000001", "task_count": 64, "parameters": {
        "model": "nai-diffusion-4-5-full", "width": 512, "height": 512,
        "steps": 20, "seed": 42, "positivePrompt": "1girl", "negativePrompt": "",
        "sampler": "k_euler_ancestral", "scale": 5}}
    response = client.post("/api/studio/plans", base_url=ORIGIN, headers=headers, json=body)
    assert response.status_code == 200
    assert fake.calls[-1][1] == "plans"
    assert fake.calls[-1][3]["task_count"] == 64
    assert fake.calls[-1][3]["request"]["parameters"]["n_samples"] == 1
    assert client.post("/api/studio/plans/1/resume", base_url=ORIGIN,
        headers={"Origin": ORIGIN}).status_code == 403
    assert client.get("/api/studio/plans/1/results/63", base_url=ORIGIN,
        headers={"X-Idlecloud-User": "2"}).status_code == 409
    assert "ic_" not in response.get_data(as_text=True)


@pytest.mark.parametrize("tool", ["vibe-encode", "upscale", "director"])
def test_vibe_tools_require_csrf_and_forward_only_known_routes(bridge, tool):
    client, fake, _ = bridge
    login = complete(client, start(client)).json
    body = {"request_id": "encoding-request-001", "request": {
        "model": "nai-diffusion-4-5-full", "image": "original", "information_extracted": 0.5}}
    url = "/api/studio/tools/" + tool
    assert client.post(url, base_url=ORIGIN, headers={"Origin": ORIGIN}, json=body).status_code == 403
    result = client.post(url, base_url=ORIGIN,
        headers={"Origin": ORIGIN, "X-CSRF-Token": login["csrf_token"]}, json=body)
    assert result.status_code == 200
    assert fake.calls[-1][:2] == ("POST", "tools/" + tool)
    assert fake.calls[-1][3] == body
    for path in ("by-request/encoding-request-001", "7", "7/result"):
        assert client.get("/api/studio/tools/" + path, base_url=ORIGIN).status_code == 200
        assert fake.calls[-1][:2] == ("GET", "tools/" + path)


def test_notes_are_scoped_by_verified_studio_user(bridge):
    first, fake, app = bridge
    first_login = complete(first, start(first)).json
    second = app.test_client()
    fake.user_id = 2
    second_login = complete(second, start(second)).json
    written = first.post('/api/studio/local/notes', base_url=ORIGIN,
        headers={'Origin': ORIGIN, 'X-CSRF-Token': first_login['csrf_token']},
        json={'note': {'title': 'private', 'text_content1': 'owner-only', 'text_content2': ''}})
    assert written.status_code == 201
    assert first.get('/api/studio/local/notes', base_url=ORIGIN).json['notes'][0]['title'] == 'private'
    assert second.get('/api/studio/local/notes', base_url=ORIGIN).json['notes'] == []
    assert first.get('/api/studio/local/notes', base_url=ORIGIN, headers={'X-Idlecloud-User': '2'}).status_code == 409
    assert second.delete('/api/studio/local/notes', base_url=ORIGIN,
        headers={'Origin': ORIGIN, 'X-CSRF-Token': second_login['csrf_token']}, json={'title': 'private'}).status_code == 404


@pytest.mark.parametrize("base", ["http://evil.example", "https://example.com/path", "https://user:pass@example.com", "https://[/"])
def test_unsafe_studio_base_is_rejected(base):
    with pytest.raises(ValueError):
        StudioTransport(base)


@pytest.mark.parametrize("days", [2, 30])
def test_session_lifetime_follows_studio_expiry(bridge, monkeypatch, days):
    client, fake, _ = bridge
    fake.expires_at = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
    now = [1000.0]
    monkeypatch.setattr("api_utils.studio_bridge.time.monotonic", lambda: now[0])
    response = complete(client, start(client))
    assert response.status_code == 200
    cookie = client.get_cookie("__Host-idlecloud_studio_session", domain="localhost")
    assert days * 86400 - 5 <= cookie.max_age <= days * 86400
    assert cookie.secure and cookie.http_only and cookie.same_site == "Strict"
    now[0] += 25 * 3600
    assert client.get("/api/studio/session", base_url=ORIGIN).status_code == 200
    now[0] += days * 86400
    assert client.get("/api/studio/session", base_url=ORIGIN).status_code == 401


@pytest.mark.parametrize("expires_at", [None, "invalid", "2030-01-01T00:00:00", "2000-01-01T00:00:00+00:00"])
def test_invalid_studio_expiry_cannot_create_session(bridge, expires_at):
    client, fake, _ = bridge
    fake.expires_at = expires_at
    assert complete(client, start(client)).status_code == 502
    assert client.get("/api/studio/session", base_url=ORIGIN).status_code == 401


def test_batch_item_transport_allows_only_numeric_submission_and_task_ids(monkeypatch):
    from unittest.mock import MagicMock
    response = MagicMock(status_code=200)
    response.json.return_value = {"images": [{"image": "synthetic"}]}
    session = MagicMock()
    session.__enter__.return_value = session
    session.request.return_value = response
    monkeypatch.setattr("api_utils.studio_bridge.requests.Session", lambda: session)
    transport = StudioTransport("http://127.0.0.1:46005")
    assert transport.call("GET", "tasks/7/results/9", token="synthetic-only")["images"]
    for path in ("tasks/7/results/../9", "tasks/7/results/0", "tasks/7/results/-1"):
        with pytest.raises(BridgeError):
            transport.call("GET", path, token="synthetic-only")
    session.request.assert_called_once()


def test_recent_results_requires_identity_and_valid_cursor(bridge):
    client, fake, _ = bridge
    url = '/api/studio/results/recent'
    assert client.get(url, base_url=ORIGIN).status_code == 401
    complete(client, start(client))
    headers = {'X-Idlecloud-User': '1'}
    assert client.get(url + '?before=123', base_url=ORIGIN, headers=headers).status_code == 200
    assert fake.calls[-1][1] == 'results/recent?before=123'
    assert client.get(url + '?before=1%26user_id=2', base_url=ORIGIN, headers=headers).status_code == 400
    assert client.get(url, base_url=ORIGIN, headers={'X-Idlecloud-User': '2'}).status_code == 409
