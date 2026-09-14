"""Studio 登录代理：浏览器仅持有随机会话，应用 Token 保留在进程内存。"""
import base64
import hashlib
import secrets
import threading
import time
import re
import ipaddress
import copy
from datetime import datetime, timezone
from urllib.parse import urlencode, urlsplit

import requests
from flask import Blueprint, jsonify, request, g, Response
from pathlib import Path
from api_utils.local_store import LocalJsonStore
from api_utils.novelai_payload_builder import build_novelai_payload, NOVELAI_MAX_COST_PER_IMAGE
from api_utils.image_validation import validate_generation_images

FLOW_COOKIE = "__Host-idlecloud_studio_flow"
SESSION_COOKIE = "__Host-idlecloud_studio_session"


class BridgeError(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code, self.status = code, status


def _validate_base(value, *, allow_local_http=False):
    try:
        parsed = urlsplit(value)
        try:
            loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
        except ValueError:
            loopback = parsed.hostname == "localhost"
        allowed_http = allow_local_http and parsed.scheme == "http" and loopback
        if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {"", "/"} or (parsed.scheme != "https" and not allowed_http)):
            raise ValueError()
    except ValueError:
        raise ValueError("Studio 地址必须为 HTTPS 源；本机 API/开发页面允许 loopback HTTP。") from None
    return value.rstrip("/")


class StudioTransport:
    def __init__(self, base_url):
        self.base_url = _validate_base(base_url, allow_local_http=True)

    def stream_image(self, path, *, token):
        """鉴权后按块转发成品；禁止重定向，不把整图读入 JSON 或应用内存。"""
        if not re.fullmatch(r"tasks/[1-9][0-9]*/(?:result|results/[1-9][0-9]*)|plans/[1-9][0-9]*/results/[0-9]+|tools/[1-9][0-9]*/result", path):
            raise BridgeError("STUDIO_OPERATION_NOT_ALLOWED", 403)
        session = requests.Session()
        session.trust_env = False
        upstream = None
        def close():
            if upstream is not None:
                upstream.close()
            session.close()
        try:
            upstream = session.get(f"{self.base_url}/api/idlecloud/{path}",
                headers={"Authorization": "Bearer " + token, "Accept": "image/*", "Accept-Encoding": "identity"},
                timeout=(5, 30), allow_redirects=False, stream=True)
            if upstream.status_code != 200:
                status = upstream.status_code if upstream.status_code in {400, 401, 403, 404, 409, 410, 413, 422, 429, 503} else 502
                code = "STUDIO_REQUEST_REJECTED"
                if status not in {401, 403}:
                    # 错误正文限长读取，不能把任意响应当作大图缓冲。
                    import json
                    raw = upstream.raw.read(8192, decode_content=True)
                    try:
                        candidate = json.loads(raw).get("detail", {}).get("code", "")
                        if isinstance(candidate, str) and re.fullmatch(r"[a-z_]{1,80}", candidate):
                            code = candidate
                    except (ValueError, AttributeError):
                        pass
                raise BridgeError(code, status)
            mime = upstream.headers.get("Content-Type", "").split(";")[0]
            if mime not in {"image/png", "image/webp", "image/jpeg"}:
                raise BridgeError("STUDIO_IMAGE_RESPONSE_INVALID", 502)
            headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
            for name in ("Content-Length", "X-Image-Seed", "X-Image-Width", "X-Image-Height"):
                if name == "Content-Length" and upstream.headers.get("Content-Encoding", "identity") != "identity":
                    continue
                value = upstream.headers.get(name, "")
                if re.fullmatch(r"[0-9]{1,20}", value):
                    headers[name] = value
            def chunks():
                try:
                    yield from upstream.iter_content(chunk_size=64 * 1024)
                finally:
                    close()
            result = Response(chunks(), content_type=mime, headers=headers)
            # 未开始迭代就断开的客户端也要关闭上游连接。
            result.call_on_close(close)
            return result
        except requests.RequestException:
            close()
            raise BridgeError("STUDIO_UNAVAILABLE", 502) from None
        except Exception:
            close()
            raise

    def call(self, method, path, *, token=None, payload=None, raw_body=None, content_type=None, request_id=None):
        # 固定接口路径且禁止重定向，避免将应用凭证发送给其他服务。
        task_path = re.fullmatch(r"tasks(?:/by-request/[A-Za-z0-9_-]{16,128}|/[1-9][0-9]*(?:/(?:cancel|result|results/[1-9][0-9]*))?)?", path)
        task_path = task_path or re.fullmatch(r"plans(?:/by-request/[A-Za-z0-9_-]{16,128}|/[1-9][0-9]*(?:/(?:cancel|resume|results/[0-9]+))?)?", path)
        tool_path = re.fullmatch(r"tools/(?:vibe-encode|upscale|director|by-request/[A-Za-z0-9_-]{16,128}|[1-9][0-9]*(?:/result)?)", path)
        media_path = re.fullmatch(r"media(?:/[1-9][0-9]*)?", path)
        if path not in {"exchange", "session", "account", "accounts", "tags"} and not task_path and not tool_path and not media_path:
            raise BridgeError("STUDIO_OPERATION_NOT_ALLOWED", 403)
        if raw_body is not None and (path != "media" or method != "POST" or payload is not None):
            raise BridgeError("STUDIO_OPERATION_NOT_ALLOWED", 403)
        headers = {"Authorization": "Bearer " + token} if token else {}
        body_options = {"json": payload}
        if raw_body is not None:
            headers.update({"Content-Type": content_type or "application/octet-stream", "Idempotency-Key": request_id or ""})
            body_options = {"data": raw_body}
        try:
            with requests.Session() as session:
                session.trust_env = False
                response = session.request(method, f"{self.base_url}/api/idlecloud/{path}",
                                           headers=headers, **body_options, timeout=(5, 15), allow_redirects=False)
            if response.status_code >= 400 or 300 <= response.status_code < 400:
                status = response.status_code if response.status_code in {400, 401, 403, 404, 409, 410, 413, 422, 429, 503} else 502
                code = "STUDIO_REQUEST_REJECTED"
                if ((task_path or tool_path or path == "tags") and status not in {401, 403}) or (media_path and status != 401):
                    try:
                        detail = response.json().get("detail", {})
                        candidate = detail.get("code", "") if isinstance(detail, dict) else ""
                        if re.fullmatch(r"[a-z_]{1,80}", candidate):
                            code = candidate
                    except (ValueError, AttributeError):
                        pass
                raise BridgeError(code, status)
            if (tool_path and path.endswith("/result")
                    and response.headers.get("Content-Type", "").split(";")[0] == "application/octet-stream"):
                return {"encoding": base64.b64encode(response.content).decode("ascii")}
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except (requests.RequestException, ValueError):
            raise BridgeError("STUDIO_UNAVAILABLE", 502) from None


