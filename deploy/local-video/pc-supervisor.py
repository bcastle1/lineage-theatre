"""Restart the dedicated loopback ComfyUI service and outbound PC worker."""
import json
import os
import subprocess
import time
from pathlib import Path
from filelock import FileLock, Timeout

ROOT = Path(__file__).resolve().parent.parent
PYTHON = ROOT / 'venv/Scripts/python.exe'
LOGS = ROOT / 'logs'
LOGS.mkdir(exist_ok=True)


def launch(name, args, cwd, env):
    path = LOGS / (name + '.log')
    if path.exists() and path.stat().st_size > 5 * 1024**2:
        path.replace(LOGS / (name + '.previous.log'))
    with path.open('ab', buffering=0) as log:
        return subprocess.Popen([str(PYTHON), '-X', 'utf8', '-u', *args], cwd=str(cwd), env=env,
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)


def main():
    env = os.environ.copy()
    settings = json.loads((ROOT / 'worker-settings.json').read_text())
    if settings.get('LINEAGE_VIDEO_ORIGIN') != 'https://www.lineagetheater.com' or len(settings.get('LINEAGE_AI_VIDEO_WORKER_KEY', '')) < 40:
        raise RuntimeError('The PC worker configuration is incomplete')
    env.update({key: settings[key] for key in ('LINEAGE_VIDEO_ORIGIN', 'LINEAGE_AI_VIDEO_WORKER_KEY')})
    env['LINEAGE_VIDEO_ENGINE'] = 'ltx'
    env['LINEAGE_COMFY_ROOT'] = str(ROOT / 'ComfyUI')
    env['LINEAGE_NODE_PATH'] = str(ROOT / 'worker/node.exe')
    comfy_env = os.environ.copy()  # The renderer does not receive the website worker credential.
    processes = {}
    commands = {
        'comfy': (['main.py', '--listen', '127.0.0.1', '--port', '8189', '--disable-auto-launch', '--disable-api-nodes',
            '--cache-none', '--fast-disk', '--disable-pinned-memory', '--vram-headroom', '2'], ROOT / 'ComfyUI', comfy_env),
        'worker': (['local-video-worker.py'], ROOT / 'worker', env),
    }
    try:
        while True:
            for name, (args, cwd, child_env) in commands.items():
                child = processes.get(name)
                if child is None or child.poll() is not None:
                    processes[name] = launch(name, args, cwd, child_env)
                    (ROOT / (name + '.pid')).write_text(str(processes[name].pid))
            time.sleep(20)
    finally:
        for child in processes.values():
            if child.poll() is None:
                child.terminate()
        for child in processes.values():
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.kill()


if __name__ == '__main__':
    try:
        with FileLock(str(ROOT / 'supervisor.lock'), timeout=0):
            main()
    except Timeout:
        pass  # A registered instance is already supervising these services.
