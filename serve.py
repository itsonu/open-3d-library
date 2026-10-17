#!/usr/bin/env python3
"""Optional local library server: serves the built app (./dist) and a private asset folder.

  python3 serve.py [--assets DIR]... [--local-assets DIR]... [--port 8000] [--host 127.0.0.1] [--no-browser]

/ -> dist/   /assets/ -> the asset folders   /catalog.json -> generated from the asset folders
--assets and --local-assets can be repeated; the catalogue is the items of every root in order (the first root wins on a duplicate id,
with a warning). Items from --local-assets get "collection": "local"; --write-catalog never includes them (private, never published).
/assets/<id>/... and the thumbnails of <id> resolve inside the one root that owns <id>.
Asset folders are named <type>-<name>; optional adult.json (list of ids), fixes.json (id -> texture overrides)
and per-folder meta.json (name, description, license, source, author, tags, sensitive, textureOverrides) are merged in.
Only files inside dist/ and the owning asset folder are served (real paths, so symlinks cannot escape); dotfiles are never served,
except thumbnails under <assets>/.thumbs/.
"""
import argparse, json, os, re, shutil, socket, subprocess, sys, tempfile, threading, time, webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

HERE = Path(__file__).resolve().parent
IMG = {'.png', '.jpg', '.jpeg', '.webp'}
META_KEYS = {'name': str, 'description': str, 'license': str, 'source': str, 'author': str, 'tags': list, 'textureOverrides': dict}
THUMB_RE = re.compile(r'\.thumbs/([^/.][^/]*/)?[^/.][^/]*\.jpg')      # the only dot-path served: .thumbs/<id>.jpg and .thumbs/<folder>/<image>.jpg
MAX_THUMB = 2 << 20
LOOPBACK = {'localhost', '127.0.0.1', '::1'}


def read_json(p, default):
    try: return json.loads(p.read_text(encoding='utf-8'))
    except (OSError, ValueError): return default


def inside(p, root):
    try: return p.resolve().is_relative_to(root)
    except (OSError, ValueError): return False


def item_dir(root, name):
    """root/name if it is an asset folder (<type>-<name>, no dotfiles, real path inside root), else None."""
    d = root / name
    return d if '-' in name and not name.startswith('.') and d.is_dir() and inside(d, root) else None


class Catalog:
    """catalog.json for the asset roots [(path, is_local)], cached; rebuilt when a root's mtime changes or after 5 s."""
    def __init__(self, roots):
        self.roots, self.lock, self.stamp, self.body, self.warned = roots, threading.Lock(), None, b'{"items":[]}', set()

    def invalidate(self): self.stamp = None

    def get(self):
        with self.lock:
            mt = []
            for r, _ in self.roots:
                try: mt.append(r.stat().st_mtime_ns)
                except OSError: mt.append(None)
            now = time.monotonic()
            if self.stamp is None or self.stamp[0] != mt or now - self.stamp[1] > 5:
                self.body, self.stamp = json.dumps({'items': self.build()}).encode(), (mt, now)
            return self.body

    def build(self):
        items, seen = [], {}
        for root, local in self.roots:
            for it in self.build_root(root, local):
                if it['id'] in seen:
                    if (it['id'], str(root)) not in self.warned:
                        self.warned.add((it['id'], str(root))); print(f"warning: duplicate id {it['id']} in {root} ignored (first root {seen[it['id']]} wins)", file=sys.stderr, flush=True)
                    continue
                seen[it['id']] = root; items.append(it)
        return items

    @staticmethod
    def build_root(root, local=False):
        if not root.is_dir(): return []
        adult = read_json(root / 'adult.json', [])
        fixes = read_json(root / 'fixes.json', {})
        thumbs = root / '.thumbs'
        items = []
        for d in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith('.') and '-' in p.name and inside(p, root)):
            kind, name = d.name.split('-', 1)
            files = []
            for f in sorted(d.iterdir()):
                if f.name.startswith('.') or f.name == 'meta.json' or not f.is_file() or not inside(f, root): continue
                e = {'n': f.name, 's': f.stat().st_size}
                if kind == 'reference' and f.suffix.lower() in IMG:   # small JPEG for the gallery grid (macOS sips only, else the app uses the full image)
                    t = thumbs / d.name / (f.stem + '.jpg')
                    if not t.exists() and shutil.which('sips') and not thumbs.is_symlink():
                        t.parent.mkdir(parents=True, exist_ok=True)
                        subprocess.run(['sips', '-s', 'format', 'jpeg', '-Z', '480', str(f), '--out', str(t)], capture_output=True)
                    if t.is_file(): e['t'] = 'assets/.thumbs/' + quote(f'{d.name}/{t.name}')
                files.append(e)
            item = {'id': d.name, 'type': kind, 'name': name, 'files': files}
            if local: item['collection'] = 'local'
            meta = read_json(d / 'meta.json', {})
            if not isinstance(meta, dict): meta = {}
            for k, typ in META_KEYS.items():
                if isinstance(meta.get(k), typ): item[k] = meta[k]
            fx = fixes.get(d.name) if isinstance(fixes, dict) else None
            tex = {**(fx if isinstance(fx, dict) else {}), **item.get('textureOverrides', {})}
            if tex: item['textureOverrides'] = tex
            if (isinstance(adult, list) and d.name in adult) or meta.get('sensitive') is True: item['sensitive'] = True
            if (thumbs / f'{d.name}.jpg').is_file() and inside(thumbs / f'{d.name}.jpg', root): item['thumb'] = f'assets/.thumbs/{quote(d.name)}.jpg'
            items.append(item)
        return items