def install_studio_bridge(app, *, transport=None):
    blueprint = Blueprint("studio_bridge", __name__)
    enabled = bool(app.config.get("STUDIO_ENABLED", False))
    pending, sessions = {}, {}
    user_stores = {}
    lock = threading.RLock()
    if enabled:
        web_origin = _validate_base(app.config["STUDIO_WEB_ORIGIN"], allow_local_http=True)
        transport = transport or StudioTransport(app.config["STUDIO_API_BASE"])
    else:
        web_origin = ""

    def require_enabled():
        if not enabled:
            raise BridgeError("STUDIO_DISABLED", 403)

    def prune():
        now = time.monotonic()
        for collection in (pending, sessions):
            for key in list(collection):
                if collection[key]["expires"] <= now:
                    collection.pop(key, None)

    def get_identity(*, csrf=False):
        require_enabled()
        session_id = request.cookies.get(SESSION_COOKIE, "")
        with lock:
            prune()
            entry = sessions.get(session_id)
        if entry is None:
            raise BridgeError("STUDIO_LOGIN_REQUIRED", 401)
        expected_user = request.headers.get("X-Idlecloud-User")
        if expected_user is not None and expected_user != str(entry["user_id"]):
            raise BridgeError("STUDIO_IDENTITY_CHANGED", 409)
        if csrf and not secrets.compare_digest(request.headers.get("X-CSRF-Token", "").encode("utf-8"), entry["csrf"].encode("ascii")):
            raise BridgeError("CSRF_INVALID", 403)
        return session_id, entry

    @blueprint.errorhandler(BridgeError)
    def error_response(error):
        response = jsonify({"code": error.code, "success": False})
        response.status_code = error.status
        if error.status in {401, 403} and error.code == "STUDIO_REQUEST_REJECTED":
            with lock:
                sessions.pop(request.cookies.get(SESSION_COOKIE, ""), None)
            response.delete_cookie(SESSION_COOKIE, secure=True, httponly=True, samesite="Strict", path="/")
        return response

    @blueprint.after_request
    def private_response(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @blueprint.get("/api/studio/config")
    def config():
        return jsonify({"enabled": enabled})

    @blueprint.post("/api/studio/start")
    def start():
        require_enabled()
        origin = request.headers.get("Origin", "")
        if origin not in app.config["ALLOWED_ORIGINS"] or not origin.startswith("https://"):
            raise BridgeError("ORIGIN_NOT_ALLOWED", 403)
        state, verifier, browser_id = (secrets.token_urlsafe(32) for _ in range(3))
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
        redirect_uri = origin + "/studio/callback"
        with lock:
            prune()
            if len(pending) >= 256:
                raise BridgeError("STUDIO_LOGIN_BUSY", 429)
            pending.pop(request.cookies.get(FLOW_COOKIE, ""), None)
            pending[browser_id] = {"state": state, "verifier": verifier, "redirect_uri": redirect_uri,
                                   "expires": time.monotonic() + 300}
        response = jsonify({"authorize_url": web_origin + "/idlecloud/authorize?" + urlencode({
            "state": state, "code_challenge": challenge, "redirect_uri": redirect_uri})})
        response.set_cookie(FLOW_COOKIE, browser_id, secure=True, httponly=True, samesite="Lax", path="/", max_age=300)
        return response

    @blueprint.post("/api/studio/complete")
    def complete():
        require_enabled()
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            raise BridgeError("STUDIO_CALLBACK_INVALID")
        state, code = payload.get("state"), payload.get("code")
        if not isinstance(state, str) or not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", state) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", code):
            raise BridgeError("STUDIO_CALLBACK_INVALID")
        with lock:
            prune()
            browser_id = request.cookies.get(FLOW_COOKIE, "")
            flow = pending.get(browser_id)
            if not flow or not secrets.compare_digest(flow["state"], state):
                raise BridgeError("STUDIO_STATE_INVALID", 403)
            if flow["redirect_uri"] != request.headers.get("Origin", "") + "/studio/callback":
                raise BridgeError("STUDIO_STATE_INVALID", 403)
            if len(sessions) >= 1024:
                raise BridgeError("STUDIO_LOGIN_BUSY", 429)
            pending.pop(browser_id)
        result = transport.call("POST", "exchange", payload={"code": code, "code_verifier": flow["verifier"], "redirect_uri": flow["redirect_uri"]})
        token = result.get("access_token")
        if not isinstance(token, str) or not token.startswith("ic_"):
            raise BridgeError("STUDIO_RESPONSE_INVALID", 502)
        # 先核实身份，不能将换码响应中的任意字段透传给浏览器。
        identity = transport.call("GET", "session", token=token)
        user_id = identity.get("user", {}).get("id")
        if type(user_id) is not int or user_id <= 0:
            raise BridgeError("STUDIO_RESPONSE_INVALID", 502)
        # 本机会话与 Cookie 服从 Studio 签发的到期时间，不自行续期或延长旧授权。
        try:
            expires_at = datetime.fromisoformat(identity["expires_at"].replace("Z", "+00:00"))
            if expires_at.tzinfo is None:
                raise ValueError("missing timezone")
            lifetime = min(30 * 24 * 3600, int((expires_at - datetime.now(timezone.utc)).total_seconds()))
            if lifetime <= 0:
                raise ValueError("expired session")
        except (KeyError, TypeError, ValueError, AttributeError):
            raise BridgeError("STUDIO_RESPONSE_INVALID", 502) from None
        session_id, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with lock:
            old = sessions.pop(request.cookies.get(SESSION_COOKIE, ""), None)
            sessions[session_id] = {"token": token, "csrf": csrf, "user_id": user_id, "expires": time.monotonic() + lifetime}
        if old:
            try:
                transport.call("DELETE", "session", token=old["token"])
            except BridgeError:
                pass  # 旧会话已从本机移除，远端还有到期和撤销保护。
        response = jsonify({"authenticated": True, "user": identity["user"], "csrf_token": csrf})
        response.set_cookie(SESSION_COOKIE, session_id, secure=True, httponly=True, samesite="Strict", path="/", max_age=lifetime)
        response.delete_cookie(FLOW_COOKIE, secure=True, httponly=True, samesite="Lax", path="/")
        return response

    @blueprint.get("/api/studio/session")
    def session_status():
        _, entry = get_identity()
        identity = transport.call("GET", "session", token=entry["token"])
        return jsonify({"authenticated": True, "user": identity["user"], "capabilities": identity["capabilities"], "csrf_token": entry["csrf"]})

    @blueprint.post("/api/studio/media")
    def save_library_media():
        _, entry = get_identity(csrf=True)
        result = transport.call("POST", "media", token=entry["token"],
            raw_body=request.get_data(cache=False), content_type=request.content_type,
            request_id=request.headers.get("Idempotency-Key"))
        return jsonify(result), 202

    @blueprint.get("/api/studio/media/<int:media_id>")
    def library_media_status(media_id):
        _, entry = get_identity()
        return jsonify(transport.call("GET", f"media/{media_id}", token=entry["token"]))

    @blueprint.get("/api/studio/tags")
    def tag_suggestions():
        _, entry = get_identity()
        payload = {"prompt": request.args.get("prompt", "")}
        if "model" in request.args:
            payload["model"] = request.args["model"]
        # 查询参数只进入固定 Studio 接口，浏览器不能选择上游地址或官方账号。
        return jsonify(transport.call("POST", "tags", token=entry["token"], payload=payload))

    @blueprint.get("/api/studio/accounts")
    def account_status():
        _, entry = get_identity()
        return jsonify(transport.call("GET", "accounts", token=entry["token"]))

    @blueprint.get("/api/studio/account")
    def account_summary():
        _, entry = get_identity()
        summary = transport.call("GET", "account", token=entry["token"])
        # 个人配额与共享账号余额分开；不伪造官方订阅、邮箱或总 Anlas。
        return jsonify({"account_snapshot": {
            "auth": {"login_mode": "studio", "can_manage_credentials": False},
            "information": {}, "subscription": {}, "anlas": {"total": None}, "v5": {},
            "studio": summary,
        }})

    @blueprint.route("/api/studio/local/<collection>", methods=["GET", "POST", "PUT", "DELETE"])
    def local_data(collection):
        _, entry = get_identity(csrf=request.method != "GET")
        identity = transport.call("GET", "session", token=entry["token"])
        if identity.get("user", {}).get("id") != entry["user_id"]:
            raise BridgeError("STUDIO_IDENTITY_CHANGED", 409)
        handlers = {
            ("settings", "GET"): "get_settings", ("settings", "PUT"): "put_settings",
            ("random-prompts", "GET"): "get_random_prompts", ("random-prompts", "PUT"): "put_random_prompts",
            ("notes", "GET"): "get_notes", ("notes", "POST"): "create_note",
            ("notes", "PUT"): "update_note", ("notes", "DELETE"): "delete_note",
        }
        endpoint = handlers.get((collection, request.method))
        if endpoint is None:
            raise BridgeError("STUDIO_OPERATION_NOT_ALLOWED", 404)
        with lock:
            if entry["user_id"] not in user_stores:
                user_stores[entry["user_id"]] = LocalJsonStore(
                    Path(app.config["DATA_DIR"]) / "studio" / str(entry["user_id"]),
                    app.config["LOCAL_STORE_MAX_BYTES"],
                )
            g.scoped_local_store = user_stores[entry["user_id"]]
        # 已完成应用鉴权/CSRF；仅复用白名单数据处理器的 schema、锁和原子写入。
        return app.view_functions[endpoint].__wrapped__()

    @blueprint.delete("/api/studio/session")
    def logout():
        session_id, entry = get_identity(csrf=True)
        # 撤销失败时保留本地入口，用户可以重试；不假报远端会话已注销。
        transport.call("DELETE", "session", token=entry["token"])
        with lock:
            sessions.pop(session_id, None)
        response = jsonify({"revoked": True})
        response.delete_cookie(SESSION_COOKIE, secure=True, httponly=True, samesite="Strict", path="/")
        return response

    @blueprint.post("/api/studio/tasks")
    @blueprint.post("/api/studio/plans")
    def submit_task():
        _, entry = get_identity(csrf=True)
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or not isinstance(body.get("parameters"), dict):
            raise BridgeError("STUDIO_TASK_INVALID")
        request_id = body.get("request_id", "")
        if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", request_id):
            raise BridgeError("STUDIO_TASK_INVALID")
        # 保留原版参数构造和图片校验。额度/账号权限由 Studio 权威复核。
        task_count = body.get("task_count", 1)
        is_plan = request.path.endswith("/plans")
        if type(task_count) is not int or not 1 <= task_count <= (64 if is_plan else 16):
            raise BridgeError("STUDIO_TASK_INVALID")
        source = copy.deepcopy(body["parameters"])
        validate_generation_images(source)
        native = build_novelai_payload(source, current_user="studio", user_total_amount=999,
            use_upscale_credits=bool(source.get("use_upscale_credits", False)),
            user_upscale_credits=NOVELAI_MAX_COST_PER_IMAGE, studio_mode=True)["data"]
        return jsonify(transport.call("POST", "plans" if is_plan else "tasks", token=entry["token"],
            payload={"request_id": request_id, "request": native, "task_count": task_count}))

    @blueprint.get("/api/studio/tasks/by-request/<request_id>")
    def find_task(request_id):
        _, entry = get_identity()
        return jsonify(transport.call("GET", "tasks/by-request/" + request_id, token=entry["token"]))

    @blueprint.get("/api/studio/plans/by-request/<request_id>")
    def find_plan(request_id):
        _, entry = get_identity()
        return jsonify(transport.call("GET", "plans/by-request/" + request_id, token=entry["token"]))

    @blueprint.get("/api/studio/plans/<int:plan_id>")
    def plan_status(plan_id):
        _, entry = get_identity()
        return jsonify(transport.call("GET", f"plans/{plan_id}", token=entry["token"]))

    @blueprint.post("/api/studio/plans/<int:plan_id>/cancel")
    @blueprint.post("/api/studio/plans/<int:plan_id>/resume")
    def plan_action(plan_id):
        _, entry = get_identity(csrf=True)
        action = request.path.rsplit("/", 1)[-1]
        return jsonify(transport.call("POST", f"plans/{plan_id}/{action}", token=entry["token"]))

    @blueprint.get("/api/studio/plans/<int:plan_id>/results/<int:index>")
    def plan_result(plan_id, index):
        _, entry = get_identity()
        path = f"plans/{plan_id}/results/{index}"
        if request.headers.get("Accept") == "image/*":
            return transport.stream_image(path, token=entry["token"])
        return jsonify(transport.call("GET", path, token=entry["token"]))

    @blueprint.get("/api/studio/tasks/<int:task_id>")
    def task_status(task_id):
        _, entry = get_identity()
        return jsonify(transport.call("GET", f"tasks/{task_id}", token=entry["token"]))

    @blueprint.get("/api/studio/tasks/<int:task_id>/result")
    def task_result(task_id):
        _, entry = get_identity()
        if request.headers.get("Accept") == "image/*":
            return transport.stream_image(f"tasks/{task_id}/result", token=entry["token"])
        return jsonify(transport.call("GET", f"tasks/{task_id}/result", token=entry["token"]))

    @blueprint.get("/api/studio/tasks/<int:submission_id>/results/<int:task_id>")
    def task_item_result(submission_id, task_id):
        _, entry = get_identity()
        if request.headers.get("Accept") == "image/*":
            return transport.stream_image(f"tasks/{submission_id}/results/{task_id}", token=entry["token"])
        return jsonify(transport.call("GET", f"tasks/{submission_id}/results/{task_id}", token=entry["token"]))

    @blueprint.post("/api/studio/tasks/<int:task_id>/cancel")
    def cancel_task(task_id):
        _, entry = get_identity(csrf=True)
        return jsonify(transport.call("POST", f"tasks/{task_id}/cancel", token=entry["token"]))

    @blueprint.post("/api/studio/tools/vibe-encode")
    @blueprint.post("/api/studio/tools/upscale", defaults={"tool": "upscale"})
    @blueprint.post("/api/studio/tools/director", defaults={"tool": "director"})
    def submit_vibe_encoding(tool="vibe-encode"):
        _, entry = get_identity(csrf=True)
        body = request.get_json(silent=True)
        if (not isinstance(body, dict) or not isinstance(body.get("request"), dict)
                or not isinstance(body.get("request_id"), str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", body["request_id"])):
            raise BridgeError("STUDIO_TOOL_INVALID")
        return jsonify(transport.call("POST", "tools/" + tool, token=entry["token"],
            payload={"request_id": body["request_id"], "request": body["request"]}))

    @blueprint.get("/api/studio/tools/by-request/<request_id>")
    def find_tool(request_id):
        _, entry = get_identity()
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", request_id):
            raise BridgeError("STUDIO_TOOL_INVALID")
        return jsonify(transport.call("GET", "tools/by-request/" + request_id, token=entry["token"]))

    @blueprint.get("/api/studio/tools/<int:operation_id>")
    @blueprint.get("/api/studio/tools/<int:operation_id>/result", defaults={"result": True})
    def tool_status(operation_id, result=False):
        _, entry = get_identity()
        path = f"tools/{operation_id}" + ("/result" if result else "")
        if result and request.headers.get("Accept") == "image/*":
            return transport.stream_image(path, token=entry["token"])
        return jsonify(transport.call("GET", path, token=entry["token"]))

    app.register_blueprint(blueprint)
