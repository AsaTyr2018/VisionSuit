import argparse
import subprocess
import shutil
import json
from pathlib import Path
import yaml
import os
import bifrost

MANIFEST_DIR = Path('manifests')
TEMP_DIR = Path('temp')
STORAGE_DIR = Path('storage')


def load_anchor(path: Path) -> dict:
    """Load anchor configuration from visionsuit-anchor file if present."""
    for name in (
        'visionsuit-anchor.yaml',
        'visionsuit-anchor.yml',
        'visionsuit-anchor.json',
    ):
        anchor = path / name
        if anchor.exists():
            with anchor.open() as f:
                if anchor.suffix in {'.yaml', '.yml'}:
                    return yaml.safe_load(f) or {}
                else:
                    return json.load(f)
    return {}


def apply_anchor(path: Path):
    """Return environment variables and package lists from anchor."""
    cfg = load_anchor(path)
    env = cfg.get('env', {}) or {}
    apt_packages = cfg.get('apt_packages', [])
    pip_packages = cfg.get('pip_packages', [])

    return env, apt_packages, pip_packages


def patch_dockerfile(dockerfile: Path, repo_dir: Path, apt: list, pip: list):
    """Inject package installation steps into the Dockerfile."""
    if not dockerfile.exists() or (not apt and not pip):
        return

    text = dockerfile.read_text()

    script = repo_dir / 'visionsuit_anchor_setup.sh'
    lines = ['#!/bin/sh', 'set -e']
    if apt:
        lines.append('apt-get update')
        lines.append('apt-get install -y $APT_PACKAGES')
        lines.append('rm -rf /var/lib/apt/lists/*')
    if pip:
        lines.append('pip install $PIP_PACKAGES')
    script.write_text('\n'.join(lines) + '\n')
    os.chmod(script, 0o755)

    df_lines = text.splitlines()

    # Remove any previously inserted anchor lines to ensure consistency
    filtered = []
    for line in df_lines:
        if 'visionsuit_anchor_setup.sh' in line:
            continue
        if line.strip().startswith('ARG APT_PACKAGES') or line.strip().startswith('ARG PIP_PACKAGES'):
            continue
        filtered.append(line)

    new_lines = []
    inserted = False
    for line in filtered:
        new_lines.append(line)
        if not inserted and line.strip().startswith('FROM'):
            new_lines.extend([
                'ARG APT_PACKAGES=""',
                'ARG PIP_PACKAGES=""',
                f'COPY {script.name} /tmp/{script.name}',
                f'RUN sh /tmp/{script.name} && rm /tmp/{script.name}'
            ])
            inserted = True

    dockerfile.write_text('\n'.join(new_lines) + '\n')

def is_installed(name: str) -> bool:
    """Return True if the app has been installed."""
    return (STORAGE_DIR / name).exists()


def list_apps():
    for manifest in MANIFEST_DIR.glob('*.yaml'):
        with manifest.open() as f:
            data = yaml.safe_load(f)
        name = data.get('name', manifest.stem)
        desc = data.get('description', '')
        print(f"{name}: {desc}")


def install_app(name):
    manifest_path = MANIFEST_DIR / f"{name}.yaml"
    if not manifest_path.exists():
        print(f"Manifest for {name} not found")
        return
    with manifest_path.open() as f:
        data = yaml.safe_load(f)
    repo = data.get('repo')
    if not repo:
        print('Repository URL missing in manifest')
        return

    clone_dir = TEMP_DIR / name
    storage_dir = STORAGE_DIR / name

    if clone_dir.exists():
        print(f"{clone_dir} already exists")
    else:
        subprocess.run(['git', 'clone', repo, str(clone_dir)], check=True)

    env_vars, apt_packages, pip_packages = apply_anchor(clone_dir)

    if shutil.which('docker'):
        port = str(data.get('default_port', 3000))
        docker_tag = name.lower()
        bifrost.ensure_bifrost()
        host_port = bifrost.pick_free_port()

        dockerfile = clone_dir / 'Dockerfile'
        build_dir = clone_dir
        if not dockerfile.exists() or not os.access(dockerfile, os.R_OK):
            builder_rel = Path('docker_setup') / 'builder.py'
            builder = clone_dir / builder_rel
            if builder.exists() and os.access(builder, os.R_OK):
                subprocess.run(['python', str(builder_rel), repo], check=True, cwd=clone_dir)
                build_dir = clone_dir / 'app'
            else:
                print('No readable Dockerfile or builder script found. Cannot build the app.')
                return

        patch_dockerfile(build_dir / 'Dockerfile', build_dir, apt_packages, pip_packages)
        build_cmd = ['docker', 'build']
        if apt_packages:
            build_cmd.extend(['--build-arg', f'APT_PACKAGES={" ".join(apt_packages)}'])
        if pip_packages:
            build_cmd.extend(['--build-arg', f'PIP_PACKAGES={" ".join(pip_packages)}'])
        build_cmd.extend(['-t', docker_tag, str(build_dir)])
        subprocess.run(build_cmd, check=True)
        cmd = [
            'docker', 'run', '-d', '--name', docker_tag,
            '--network', 'asgard',
        ]
        for k, v in env_vars.items():
            cmd.extend(['-e', f'{k}={v}'])
        cmd.extend(['-p', f'{host_port}:{port}', docker_tag])
        subprocess.run(cmd, check=True)
        bifrost.add_route(name, host_port)
        print(f"App {name} running at /{name} (port {host_port})")
        STORAGE_DIR.mkdir(exist_ok=True)
        if storage_dir.exists():
            shutil.rmtree(storage_dir)
        shutil.move(str(clone_dir), storage_dir)
        print(f"Stored app files in {storage_dir}")
    else:
        print('Docker not found. Cannot build or run the app.')