def parse_range(h, size):
    """-> None (no/ignored Range header), 'bad' (unsatisfiable) or (first, last). Single ranges only."""
    m = re.fullmatch(r'bytes=(\d*)-(\d*)', (h or '').strip())
    if not m or not (m[1] or m[2]): return None            # absent, multi-range or malformed: serve the whole file
    if m[1]:
        a = int(m[1])
        if m[2] and int(m[2]) < a: return None
        return 'bad' if a >= size else (a, min(int(m[2]), size - 1) if m[2] else size - 1)
    n = int(m[2])                                           # suffix range: last n bytes
    return 'bad' if n == 0 or size == 0 else (max(size - n, 0), size - 1)


class Handler(SimpleHTTPRequestHandler):
    timeout = 30
    server_version = 'o3dl'

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); self.send_header('Accept-Ranges', 'bytes'); self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def log_request(self, code='-', size='-'):                # only log errors
        if int(code) >= 400: super().log_request(code, size)

    def host_ok(self):
        return self.server.hosts is None or (self.headers.get('Host') or '').lower() in self.server.hosts

    def reject(self, code, msg=None):
        try: n = int(self.headers.get('Content-Length', 0))
        except ValueError: n = 0
        if 0 < n <= 16 << 20:                                  # drain the body so the client sees the reply instead of a reset
            try: self.rfile.read(n)
            except OSError: pass
        self.send_error(code, msg)

    def resolve(self):
        """URL path -> real file under dist/ or the asset root that owns the id, else None."""
        path = unquote(urlsplit(self.path).path)
        if '\0' in path or '\\' in path: return None
        parts = [p for p in path.split('/') if p]
        if any(p in ('.', '..') for p in parts): return None
        assets = bool(parts) and parts[0] == 'assets'
        if assets: parts = parts[1:]
        if any(p.startswith('.') for p in parts) and not (assets and THUMB_RE.fullmatch('/'.join(parts))): return None
        if assets:
            if parts[:1] == ['.thumbs'] and len(parts) > 1:      # thumbnails live in the root that owns the id
                base = self.server.owner(parts[1][:-4] if len(parts) == 2 else parts[1])
            else: base = self.server.owner(parts[0]) if parts else None
            if not base: return None
        else: base = self.server.dist
        try:
            p = base.joinpath(*parts)
            if p.is_dir() and not assets: p = p / 'index.html'      # no directory listings; dist directories serve their index
            p = p.resolve()
        except (OSError, ValueError): return None
        return p if p.is_relative_to(base) and p.is_file() else None

    def do_HEAD(self): self.do_GET(True)

    def do_GET(self, head=False):
        if not self.host_ok(): return self.send_error(403, 'Bad Host header')
        if urlsplit(self.path).path == '/catalog.json':
            data = self.server.catalog.get()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers()
            if not head: self.wfile.write(data)
            return
        p = self.resolve()
        if not p: return self.send_error(404, 'Not found' + ('' if self.server.dist.is_dir() else ' (dist/ is missing: run `npm run build`)'))
        try: f = open(p, 'rb')
        except OSError: return self.send_error(404)
        with f:
            size = os.fstat(f.fileno()).st_size
            r = parse_range(self.headers.get('Range'), size)
            if r == 'bad':
                self.send_response(416); self.send_header('Content-Range', f'bytes */{size}'); self.send_header('Content-Length', '0'); return self.end_headers()
            a, b = r or (0, size - 1)
            self.send_response(206 if r else 200)
            self.send_header('Content-Type', self.guess_type(str(p)))
            if r: self.send_header('Content-Range', f'bytes {a}-{b}/{size}')
            self.send_header('Content-Length', str(max(b - a + 1, 0))); self.end_headers()
            if head or not size: return
            f.seek(a); left = b - a + 1
            try:
                while left > 0:
                    chunk = f.read(min(65536, left))
                    if not chunk: break
                    self.wfile.write(chunk); left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError): pass

    def do_POST(self):                                         # the page saves model previews here: POST /thumb/<id>.jpg
        if not self.host_ok(): return self.reject(403, 'Bad Host header')
        if self.headers.get('X-O3DL') != '1': return self.reject(403, 'Missing X-O3DL header')   # custom header: plain cross-site form posts cannot send it
        m = re.fullmatch(r'/thumb/([A-Za-z0-9_-]+)\.jpg', self.path)
        assets = m and self.server.owner(m[1])
        if not assets: return self.reject(404)
        cl = self.headers.get('Content-Length')
        if cl is None: return self.send_error(411)
        if not re.fullmatch(r'\d+', cl.strip()): return self.send_error(400, 'Bad Content-Length')
        n = int(cl)
        if n > MAX_THUMB: return self.reject(413)
        data = self.rfile.read(n)
        if len(data) != n: return self.send_error(400, 'Short body')
        if data[:3] != b'\xff\xd8\xff': return self.send_error(415, 'Not a JPEG')
        tdir = assets / '.thumbs'; dest = tdir / f'{m[1]}.jpg'
        if tdir.is_symlink() or dest.is_symlink(): return self.send_error(403, 'Refusing to write through a symlink')
        tdir.mkdir(exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=tdir, suffix='.tmp')
        try:
            with os.fdopen(fd, 'wb') as f: f.write(data)
            os.replace(tmp, dest)                              # atomic; replaces a link at dest rather than following it
        except BaseException:
            try: os.unlink(tmp)
            except OSError: pass
            raise
        self.server.catalog.invalidate()
        self.send_response(204); self.end_headers()


