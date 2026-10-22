#!/usr/bin/env python3
"""Медиасервер для телевизора. Запуск: python3 server.py"""
import ipaddress
import json
import mimetypes
import re
import threading
import time
import traceback
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

from sorter import (ROOT, VIDEO_EXT, SUB_EXT, EP_ONLY, load_config, parse_episode,
                    parse_season, sort_inbox)

CFG = load_config()
MEDIA = CFG['media_dir']
WEB = ROOT / 'web'
STATE_FILE = ROOT / 'data' / 'progress.json'
IMAGE_NAMES = ('poster', 'folder', 'cover')
IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.webp'}
# из media/ отдаём только то, что нужно плееру: никаких .html и прочего из раздач
SERVABLE_EXT = VIDEO_EXT | SUB_EXT | IMAGE_EXT
# приложение на ТВ открыто из file:// — браузер присылает Origin "null" или "file://"
APP_ORIGINS = {'null', 'file://'}
BACKDROP_NAMES = ('backdrop', 'fanart', 'background')

MIME = {'.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
        '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mov': 'video/quicktime',
        '.wmv': 'video/x-ms-wmv', '.js': 'application/javascript', '.css': 'text/css',
        '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json'}


# ---------- прогресс просмотра ----------

state_lock = threading.Lock()


def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


STATE = load_state()


def save_progress(file_id, pos, dur):
    with state_lock:
        rec = STATE.setdefault(file_id, {})
        rec.update(pos=round(pos, 1), dur=round(dur, 1), t=time.time())
        if dur and pos / dur > 0.92:
            rec['watched'] = True
            rec['pos'] = 0
        elif pos > 0 and dur and pos / dur < 0.9:
            rec['watched'] = False
        STATE_FILE.parent.mkdir(exist_ok=True)
        tmp = STATE_FILE.with_suffix('.tmp')
        tmp.write_text(json.dumps(STATE, ensure_ascii=False), encoding='utf-8')
        tmp.replace(STATE_FILE)


def set_watched(file_ids, watched):
    with state_lock:
        for fid in file_ids:
            rec = STATE.setdefault(fid, {})
            rec.update(watched=watched, pos=0, t=time.time())
        tmp = STATE_FILE.with_suffix('.tmp')
        STATE_FILE.parent.mkdir(exist_ok=True)
        tmp.write_text(json.dumps(STATE, ensure_ascii=False), encoding='utf-8')
        tmp.replace(STATE_FILE)


def progress_of(file_id):
    rec = STATE.get(file_id)
    if not rec:
        return None
    return {'pos': rec.get('pos', 0), 'dur': rec.get('dur', 0), 'watched': rec.get('watched', False),
            't': rec.get('t', 0)}


# ---------- сканирование библиотеки ----------

def rel(p: Path):
    return p.relative_to(MEDIA).as_posix()


def find_image(folder: Path, names):
    for n in names:
        for ext in ('.jpg', '.jpeg', '.png', '.webp'):
            f = folder / (n + ext)
            if f.exists():
                return rel(f)
    return None


def subs_for(video: Path):
    out = []
    stem = video.stem.casefold()
    for f in video.parent.iterdir():
        if f.suffix.lower() in SUB_EXT and f.stem.casefold().startswith(stem):
            label = f.stem[len(video.stem):].strip(' ._-') or f.suffix[1:].upper()
            out.append({'id': rel(f), 'label': label})
    return out


def scan_movies():
    movies = []
    root = MEDIA / 'movies'
    if not root.exists():
        return movies
    for entry in sorted(root.iterdir(), key=lambda p: p.name.casefold()):
        if entry.is_dir():
            vids = sorted((f for f in entry.rglob('*') if f.suffix.lower() in VIDEO_EXT),
                          key=lambda f: -f.stat().st_size)
            if not vids:
                continue
            video, folder, name = vids[0], entry, entry.name
        elif entry.suffix.lower() in VIDEO_EXT:
            video, folder, name = entry, None, entry.stem
        else:
            continue
        m = re.match(r'^(.*?)\s*\((\d{4})\)\s*$', name)
        title, year = (m.group(1), m.group(2)) if m else (name, None)
        movies.append({
            'type': 'movie', 'id': rel(video), 'file': rel(video), 'title': title, 'year': year,
            'poster': folder and find_image(folder, IMAGE_NAMES),
            'backdrop': folder and find_image(folder, BACKDROP_NAMES),
            'subs': subs_for(video), 'added': video.stat().st_mtime,
            'size': video.stat().st_size,
        })
    return movies


