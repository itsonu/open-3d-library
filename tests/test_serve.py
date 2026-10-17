import http.client, json, os, sys, tempfile, threading, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import serve

JPEG = b'\xff\xd8\xff\xe0' + b'0' * 64


class ServeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        t = Path(cls.tmp.name)
        cls.assets, cls.dist = t / 'assets', t / 'dist'
        (cls.assets / 'character-hero').mkdir(parents=True)
        (cls.assets / 'character-hero' / 'hero.glb').write_bytes(bytes(range(100)))
        (cls.assets / 'character-hero' / 'meta.json').write_text(json.dumps({'description': 'd', 'license': 'MIT', 'sensitive': True}))
        (cls.assets / 'pose-sit').mkdir()
        (cls.assets / 'pose-sit' / 'sit.fbx').write_bytes(b'fbx')
        (cls.assets / 'adult.json').write_text('["pose-sit"]')
        (cls.assets / 'fixes.json').write_text('{"pose-sit": {"*": "tex.png"}}')
        (cls.assets / '.secret').write_text('nope')
        (cls.assets / '.git').mkdir(); (cls.assets / '.git' / 'config').write_text('[core]')
        cls.dist.mkdir(); (cls.dist / 'index.html').write_text('<h1>app</h1>')
        (t / 'outside.txt').write_text('outside')
        try: os.symlink(t / 'outside.txt', cls.assets / 'character-hero' / 'link.txt')
        except (OSError, NotImplementedError): pass
        serve.Handler.log_message = lambda *a: None
        cls.srv = serve.make_server(cls.dist, cls.assets, port=0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); cls.srv.server_close(); cls.tmp.cleanup()

    def req(self, method, path, headers=None, body=None, host=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        c.putrequest(method, path, skip_host=True)          # raw path: no client-side normalisation of ..
        c.putheader('Host', host or f'127.0.0.1:{self.port}')
        for k, v in (headers or {}).items(): c.putheader(k, v)
        c.endheaders(body)
        r = c.getresponse(); data = r.read(); c.close()
        return r, data

    def post(self, path, body, headers=None):
        return self.req('POST', path, {'Content-Length': str(len(body)), **(headers or {})}, body)[0]

    def items(self):
        return {i['id']: i for i in json.loads(self.req('GET', '/catalog.json')[1])['items']}

    def test_index_and_catalog(self):
        r, d = self.req('GET', '/'); self.assertEqual((r.status, d), (200, b'<h1>app</h1>'))
        it = self.items()
        self.assertEqual(set(it), {'character-hero', 'pose-sit'})
        h = it['character-hero']
        self.assertEqual((h['type'], h['name'], h['files']), ('character', 'hero', [{'n': 'hero.glb', 's': 100}]))
        self.assertEqual((h['description'], h['license'], h['sensitive']), ('d', 'MIT', True))
        self.assertEqual((it['pose-sit']['sensitive'], it['pose-sit']['textureOverrides']), (True, {'*': 'tex.png'}))

    def test_asset_served(self):
        r, d = self.req('GET', '/assets/character-hero/hero.glb')
        self.assertEqual((r.status, d), (200, bytes(range(100))))

    def test_not_served(self):
        paths = ['/assets/../serve.py', '/assets/%2e%2e/serve.py', '/%2e%2e/serve.py', '/assets/%2e%2e%2fserve.py', '/../serve.py',
                 '/assets/character-hero/..%2f..%2fserve.py', '/.git/config', '/assets/.git/config', '/assets/.secret', '/assets/.thumbs/..%2f.secret',
                 '/assets/', '/assets', '/assets/character-hero/']
        if (self.assets / 'character-hero' / 'link.txt').is_symlink(): paths.append('/assets/character-hero/link.txt')   # symlink leaving the asset folder
        for p in paths: self.assertEqual(self.req('GET', p)[0].status, 404, p)

    def test_bad_host(self):
        for h in ['evil.example', f'evil.example:{self.port}', 'localhost.evil.com:%d' % self.port]:
            self.assertIn(self.req('GET', '/catalog.json', host=h)[0].status, (400, 403), h)
        self.assertEqual(self.req('GET', '/catalog.json', host=f'localhost:{self.port}')[0].status, 200)

    def test_thumb_rules(self):
        ok = {'X-O3DL': '1'}
        self.assertEqual(self.post('/thumb/character-hero.jpg', JPEG).status, 403)                     # no header
        self.assertEqual(self.post('/thumb/character-hero.jpg', b'x' * (2 << 20) + b'x', ok).status, 413)
        self.assertEqual(self.post('/thumb/character-hero.jpg', b'GIF89a', ok).status, 415)
        self.assertEqual(self.post('/thumb/nope.jpg', JPEG, ok).status, 404)
        self.assertEqual(self.post('/thumb/..%2f..%2fx.jpg', JPEG, ok).status, 404)
        for cl in ['-1', 'abc']:
            self.assertEqual(self.req('POST', '/thumb/character-hero.jpg', {'X-O3DL': '1', 'Content-Length': cl}, None)[0].status, 400, cl)
        self.assertEqual(self.post('/thumb/character-hero.jpg', JPEG, ok).status, 204)
        self.assertEqual(self.items()['character-hero']['thumb'], 'assets/.thumbs/character-hero.jpg')
        r, d = self.req('GET', '/assets/.thumbs/character-hero.jpg')
        self.assertEqual((r.status, d), (200, JPEG))
        self.assertEqual(self.req('GET', '/assets/.thumbs/')[0].status, 404)

    def test_range(self):
        u = '/assets/character-hero/hero.glb'
        r, d = self.req('GET', u, {'Range': 'bytes=10-19'})
        self.assertEqual((r.status, d, r.getheader('Content-Range')), (206, bytes(range(10, 20)), 'bytes 10-19/100'))
        r, d = self.req('GET', u, {'Range': 'bytes=-5'}); self.assertEqual((r.status, d, r.getheader('Content-Range')), (206, bytes(range(95, 100)), 'bytes 95-99/100'))
        r, d = self.req('GET', u, {'Range': 'bytes=90-'}); self.assertEqual((r.status, r.getheader('Content-Range')), (206, 'bytes 90-99/100'))
        r, d = self.req('GET', u, {'Range': 'bytes=100-'}); self.assertEqual((r.status, r.getheader('Content-Range')), (416, 'bytes */100'))
        r, d = self.req('GET', u, {'Range': 'bytes=500-600'}); self.assertEqual((r.status, r.getheader('Content-Range')), (416, 'bytes */100'))


class TwoRootsTest(unittest.TestCase):
    """--assets (public) plus --local-assets (private): ownership, thumbnails, traversal, catalogue rules."""
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        t = Path(cls.tmp.name)
        cls.pub, cls.loc, cls.dist = t / 'public', t / 'local', t / 'dist'
        for root, ids in ((cls.pub, ['prop-box', 'prop-dup']), (cls.loc, ['outfit-secret', 'prop-dup'])):
            for i in ids:
                (root / i).mkdir(parents=True)
                (root / i / f'{i}.glb').write_bytes(root.name.encode() + b':' + i.encode())
        (cls.loc / '.thumbs').mkdir(); (cls.loc / '.thumbs' / 'outfit-secret.jpg').write_bytes(JPEG)
        (cls.loc / 'note.txt').write_text('loose private file')
        (cls.pub / 'prop-box' / 'to-local').symlink_to(cls.loc / 'outfit-secret' / 'outfit-secret.glb')   # symlink out of its root
        cls.dist.mkdir(); (cls.dist / 'index.html').write_text('x')
        serve.Handler.log_message = lambda *a: None
        cls.srv = serve.make_server(cls.dist, cls.pub, port=0, local=cls.loc)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); cls.srv.server_close(); cls.tmp.cleanup()

    def req(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        c.putrequest(method, path, skip_host=True); c.putheader('Host', f'127.0.0.1:{self.port}')
        for k, v in (headers or {}).items(): c.putheader(k, v)
        c.endheaders(body)
        r = c.getresponse(); data = r.read(); c.close()
        return r, data

    def items(self):
        return {i['id']: i for i in json.loads(self.req('GET', '/catalog.json')[1])['items']}

    def test_catalog_collection_and_duplicates(self):
        it = self.items()
        self.assertEqual(set(it), {'prop-box', 'prop-dup', 'outfit-secret'})
        self.assertNotIn('collection', it['prop-box'])
        self.assertEqual(it['outfit-secret']['collection'], 'local')
        self.assertNotIn('collection', it['prop-dup'])                       # duplicate id: the first (public) root wins
        self.assertEqual(self.req('GET', '/assets/prop-dup/prop-dup.glb')[1], b'public:prop-dup')

    def test_ownership(self):
        self.assertEqual(self.req('GET', '/assets/prop-box/prop-box.glb')[1], b'public:prop-box')
        self.assertEqual(self.req('GET', '/assets/outfit-secret/outfit-secret.glb')[1], b'local:outfit-secret')
        self.assertEqual(self.req('GET', '/assets/prop-box/outfit-secret.glb')[0].status, 404)     # file of another root's item
        self.assertEqual(self.req('GET', '/assets/note.txt')[0].status, 404)                        # loose file at a root is not an item
        r, d = self.req('GET', '/assets/.thumbs/outfit-secret.jpg'); self.assertEqual((r.status, d), (200, JPEG))

    def test_thumb_written_to_owner(self):
        ok = {'X-O3DL': '1', 'Content-Length': str(len(JPEG))}
        self.assertEqual(self.req('POST', '/thumb/prop-box.jpg', ok, JPEG)[0].status, 204)
        self.assertEqual(self.req('POST', '/thumb/prop-dup.jpg', ok, JPEG)[0].status, 204)
        self.assertTrue((self.pub / '.thumbs' / 'prop-box.jpg').is_file())
        self.assertTrue((self.pub / '.thumbs' / 'prop-dup.jpg').is_file())
        self.assertFalse((self.loc / '.thumbs' / 'prop-box.jpg').exists())
        self.assertFalse((self.loc / '.thumbs' / 'prop-dup.jpg').exists())
        self.assertEqual(self.req('POST', '/thumb/outfit-secret.jpg', ok, JPEG)[0].status, 204)
        self.assertFalse((self.pub / '.thumbs' / 'outfit-secret.jpg').exists())
        self.assertEqual(self.items()['outfit-secret']['thumb'], 'assets/.thumbs/outfit-secret.jpg')

    def test_traversal_across_roots(self):
        n = self.loc.name
        for p in [f'/assets/../{n}/outfit-secret/outfit-secret.glb', f'/assets/%2e%2e/{n}/outfit-secret/outfit-secret.glb',
                  f'/assets/prop-box/..%2f..%2f{n}/outfit-secret/outfit-secret.glb', f'/assets/prop-box/../outfit-secret/outfit-secret.glb',
                  f'/assets/.thumbs/..%2f{n}/note.txt', '/assets/.thumbs/prop-box/../../outfit-secret/outfit-secret.glb',
                  '/assets/prop-box/to-local']:                                 # the last is a symlink from the public root into the local one
            self.assertEqual(self.req('GET', p)[0].status, 404, p)

    def test_write_catalog_excludes_local(self):
        out = Path(self.tmp.name) / 'catalog.json'
        argv = sys.argv
        sys.argv = ['serve.py', '--assets', str(self.pub), '--local-assets', str(self.loc), '--write-catalog', str(out)]
        try: serve.main()
        finally: sys.argv = argv
        ids = {i['id'] for i in json.loads(out.read_text())['items']}
        self.assertEqual(ids, {'prop-box', 'prop-dup'})
        self.assertNotIn('outfit-secret', out.read_text())


if __name__ == '__main__':
    unittest.main()
