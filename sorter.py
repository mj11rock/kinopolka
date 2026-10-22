#!/usr/bin/env python3
"""Сортировщик: разбирает media/inbox и раскладывает видео по библиотеке.

    media/movies/Название (Год)/Название (Год).mkv
    media/series/Название/Сезон 01/Название S01E02.mkv

Запуск:
    python3 sorter.py            # отсортировать один раз
    python3 sorter.py --dry-run  # только показать, что будет сделано
    python3 sorter.py --watch    # следить за inbox и сортировать новое
"""
import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent

VIDEO_EXT = {'.mkv', '.mp4', '.m4v', '.avi', '.mov', '.ts', '.m2ts', '.webm', '.wmv', '.mpg', '.mpeg', '.flv'}
SUB_EXT = {'.srt', '.ass', '.ssa', '.vtt'}
# Файлы, которые ещё качаются
PARTIAL_EXT = {'.part', '.!qb', '.crdownload', '.tmp', '.download', '.!ut', '.bc!'}

# Мусорные теги релизов, после которых название фильма/сериала заканчивается
JUNK = re.compile(
    r'\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?|hdr|dv|sdr|web[- .]?dl|web[- .]?rip|webrip|web|'
    r'blu[- .]?ray|bdrip|brrip|bdremux|remux|hdrip|dvdrip|dvd|hdtv|tvrip|satrip|camrip|ts|'
    r'x264|x265|h[ .]?264|h[ .]?265|hevc|avc|xvid|divx|10bit|8bit|aac\d?|ac3|dts(-hd)?|truehd|atmos|'
    r'ddp?\d?(\.\d)?|eac3|mp3|flac|proper|repack|extended|unrated|directors[ .]cut|imax|'
    r'rus|eng|ukr|dub|mvo|avo|lostfilm|newstudio|novafilm|alexfilm|amedia|coldfilm|hdrezka|rezka|'
    r'jaskier|kubik|baibako|kerob|ozz|nnmclub|rutracker|rutor|kinozal)\b',
    re.I)

EP_PATTERNS = [
    re.compile(r'[Ss](\d{1,2})[ ._-]?[EeЕе](\d{1,3})'),                 # S01E02, s1e2, S01.E02
    re.compile(r'\b(\d{1,2})[xXхХ](\d{2,3})\b'),                         # 1x02
    re.compile(r'(?:сезон|season)[ ._-]*(\d{1,2}).{0,10}?(?:серия|episode|эпизод|ep)[ ._-]*(\d{1,3})', re.I),
]
SEASON_ONLY = re.compile(r'(?:\b[Ss](\d{1,2})\b|(?:сезон|season)[ ._-]*(\d{1,2})|(\d{1,2})[ ._-]*(?:сезон|season))', re.I)
EP_ONLY = re.compile(r'(?:\b[EeЕе][Pp]?[ ._-]?(\d{1,3})\b|(?:серия|episode|эпизод)[ ._-]*(\d{1,3})|(\d{1,3})[ ._-]*(?:серия|эпизод))', re.I)
YEAR = re.compile(r'(?<!\d)(19[2-9]\d|20[0-4]\d)(?!\d)')


def load_config():
    cfg = {'media_dir': 'media', 'port': 8090}
    p = ROOT / 'config.json'
    if p.exists():
        cfg.update(json.loads(p.read_text(encoding='utf-8')))
    media = Path(cfg['media_dir'])
    cfg['media_dir'] = media if media.is_absolute() else ROOT / media
    return cfg


def clean_title(s):
    """'The.Last.of.Us.[LostFilm]' -> 'The Last of Us'"""
    s = re.sub(r'^\s*(\[[^\]]*\]|\([^)]*\))\s*', '', s)    # [Группа] в начале
    s = re.sub(r'[\[\(][^\]\)]*[\]\)]', ' ', s)             # прочие скобки
    s = re.sub(r'[._]+', ' ', s)
    m = JUNK.search(s)
    if m:
        s = s[:m.start()]
    s = re.sub(r'\s+-\s*$|^\s*-\s+', '', s)
    s = re.sub(r'\s+', ' ', s).strip(' -,([')
    return s


def safe_name(s):
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', s).strip(' .')
    return s or 'Без названия'


def parse_episode(name):
    """Ищет сезон/серию в строке. Возвращает (сезон, серия, позиция начала) или None."""
    for pat in EP_PATTERNS:
        m = pat.search(name)
        if m:
            return int(m.group(1)), int(m.group(2)), m.start()
    return None


def parse_season(name):
    m = SEASON_ONLY.search(name)
    if m:
        return int(next(g for g in m.groups() if g)), m.start()
    return None


