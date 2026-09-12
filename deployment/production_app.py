"""Linux 同机独立服务入口；会话在单进程内，官方请求仍由原有模式路由。"""
import os
from pathlib import Path

from lan_app import create_lan_app
from api_utils.studio_bridge import _validate_base


def server_options(environment=None):
    """限制配置范围，保留单进程；线程数不是用户数或生成并发额度。"""
    env = os.environ if environment is None else environment
    options = {}
    for key, name, default, low, high in (
        ("IDLECLOUD_THREADS", "threads", 8, 1, 64),
        ("IDLECLOUD_CONNECTION_LIMIT", "connection_limit", 100, 8, 4096),
        ("IDLECLOUD_CHANNEL_TIMEOUT", "channel_timeout", 120, 30, 600),
    ):
        try:
            value = int(env.get(key, str(default)))
        except (TypeError, ValueError):
            raise ValueError(f"{key} 必须为整数。") from None
        if not low <= value <= high:
            raise ValueError(f"{key} 超出允许范围。")
        options[name] = value
    return options


def create_production_app(environment=None):
    env = os.environ if environment is None else environment
    server_options(env)
    origin = _validate_base(env.get("IDLECLOUD_PUBLIC_ORIGIN", ""))
    studio_web = _validate_base(env.get("IDLECLOUD_STUDIO_WEB_ORIGIN", ""))
    studio_api = _validate_base(env.get("IDLECLOUD_STUDIO_API_BASE", ""), allow_local_http=True)
    data_dir = Path(env.get("IDLECLOUD_DATA_DIR", ""))
    if not data_dir.is_absolute():
        raise ValueError("IDLECLOUD_DATA_DIR 必须是绝对路径。")
    port = int(env.get("IDLECLOUD_PORT", "46011"))
    application = create_lan_app({"PORT": port, "PUBLIC_ORIGINS": [origin],
        "DATA_DIR": str(data_dir), "STUDIO_ENABLED": True,
        "STUDIO_WEB_ORIGIN": studio_web, "STUDIO_API_BASE": studio_api})

    @application.get("/healthz")
    def health():
        # 只探测本服务与静态构建，不访问 Studio 用户、官方凭据或收费接口。
        ready = (Path(application.config["FRONTEND_OUT_DIR"]) / "login.html").is_file()
        return {"status": "ready" if ready else "not_ready", "frontend": ready}, 200 if ready else 503

    return application


if __name__ == "__main__":
    from waitress import serve
    app = create_production_app()
    # 必须单进程；线程共享应用会话，不能用多个 gunicorn worker 替代。
    serve(app, host="127.0.0.1", port=app.config["PORT"], **server_options(),
          clear_untrusted_proxy_headers=True)
