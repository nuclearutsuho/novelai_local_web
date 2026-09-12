"""只使用合成目录检验完整性和不覆盖边界。"""
import stat
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deployment"))
from data_backup import backup_data, restore_data


def test_backup_restore_preserves_separate_users_and_binary_bytes(tmp_path):
    source = tmp_path / "source"
    for name, content in {"studio/1/notes.json": b'{"text":"user-one"}',
                          "studio/2/notes.json": b'{"text":"user-two"}',
                          "settings.json": b'{"theme":"dark"}', "nested/data.bin": bytes(range(256))}.items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    archive = tmp_path / "backup.zip"
    destination = tmp_path / "restored"
    assert backup_data(source, archive) == 4
    assert restore_data(archive, destination) == 4
    for path in source.rglob("*"):
        if path.is_file():
            assert (destination / path.relative_to(source)).read_bytes() == path.read_bytes()
    with pytest.raises(ValueError):
        restore_data(archive, source)
    with pytest.raises(FileExistsError):
        backup_data(source, archive)


@pytest.mark.parametrize("name", ["../outside", "/absolute", "C:/outside", "folder\\escape", "NUL.txt", "trailing. "])
def test_restore_rejects_unsafe_paths_before_creating_destination(tmp_path, name):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.writestr(name, b"test")
    if "\\" in name:
        # Windows ZIP 写入会规范化分隔符，手工构造归档中的原始不安全名称。
        archive.write_bytes(archive.read_bytes().replace(name.replace("\\", "/").encode(), name.encode()))
    destination = tmp_path / "restored"
    with pytest.raises(ValueError):
        restore_data(archive, destination)
    assert not destination.exists()


def test_restore_rejects_archive_symlinks(tmp_path):
    archive = tmp_path / "link.zip"
    entry = zipfile.ZipInfo("link")
    entry.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.writestr(entry, "../outside")
    with pytest.raises(ValueError):
        restore_data(archive, tmp_path / "restored")


def test_backup_cannot_be_written_inside_source(tmp_path):
    with pytest.raises(ValueError):
        backup_data(tmp_path, tmp_path / "recursive.zip")


def test_restored_production_app_loads_user_data_and_backup_can_roll_back_edits(tmp_path):
    from production_app import create_production_app
    from api_utils.local_store import LocalJsonStore
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "login.html").write_text("synthetic frontend", encoding="utf-8")

    def open_app(directory):
        app = create_production_app({"IDLECLOUD_PUBLIC_ORIGIN": "https://idlecloud.example.com",
            "IDLECLOUD_STUDIO_WEB_ORIGIN": "https://studio.example.com",
            "IDLECLOUD_STUDIO_API_BASE": "http://127.0.0.1:8000", "IDLECLOUD_DATA_DIR": str(directory)})
        app.config["FRONTEND_OUT_DIR"] = str(frontend)
        return app

    source = tmp_path / "original"
    original = open_app(source)
    original.extensions["local_store"].write("settings", {"language": "zh-CN"})
    for user_id in (1, 2):
        LocalJsonStore(source / "studio" / str(user_id)).write("notes", [
            {"id": f"note-{user_id}", "title": f"用户{user_id}", "content": f"合成笔记{user_id}"}])
    archive = tmp_path / "snapshot.zip"
    backup_data(source, archive)

    restored = tmp_path / "restored"
    restore_data(archive, restored)
    application = open_app(restored)
    assert application.extensions["local_store"].read("settings") == {"language": "zh-CN"}
    for user_id in (1, 2):
        notes = LocalJsonStore(restored / "studio" / str(user_id)).read("notes")
        assert notes[0]["content"] == f"合成笔记{user_id}"
    assert application.test_client().get("/healthz", base_url="http://127.0.0.1:46011").status_code == 200
    assert application.extensions["local_sessions"] == {}

    # 模拟升级后的数据修改；回滚仍恢复到新目录，不覆盖当前实例或唯一备份。
    application.extensions["local_store"].write("settings", {"language": "en-US"})
    rollback = tmp_path / "rollback"
    restore_data(archive, rollback)
    rolled_back = open_app(rollback)
    assert rolled_back.extensions["local_store"].read("settings") == {"language": "zh-CN"}
    assert application.extensions["local_store"].read("settings") == {"language": "en-US"}
    assert original.extensions["local_store"].read("settings") == {"language": "zh-CN"}
