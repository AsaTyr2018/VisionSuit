# Web server for VisionSuit listing available applications

from flask import Flask, render_template, redirect, url_for, flash, request
import app_manager
from pathlib import Path
import yaml

app = Flask(__name__)
app.secret_key = 'visionsuit'

MANIFEST_DIR = Path('manifests')

def load_manifests():
    apps = []
    for manifest in MANIFEST_DIR.glob('*.yaml'):
        with manifest.open() as f:
            data = yaml.safe_load(f)
        data.setdefault('name', manifest.stem)
        data['installed'] = app_manager.is_installed(data['name'])
        apps.append(data)
    return apps

@app.route('/')
def index():
    apps = load_manifests()
    return render_template('index.html', apps=apps)

@app.route('/install/<name>')
def install(name):
    try:
        app_manager.install_app(name)
        flash(f'Installed {name}', 'success')
    except Exception as e:
        flash(f'Error installing {name}: {e}', 'danger')
    return redirect(url_for('index'))

@app.route('/update/<name>')
def update(name):
    try:
        app_manager.update_app(name)
        flash(f'Updated {name}', 'success')
    except Exception as e:
        flash(f'Error updating {name}: {e}', 'danger')
    return redirect(url_for('index'))

@app.route('/remove/<name>')
def remove(name):
    try:
        app_manager.remove_app(name)
        flash(f'Removed {name}', 'success')
    except Exception as e:
        flash(f'Error removing {name}: {e}', 'danger')
    return redirect(url_for('index'))

@app.route('/open/<name>')
def open_app(name):
    manifest_path = MANIFEST_DIR / f"{name}.yaml"
    if not manifest_path.exists():
        flash(f'Manifest for {name} not found', 'danger')
        return redirect(url_for('index'))
    with manifest_path.open() as f:
        data = yaml.safe_load(f)
    port = data.get('default_port', 3000)
    host = request.host.split(':')[0]
    url = f'http://{host}:{port}'
    return redirect(url)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
