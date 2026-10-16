"""Rebuild library.json, make image thumbnails, then serve the library at http://127.0.0.1:8000"""
import json, os, pathlib, re, subprocess, sys, threading, webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

root = pathlib.Path(__file__).parent.resolve()
os.chdir(root)
thumbs = root / '.thumbs'          # hidden cache: image thumbnails (sips) + model previews (posted by the page)
IMG = {'.png', '.jpg', '.jpeg', '.webp'}

def build():
    lib = []
    for d in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith('.') and '-' in p.name):
        kind, name = d.name.split('-', 1)
        files = []
        for f in sorted(d.iterdir()):
            if not f.is_file() or f.name == '.DS_Store': continue
            e = {'n': f.name, 's': f.stat().st_size}
            if kind == 'reference' and f.suffix.lower() in IMG:   # small JPEG for the gallery grid
                t = thumbs / d.name / (f.stem + '.jpg')
                if not t.exists():
                    t.parent.mkdir(parents=True, exist_ok=True)
                    subprocess.run(['sips', '-s', 'format', 'jpeg', '-Z', '480', str(f), '--out', str(t)], capture_output=True)
                if t.exists(): e['t'] = t.relative_to(root).as_posix()
            files.append(e)
        item = {'id': d.name, 'type': kind, 'name': name, 'files': files}
        if (thumbs / f'{d.name}.jpg').exists(): item['thumb'] = f'.thumbs/{d.name}.jpg'
        lib.append(item)
    (root / 'library.json').write_text(json.dumps(lib))
    return lib

class Handler(SimpleHTTPRequestHandler):
    _left = None
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()
    def log_message(self, fmt, *a):
        if not str(a[1:2]).startswith(("('2", "('3")): super().log_message(fmt, *a)   # only log errors
    def send_head(self):                       # byte ranges so audio can seek
        rng, path = self.headers.get('Range'), self.translate_path(self.path)
        m = re.match(r'bytes=(\d*)-(\d*)', rng or '')
        if not m or not os.path.isfile(path): return super().send_head()
        size = os.path.getsize(path)
        if m[1]: a, b = int(m[1]), min(int(m[2] or size - 1), size - 1)
        else: a, b = max(size - int(m[2] or 0), 0), size - 1
        if a > b: self.send_error(416); return None
        self._left = b - a + 1
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path)); self.send_header('Content-Range', f'bytes {a}-{b}/{size}')
        self.send_header('Content-Length', str(self._left)); self.end_headers()
        f = open(path, 'rb'); f.seek(a); return f
    def copyfile(self, src, dst):
        try:
            while True:
                n = 65536 if self._left is None else min(65536, self._left)
                chunk = src.read(n) if n else b''
                if not chunk: break
                dst.write(chunk)
                if self._left is not None: self._left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError): pass
    def do_GET(self):                          # fresh index on every page load, so new previews show up
        if self.path.split('?')[0] == '/library.json': build()
        super().do_GET()
    def do_POST(self):                         # the page saves model previews here
        m = re.fullmatch(r'/thumb/([\w-]+)\.jpg', self.path)
        if not m or not (root / m[1]).is_dir(): return self.send_error(404)
        data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        thumbs.mkdir(exist_ok=True); (thumbs / f'{m[1]}.jpg').write_bytes(data)
        self.send_response(204); self.end_headers()

class Server(ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True

if __name__ == '__main__':
    print('building index (first run makes image thumbnails, ~1 min)...', flush=True)
    lib = build()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    srv = Server(('127.0.0.1', port), Handler)
    print(f'{len(lib)} items -> http://127.0.0.1:{port}  (Ctrl+C to stop)', flush=True)
    threading.Timer(.5, webbrowser.open, [f'http://127.0.0.1:{port}']).start()
    srv.serve_forever()
