"""
Dev server — watches all .py / .html / .js / .css / .json files and
restarts server.py automatically when anything changes.
"""
import os
import subprocess
import sys
import time

WATCH_EXTS = {'.py', '.html', '.js', '.css', '.json'}
SKIP_DIRS  = {'.git', '__pycache__', 'node_modules', '.tmp.driveupload'}

def get_mtimes():
    mtimes = {}
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if any(f.endswith(ext) for ext in WATCH_EXTS):
                path = os.path.normpath(os.path.join(root, f))
                try:
                    mtimes[path] = os.path.getmtime(path)
                except OSError:
                    pass
    return mtimes


proc = None

def start():
    global proc
    proc = subprocess.Popen([sys.executable, 'server.py'])
    print('  [dev] Server started (PID %d)' % proc.pid)

def restart(reason=''):
    global proc
    if reason:
        print(f'  [dev] Changed: {reason}')
    print('  [dev] Restarting...')
    if proc:
        proc.terminate()
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    start()

print('  [dev] Watching for changes — Ctrl+C to stop\n')
start()
mtimes = get_mtimes()

try:
    while True:
        time.sleep(1)
        new_mtimes = get_mtimes()

        changed = None
        for path, mtime in new_mtimes.items():
            if mtimes.get(path) != mtime:
                changed = path
                break
        if not changed:
            for path in mtimes:
                if path not in new_mtimes:
                    changed = path + ' (deleted)'
                    break

        if changed:
            restart(changed)
            mtimes = get_mtimes()
        elif proc.poll() is not None:
            print('  [dev] Server exited unexpectedly — restarting...')
            start()
            mtimes = get_mtimes()

except KeyboardInterrupt:
    print('\n  [dev] Stopped.')
    if proc:
        proc.terminate()
