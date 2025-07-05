# Web server for VisionSuit listing available applications

from flask import Flask, render_template, redirect, url_for, flash
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

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
