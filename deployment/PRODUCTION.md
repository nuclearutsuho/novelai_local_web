# 同机独立生产服务

此方案尚未发布到生产服务器。它保留 Studio 与 Idlecloud 两个独立服务、两个 HTTPS 域名，Studio 后端继续负责用户权限、官方账号、执行队列和计费。正式发布须另行明确授权。

## 发布前条件

准备和执行的分界、环境核对表、放量与回滚条件见 [发布检查清单](RELEASE-CHECKLIST.md)。功能开发期间只维护模板，不把当前工作区或历史运行包当作最终发布版本。

- Studio 已部署同一联动版本及相应数据库迁移（授权表、工具操作表）；使用 Studio 原有迁移和发布流程，不让 Idlecloud 连接或迁移 Studio 数据库。
- 明确 Idlecloud 域名、Studio 域名和 Studio API 的本机端口。模板中的 example.com 和 8000 必须替换，不能按本地开发端口猜测生产配置。
- Studio 配置开启 `IDLECLOUD_ENABLED`，将 `https://实际Idlecloud域名/studio/callback` 加入 `IDLECLOUD_REDIRECT_URIS` 完整白名单。保留其他已批准入口；不要使用通配符。
- 备份 Studio 数据库和 Idlecloud 数据目录，记录当前两个服务的版本。确认个人用户登录、额度及模拟生成验收已完成；真实收费验收仍按单独授权执行。

## 独立目录和进程

也可从已经完成前端构建的工作区制作预构建运行包：执行 `python deployment/package_release.py <源码绝对路径> <新ZIP绝对路径>`。输出只收集后端 Python、前端 out、许可证和生产模板，不包含实际配置、数据、证书或虚拟环境；已有文件不会被覆盖。包内 `release-manifest.json` 逐文件记录大小与 SHA-256，部署前应解压到新版本目录并逐项核对。打包失败的输出不可部署。该包标识为 working-tree 快照，不冒充已提交版本；前端重新构建仍需完整源码仓库。

为服务创建专用系统用户 idlecloud，数据目录 `/var/lib/idlecloud` 仅授予该用户读写权限。每个不可变版本位于 `/opt/idlecloud/releases/<版本>`，`/opt/idlecloud/current` 指向当前版本。代码及静态构建由发布用户写入，服务用户只读。

解压前，使用可信源码目录中的校验脚本（Python 3.11 以上），执行 `python deployment/verify_release.py <ZIP路径> --sha256 <可信交付记录中的整体摘要>`。脚本只读检查文件集合、大小、逐文件摘要、重复路径与整体摘要，不解压、不启动服务。仅校验包内清单不能证明来源可信；不要使用待校验包自身提供的脚本或摘要作为信任依据。通过后才解压到全新版本目录。

在版本目录建立 Python 虚拟环境并安装 `deployment/requirements.lock.txt`。从完整源码发布时，在 `next_nai_web` 执行 `npm ci`、`npm run build`；使用已校验的预构建运行包时跳过前端构建。检查 `next_nai_web/out/login.html` 存在。构建使用仓库锁文件，不在 current 目录边服务边重新构建，避免静态导出期间出现 503。

已验证的 Python 版本为 Linux Python 3.12。服务模板固定读取 `nai_flask/.venv/bin/python`，虚拟环境须建立在这个位置，例如在版本根目录执行 `python3.12 -m venv nai_flask/.venv`，再使用该解释器安装锁定依赖。Debian/Ubuntu 若提示 ensurepip 缺失，先由运维安装匹配 Python 版本的 venv 系统包，不要误用 Windows 的 `.venv`。

把 `production.env.example` 填成 `/etc/idlecloud/production.env`，权限 0600。这里只需要服务地址和数据路径，不需要复制任何 Studio 官方 Token、密码或数据库凭据。生产入口覆盖 Windows 本地配置中的连接项。

安装 `idlecloud.service` 后使用 `systemctl daemon-reload` 和 `systemctl enable --now idlecloud`。只启动这一份进程；当前 Studio 应用 Token、PKCE 流程和独立模式会话在内存中，多进程会导致随机掉线。重启会失效本地登录，Studio 已创建的任务不会因此重发；用户重新登录后按原请求查询恢复。

## HTTPS 和健康检查

