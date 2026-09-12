"""独立局域网部署适配层；保留原版路由、生成算法和来源校验。"""
from pathlib import Path
import sys
import os
import json

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "nai_flask"))
from flask import request
from app import create_app, ApiError
from api_utils.studio_bridge import install_studio_bridge

ORIGIN = "https://192.168.31.238:46010"
# 只增加指定本机 HTTPS 入口，不批准任意开发端口或 HTTP 来源。
LOCAL_ORIGIN = "https://127.0.0.1:46010"
ALLOWED_ORIGINS = {ORIGIN, LOCAL_ORIGIN}


def create_lan_app(overrides=None, novelai_client=None):
    """只批准固定 HTTPS 来源，代理重写 Host，绝不重写 Origin。"""
    config = {
        "HOST": "127.0.0.1", "PORT": 46011,
        "DATA_DIR": str(ROOT / "data"),
        "SESSION_COOKIE_SECURE": True,
        "SESSION_COOKIE_NAME": "__Host-idlecloud_session",
        "PUBLIC_ORIGINS": sorted(ALLOWED_ORIGINS),
        "STUDIO_ENABLED": os.environ.get("IDLECLOUD_STUDIO_ENABLED") == "1",
        "STUDIO_WEB_ORIGIN": os.environ.get("IDLECLOUD_STUDIO_WEB_ORIGIN", "http://127.0.0.1:3000"),
        "STUDIO_API_BASE": os.environ.get("IDLECLOUD_STUDIO_API_BASE", "http://127.0.0.1:8000"),
    }
    local_studio_config = ROOT / "deployment" / "studio.json"
    if local_studio_config.exists():
        # 本机部署配置只接受联动连接项，不允许覆盖数据目录与来源保护。
        saved = json.loads(local_studio_config.read_text(encoding="utf-8"))
        config.update({key: saved[key] for key in ("STUDIO_ENABLED", "STUDIO_WEB_ORIGIN", "STUDIO_API_BASE") if key in saved})
    config.update(overrides or {})
    application = create_app(config, novelai_client=novelai_client)
    public_origins = set(application.config["PUBLIC_ORIGINS"])
    application.config["ALLOWED_ORIGINS"] = public_origins
    backend_host = f'127.0.0.1:{application.config["PORT"]}'

    def strict_boundary():
        # 原版继续验证 loopback Host；这里补充完整端口及来源逐字匹配。
        if request.host != backend_host:
            raise ApiError("The Host header is not allowed.", 400, "HOST_NOT_ALLOWED")
        origin = request.headers.get("Origin")
        if origin is not None and origin not in public_origins:
            raise ApiError("The Origin header is not allowed.", 403, "ORIGIN_NOT_ALLOWED")
        # 正常外站链接可打开登录和回调文档；不放行 iframe、跨站 API 或写请求。
        entry_document = (request.method == "GET" and request.path in {"/login", "/studio/start", "/studio/callback"}
                          and request.headers.get("Sec-Fetch-Mode") == "navigate"
                          and request.headers.get("Sec-Fetch-Dest") == "document")
        if request.headers.get("Sec-Fetch-Site") == "cross-site" and not entry_document:
            raise ApiError("Cross-site requests are not allowed.", 403, "ORIGIN_NOT_ALLOWED")

    application.before_request_funcs[None].insert(0, strict_boundary)
    install_studio_bridge(application)
    return application


if __name__ == "__main__":
    from waitress import serve
    serve(create_lan_app(), host="127.0.0.1", port=46011, threads=4,
          clear_untrusted_proxy_headers=True)