def season_number(name):
    s = parse_season(name)
    if s:
        return s[0]
    m = re.search(r'\d+', name)
    return int(m.group()) if m else 0


def episode_number(stem):
    ep = parse_episode(stem)
    if ep:
        return ep[1]
    m = EP_ONLY.search(stem) or re.match(r'^\D{0,3}(\d{1,3})\b', stem)
    if m:
        return int(next(g for g in m.groups() if g))
    return None


def scan_show(show_dir: Path):
    seasons = {}
    for f in show_dir.rglob('*'):
        if f.suffix.lower() not in VIDEO_EXT or 'sample' in f.stem.lower():
            continue
        parent = f.parent
        if parent != show_dir:
            snum = season_number(parent.name)
        else:
            ep = parse_episode(f.stem)
            snum = ep[0] if ep else 1
        seasons.setdefault(snum, []).append(f)

    out = []
    for snum in sorted(seasons):
        files = sorted(seasons[snum], key=lambda f: (episode_number(f.stem) or 9999, f.name.casefold()))
        eps = []
        for i, f in enumerate(files, 1):
            num = episode_number(f.stem) or i
            eps.append({'type': 'episode', 'id': rel(f), 'file': rel(f), 'season': snum, 'episode': num,
                        'title': f'Серия {num}', 'subs': subs_for(f), 'added': f.stat().st_mtime,
                        'show': rel(show_dir), 'showTitle': show_dir.name})
        out.append({'season': snum, 'title': f'Сезон {snum}' if snum else 'Спецвыпуски', 'episodes': eps})
    return out


_cache = {'t': 0, 'data': None}
_cache_lock = threading.Lock()


def library(force=False):
    with _cache_lock:
        if not force and _cache['data'] and time.time() - _cache['t'] < 15:
            return _cache['data']
        movies = scan_movies()
        shows = []
        root = MEDIA / 'series'
        if root.exists():
            for d in sorted((d for d in root.iterdir() if d.is_dir()), key=lambda p: p.name.casefold()):
                seasons = scan_show(d)
                if not seasons:
                    continue
                eps = [e for s in seasons for e in s['episodes']]
                shows.append({'type': 'show', 'id': rel(d), 'title': d.name,
                              'poster': find_image(d, IMAGE_NAMES),
                              'backdrop': find_image(d, BACKDROP_NAMES),
                              'seasons': seasons, 'seasonCount': len(seasons), 'episodeCount': len(eps),
                              'added': max(e['added'] for e in eps)})
        _cache.update(t=time.time(), data={'movies': movies, 'shows': shows})
        return _cache['data']


def with_progress(item):
    item = dict(item)
    item['progress'] = progress_of(item['file'])
    return item


def show_summary(show):
    s = {k: v for k, v in show.items() if k != 'seasons'}
    eps = [e for se in show['seasons'] for e in se['episodes']]
    s['watchedCount'] = sum(1 for e in eps if (STATE.get(e['file']) or {}).get('watched'))
    s['next'] = next_episode(show)
    return s


def next_episode(show):
    """Серия, с которой продолжить: недосмотренная последняя или следующая за досмотренной."""
    eps = [e for se in show['seasons'] for e in se['episodes']]
    touched = [(STATE[e['file']].get('t', 0), i) for i, e in enumerate(eps) if e['file'] in STATE]
    if not touched:
        return with_progress(eps[0]) if eps else None
    _, i = max(touched)
    rec = STATE[eps[i]['file']]
    if rec.get('watched'):
        if i + 1 < len(eps):
            return with_progress(eps[i + 1])
        return None
    return with_progress(eps[i])