在现有 Nginx 的独立 HTTPS server 块加入 `nginx-idlecloud.conf.example`，使用正式证书。代理传递原始 Origin，不伪造允许来源；上游 Host 必须与服务实际监听端口匹配。若调整 46011，环境文件、代理与健康检查同时调整。后端只监听 loopback，不开放该端口到公网。

先运行 `nginx -t`，再按现有运维流程 reload。检查：

```sh
curl --fail http://127.0.0.1:46011/healthz
curl --fail https://实际Idlecloud域名/healthz
curl --fail https://实际Idlecloud域名/login -o /dev/null
```

healthz 只证明 Idlecloud 和前端构建就绪，不证明 Studio 可登录或官方生成成功。随后人工验证 Studio 授权往返、普通用户权限和备用官方入口显示；不要用真实生成作为无条件健康检查。日志使用 `journalctl -u idlecloud`，不得粘贴凭据或完整敏感请求内容。

## 备份与回滚

先停止 Idlecloud，再备份 `/var/lib/idlecloud`，避免 JSON 文件在写入中被复制。该目录可能含独立模式的敏感本地数据，备份继承私有权限；不要把它提交到 Git。浏览器 IndexedDB 和本地下载文件不在服务端备份内。

可使用版本内的 `deployment/data_backup.py`，参数必须为绝对路径。先创建仅运维账号可访问的备份父目录；不要使用已有备份文件名。恢复只允许写入全新目录，不能直接覆盖现用数据：

```sh
systemctl stop idlecloud
/opt/idlecloud/current/nai_flask/.venv/bin/python /opt/idlecloud/current/deployment/data_backup.py backup /var/lib/idlecloud /受保护备份目录/idlecloud-版本.zip
/opt/idlecloud/current/nai_flask/.venv/bin/python /opt/idlecloud/current/deployment/data_backup.py restore /受保护备份目录/idlecloud-版本.zip /var/lib/idlecloud-restored-版本
```

工具验证 ZIP 完整性和路径，并保留数据文件字节。失败的新建输出可能不完整，不能用于切换服务。确认恢复目录后再按现有运维流程设置服务用户权限并切换数据路径，重新启动和验证；保留旧目录作为回退依据。工具不备份 Studio 数据库，不处理浏览器缓存，也不会自动停止/启动服务。10 项合成目录测试已验证恢复一致性、不覆盖、不安全归档拒绝，以及恢复后通过生产入口重新读取用户数据和回滚数据修改。另有 7 项生产入口测试通过；未切换真实代码版本或在生产目录演练。

回滚 Idlecloud：停止服务，将 current 原子切换到已保留的上一版本，再启动并复核 healthz、登录页。数据格式向后不兼容时先额外备份当前目录，再从匹配版本的备份恢复，不能直接覆盖唯一副本。内存登录失效是预期行为。

若恢复后将 `IDLECLOUD_DATA_DIR` 改成其他目录，还须同步 systemd 的 `ReadWritePaths` 并执行 `systemctl daemon-reload`；模板只允许写入 `/var/lib/idlecloud`。新目录须授予服务用户权限，不能只修改环境文件，否则 `ProtectSystem=strict` 会阻止写入。

回滚 Studio：使用 Studio 自己的版本与数据库回滚流程；不得为回滚前端随意删除授权、任务或账本表。若要暂时关闭联动，在 Studio 关闭应用开关并移除本次批准的回调，普通 Studio 功能保持独立运行。

## 验证边界

生产入口可在隔离测试中验证 HTTPS 配置校验、Host/Origin 边界与无凭据健康探测。Linux systemd、Nginx、正式证书、生产迁移和备份恢复须在批准的目标环境完成验证；目前不据这些模板宣称已部署成功。

2026-09-12 已在独立 `python:3.12-slim` Linux 容器验证：锁定依赖完整安装，`nai_flask/tests` 全部 124 项通过；真实 Waitress 生产进程在 root 和非 root（UID/GID 65534）下均能启动，`/healthz`、`/login`、`/studio/callback`、`/main` 返回 200，外部错误 Origin 返回 403。测试使用临时数据目录，无 Studio 或官方请求。容器 Python 为 3.12.14，镜像摘要为 `sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea`。该证据覆盖 Linux Python 运行时与非 root 文件访问，不覆盖 systemd 沙箱、Nginx、证书或实际目标服务器。
