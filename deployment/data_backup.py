"""离线数据备份与恢复。调用前停止服务；恢复只允许创建新目录。"""
import argparse
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import zipfile


def _absolute(value):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("请使用绝对路径。")
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        raise ValueError("不接受链接或联接目录。")
    return path.resolve()


def backup_data(source, archive):
    source, archive = _absolute(source), _absolute(archive)
    if not source.is_dir() or archive.is_relative_to(source):
        raise ValueError("源必须为目录，备份文件必须位于源目录之外。")
    files = sorted(source.rglob("*"))
    for path in files:
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise ValueError("源目录含链接，未创建备份。")
        if not path.is_dir() and not path.is_file():
            raise ValueError("源目录含非常规文件，未创建备份。")
    # 排他创建，不覆盖旧备份；Unix 上从创建时即采用私有权限。
    handle = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(handle, "wb") as output, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zipped:
        for path in files:
            zipped.write(path, path.relative_to(source).as_posix())
    return sum(path.is_file() for path in files)


def restore_data(archive, destination):
    archive, destination = _absolute(archive), _absolute(destination)
    if destination.exists():
        raise ValueError("恢复目标已存在；请指定一个全新目录。")
    with zipfile.ZipFile(archive) as zipped:
        names = set()
        entries = zipped.infolist()
        for entry in entries:
            # orig_filename 保留 ZIP 中的原始拼写，避免 Windows 自动规范化掩盖反斜杠。
            name = entry.orig_filename
            path = PurePosixPath(name)
            mode = entry.external_attr >> 16
            reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
            if (not name or "\x00" in name or path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name
                    or any(part.rstrip(" .") != part or part.split(".")[0].upper() in reserved for part in path.parts)
                    or stat.S_ISLNK(mode) or name.casefold() in names):
                raise ValueError("备份包含不安全或重复的路径。")
            names.add(name.casefold())
        if zipped.testzip() is not None:
            raise ValueError("备份完整性检查失败，未恢复数据。")
        if sum(entry.file_size for entry in entries) > shutil.disk_usage(destination.parent).free:
            raise ValueError("目标磁盘空间不足。")
        destination.mkdir(mode=0o700)
        for entry in entries:
            target = destination / entry.filename
            if not target.resolve().is_relative_to(destination):
                raise ValueError("恢复路径超出目标目录。")
            if entry.is_dir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            handle = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with zipped.open(entry) as source, os.fdopen(handle, "wb") as output:
                shutil.copyfileobj(source, output)
    return sum(not entry.is_dir() for entry in entries)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("backup", "restore"))
    parser.add_argument("source")
    parser.add_argument("destination")
    args = parser.parse_args()
    try:
        count = (backup_data if args.action == "backup" else restore_data)(args.source, args.destination)
    except Exception:
        # 不把数据内容或内部异常原文写入终端；失败的新文件/目录不得当作完整备份使用。
        parser.exit(1, "操作失败：请检查路径、权限、空间和归档完整性；本次新建输出可能不完整，原数据未覆盖。\n")
    print(f"操作完成，共 {count} 个文件。")
