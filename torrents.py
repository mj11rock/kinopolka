#!/usr/bin/env python3
"""Загрузчик торрентов: качает .torrent из media/torrents и отдаёт скачанное сортировщику.

    media/torrents/Фильм.torrent  ->  media/downloads/<хэш>/...  ->  media/inbox/...

Пока торрент качается, файлы лежат в downloads, поэтому в inbox попадает только
докачанное целиком. После загрузки раздача останавливается, а .torrent
переименовывается в .torrent.done. Удалишь .torrent во время загрузки — загрузка
отменится, а недокачанные файлы сотрутся.

Нужен libtorrent:  sudo apt install python3-libtorrent

Запуск:
    python3 torrents.py   # качать без сервера (server.py запускает загрузчик сам)
"""
import os
import shutil
import sys
import time
import traceback
from pathlib import Path

from sorter import ROOT, load_config

RESUME_DIR = ROOT / 'data' / 'torrents'
LOG_EVERY = 60  # раз в сколько секунд писать прогресс


def unique(dst: Path):
    """'Фильм' -> 'Фильм (2)', если такое имя в inbox уже занято."""
    n = 2
    base = dst
    while dst.exists():
        dst = base.with_name(f'{base.stem} ({n}){base.suffix}' if base.is_file() else f'{base.name} ({n})')
        n += 1
    return dst


def human(n):
    for unit in ('Б', 'КБ', 'МБ', 'ГБ'):
        if n < 1024:
            return f'{n:.0f} {unit}'
        n /= 1024
    return f'{n:.1f} ТБ'


class Downloader:
    def __init__(self, lt, media: Path, port=6881):
        self.lt = lt
        self.watch = media / 'torrents'
        self.work = media / 'downloads'
        self.inbox = media / 'inbox'
        for d in (self.watch, self.work, self.inbox, RESUME_DIR):
            d.mkdir(parents=True, exist_ok=True)
        cat = lt.alert.category_t
        self.ses = lt.session({
            'listen_interfaces': f'0.0.0.0:{port},[::]:{port}',
            'alert_mask': cat.status_notification | cat.error_notification | cat.storage_notification,
        })
        self.active = {}    # хэш -> (путь к .torrent, handle)
        self.finished = {}  # хэш -> путь к .torrent: загрузка закончена, осталось перенести файлы
        self.bad = set()    # .torrent, которые не открылись
        self.last_log = 0

    def add_new(self):
        for t in sorted(self.watch.glob('*.torrent')):
            if t in self.bad or any(t == p for p, _ in self.active.values()) or t in self.finished.values():
                continue
            try:
                ti = self.lt.torrent_info(str(t))
            except RuntimeError as e:
                print(f'! не открылся торрент {t.name}: {e}')
                self.bad.add(t)
                continue
            key = str(ti.info_hashes().get_best())
            if key in self.active or key in self.finished:
                print(f'! {t.name}: этот торрент уже качается')
                self.bad.add(t)
                continue
            resume = RESUME_DIR / f'{key}.resume'
            atp = self.lt.add_torrent_params()
            if resume.exists():
                try:
                    atp = self.lt.read_resume_data(resume.read_bytes())
                except RuntimeError:
                    pass  # битый файл — libtorrent просто перепроверит скачанное
            atp.ti = ti
            atp.save_path = str(self.work / key)
            self.active[key] = (t, self.ses.add_torrent(atp))
            print(f'↓ качаю: {ti.name()} ({human(ti.total_size())})')

    def drop_cancelled(self):
        """.torrent удалили из папки — отменяем загрузку и стираем недокачанное."""
        for key, (t, h) in list(self.active.items()):
            if not t.exists():
                print(f'× отменено: {h.status().name}')
                self.ses.remove_torrent(h, self.lt.options_t.delete_files)
                del self.active[key]
                (RESUME_DIR / f'{key}.resume').unlink(missing_ok=True)

    def handle_alerts(self):
        lt = self.lt
        for a in self.ses.pop_alerts():
            if isinstance(a, lt.torrent_finished_alert):
                key = str(a.handle.info_hashes().get_best())
                if key in self.active:
                    t, h = self.active.pop(key)
                    print(f'✓ скачано: {h.status().name}')
                    self.ses.remove_torrent(h)  # не раздаём
                    self.finished[key] = t
            elif isinstance(a, lt.save_resume_data_alert):
                key = str(a.handle.info_hashes().get_best())
                if key in self.active:
                    (RESUME_DIR / f'{key}.resume').write_bytes(lt.write_resume_data_buf(a.params))
            elif isinstance(a, (lt.torrent_error_alert, lt.file_error_alert)):
                print(f'! {a.message()}')

    def hand_over(self):
        """Переносит скачанное в inbox. Если файл ещё занят (Windows), попробуем в следующий раз."""
        for key, t in list(self.finished.items()):
            src = self.work / key
            try:
                for item in src.iterdir():
                    if item.name.startswith('.') and item.suffix == '.parts':
                        continue
                    dst = unique(self.inbox / item.name)
                    try:
                        os.rename(item, dst)
                    except OSError:
                        shutil.move(str(item), str(dst))
                shutil.rmtree(src, ignore_errors=True)
                t.rename(t.with_name(t.name + '.done'))
            except OSError as e:
                print(f'! не удалось перенести {src.name} в inbox ({e}), попробую позже')
                continue
            (RESUME_DIR / f'{key}.resume').unlink(missing_ok=True)
            del self.finished[key]

    def log_progress(self):
        if time.time() - self.last_log < LOG_EVERY or not self.active:
            return
        self.last_log = time.time()
        for t, h in self.active.values():
            s = h.status()
            what = f'{s.progress * 100:.1f}%, {human(s.download_rate)}/с, пиров {s.num_peers}'
            if s.errc.value():
                what = f'ошибка: {s.errc.message()}'
            print(f'  {s.name}: {what}')
            # прогресс сохраняем заодно: после перезапуска загрузка продолжится с того же места
            h.save_resume_data()

    def step(self):
        self.add_new()
        self.drop_cancelled()
        self.handle_alerts()
        self.hand_over()
        self.log_progress()

    def run(self, interval=5):
        while True:
            try:
                self.step()
            except Exception:
                traceback.print_exc()
            time.sleep(interval)


def start(cfg):
    """Downloader или None, если libtorrent не установлен."""
    try:
        import libtorrent as lt
    except ImportError:
        print('Торренты выключены: нет libtorrent (sudo apt install python3-libtorrent)')
        return None
    return Downloader(lt, cfg['media_dir'], int(cfg.get('torrent_port', 6881)))


def main():
    d = start(load_config())
    if not d:
        return 1
    print(f'Слежу за {d.watch}, Ctrl+C для выхода')
    try:
        d.run()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    sys.exit(main())
