import argparse
import subprocess
import shutil
from pathlib import Path
import yaml

MANIFEST_DIR = Path('manifests')
TEMP_DIR = Path('temp')


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
    if clone_dir.exists():
        print(f"{clone_dir} already exists")
    else:
        subprocess.run(['git', 'clone', repo, str(clone_dir)], check=True)

    if shutil.which('docker'):
        port = str(data.get('default_port', 3000))
        docker_tag = name.lower()

        dockerfile = clone_dir / 'Dockerfile'
        build_dir = clone_dir
        if not dockerfile.exists():
            builder = clone_dir / 'docker_setup' / 'builder.py'
            if builder.exists():
                subprocess.run(['python', str(builder), repo], check=True)
                build_dir = clone_dir / 'app'
            else:
                print('No Dockerfile or builder script found. Cannot build the app.')
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
    else:
        print('Docker not found. Cannot build or run the app.')


def main():
    parser = argparse.ArgumentParser(description='VisionSuit App Manager')
    subparsers = parser.add_subparsers(dest='command')

    subparsers.add_parser('list', help='List available apps')

    install_parser = subparsers.add_parser('install', help='Install an app from manifest')
    install_parser.add_argument('name', help='App name as defined in manifest')

    args = parser.parse_args()
    if args.command == 'list':
        list_apps()
    elif args.command == 'install':
        install_app(args.name)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
