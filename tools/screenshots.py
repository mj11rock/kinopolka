#!/usr/bin/env python3
"""Снимает скриншоты интерфейса для README на демо-библиотеке.

    python3 tools/screenshots.py

Собирает во временной папке библиотеку-пустышку с выдуманными названиями, запускает
на ней сервер и фотографирует экраны headless-браузером (Edge из Windows или Chromium).
Нажатия пульта имитируются, поэтому после редизайна может понадобиться поправить SHOTS.
Результат: docs/screenshots/*.png
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'screenshots'
PORT = 8199

BROWSERS = [
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    'chromium', 'chromium-browser', 'google-chrome',
]

# Выдуманные сериалы: (название, {сезон: число серий})
SHOWS = [
    ('Северный ветер', {1: 8, 2: 8, 3: 6}),
    ('Тихая гавань', {1: 10, 2: 10}),
    ('Последний рейс', {1: 6}),
    ('Город огней', {1: 12, 2: 12}),
    ('Хроники Мглы', {1: 8}),
    ('Дальний свет', {1: 7, 2: 7}),
]
MOVIES = [
    ('Метрополис', 1927), ('Носферату', 1922), ('Генерал', 1926), ('Путешествие на Луну', 1902),
    ('Глубина', 2021), ('Сто дней до весны', 2019), ('Остров', 2024), ('Тени над рекой', 2016),
]

# Фон для кадра в плеере (сам видеофайл в демо — пустышка)
SCENE = ("data:image/svg+xml;utf8," + """<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1920 1080'>
<defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='%23243b6b'/>
<stop offset='.55' stop-color='%23e9876a'/><stop offset='1' stop-color='%23f6c37a'/></linearGradient></defs>
<rect width='1920' height='1080' fill='url(%23s)'/><circle cx='1300' cy='600' r='120' fill='%23ffe3a8'/>
<path d='M0 700 L300 520 L560 690 L860 470 L1180 700 L1500 560 L1920 720 V1080 H0Z' fill='%233a3354'/>
<path d='M0 820 L420 640 L760 800 L1100 660 L1500 820 L1920 700 V1080 H0Z' fill='%23231f36'/>
<path d='M0 940 Q960 860 1920 950 V1080 H0Z' fill='%23120f1d'/></svg>""").replace('\n', '')

FAKE_ENGINE = """
window.__FAKE = { name: 'fake',
  open: function (u, s, ev) { this.ev = ev; ev.buffering(false); ev.ready(); },
  time: function () { return 1874; }, duration: function () { return 3290; },
  paused: function () { return true; }, play: function () {}, pause: function () {}, seek: function () {},
  tracks: function (t) { return t === 'AUDIO' ? [
    { index: 0, label: 'Дорожка 1 · RUS · AC3 · 6 кан.', active: true },
    { index: 1, label: 'Дорожка 2 · RUS · AAC · 2 кан.', active: false },
    { index: 2, label: 'Дорожка 3 · ENG · EAC3 · 6 кан.', active: false }] : []; },
  selectAudio: function () {}, selectText: function () {}, destroy: function () {}, suspend: function () {}, restore: function () {} };