def update_app(name):
    manifest_path = MANIFEST_DIR / f"{name}.yaml"
    if not manifest_path.exists():
        print(f"Manifest for {name} not found")
        return
    storage_dir = STORAGE_DIR / name
    if not storage_dir.exists():
        print(f"{name} is not installed")
        return
    with manifest_path.open() as f:
        data = yaml.safe_load(f)
    repo = data.get('repo')
    port = str(data.get('default_port', 3000))
    docker_tag = name.lower()
    bifrost.ensure_bifrost()
    host_port = bifrost.get_route(name) or bifrost.pick_free_port()

    subprocess.run(['git', '-C', str(storage_dir), 'pull'], check=True)

    env_vars, apt_packages, pip_packages = apply_anchor(storage_dir)

    if shutil.which('docker'):
        subprocess.run(['docker', 'rm', '-f', docker_tag], check=False)

        dockerfile = storage_dir / 'Dockerfile'
        build_dir = storage_dir
        if not dockerfile.exists() or not os.access(dockerfile, os.R_OK):
            builder_rel = Path('docker_setup') / 'builder.py'
            builder = storage_dir / builder_rel
            if builder.exists() and os.access(builder, os.R_OK):
                subprocess.run(['python', str(builder_rel), repo], check=True, cwd=storage_dir)
                build_dir = storage_dir / 'app'
            else:
                print('No readable Dockerfile or builder script found. Cannot build the app.')
                return

        patch_dockerfile(build_dir / 'Dockerfile', build_dir, apt_packages, pip_packages)

        build_cmd = ['docker', 'build']
        if apt_packages:
            build_cmd.extend(['--build-arg', f'APT_PACKAGES={" ".join(apt_packages)}'])
        if pip_packages:
            build_cmd.extend(['--build-arg', f'PIP_PACKAGES={" ".join(pip_packages)}'])
        build_cmd.extend(['-t', docker_tag, str(build_dir)])
        subprocess.run(build_cmd, check=True)
        cmd = [
            'docker', 'run', '-d', '--name', docker_tag,
            '--network', 'asgard',
        ]
        for k, v in env_vars.items():
            cmd.extend(['-e', f'{k}={v}'])
        cmd.extend(['-p', f'{host_port}:{port}', docker_tag])
        subprocess.run(cmd, check=True)
        bifrost.add_route(name, host_port)
        print(f"Updated {name} running at /{name} (port {host_port})")
    else:
        print('Docker not found. Cannot build or run the app.')


def remove_app(name):
    storage_dir = STORAGE_DIR / name
    docker_tag = name.lower()

    if shutil.which('docker'):
        subprocess.run(['docker', 'rm', '-f', docker_tag], check=False)
    bifrost.remove_route(name)

    if storage_dir.exists():
        shutil.rmtree(storage_dir)
        print(f"Removed storage for {name}")


def main():
    parser = argparse.ArgumentParser(description='VisionSuit App Manager')
    subparsers = parser.add_subparsers(dest='command')

    subparsers.add_parser('list', help='List available apps')

    install_parser = subparsers.add_parser('install', help='Install an app from manifest')
    install_parser.add_argument('name', help='App name as defined in manifest')

    update_parser = subparsers.add_parser('update', help='Update an installed app')
    update_parser.add_argument('name', help='App name as defined in manifest')

    remove_parser = subparsers.add_parser('remove', help='Remove an installed app')
    remove_parser.add_argument('name', help='App name as defined in manifest')

    args = parser.parse_args()
    if args.command == 'list':
        list_apps()
    elif args.command == 'install':
        install_app(args.name)
    elif args.command == 'update':
        update_app(args.name)
    elif args.command == 'remove':
        remove_app(args.name)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
