"""制作预构建运行包：白名单收集，不读取数据、环境配置或证书目录。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import zipfile

REQUIRED_FILES = (
    'LICENSE', 'nai_flask/app.py', 'deployment/production_app.py',
    'deployment/lan_app.py', 'deployment/data_backup.py', 'deployment/verify_release.py',
    'deployment/requirements.lock.txt', 'deployment/idlecloud.service',
    'deployment/production.env.example', 'deployment/nginx-idlecloud.conf.example',
    'deployment/PRODUCTION.md', 'deployment/RELEASE-CHECKLIST.md', 'next_nai_web/out/login.html',
)
STATIC_SUFFIXES = {'.html', '.txt', '.js', '.css', '.json', '.def', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.wasm'}


def _require_regular(path):
    if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
        raise ValueError('运行包不接受链接或联接。')
    if not path.is_file():
        raise ValueError(f'运行文件缺失：{path.name}')


def package_release(source, archive):
    source, archive = Path(source), Path(archive)
    if not source.is_absolute() or not archive.is_absolute():
        raise ValueError('源码和输出路径必须为绝对路径。')
    if source.is_symlink() or getattr(source, 'is_junction', lambda: False)():
        raise ValueError('源码目录不能是链接。')
    if archive.is_symlink() or getattr(archive, 'is_junction', lambda: False)():
        raise ValueError('输出不能是链接。')
    source, archive = source.resolve(), archive.resolve()
    folders = {'nai_flask/api_utils': {'.py'}, 'next_nai_web/out': STATIC_SUFFIXES}
    if any(archive.is_relative_to(source / folder) for folder in folders):
        raise ValueError('输出不能放进打包输入目录。')
    files = {source / name for name in REQUIRED_FILES}
    for folder, suffixes in folders.items():
        directory = source / folder
        if not directory.is_dir():
            raise ValueError(f'运行目录缺失：{folder}')
        for path in [directory, *directory.rglob('*')]:
            if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
                raise ValueError('输入目录含链接或联接。')
            if path.is_file() and not any(part.startswith('.') for part in path.relative_to(directory).parts):
                if folder == 'next_nai_web/out' and path.suffix.lower() not in suffixes:
                    raise ValueError(f'未审阅的静态文件类型：{path.suffix}')
                if path.suffix.lower() in suffixes:
                    files.add(path)
    for path in files:
        _require_regular(path)
        for parent in path.parents:
            if parent == source:
                break
            if parent.is_symlink() or getattr(parent, 'is_junction', lambda: False)():
                raise ValueError('运行文件的父目录不能是链接。')
        # 固定文件的父目录也不能通过链接跳出源码目录。
        if not path.resolve().is_relative_to(source):
            raise ValueError('输入路径超出源码目录。')
    manifest = {'format': 1, 'source': 'working-tree', 'files': []}
    stamps = {}
    # 排他创建，不覆盖已有交付包；仅在内存读取当前白名单文件。
    handle = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(handle, 'wb') as output, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zipped:
        for path in sorted(files):
            before = path.stat()
            data = path.read_bytes()
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError('打包期间文件变化，请重新构建后使用新文件名打包。')
            stamps[path] = (after.st_size, after.st_mtime_ns)
            name = path.relative_to(source).as_posix()
            zipped.writestr(name, data)
            manifest['files'].append({'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        for path, stamp in stamps.items():
            current = path.stat()
            if (current.st_size, current.st_mtime_ns) != stamp:
                raise ValueError('打包期间输入变化，运行包不完整。')
        zipped.writestr('release-manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('archive')
    args = parser.parse_args()
    try:
        result = package_release(args.source, args.archive)
        print(f"运行包已创建，共 {len(result['files'])} 个文件；尚未部署。")
    except (OSError, ValueError) as error:
        parser.exit(1, f'打包失败：{error}\n失败输出可能不完整，请勿部署。\n')
