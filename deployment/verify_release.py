"""只读检查运行包清单和文件摘要，不解压或启动服务。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import zipfile


def _safe_name(name):
    # 同时拒绝 Windows 和 POSIX 上可能改变解压位置的名称。
    return (isinstance(name, str) and bool(name)
            and not any(char in name for char in '\\:\x00')
            and all(part not in ('', '.', '..') and not part.endswith((' ', '.'))
                    for part in name.split('/')))


def verify_release(archive, expected_sha256=None):
    with Path(archive).open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
        if expected_sha256 is not None and (
                not re.fullmatch('[0-9a-fA-F]{64}', expected_sha256)
                or digest != expected_sha256.lower()):
            raise ValueError('运行包整体 SHA-256 不匹配。')
        handle.seek(0)
        with zipfile.ZipFile(handle) as zipped:
            infos = zipped.infolist()
            names = [entry.filename for entry in infos]
            if len({name.casefold() for name in names}) != len(names):
                raise ValueError('归档存在重复或大小写冲突路径。')
            for entry in infos:
                mode = entry.external_attr >> 16
                if (not _safe_name(entry.filename) or entry.is_dir()
                        or stat.S_IFMT(mode) not in (0, stat.S_IFREG)):
                    raise ValueError('归档包含不安全路径或非普通文件。')
            if 'release-manifest.json' not in names:
                raise ValueError('运行包缺少清单。')
            if zipped.getinfo('release-manifest.json').file_size > 4 * 1024 * 1024:
                raise ValueError('清单过大。')
            manifest = json.loads(zipped.read('release-manifest.json'))
            if (not isinstance(manifest, dict) or manifest.get('format') != 1
                    or not isinstance(manifest.get('files'), list)):
                raise ValueError('不支持的清单格式。')
            declared = {}
            for item in manifest['files']:
                if (not isinstance(item, dict) or not _safe_name(item.get('path'))
                        or type(item.get('size')) is not int or item['size'] < 0
                        or not isinstance(item.get('sha256'), str)
                        or not re.fullmatch('[0-9a-f]{64}', item['sha256'])):
                    raise ValueError('清单文件记录无效。')
                name = item['path']
                if name in declared or name == 'release-manifest.json':
                    raise ValueError('清单包含重复文件。')
                declared[name] = item
            if set(names) != set(declared) | {'release-manifest.json'}:
                raise ValueError('清单与归档文件集合不一致。')
            for name, item in declared.items():
                if zipped.getinfo(name).file_size != item['size']:
                    raise ValueError(f'文件大小不匹配：{name}')
                # 分块读取，避免把大型静态资源同时加载进内存。
                with zipped.open(name) as content:
                    actual = hashlib.file_digest(content, 'sha256').hexdigest()
                if actual != item['sha256']:
                    raise ValueError(f'文件摘要不匹配：{name}')
    return {'files': len(declared), 'sha256': digest}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive')
    parser.add_argument('--sha256', help='从可信交付记录取得的整体 SHA-256')
    args = parser.parse_args()
    try:
        result = verify_release(args.archive, args.sha256)
        print(f"校验通过：{result['files']} 个文件；SHA-256 {result['sha256']}。尚未部署。")
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
        parser.exit(1, f'校验失败：{error}\n请勿部署此运行包。\n')
