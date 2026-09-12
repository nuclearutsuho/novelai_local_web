"""只用合成源码目录验证运行包内容与私有配置排除。"""
import hashlib
import json
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'deployment'))
from package_release import REQUIRED_FILES, package_release
from verify_release import verify_release


def source_tree(tmp_path):
    source = tmp_path / 'source'
    for name in [*REQUIRED_FILES, 'nai_flask/api_utils/client.py', 'next_nai_web/out/_next/static/app.js', 'next_nai_web/out/tokenizer.def']:
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('synthetic runtime', encoding='utf-8')
    return source


def test_runtime_manifest_matches_bytes_and_excludes_private_paths(tmp_path):
    source = source_tree(tmp_path)
    for name in ['data/session.json', '.env', 'deployment/studio.json', 'deployment/processes.json', 'deployment/pki/key.pem', 'nai_flask/.venv/private.py', 'next_nai_web/out/.env']:
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('test-secret-not-for-release')
    archive = tmp_path / 'release.zip'
    manifest = package_release(source, archive)
    with zipfile.ZipFile(archive) as zipped:
        assert 'next_nai_web/out/tokenizer.def' in zipped.namelist()
        assert json.loads(zipped.read('release-manifest.json')) == manifest
        assert len(zipped.namelist()) == len(manifest['files']) + 1
        for entry in manifest['files']:
            data = zipped.read(entry['path'])
            assert b'test-secret' not in data
            assert len(data) == entry['size']
            assert hashlib.sha256(data).hexdigest() == entry['sha256']
    with pytest.raises(FileExistsError):
        package_release(source, archive)


def test_missing_build_or_output_in_runtime_tree_is_rejected(tmp_path):
    source = source_tree(tmp_path)
    with pytest.raises(ValueError):
        package_release(source, source / 'next_nai_web/out/release.zip')
    (source / 'next_nai_web/out/login.html').unlink()
    archive = tmp_path / 'missing.zip'
    with pytest.raises(ValueError):
        package_release(source, archive)
    assert not archive.exists()


def test_unknown_static_format_is_not_silently_omitted(tmp_path):
    source = source_tree(tmp_path)
    (source / 'next_nai_web/out/new-format.custom').write_bytes(b'asset')
    with pytest.raises(ValueError):
        package_release(source, tmp_path / 'unknown.zip')


def test_verifier_accepts_package_and_checks_external_digest(tmp_path):
    archive = tmp_path / 'release.zip'
    manifest = package_release(source_tree(tmp_path), archive)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert verify_release(archive, digest) == {'files': len(manifest['files']), 'sha256': digest}
    with pytest.raises(ValueError, match='整体'):
        verify_release(archive, '0' * 64)


@pytest.mark.parametrize('change', ['content', 'missing', 'extra', 'duplicate', 'unsafe', 'size', 'bad_record'])
def test_verifier_rejects_changed_or_unsafe_archive(tmp_path, change):
    original = tmp_path / 'original.zip'
    package_release(source_tree(tmp_path), original)
    with zipfile.ZipFile(original) as zipped:
        entries = {name: zipped.read(name) for name in zipped.namelist()}
    manifest = json.loads(entries['release-manifest.json'])
    name = manifest['files'][0]['path']
    if change == 'content':
        entries[name] = b'x' * len(entries[name])
    elif change == 'missing':
        del entries[name]
    elif change == 'extra':
        entries['unexpected.txt'] = b'extra'
    elif change == 'unsafe':
        entries['../outside.txt'] = b'unsafe'
    elif change == 'size':
        manifest['files'][0]['size'] += 1
    elif change == 'bad_record':
        manifest['files'][0] = None
    entries['release-manifest.json'] = json.dumps(manifest).encode()
    broken = tmp_path / 'broken.zip'
    with zipfile.ZipFile(broken, 'w') as zipped:
        for path, data in entries.items():
            zipped.writestr(path, data)
        if change == 'duplicate':
            # 不同大小写的同名条目在 Windows 上会覆盖彼此。
            zipped.writestr(name.upper(), entries[name])
    with pytest.raises(ValueError):
        verify_release(broken)