class Server(ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True

    def owner(self, id):
        """The first root that has an asset folder <id>, else None."""
        return next((r for r, _ in self.roots if item_dir(r, id)), None)


def make_server(dist, assets, host='127.0.0.1', port=8000, check_host=True, local=()):
    """assets / local: one folder or a list of folders; local ones are private (items get collection: local)."""
    one = lambda x: [x] if isinstance(x, (str, Path)) else list(x)
    Server.address_family = socket.AF_INET6 if ':' in host else socket.AF_INET
    srv = Server((host, port), Handler)
    srv.dist = Path(dist).resolve()
    srv.roots = [(Path(r).resolve(), False) for r in one(assets)] + [(Path(r).resolve(), True) for r in one(local)]
    srv.catalog = Catalog(srv.roots)
    p = srv.server_address[1]
    names = ('localhost', '127.0.0.1', '[::1]')            # DNS-rebinding protection: only loopback names are accepted as Host
    srv.hosts = ({f'{h}:{p}' for h in names} | (set(names) if p == 80 else set())) if check_host else None
    return srv


def main():
    ap = argparse.ArgumentParser(description='Serve the built app and a private asset folder.')
    ap.add_argument('--assets', action='append', help='asset folder, repeatable (default: ./public/assets)')
    ap.add_argument('--local-assets', action='append', default=[], metavar='DIR', help='private asset folder, repeatable: items get collection "local", never written to the catalog file')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--dist', default=str(HERE / 'dist'), help=argparse.SUPPRESS)
    ap.add_argument('--write-catalog', metavar='FILE', help='write the catalog of --assets to FILE and exit (used for public/catalog.json)')
    a = ap.parse_args()
    a.assets = a.assets or [str(HERE / 'public' / 'assets')]
    if a.write_catalog:
        items = Catalog([(Path(r).resolve(), False) for r in a.assets]).build()      # public roots only: --local-assets is never published
        Path(a.write_catalog).write_text(json.dumps({'items': items}, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
        return print(f'{len(items)} items -> {a.write_catalog}')
    if not Path(a.dist).is_dir(): print('dist/ not found: run `npm run build` first (until then only /assets/ and /catalog.json work).', file=sys.stderr)
    for r in a.assets + a.local_assets:
        if not Path(r).is_dir(): print(f'asset folder not found: {r}', file=sys.stderr)
    srv = make_server(a.dist, a.assets, a.host, a.port, check_host=a.host in LOOPBACK, local=a.local_assets)
    print('building catalog (the first run makes image thumbnails on macOS, can take a minute)...', flush=True)
    n = len(json.loads(srv.catalog.get())['items'])
    url = f'http://{"[" + a.host + "]" if ":" in a.host else a.host}:{srv.server_address[1]}'
    print(f'{n} items -> {url}  (Ctrl+C to stop)', flush=True)
    if not a.no_browser: threading.Timer(.5, webbrowser.open, [url]).start()
    try: srv.serve_forever()
    except KeyboardInterrupt: pass


if __name__ == '__main__':
    main()
