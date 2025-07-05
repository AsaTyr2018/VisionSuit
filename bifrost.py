import json
import subprocess
import socket
from pathlib import Path

ROUTE_FILE = Path('bifrost_routes.json')
CONF_DIR = Path('bifrost_conf')
CONF_FILE = CONF_DIR / 'default.conf'


def ensure_network(name: str):
    """Create the Docker network if it doesn't exist."""
    result = subprocess.run(['docker', 'network', 'inspect', name],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode != 0:
        subprocess.run(['docker', 'network', 'create', name], check=True)


def ensure_bifrost():
    """Ensure Bifrost container and networks are running."""
    ensure_network('asgard')
    ensure_network('midgard')
    ROUTE_FILE.touch(exist_ok=True)
    CONF_DIR.mkdir(exist_ok=True)
    regenerate_config()

    inspect = subprocess.run(['docker', 'inspect', 'bifrost'],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if inspect.returncode != 0:
        subprocess.run([
            'docker', 'run', '-d', '--name', 'bifrost',
            '-p', '80:80',
            '--network', 'midgard',
            '--add-host=host.docker.internal:host-gateway',
            '-v', f'{CONF_FILE.absolute()}:/etc/nginx/conf.d/default.conf:ro',
            'nginx:alpine'
        ], check=True)
        subprocess.run(['docker', 'network', 'connect', 'asgard', 'bifrost'], check=True)
    else:
        state = subprocess.run(['docker', 'inspect', '-f', '{{.State.Running}}', 'bifrost'],
                               capture_output=True, text=True)
        if 'false' in state.stdout:
            subprocess.run(['docker', 'start', 'bifrost'], check=True)
        reload_bifrost()


def load_routes() -> dict:
    try:
        return json.loads(ROUTE_FILE.read_text())
    except Exception:
        return {}


def save_routes(routes: dict):
    ROUTE_FILE.write_text(json.dumps(routes))


def regenerate_config():
    routes = load_routes()
    lines = [
        'server {',
        '    listen 80;',
        '    server_name _;'
    ]
    for app, port in routes.items():
        lines.extend([
            f'    location /{app}/ {{',
            f'        proxy_pass http://host.docker.internal:{port}/;',
            '        proxy_set_header Host $host;',
            '        proxy_set_header X-Real-IP $remote_addr;',
            '    }'
        ])
    lines.append('}')
    CONF_FILE.write_text('\n'.join(lines))


def reload_bifrost():
    regenerate_config()
    subprocess.run(['docker', 'cp', str(CONF_FILE), 'bifrost:/etc/nginx/conf.d/default.conf'], check=False)
    subprocess.run(['docker', 'exec', 'bifrost', 'nginx', '-s', 'reload'], check=False)


def add_route(app: str, port: int):
    routes = load_routes()
    routes[app] = port
    save_routes(routes)
    reload_bifrost()


def remove_route(app: str):
    routes = load_routes()
    if app in routes:
        routes.pop(app)
        save_routes(routes)
        reload_bifrost()


def get_route(app: str):
    routes = load_routes()
    return routes.get(app)


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]
