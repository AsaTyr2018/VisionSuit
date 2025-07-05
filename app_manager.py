import argparse
import subprocess
import shutil
from pathlib import Path
import yaml
import os

MANIFEST_DIR = Path('manifests')
TEMP_DIR = Path('temp')
STORAGE_DIR = Path('storage')

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

    if shutil.which('docker'):
        port = str(data.get('default_port', 3000))
        docker_tag = name.lower()

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

        subprocess.run(['docker', 'build', '-t', docker_tag, str(build_dir)], check=True)
        subprocess.run([
            'docker',
            'run',
            '-d',
            '--name', docker_tag,
            '-p', f'{port}:{port}',
            docker_tag,
        ], check=True)
        print(f"App {name} running at /{name} (port {port})")
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

    subprocess.run(['git', '-C', str(storage_dir), 'pull'], check=True)

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

        subprocess.run(['docker', 'build', '-t', docker_tag, str(build_dir)], check=True)
        subprocess.run([
            'docker',
            'run',
            '-d',
            '--name', docker_tag,
            '-p', f'{port}:{port}',
            docker_tag,
        ], check=True)
        print(f"Updated {name} running at /{name} (port {port})")
    else:
        print('Docker not found. Cannot build or run the app.')


def remove_app(name):
    storage_dir = STORAGE_DIR / name
    docker_tag = name.lower()

    if shutil.which('docker'):
        subprocess.run(['docker', 'rm', '-f', docker_tag], check=False)

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