"""

# Скриншоты: имя -> шаги (задержка мс, код клавиши или JS)
L, U, R, D, OK = 37, 38, 39, 40, 13
SHOTS = {
    'home': [(400, R)],
    'series': [(0, D), (300, OK), (900, D), (300, D), (300, R)],
    'library': [(0, U), (300, R), (300, OK), (900, R), (300, R)],
    'player': [(0, OK)],
    'audio': [(0, OK), (1200, "document.querySelector('.obtn[data-key=audio]').click()")],
}


def find_browser():
    for b in BROWSERS:
        if shutil.which(b) or Path(b).exists():
            return b
    sys.exit('Не нашёл Edge/Chrome/Chromium для скриншотов')


def build_demo(base: Path):
    for name in ('server.py', 'sorter.py'):
        shutil.copy(ROOT / name, base / name)
    shutil.copytree(ROOT / 'web', base / 'web')
    (base / 'config.json').write_text(json.dumps({'media_dir': 'media', 'port': PORT, 'auto_sort': False}))
    media = base / 'media'
    now = time.time()
    progress = {}
    for i, (title, seasons) in enumerate(SHOWS):
        for s, count in seasons.items():
            for e in range(1, count + 1):
                f = media / 'series' / title / f'Сезон {s:02d}' / f'{title} S{s:02d}E{e:02d}.mkv'
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(b'\0')
                os.utime(f, (now - i * 86400, now - i * 86400))
    for i, (title, year) in enumerate(MOVIES):
        f = media / 'movies' / f'{title} ({year})' / f'{title} ({year}).mkv'
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(b'\0' * 1024)
        os.utime(f, (now - (i + 2) * 43200,) * 2)

    # прогресс: сериал «Северный ветер» досмотрен до S02E03, фильм начат
    def ep(title, s, e):
        return f'series/{title}/Сезон {s:02d}/{title} S{s:02d}E{e:02d}.mkv'
    t = now
    for s, count in ((1, 8), (2, 2)):
        for e in range(1, count + 1):
            progress[ep('Северный ветер', s, e)] = {'pos': 0, 'dur': 3200, 'watched': True, 't': t - 9000}
    progress[ep('Северный ветер', 2, 3)] = {'pos': 1874, 'dur': 3290, 'watched': False, 't': t}
    progress[ep('Тихая гавань', 1, 4)] = {'pos': 900, 'dur': 2700, 'watched': False, 't': t - 3600}
    progress['movies/Глубина (2021)/Глубина (2021).mkv'] = {'pos': 2400, 'dur': 6900, 'watched': False, 't': t - 7200}
    (base / 'data').mkdir()
    (base / 'data' / 'progress.json').write_text(json.dumps(progress, ensure_ascii=False), encoding='utf-8')

    srt = media / 'series' / 'Северный ветер' / 'Сезон 02' / 'Северный ветер S02E03.rus.srt'
    srt.write_text('1\n00:31:10,000 --> 00:31:20,000\nЕсли ветер переменится к утру,\nмы успеем уйти до шторма.\n', encoding='utf-8')

    # демо-хуки: подменённый движок плеера и картинка вместо кадра
    js = (base / 'web' / 'app.js').read_text(encoding='utf-8')
    hook = 'this.engine = HAS_AVPLAY ? AvEngine : HtmlEngine;'
    if hook in js:
        js = js.replace(hook, 'this.engine = window.__FAKE || (HAS_AVPLAY ? AvEngine : HtmlEngine);')
    (base / 'web' / 'app.js').write_text(FAKE_ENGINE + js, encoding='utf-8')
    css = (base / 'web' / 'app.css').read_text(encoding='utf-8')
    css += f'\n#video {{ background: #000 url("{SCENE}") center / cover !important; }}\n'
    (base / 'web' / 'app.css').write_text(css, encoding='utf-8')


def inject_steps(base: Path, steps):
    parts = []
    for delay, act in steps:
        code = act if isinstance(act, str) else \
            f"var e = new Event('keydown'); e.keyCode = {act}; document.dispatchEvent(e);"
        parts.append(f'function () {{ {code} }}, {delay}')
    runner = ('(function () { var q = [' + ', '.join('[' + p + ']' for p in parts) + '];'
              ' function next() { var s = q.shift(); if (!s) return; setTimeout(function () { s[0](); next(); }, s[1]); }'
              ' setTimeout(next, 900); })();')
    (base / 'web' / 'steps.js').write_text(runner, encoding='utf-8')
    html = (base / 'web' / 'index.html').read_text(encoding='utf-8')
    if 'steps.js' not in html:
        html = html.replace('<script src="app.js"></script>', '<script src="app.js"></script>\n<script src="steps.js"></script>')
        (base / 'web' / 'index.html').write_text(html, encoding='utf-8')


def win_path(p: Path):
    return subprocess.check_output(['wslpath', '-w', str(p)], text=True).strip()


def main():
    browser = find_browser()
    is_win = browser.endswith('.exe')
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix='kinopolka-shots-'))
    try:
        build_demo(tmp)
        srv = subprocess.Popen([sys.executable, 'server.py'], cwd=tmp, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        try:
            for _ in range(50):
                try:
                    urllib.request.urlopen(f'http://localhost:{PORT}/api/ping', timeout=1)
                    break
                except OSError:
                    time.sleep(0.2)
            for name, steps in SHOTS.items():
                inject_steps(tmp, steps)
                shot = tmp / f'{name}.png'
                budget = 2500 + sum(d for d, _ in steps) + 400 * len(steps)
                subprocess.run([browser, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1920,1080',
                                f'--virtual-time-budget={budget}', f'--screenshot={win_path(shot) if is_win else shot}',
                                f'http://localhost:{PORT}/?{name}'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
                if shot.exists():
                    shutil.copy(shot, OUT / f'{name}.png')
                    print(f'✓ {OUT / name}.png')
                else:
                    print(f'✗ {name}: браузер не сохранил скриншот')
        finally:
            srv.terminate()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