def home():
    lib = library()
    movies = [with_progress(m) for m in lib['movies']]
    shows = [show_summary(s) for s in lib['shows']]

    cont = []
    for m in movies:
        p = m['progress']
        if p and not p['watched'] and p['pos'] > 30:
            cont.append((p['t'], m))
    for s, full in zip(shows, lib['shows']):
        nxt = s['next']
        eps = [e for se in full['seasons'] for e in se['episodes']]
        last_t = max((STATE[e['file']].get('t', 0) for e in eps if e['file'] in STATE), default=0)
        if nxt and last_t:
            cont.append((last_t, dict(nxt, poster=s['poster'], backdrop=s['backdrop'])))
    cont.sort(key=lambda x: -x[0])

    recent = sorted([*movies, *shows], key=lambda x: -x['added'])[:20]
    return {'continue': [c for _, c in cont][:20], 'recent': recent, 'movies': movies, 'shows': shows}


def show_details(show_id):
    for s in library()['shows']:
        if s['id'] == show_id:
            d = show_summary(s)
            d['seasons'] = [{'season': se['season'], 'title': se['title'],
                             'episodes': [with_progress(e) for e in se['episodes']]} for se in s['seasons']]
            return d
    return None


# ---------- субтитры ----------

def read_text(p: Path):
    raw = p.read_bytes()
    for enc in ('utf-8-sig', 'utf-16') if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else ('utf-8-sig', 'cp1251'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode('latin-1')


def ts(s):
    s = s.strip().replace(',', '.')
    parts = s.split(':')
    sec = float(parts[-1])
    if len(parts) > 1:
        sec += int(parts[-2]) * 60
    if len(parts) > 2:
        sec += int(parts[-3]) * 3600
    return sec


def parse_subs(p: Path):
    text = read_text(p).replace('\r\n', '\n').replace('\r', '\n')
    cues = []
    if p.suffix.lower() in ('.ass', '.ssa'):
        fmt = None
        for line in text.split('\n'):
            if line.startswith('Format:') and fmt is None and 'Start' in line:
                fmt = [x.strip() for x in line[7:].split(',')]
            elif line.startswith('Dialogue:') and fmt:
                vals = line[9:].split(',', len(fmt) - 1)
                d = dict(zip(fmt, vals))
                t = re.sub(r'\{[^}]*\}', '', d.get('Text', '')).replace('\\N', '\n').replace('\\n', '\n').strip()
                if t:
                    cues.append({'s': ts(d['Start']), 'e': ts(d['End']), 't': t})
    else:
        for block in re.split(r'\n\s*\n', text):
            lines = [l for l in block.split('\n') if l.strip()]
            for i, l in enumerate(lines):
                if '-->' in l:
                    a, b = l.split('-->')
                    t = '\n'.join(lines[i + 1:])
                    t = re.sub(r'<[^>]+>|\{[^}]*\}', '', t).strip()
                    if t:
                        cues.append({'s': ts(a), 'e': ts(b.split()[0]), 't': t})
                    break
    cues.sort(key=lambda c: c['s'])
    return cues


# ---------- HTTP ----------

def safe_media_path(relpath, allowed=SERVABLE_EXT):
    p = (MEDIA / unquote(relpath)).resolve()
    if MEDIA.resolve() not in p.parents or not p.is_file():
        return None
    if p.suffix.lower() not in allowed or (MEDIA / 'inbox').resolve() in p.parents:
        return None
    return p


def host_allowed(host):
    """Защита от DNS rebinding: пускаем только по IP, localhost и именам из config.json."""
    name = (host or '').rsplit(':', 1)[0].strip('[]').lower()
    if name in ('localhost', '') or name in [h.lower() for h in CFG.get('allowed_hosts', [])]:
        return True
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        if '/api/progress' not in self.path:
            print(f'{self.address_string()} {fmt % args}')

    def origin_ok(self):
        """Свой интерфейс (тот же хост) или приложение на ТВ. Чужие сайты — нет."""
        origin = self.headers.get('Origin')
        if origin is None or origin in APP_ORIGINS:
            return True
        return urlparse(origin).netloc == self.headers.get('Host')

    def guard(self):
        if host_allowed(self.headers.get('Host')) and self.origin_ok():
            return True
        self.send_json({'error': 'forbidden'}, 403)
        return False

    def cors(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        origin = self.headers.get('Origin')
        if origin in APP_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS')
            self.send_header('Vary', 'Origin')

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not self.guard():
            return
        self.send_response(204)
        self.cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if not self.guard():
            return
        try:
            if url.path == '/api/home':
                return self.send_json(home())
            if url.path == '/api/show':
                d = show_details(q.get('id', ''))
                return self.send_json(d) if d else self.send_json({'error': 'not found'}, 404)
            if url.path == '/api/subs':
                p = safe_media_path(q.get('id', ''), SUB_EXT)
                return self.send_json(parse_subs(p)) if p else self.send_json([], 404)
            if url.path == '/api/ping':
                return self.send_json({'ok': True, 'name': 'Кинополка'})
            if url.path.startswith('/media/'):
                p = safe_media_path(url.path[len('/media/'):])
                if not p:
                    return self.send_json({'error': 'not found'}, 404)
                return self.send_file(p, head, cache=p.suffix.lower() not in VIDEO_EXT)
            # статика интерфейса
            name = unquote(url.path).lstrip('/') or 'index.html'
            p = (WEB / name).resolve()
            if WEB.resolve() in p.parents and p.is_file():
                return self.send_file(p, head)
            self.send_json({'error': 'not found'}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            self.send_json({'error': 'server error'}, 500)

    def do_POST(self):
        url = urlparse(self.path)
        if not self.guard():
            return
        # JSON-only: обычная HTML-форма с чужого сайта так не отправит
        if not (self.headers.get('Content-Type') or '').startswith('application/json'):
            return self.send_json({'error': 'json expected'}, 415)
        length = int(self.headers.get('Content-Length') or 0)
        try:
            data = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return self.send_json({'error': 'bad json'}, 400)
        if url.path == '/api/progress':
            save_progress(data['file'], float(data.get('pos', 0)), float(data.get('dur', 0)))
            return self.send_json({'ok': True})
        if url.path == '/api/watched':
            set_watched(data.get('files', []), bool(data.get('watched', True)))
            return self.send_json({'ok': True})
        if url.path == '/api/rescan':
            sort_inbox(quiet=True)
            library(force=True)
            return self.send_json({'ok': True})
        self.send_json({'error': 'not found'}, 404)

    def send_file(self, p: Path, head=False, cache=False):
        size = p.stat().st_size
        start, end = 0, size - 1
        rng = self.headers.get('Range')
        m = re.match(r'bytes=(\d*)-(\d*)', rng or '')
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
            else:  # bytes=-500 — последние 500 байт
                start = max(0, size - int(m.group(2)))
            if start >= size:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else:
            self.send_response(200)
        length = end - start + 1
        ctype = MIME.get(p.suffix.lower()) or mimetypes.guess_type(p.name)[0] or 'application/octet-stream'
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'max-age=3600' if cache else 'no-cache')
        self.cors()
        self.end_headers()
        if head:
            return
        with open(p, 'rb') as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


def auto_sort_loop():
    while True:
        try:
            if sort_inbox(quiet=True):
                library(force=True)
        except Exception:
            traceback.print_exc()
        time.sleep(60)


def lan_ip():
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def main():
    for d in ('inbox', 'movies', 'series'):
        (MEDIA / d).mkdir(parents=True, exist_ok=True)
    if CFG.get('auto_sort', True):
        threading.Thread(target=auto_sort_loop, daemon=True).start()
    port = int(CFG['port'])
    srv = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    srv.daemon_threads = True
    print(f'Медиатека: {MEDIA}')
    print(f'Сервер запущен: http://{lan_ip()}:{port}  (Ctrl+C — остановить)')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
