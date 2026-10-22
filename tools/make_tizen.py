#!/usr/bin/env python3
"""Собирает приложение для Samsung TV (.wgt) и, если есть Tizen CLI, ставит его на телевизор.

    python3 tools/make_tizen.py                       # только подготовить build/tizen
    python3 tools/make_tizen.py --tv 192.168.0.50     # собрать, подписать и установить на ТВ

Сертификат подписи создаётся один раз в Tizen Studio → Certificate Manager (профиль Samsung).
Имя профиля передай через --profile (по умолчанию «tv»).
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server import app_token, lan_ip  # noqa: E402
from sorter import ROOT, load_config  # noqa: E402

TIZEN_CANDIDATES = ['tizen', '/mnt/c/tizen-studio/tools/ide/bin/tizen.bat',
                    'C:/tizen-studio/tools/ide/bin/tizen.bat']
SDB_CANDIDATES = ['sdb', '/mnt/c/tizen-studio/tools/sdb.exe', 'C:/tizen-studio/tools/sdb.exe']


def find(cands):
    for c in cands:
        if shutil.which(c) or Path(c).exists():
            return c
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--server', help='адрес ПК, по умолчанию текущий IP в локальной сети')
    ap.add_argument('--tv', help='IP телевизора (в режиме разработчика) для установки')
    ap.add_argument('--profile', default='tv', help='профиль сертификата Tizen')
    a = ap.parse_args()

    server = a.server or f"http://{lan_ip()}:{load_config()['port']}"
    if not server.startswith('http'):
        server = 'http://' + server
    out = ROOT / 'build' / 'tizen'
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / 'web', out)
    (out / 'server-url.js').write_text(f"window.SERVER_URL = '{server}';\nwindow.APP_TOKEN = '{app_token()}';\n",
                                      encoding='utf-8')
    print(f'Подготовлено: {out}\nАдрес сервера в приложении: {server}')

    tizen = find(TIZEN_CANDIDATES)
    if not tizen:
        print('\nTizen CLI не найден. Установи Tizen Studio (см. README) или собери проект build/tizen вручную.')
        return
    win = tizen.endswith('.bat')

    def path(p):  # путь для Windows-версии Tizen Studio
        if not win:
            return str(p)
        return subprocess.check_output(['wslpath', '-w', str(p)], text=True).strip()

    def run(*cmd):
        cmd = list(cmd)
        if win and cmd[0].endswith('.bat'):
            cmd = ['cmd.exe', '/c', path(Path(cmd[0])) if cmd[0].startswith('/') else cmd[0]] + cmd[1:]
        print('$', ' '.join(cmd))
        subprocess.run(cmd, check=True)

    run(tizen, 'package', '-t', 'wgt', '-s', a.profile, '--', path(out))
    wgt = next(out.glob('*.wgt'))
    print(f'Пакет: {wgt}')
    if a.tv:
        sdb = find(SDB_CANDIDATES)
        run(sdb, 'connect', a.tv)
        target = subprocess.check_output([sdb, 'devices'], text=True).strip().splitlines()[-1].split()[-1]
        run(tizen, 'install', '-n', path(wgt), '-t', target)
        print('Готово! Приложение «Кинополка» появилось на телевизоре.')


if __name__ == '__main__':
    main()