def classify(video: Path, inbox: Path):
    """Определяет, что за файл. Возвращает dict(kind=movie|episode, ...) или None."""
    stem = video.stem
    # родительские папки внутри inbox, от ближней к дальней (раздачи бывают вложенными)
    parents = list(reversed(video.relative_to(inbox).parent.parts))

    ep = parse_episode(stem)
    if ep:
        season, episode, pos = ep
        title = clean_title(stem[:pos])
        if not title:  # имя файла вида "S01E02.mkv" — название берём из папки
            for p in parents:
                t = parse_episode(p) or parse_season(p)
                title = clean_title(p[:t[-1]] if t else p)
                if title:
                    break
        return {'kind': 'episode', 'title': title, 'season': season, 'episode': episode}

    # Серия без сезона в имени, но папка указывает на сезон: "Show.S02/05.mkv"
    for p in parents:
        s = parse_season(p)
        if s:
            em = EP_ONLY.search(stem) or re.match(r'^\D{0,3}(\d{1,3})\b', stem)
            if em:
                episode = int(next(g for g in em.groups() if g))
                title = clean_title(p[:s[1]])
                if not title:
                    title = next((clean_title(q) for q in parents if clean_title(q) and not parse_season(q)), '')
                return {'kind': 'episode', 'title': title, 'season': s[0], 'episode': episode}

    # Явное "Серия 3" / "Episode 3" / "E03" без сезона — считаем первым сезоном
    em = EP_ONLY.search(stem)
    if em and (em.group(1) or em.group(2) or em.group(3)):
        title = clean_title(stem[:em.start()])
        if not title:
            title = next((clean_title(YEAR.split(q)[0]) for q in parents if clean_title(q)), '')
        if title:
            return {'kind': 'episode', 'title': title, 'season': 1,
                    'episode': int(next(g for g in em.groups() if g))}

    # Фильм: название до года
    for src in [stem] + parents:
        m = YEAR.search(src)
        if m and m.start() > 0:
            title = clean_title(src[:m.start()])
            if title:
                return {'kind': 'movie', 'title': title, 'year': m.group(1)}
    title = clean_title(stem)
    return {'kind': 'movie', 'title': title, 'year': None} if title else None


def find_series_dir(series_root: Path, title: str):
    """Совпадение без учёта регистра с существующей папкой сериала."""
    key = title.casefold()
    if series_root.exists():
        for d in series_root.iterdir():
            if d.is_dir() and d.name.casefold() == key:
                return d
    return series_root / safe_name(title)


def target_for(info, ext, media: Path):
    if info['kind'] == 'episode':
        show_dir = find_series_dir(media / 'series', info['title'])
        name = f"{show_dir.name} S{info['season']:02d}E{info['episode']:02d}{ext}"
        return show_dir / f"Сезон {info['season']:02d}" / name
    title = safe_name(info['title'])
    if info['year']:
        title = f"{title} ({info['year']})"
    return media / 'movies' / title / f'{title}{ext}'


def is_settled(path: Path, min_age=60):
    """Файл не качается прямо сейчас: нет .part-хвоста и давно не менялся."""
    if path.suffix.lower() in PARTIAL_EXT:
        return False
    try:
        return time.time() - path.stat().st_mtime > min_age
    except OSError:
        return False


def related_subs(video: Path):
    """Субтитры рядом с видео или в подпапках раздачи (Subs/, Subtitles/ ...)."""
    stem = video.stem.casefold()
    return [f for f in video.parent.rglob('*')
            if f.is_file() and f.suffix.lower() in SUB_EXT and f.stem.casefold().startswith(stem)]


def move(src: Path, dst: Path, dry):
    if dst.exists():
        print(f'  ! уже есть: {dst}')
        return False
    print(f'  {src.name}\n    -> {dst}')
    if not dry:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
    return True


def sort_inbox(dry=False, quiet=False):
    cfg = load_config()
    media = cfg['media_dir']
    inbox = media / 'inbox'
    for d in ('inbox', 'movies', 'series'):
        (media / d).mkdir(parents=True, exist_ok=True)

    videos = sorted(p for p in inbox.rglob('*') if p.is_file() and p.suffix.lower() in VIDEO_EXT)
    moved = 0
    for v in videos:
        if not is_settled(v):
            continue
        if 'sample' in v.stem.lower() and v.stat().st_size < 300 * 2**20:
            continue
        info = classify(v, inbox)
        if not info or not info['title']:
            print(f'? не понял, что это: {v.relative_to(inbox)} — оставляю в inbox')
            continue
        dst = target_for(info, v.suffix.lower(), media)
        subs = related_subs(v)
        if move(v, dst, dry):
            moved += 1
            for s in subs:
                # "Видео.rus.srt" -> "<новое имя>.rus.srt"
                tail = s.name[len(v.stem):]
                move(s, dst.with_name(dst.stem + tail), dry)

    if not dry:
        # чистим опустевшие папки раздач
        for d in sorted((p for p in inbox.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            leftovers = [f for f in d.rglob('*') if f.is_file()
                         and f.suffix.lower() not in {'.txt', '.nfo', '.jpg', '.png', '.url', '.exe', '.sfv'}]
            if not leftovers:
                shutil.rmtree(d, ignore_errors=True)
    if moved or not quiet:
        print(f'Готово: перемещено {moved} видео' + (' (пробный прогон)' if dry else ''))
    return moved


def main():
    ap = argparse.ArgumentParser(description='Сортировка media/inbox')
    ap.add_argument('--dry-run', action='store_true', help='ничего не перемещать, только показать')
    ap.add_argument('--watch', action='store_true', help='следить за inbox')
    ap.add_argument('--interval', type=int, default=30)
    a = ap.parse_args()
    if a.watch:
        print('Слежу за inbox, Ctrl+C для выхода')
        while True:
            sort_inbox(quiet=True)
            time.sleep(a.interval)
    sort_inbox(a.dry_run)


if __name__ == '__main__':
    sys.exit(main())
