/* Кинополка — интерфейс для Samsung Tizen TV (и любого браузера).
 * Пишем без async/await и прочих новинок: на ТВ 2017–2018 годов старый Chromium. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- утилиты
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const IS_TIZEN = typeof window.tizen !== 'undefined';
  const HAS_AVPLAY = typeof window.webapis !== 'undefined' && !!window.webapis.avplay;

  function serverUrl() {
    if (location.protocol.indexOf('http') === 0) return '';
    let s = window.SERVER_URL || '';
    try { s = localStorage.getItem('server') || s; } catch (e) { /* нет хранилища */ }
    return s.replace(/\/+$/, '');
  }
  let API = serverUrl();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function el(html) {
    const d = document.createElement('div');
    d.innerHTML = html.trim();
    // Tizen по умолчанию запрещает style="..." в разметке (CSP), а element.style — нет.
    // Поэтому динамические стили передаём через data-атрибуты и выставляем тут.
    Array.prototype.forEach.call(d.querySelectorAll('[data-bg], [data-w]'), (n) => {
      if (n.dataset.bg) n.style.background = n.dataset.bg;
      if (n.dataset.w) n.style.width = n.dataset.w + '%';
    });
    return d.firstChild;
  }
  // приложение на ТВ подтверждает себя токеном (вшивается при сборке), браузеру на ПК он не нужен
  function headers(extra) {
    const h = extra || {};
    if (window.APP_TOKEN) h['X-App-Token'] = window.APP_TOKEN;
    return h;
  }
  function api(path) {
    return fetch(API + path, { headers: headers() }).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function post(path, body) {
    return fetch(API + path, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) })
      .then((r) => r.json()).catch(() => null);
  }
  function mediaUrl(rel) {
    return API + '/media/' + rel.split('/').map(encodeURIComponent).join('/');
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
    return n + ' ' + w;
  }
  function fmtSize(b) {
    return b > 1e9 ? (b / 1e9).toFixed(1) + ' ГБ' : Math.round(b / 1e6) + ' МБ';
  }
  function epCode(e) {
    return 'S' + (e.season < 10 ? '0' : '') + e.season + 'E' + (e.episode < 10 ? '0' : '') + e.episode;
  }
  let toastTimer;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  const ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6L18 18V6z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
    audio: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
    subs: '<svg viewBox="0 0 24 24"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
    restart: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
  };

  // ---------------------------------------------------------------- масштаб под окно браузера
  function fit() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    app.style.transform = s === 1 ? '' : 'scale(' + s + ')';
  }
  window.addEventListener('resize', fit);
  fit();

  // ---------------------------------------------------------------- фон
  let backdropUrl = null;
  function setBackdrop(rel) {
    const url = rel ? mediaUrl(rel) : null;
    if (url === backdropUrl) return;
    backdropUrl = url;
    const img = $('backdrop-img');
    img.classList.remove('on');
    if (!url) return;
    const pre = new Image();
    pre.onload = () => {
      if (backdropUrl !== url) return;
      img.style.backgroundImage = 'url("' + url + '")';
      img.classList.add('on');
    };
    pre.src = url;
  }

  // ---------------------------------------------------------------- карточки
  function hue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }
  function artHtml(item, title, sub) {
    if (item.poster) return '<img src="' + esc(mediaUrl(item.poster)) + '" alt="">';
    const h = hue(title);
    const bg = 'linear-gradient(155deg, hsl(' + h + ',55%,42%) 0%, hsl(' + ((h + 40) % 360) + ',60%,16%) 100%)';
    return '<div class="ph" data-bg="' + bg + '"><div class="ph-letter">' + esc(title.charAt(0).toUpperCase()) +
      '</div><div class="ph-title">' + esc(title) + '</div>' + (sub ? '<div class="ph-sub">' + esc(sub) + '</div>' : '') + '</div>';
  }
  function progressHtml(p) {
    if (!p || p.watched || !p.dur || p.pos < 5) return '';
    return '<div class="pbar"><div data-w="' + Math.min(100, p.pos / p.dur * 100).toFixed(1) + '"></div></div>';
  }
  function itemTitle(it) {
    return it.type === 'episode' ? it.showTitle : it.title;
  }
  function itemMeta(it) {
    if (it.type === 'show') {
      const parts = [plural(it.seasonCount, 'сезон', 'сезона', 'сезонов'), plural(it.episodeCount, 'серия', 'серии', 'серий')];
      if (it.watchedCount) parts.push('просмотрено ' + it.watchedCount);
      return parts.join(' · ');
    }
    if (it.type === 'episode') {
      const p = it.progress;
      return epCode(it) + (p && p.pos > 5 && !p.watched ? ' · осталось ' + fmtTime(p.dur - p.pos) : '');
    }
    const parts = ['Фильм'];
    if (it.year) parts.push(it.year);
    const p = it.progress;
    if (p && p.watched) parts.push('просмотрен');
    else if (p && p.pos > 5) parts.push('осталось ' + fmtTime(p.dur - p.pos));
    return parts.join(' · ');
  }

  function makeCard(item, opts) {
    opts = opts || {};
    const wide = !!opts.wide;
    const title = itemTitle(item);
    const sub = item.type === 'episode' ? epCode(item) : item.year || '';
    let badge = '';
    if (item.type === 'show' && item.watchedCount && item.watchedCount === item.episodeCount) badge = '<div class="badge ok">✓</div>';
    else if (item.type === 'movie' && item.progress && item.progress.watched) badge = '<div class="badge ok">✓</div>';
    else if (item.type === 'episode') badge = '<div class="badge">' + epCode(item) + '</div>';
    const card = el('<div class="card focusable' + (wide ? ' wide' : '') + '"><div class="art">' + artHtml(item, title, wide && item.type !== 'episode' ? sub : '') +
      badge + progressHtml(item.progress) + '</div><div class="label">' + esc(wide ? title + ' — ' + item.title : title) + '</div></div>');
    card.dataset.key = (opts.row || '') + ':' + item.id;
    card.tvFocus = () => {
      setBackdrop(item.backdrop || item.poster);
      if (opts.onFocus) opts.onFocus(item);
    };
    card.tvSelect = () => openItem(item);
    return card;
  }

  function openItem(item) {
    if (item.type === 'show') pushScreen(showScreen(item.id));
    else if (item.type === 'movie') pushScreen(movieScreen(item));
    else if (item.type === 'episode') {
      api('/api/show?id=' + encodeURIComponent(item.show)).then((show) => {
        const list = flatEpisodes(show);
        Player.start(list, Math.max(0, indexOf(list, item.file)), show);
      }).catch(() => toast('Не удалось загрузить сериал'));
    }
  }
  function flatEpisodes(show) {
    const out = [];
    show.seasons.forEach((s) => s.episodes.forEach((e) => out.push(e)));
    return out;
  }
  function indexOf(list, file) {
    for (let i = 0; i < list.length; i++) if (list[i].file === file) return i;
    return -1;
  }

  // ---------------------------------------------------------------- навигация пультом
  let focused = null;
  let modalScope = null; // плеер или меню перехватывают навигацию

  function focus(node) {
    if (!node) return;
    if (focused) focused.classList.remove('focused');
    focused = node;
    node.classList.add('focused');
    const mem = node.closest('[data-remember]');
    if (mem) mem.tvLast = node;
    ensureVisible(node);
    if (node.tvFocus) node.tvFocus();
  }

  function scopeRoots() {
    if (modalScope) return [modalScope];
    const cur = currentScreen();
    return [$('topbar')].concat(cur ? [cur.el] : []);
  }

  function visible(n) {
    return n.offsetParent !== null || n === focused;
  }

  function move(dir) {
    if (!focused) return focusFirst();
    const r = focused.getBoundingClientRect();
    let cands = [];
    scopeRoots().forEach((root) => {
      Array.prototype.forEach.call(root.querySelectorAll('.focusable'), (n) => {
        if (n !== focused && visible(n)) cands.push(n);
      });
    });
    const scored = [];
    cands.forEach((n) => {
      const c = n.getBoundingClientRect();
      let gap, ortho;
      if (dir === 'right') { if (c.left < r.right - 4) return; gap = c.left - r.right; ortho = Math.abs((c.top + c.bottom) / 2 - (r.top + r.bottom) / 2); }
      if (dir === 'left') { if (c.right > r.left + 4) return; gap = r.left - c.right; ortho = Math.abs((c.top + c.bottom) / 2 - (r.top + r.bottom) / 2); }
      if (dir === 'down') { if (c.top < r.bottom - 4) return; gap = c.top - r.bottom; ortho = Math.abs((c.left + c.right) / 2 - (r.left + r.right) / 2); }
      if (dir === 'up') { if (c.bottom > r.top + 4) return; gap = r.top - c.bottom; ortho = Math.abs((c.left + c.right) / 2 - (r.left + r.right) / 2); }
      // для горизонтали отбрасываем то, что совсем не на нашей "строке"
      if ((dir === 'left' || dir === 'right') && ortho > Math.max(r.height, c.height)) return;
      scored.push({ n: n, gap: Math.max(0, gap), ortho: ortho });
    });
    if (!scored.length) return false;
    const minGap = Math.min.apply(null, scored.map((s) => s.gap));
    const line = scored.filter((s) => s.gap <= minGap + 60);
    line.sort((a, b) => a.ortho - b.ortho);
    let target = line[0].n;
    // в строку возвращаемся на ту карточку, где были
    const mem = target.closest('[data-remember]');
    if (mem && mem !== focused.closest('[data-remember]') && mem.tvLast && mem.contains(mem.tvLast)) target = mem.tvLast;
    focus(target);
    return true;
  }

  function focusFirst(root) {
    const roots = root ? [root] : scopeRoots().slice().reverse();
    for (let i = 0; i < roots.length; i++) {
      const n = roots[i].querySelector('.focusable');
      if (n) { focus(n); return true; }
    }
    return false;
  }

  function offsetWithin(node, ancestor) {
    let x = 0, y = 0;
    while (node && node !== ancestor) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent;
    }
    return { x: x, y: y };
  }

  function ensureVisible(node) {
    // горизонтальная лента
    const items = node.closest('.row-items');
    if (items) {
      const track = items.parentNode;
      const maxX = Math.max(0, items.scrollWidth + 80 - track.clientWidth);
      const x = Math.min(Math.max(0, node.offsetLeft - 80), maxX);
      items.style.transform = 'translateX(' + -x + 'px)';
    }
    // вертикальная прокрутка экрана
    const inner = node.closest('.scroll-inner');
    if (!inner) return;
    const box = inner.parentNode;
    const viewH = box.clientHeight;
    const pos = offsetWithin(node, inner);
    let y = inner.tvY || 0;
    const row = node.closest('.row');
    if (row && inner.dataset.snap === 'rows') {
      y = offsetWithin(row, inner).y;
    } else {
      const top = pos.y, bottom = pos.y + node.offsetHeight;
      const padTop = Number(inner.dataset.padTop || 140), padBottom = 80;
      if (top - y < padTop) y = top - padTop;
      if (bottom - y > viewH - padBottom) y = bottom - viewH + padBottom;
      y = Math.max(0, Math.min(y, Math.max(0, inner.offsetHeight - viewH + padBottom)));
    }
    inner.tvY = y;
    inner.style.transform = 'translateY(' + -y + 'px)';
  }

  // ---------------------------------------------------------------- стек экранов
  const stack = [];
  function currentScreen() { return stack[stack.length - 1]; }

  function pushScreen(scr) {
    const cur = currentScreen();
    if (cur) {
      cur.focusKey = focused && focused.dataset.key;
      cur.el.classList.add('hidden');
    }
    stack.push(scr);
    $('screens').appendChild(scr.el);
    scr.load();
  }
  function popScreen() {
    if (stack.length <= 1) return false;
    const top = stack.pop();
    top.el.parentNode.removeChild(top.el);
    const cur = currentScreen();
    cur.el.classList.remove('hidden');
    cur.load(true);
    return true;
  }
  function restoreFocus(scr, fallback) {
    let n = null;
    if (scr.focusKey) {
      const all = scr.el.querySelectorAll('.focusable');
      for (let i = 0; i < all.length; i++) if (all[i].dataset.key === scr.focusKey) { n = all[i]; break; }
    }
    focus(n || fallback || scr.el.querySelector('.focusable') || document.querySelector('#tabs .tab.active'));
  }

  let activeTab = 'home';
  function setTab(name) {
    if (name === 'refresh') {
      toast('Сортирую новые файлы и обновляю библиотеку…');
      post('/api/rescan', {}).then(() => { toast('Библиотека обновлена'); currentScreen().load(true); });
      return;
    }
    while (stack.length) { const s = stack.pop(); s.el.parentNode && s.el.parentNode.removeChild(s.el); }
    activeTab = name;
    Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), (t) => t.classList.toggle('active', t.dataset.tab === name));
    const scr = name === 'shows' ? gridScreen('shows') : name === 'movies' ? gridScreen('movies') : homeScreen();
    scr.focusKey = null;
    pushScreen(scr);
  }
  Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), (t) => {
    t.dataset.key = 'tab:' + t.dataset.tab;
    t.tvSelect = () => setTab(t.dataset.tab);
    t.tvFocus = () => { if (stack.length === 1 && currentScreen().onTabFocus) currentScreen().onTabFocus(); };
  });

  function errorScreenHtml(err) {
    return '<div class="grid-head">Нет связи с компьютером</div><div class="empty">Проверь, что на ПК запущен сервер (<code>start.sh</code>), ' +
      'и что ТВ и ПК в одной сети.<br>Адрес сервера: <code>' + esc(API || location.host) + '</code><br><small>' + esc(err) + '</small></div>' +
      (IS_TIZEN ? '<div class="buttons error-actions"><div class="btn focusable" id="change-server">Изменить адрес</div></div>' : '');
  }
  function bindErrorButtons(root) {
    const b = root.querySelector('#change-server');
    if (b) b.tvSelect = () => setupScreen();
  }

  // ---------------------------------------------------------------- главная
  function homeScreen() {
    const scr = { el: el('<section class="screen"></section>') };
    let data = null;
    const spot = el('<div class="spotlight"><div class="spot-title"></div><div class="spot-meta"></div><div class="spot-hint"></div></div>');

    function setSpot(it) {
      if (!it) {
        spot.querySelector('.spot-title').textContent = 'Добро пожаловать';
        spot.querySelector('.spot-meta').innerHTML = data ? plural(data.shows.length, 'сериал', 'сериала', 'сериалов') + ' · ' +
          plural(data.movies.length, 'фильм', 'фильма', 'фильмов') : '';
        spot.querySelector('.spot-hint').textContent = '';
        return;
      }
      spot.querySelector('.spot-title').textContent = itemTitle(it);
      spot.querySelector('.spot-meta').innerHTML = it.type === 'episode'
        ? '<b>' + esc(epCode(it)) + '</b> · ' + esc(itemMeta(it).replace(epCode(it) + ' · ', '').replace(epCode(it), it.title))
        : esc(itemMeta(it));
      spot.querySelector('.spot-hint').textContent = it.type === 'show' ? 'OK — открыть сериал' : 'OK — смотреть';
    }
    scr.onTabFocus = () => { setSpot(null); setBackdrop(null); };

    function row(title, items, opts) {
      if (!items.length) return null;
      const r = el('<div class="row"><div class="row-title">' + esc(title) + '<span>' + items.length + '</span></div>' +
        '<div class="row-track"><div class="row-items" data-remember="1"></div></div></div>');
      const box = r.querySelector('.row-items');
      items.forEach((it) => box.appendChild(makeCard(it, { wide: opts.wide, row: opts.key, onFocus: setSpot })));
      return r;
    }

    scr.load = (resume) => {
      api('/api/home').then((d) => {
        data = d;
        scr.el.innerHTML = '';
        scr.el.appendChild(spot);
        const box = el('<div class="scroller rows-area"><div class="scroll-inner" data-snap="rows"></div></div>');
        const inner = box.firstChild;
        [row('Продолжить просмотр', d.continue, { wide: true, key: 'c' }),
          row('Недавно добавленные', d.recent, { key: 'r' }),
          row('Сериалы', d.shows, { key: 's' }),
          row('Фильмы', d.movies, { key: 'm' })].forEach((r) => r && inner.appendChild(r));
        if (!d.shows.length && !d.movies.length) {
          inner.appendChild(el('<div class="empty">Библиотека пуста. Скопируй скачанные фильмы и сериалы в папку<br>' +
            '<code>media/inbox</code> на компьютере — они сами разложатся по полкам в течение минуты.</div>'));
        }
        scr.el.appendChild(box);
        setSpot(null);
        restoreFocus(scr, resume ? null : inner.querySelector('.focusable'));
      }).catch((e) => {
        scr.el.innerHTML = errorScreenHtml(e.message);
        bindErrorButtons(scr.el);
        focusFirst(scr.el) || focus(document.querySelector('#tabs .tab'));
      });
    };
    return scr;
  }

  // ---------------------------------------------------------------- сетка сериалов / фильмов
  function gridScreen(kind) {
    const scr = { el: el('<section class="screen"></section>') };
    scr.onTabFocus = () => setBackdrop(null);
    scr.load = (resume) => {
      api('/api/home').then((d) => {
        const items = kind === 'shows' ? d.shows : d.movies;
        scr.el.innerHTML = '';
        const box = el('<div class="scroller"><div class="scroll-inner"><div class="grid-head">' + (kind === 'shows' ? 'Сериалы' : 'Фильмы') +
          '<span>' + items.length + '</span></div><div class="grid"></div></div></div>');
        const grid = box.querySelector('.grid');
        items.forEach((it) => grid.appendChild(makeCard(it, { row: kind })));
        if (!items.length) grid.appendChild(el('<div class="empty">Пока пусто. Кидай файлы в <code>media/inbox</code>.</div>'));
        scr.el.appendChild(box);
        restoreFocus(scr, grid.querySelector('.focusable'));
      }).catch((e) => { scr.el.innerHTML = errorScreenHtml(e.message); bindErrorButtons(scr.el); focusFirst(); });
    };
    return scr;
  }

  // ---------------------------------------------------------------- сериал
  function showScreen(id) {
    const scr = { el: el('<section class="screen"></section>') };
    let season = null;

    scr.load = (resume) => {
      api('/api/show?id=' + encodeURIComponent(id)).then((show) => {
        const list = flatEpisodes(show);
        if (season === null) season = show.next ? show.next.season : show.seasons[0].season;
        setBackdrop(show.backdrop || show.poster);
        scr.el.innerHTML = '';
        const box = el('<div class="scroller"><div class="scroll-inner"></div></div>');
        const inner = box.firstChild;
        const nxt = show.next;
        let playLabel = 'Смотреть';
        if (nxt) {
          const p = nxt.progress;
          playLabel = (p && p.pos > 5 && !p.watched ? 'Продолжить ' : 'Смотреть ') + epCode(nxt);
        } else if (show.watchedCount) {
          playLabel = 'Пересмотреть';
        }
        const top = el('<div class="detail-top"><div class="detail-poster">' + artHtml(show, show.title, '') + '</div><div class="detail-info">' +
          '<div class="detail-title">' + esc(show.title) + '</div><div class="detail-meta">' + esc(itemMeta(show)) + '</div>' +
          '<div class="buttons">' +
          '<div class="btn primary focusable" data-key="play">' + ICONS.play + esc(playLabel) + '</div>' +
          '<div class="btn focusable" data-key="mark">' + ICONS.check + 'Сезон просмотрен</div>' +
          '<div class="btn focusable" data-key="unmark">' + ICONS.restart + 'Снять отметки</div>' +
          '</div></div></div>');
        inner.appendChild(top);
        top.querySelector('[data-key=play]').tvSelect = () => {
          const i = nxt ? indexOf(list, nxt.file) : 0;
          Player.start(list, Math.max(0, i), show);
        };
        const seasonFiles = () => show.seasons.filter((s) => s.season === season)[0].episodes.map((e) => e.file);
        top.querySelector('[data-key=mark]').tvSelect = () => {
          post('/api/watched', { files: seasonFiles(), watched: true }).then(() => { toast('Сезон отмечен просмотренным'); scr.focusKey = 'mark'; scr.load(true); });
        };
        top.querySelector('[data-key=unmark]').tvSelect = () => {
          post('/api/watched', { files: seasonFiles(), watched: false }).then(() => { toast('Отметки сняты'); scr.focusKey = 'unmark'; scr.load(true); });
        };

        const tabs = el('<div class="seasons" data-remember="1"></div>');
        const eps = el('<div class="episodes"></div>');
        function renderSeason() {
          eps.innerHTML = '';
          const s = show.seasons.filter((x) => x.season === season)[0] || show.seasons[0];
          s.episodes.forEach((e) => {
            const p = e.progress;
            const watched = p && p.watched;
            const sub = watched ? 'Просмотрено' : p && p.pos > 5 ? 'Осталось ' + fmtTime(p.dur - p.pos) : epCode(e);
            const n = el('<div class="ep focusable' + (watched ? ' watched' : '') + '"><div class="ep-num">' + e.episode + '</div><div>' +
              '<div class="ep-title">' + esc(e.title) + '</div><div class="ep-sub">' + esc(sub) + (e.subs.length ? ' · субтитры' : '') +
              '</div></div>' + progressHtml(p) + '</div>');
            n.dataset.key = 'ep:' + e.file;
            n.tvSelect = () => Player.start(list, indexOf(list, e.file), show);
            eps.appendChild(n);
          });
        }
        if (show.seasons.length > 1) {
          show.seasons.forEach((s) => {
            const t = el('<div class="season-tab focusable' + (s.season === season ? ' active' : '') + '">' + esc(s.title) + '</div>');
            t.dataset.key = 'season:' + s.season;
            t.tvFocus = () => {
              if (season === s.season) return;
              season = s.season;
              Array.prototype.forEach.call(tabs.children, (c) => c.classList.toggle('active', c === t));
              renderSeason();
            };
            if (s.season === season) tabs.tvLast = t;
            tabs.appendChild(t);
          });
          inner.appendChild(tabs);
        }
        inner.appendChild(eps);
        renderSeason();
        scr.el.appendChild(box);
        restoreFocus(scr, top.querySelector('[data-key=play]'));
      }).catch((e) => { scr.el.innerHTML = errorScreenHtml(e.message); bindErrorButtons(scr.el); focusFirst(); });
    };
    return scr;
  }

  // ---------------------------------------------------------------- фильм
  function movieScreen(movie) {
    const scr = { el: el('<section class="screen"></section>') };
    scr.load = (resume) => {
      // свежий прогресс берём с сервера
      api('/api/home').then((d) => {
        const m = d.movies.filter((x) => x.id === movie.id)[0] || movie;
        setBackdrop(m.backdrop || m.poster);
        const p = m.progress;
        const resumeable = p && !p.watched && p.pos > 30;
        const meta = [m.year, fmtSize(m.size), m.subs.length ? 'субтитры: ' + m.subs.map((s) => s.label).join(', ') : '']
          .filter(Boolean).map(esc).join('<span class="dot">•</span>');
        scr.el.innerHTML = '';
        const top = el('<div class="detail-top"><div class="detail-poster">' + artHtml(m, m.title, m.year) + '</div><div class="detail-info">' +
          '<div class="detail-title">' + esc(m.title) + '</div><div class="detail-meta">' + meta + '</div><div class="buttons">' +
          (resumeable ? '<div class="btn primary focusable" data-key="resume">' + ICONS.play + 'Продолжить с ' + fmtTime(p.pos) + '</div>' +
            '<div class="btn focusable" data-key="start">' + ICONS.restart + 'Сначала</div>'
            : '<div class="btn primary focusable" data-key="start">' + ICONS.play + 'Смотреть</div>') +
          '<div class="btn focusable" data-key="mark">' + ICONS.check + (p && p.watched ? 'Не просмотрен' : 'Просмотрен') + '</div>' +
          '</div></div></div>');
        const r = top.querySelector('[data-key=resume]');
        if (r) r.tvSelect = () => Player.start([m], 0, null);
        top.querySelector('[data-key=start]').tvSelect = () => Player.start([m], 0, null, true);
        top.querySelector('[data-key=mark]').tvSelect = () => {
          post('/api/watched', { files: [m.file], watched: !(p && p.watched) }).then(() => { scr.focusKey = 'mark'; scr.load(true); });
        };
        scr.el.appendChild(top);
        restoreFocus(scr, top.querySelector('.btn'));
      }).catch((e) => { scr.el.innerHTML = errorScreenHtml(e.message); bindErrorButtons(scr.el); focusFirst(); });
    };
    return scr;
  }

  // ---------------------------------------------------------------- адрес сервера (для приложения на ТВ)
  function setupScreen() {
    while (stack.length) { const s = stack.pop(); s.el.parentNode && s.el.parentNode.removeChild(s.el); }
    const scr = { el: el('<section class="screen setup"><h1>Подключение к компьютеру</h1>' +
      '<p>Введи адрес, который показывает сервер при запуске на ПК, например <b>192.168.0.176:8090</b></p>' +
      '<input id="srv" class="focusable" type="text" value="' + esc(API.replace(/^https?:\/\//, '') || '192.168.0.') + '">' +
      '<div class="buttons"><div class="btn primary focusable" id="srv-ok">Подключиться</div></div></section>') };
    scr.load = () => {
      const inp = scr.el.querySelector('#srv');
      inp.tvSelect = () => inp.focus();
      scr.el.querySelector('#srv-ok').tvSelect = () => {
        let v = inp.value.trim();
        if (!/^https?:\/\//.test(v)) v = 'http://' + v;
        if (!/:\d+$/.test(v)) v += ':8090';
        try { localStorage.setItem('server', v); } catch (e) { /* ignore */ }
        API = v;
        setTab('home');
      };
      focus(inp);
    };
    pushScreen(scr);
  }

  // ---------------------------------------------------------------- меню выбора
  const Menu = {
    open(title, items) {
      $('menu-title').textContent = title;
      const box = $('menu-items');
      box.innerHTML = '';
      let act = null;
      items.forEach((it) => {
        const n = el('<div class="mitem focusable' + (it.active ? ' active' : '') + '">' + esc(it.label) + '</div>');
        n.tvSelect = () => { Menu.close(); it.onSelect(); };
        if (it.active) act = n;
        box.appendChild(n);
      });
      this.prevFocus = focused;
      this.prevScope = modalScope;
      $('menu').classList.remove('hidden');
      modalScope = $('menu');
      focus(act || box.firstChild);
    },
    close() {
      $('menu').classList.add('hidden');
      modalScope = this.prevScope;
      focus(this.prevFocus);
    },
    isOpen() { return !$('menu').classList.contains('hidden'); },
  };

  // ---------------------------------------------------------------- движки воспроизведения
  // AVPlay — родной плеер Samsung: MKV, AC3/DTS, несколько аудиодорожек, встроенные субтитры.
  const AvEngine = {
    name: 'av',
    open(url, start, ev) {
      const av = webapis.avplay;
      try { av.stop(); av.close(); } catch (e) { /* ещё не открыт */ }
      this.ev = ev;
      this.cur = start;
      av.open(url);
      av.setDisplayRect(0, 0, 1920, 1080);
      try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) { /* старые модели */ }
      av.setListener({
        onbufferingstart: () => ev.buffering(true),
        onbufferingcomplete: () => ev.buffering(false),
        oncurrentplaytime: (ms) => { this.cur = ms / 1000; },
        onstreamcompleted: () => ev.ended(),
        onerror: (e) => ev.error(String(e)),
        onsubtitlechange: (dur, text) => ev.subtitle(text, dur),
      });
      try { av.setSilentSubtitle(true); } catch (e) { /* ignore */ }
      ev.buffering(true);
      av.prepareAsync(() => {
        ev.buffering(false);
        av.play();
        if (start > 0) av.seekTo(Math.floor(start * 1000), () => {}, () => {});
        ev.ready();
      }, (e) => ev.error(String(e)));
    },
    time() { return this.cur; },
    duration() { try { return webapis.avplay.getDuration() / 1000; } catch (e) { return 0; } },
    paused() { try { return webapis.avplay.getState() === 'PAUSED'; } catch (e) { return false; } },
    play() { webapis.avplay.play(); },
    pause() { webapis.avplay.pause(); },
    seek(t) {
      this.cur = t;
      this.ev.buffering(true);
      webapis.avplay.seekTo(Math.floor(t * 1000), () => this.ev.buffering(false), () => this.ev.buffering(false));
    },
    tracks(type) {
      let info = [];
      try { info = webapis.avplay.getTotalTrackInfo(); } catch (e) { return []; }
      let current = -1;
      try {
        webapis.avplay.getCurrentStreamInfo().forEach((s) => { if (s.type === type) current = s.index; });
      } catch (e) { /* ignore */ }
      const out = [];
      for (let i = 0; i < info.length; i++) {
        const t = info[i];
        if (t.type !== type) continue;
        let x = {};
        try { x = JSON.parse(t.extra_info); } catch (e) { /* бывает не JSON */ }
        const parts = [];
        if (x.language) parts.push(String(x.language).toUpperCase());
        if (x.fourCC && type === 'AUDIO') parts.push(String(x.fourCC).toUpperCase());
        if (x.channels) parts.push(x.channels + ' кан.');
        out.push({ index: t.index, label: (type === 'AUDIO' ? 'Дорожка ' : 'Встроенные ') + (out.length + 1) +
          (parts.length ? ' · ' + parts.join(' · ') : ''), active: t.index === current });
      }
      return out;
    },
    selectAudio(idx) { webapis.avplay.setSelectTrack('AUDIO', idx); },
    selectText(idx) {
      if (idx < 0) { webapis.avplay.setSilentSubtitle(true); return; }
      webapis.avplay.setSilentSubtitle(false);
      webapis.avplay.setSelectTrack('TEXT', idx);
    },
    destroy() { try { webapis.avplay.stop(); webapis.avplay.close(); } catch (e) { /* ignore */ } },
    suspend() { try { webapis.avplay.suspend(); } catch (e) { /* ignore */ } },
    restore() { try { webapis.avplay.restore(); } catch (e) { /* ignore */ } },
  };

  // HTML5 <video> — для проверки в браузере на ПК (MP4/H.264 работает, MKV — как повезёт).
  const HtmlEngine = {
    name: 'html',
    open(url, start, ev) {
      const v = $('video');
      this.ev = ev;
      v.onwaiting = () => ev.buffering(true);
      v.onplaying = () => ev.buffering(false);
      v.oncanplay = () => ev.buffering(false);
      v.onended = () => ev.ended();
      v.onerror = () => ev.error(v.error ? 'код ' + v.error.code : 'неизвестно');
      v.onloadedmetadata = () => {
        if (start > 0) v.currentTime = start;
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
        ev.ready();
      };
      ev.buffering(true);
      v.src = url;
      v.load();
    },
    time() { return $('video').currentTime || 0; },
    duration() { return $('video').duration || 0; },
    paused() { return $('video').paused; },
    play() { $('video').play(); },
    pause() { $('video').pause(); },
    seek(t) { $('video').currentTime = t; },
    tracks(type) {
      const at = $('video').audioTracks;
      if (type !== 'AUDIO' || !at || at.length < 2) return [];
      const out = [];
      for (let i = 0; i < at.length; i++) {
        out.push({ index: i, label: 'Дорожка ' + (i + 1) + (at[i].language ? ' · ' + at[i].language.toUpperCase() : ''), active: at[i].enabled });
      }
      return out;
    },
    selectAudio(idx) {
      const at = $('video').audioTracks;
      for (let i = 0; i < at.length; i++) at[i].enabled = i === idx;
    },
    selectText() {},
    destroy() { const v = $('video'); v.pause(); v.removeAttribute('src'); v.load(); },
    suspend() {},
    restore() {},
  };

  // ---------------------------------------------------------------- плеер
  const Player = {
    active: false,

    start(list, idx, show, fromStart) {
      this.list = list;
      this.show = show;
      this.prevFocus = focused;
      this.prevScope = modalScope;
      this.active = true;
      this.engine = HAS_AVPLAY ? AvEngine : HtmlEngine;
      document.documentElement.classList.add('playing', HAS_AVPLAY ? 'av-mode' : 'video-mode');
      $('player').classList.remove('hidden');
      modalScope = $('player');
      clearInterval(this.tick);
      this.tick = setInterval(() => this.update(), 250);
      this.load(idx, fromStart);
    },

    load(idx, fromStart) {
      this.saveProgress();
      this.idx = idx;
      const it = this.item = this.list[idx];
      this.dur = 0;
      this.lastSave = 0;
      this.ending = false;
      this.cues = null;
      this.cueIdx = 0;
      this.subMode = 'off';
      this.subText = '';
      $('subtitle').textContent = '';
      $('next-card').classList.add('hidden');
      $('player-msg').classList.add('hidden');
      $('osd-title').textContent = it.type === 'episode' ? it.showTitle : it.title;
      $('osd-sub').textContent = it.type === 'episode' ? 'Сезон ' + it.season + ', серия ' + it.episode : (it.year || '');
      this.buildButtons();
      const p = it.progress;
      const start = !fromStart && p && !p.watched && p.pos > 10 ? p.pos - 3 : 0;
      this.pos = start;
      // внешние субтитры: включаем первые найденные, предпочитая русские
      if (it.subs && it.subs.length) {
        const ru = it.subs.filter((s) => /rus|ru\b|рус/i.test(s.label))[0] || it.subs[0];
        this.loadExternalSubs(ru);
      }
      this.engine.open(mediaUrl(it.file), start, {
        ready: () => { this.dur = this.engine.duration(); },
        buffering: (on) => $('player').classList.toggle('loading', on),
        ended: () => this.onEnded(),
        error: (msg) => this.showError(msg),
        subtitle: (text) => { if (this.subMode === 'embedded') this.setSubtitle(text); },
      });
      this.showOsd('play');
    },

    buildButtons() {
      const box = $('osd-buttons');
      box.innerHTML = '';
      const add = (key, icon, text, fn) => {
        const b = el('<div class="obtn focusable" data-key="' + key + '">' + ICONS[icon] + (text ? '<span>' + esc(text) + '</span>' : '') + '</div>');
        b.tvSelect = fn;
        box.appendChild(b);
        return b;
      };
      if (this.idx > 0) add('prev', 'prev', '', () => this.load(this.idx - 1, true));
      this.playBtn = add('play', 'pause', '', () => this.togglePause());
      if (this.idx < this.list.length - 1) add('next', 'next', 'След. серия', () => this.load(this.idx + 1, true));
      add('audio', 'audio', 'Звук', () => this.audioMenu());
      add('subs', 'subs', 'Субтитры', () => this.subsMenu());
      $('seekbar').dataset.key = 'seek';
    },

    togglePause() {
      if (this.engine.paused()) this.engine.play(); else this.engine.pause();
      setTimeout(() => this.updatePlayIcon(), 50);
      this.showOsd();
    },
    updatePlayIcon() {
      if (this.playBtn) this.playBtn.innerHTML = this.engine.paused() ? ICONS.play : ICONS.pause;
    },

    showOsd(focusKey) {
      $('player').classList.add('osd-on');
      if (focusKey) {
        const n = $('player').querySelector('[data-key=' + focusKey + ']');
        if (n) focus(n);
      } else if (!focused || !$('player').contains(focused)) {
        focus(this.playBtn);
      }
      clearTimeout(this.osdTimer);
      this.osdTimer = setTimeout(() => {
        if (!this.engine.paused() && this.seekTarget == null && !Menu.isOpen()) $('player').classList.remove('osd-on');
      }, 5000);
    },
    osdVisible() { return $('player').classList.contains('osd-on'); },

    // перемотка с накоплением: держишь кнопку — шаг растёт
    seekBy(dir) {
      const now = Date.now();
      this.seekCount = now - (this.lastSeekKey || 0) < 450 ? (this.seekCount || 0) + 1 : 0;
      this.lastSeekKey = now;
      const step = this.seekCount < 6 ? 10 : this.seekCount < 20 ? 30 : 60;
      const base = this.seekTarget != null ? this.seekTarget : this.engine.time();
      const dur = this.dur || this.engine.duration();
      this.seekTarget = Math.max(0, Math.min(dur ? dur - 2 : 1e9, base + dir * step));
      this.showOsd('seek');
      this.update();
      clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => {
        const t = this.seekTarget;
        this.seekTarget = null;
        this.engine.seek(t);
        this.pos = t;
        this.cueIdx = 0;
        this.showOsd();
      }, 700);
    },

    update() {
      if (!this.active) return;
      const t = this.engine.time();
      this.pos = t;
      if (!this.dur) this.dur = this.engine.duration();
      const dur = this.dur;
      const shown = this.seekTarget != null ? this.seekTarget : t;
      const pct = dur ? Math.min(100, shown / dur * 100) : 0;
      $('seek-fill').style.width = pct + '%';
      $('seek-knob').style.left = pct + '%';
      $('t-cur').textContent = fmtTime(shown);
      $('t-dur').textContent = dur ? '-' + fmtTime(dur - shown) : '';
      const tip = $('seek-tip');
      tip.textContent = fmtTime(shown);
      tip.classList.toggle('on', this.seekTarget != null);
      this.updatePlayIcon();
      if (this.subMode === 'external' && this.cues) this.renderCue(t);
      if (dur && Date.now() - this.lastSave > 10000 && t > 0) this.saveProgress();
    },

    saveProgress() {
      if (!this.item || !this.dur || !this.pos) return;
      this.lastSave = Date.now();
      const p = { pos: this.pos, dur: this.dur, watched: this.pos / this.dur > 0.92, t: Date.now() / 1000 };
      this.item.progress = p;
      post('/api/progress', { file: this.item.file, pos: this.pos, dur: this.dur });
    },

    // ----- субтитры
    loadExternalSubs(sub) {
      this.subMode = 'external';
      this.subLabel = sub.id;
      this.cues = null;
      api('/api/subs?id=' + encodeURIComponent(sub.id)).then((c) => {
        if (this.subLabel === sub.id) { this.cues = c; this.cueIdx = 0; }
      }).catch(() => toast('Не удалось загрузить субтитры'));
      try { this.engine.selectText(-1); } catch (e) { /* ignore */ }
    },
    renderCue(t) {
      const c = this.cues;
      let i = this.cueIdx;
      if (i >= c.length || (c[i] && c[i].s > t)) i = 0; // перемотали назад
      while (i < c.length && c[i].e < t) i++;
      this.cueIdx = i;
      const txt = i < c.length && c[i].s <= t ? c[i].t : '';
      this.setSubtitle(txt);
    },
    setSubtitle(text) {
      if (text !== this.subText) {
        this.subText = text;
        $('subtitle').textContent = text || '';
      }
    },
    subsMenu() {
      const items = [{ label: 'Выключены', active: this.subMode === 'off', onSelect: () => {
        this.subMode = 'off'; this.subLabel = null; this.setSubtitle(''); try { this.engine.selectText(-1); } catch (e) { /* ignore */ }
      } }];
      (this.item.subs || []).forEach((s) => items.push({
        label: 'Файл: ' + s.label, active: this.subMode === 'external' && this.subLabel === s.id,
        onSelect: () => { this.setSubtitle(''); this.loadExternalSubs(s); },
      }));
      this.engine.tracks('TEXT').forEach((t) => items.push({
        label: t.label, active: this.subMode === 'embedded' && this.subLabel === t.index,
        onSelect: () => {
          this.subMode = 'embedded'; this.subLabel = t.index; this.setSubtitle('');
          try { this.engine.selectText(t.index); } catch (e) { toast('Не удалось включить субтитры'); }
        },
      }));
      Menu.open('Субтитры', items);
    },
    audioMenu() {
      const tracks = this.engine.tracks('AUDIO');
      if (!tracks.length) return toast(HAS_AVPLAY ? 'В файле одна аудиодорожка' : 'Выбор дорожек работает в приложении на ТВ');
      Menu.open('Звуковая дорожка', tracks.map((t) => ({
        label: t.label, active: t.active,
        onSelect: () => { try { this.engine.selectAudio(t.index); toast('Дорожка переключена'); } catch (e) { toast('Не удалось переключить'); } },
      })));
    },

    // ----- конец серии / ошибки
    onEnded() {
      this.pos = this.dur;
      this.saveProgress();
      if (this.idx < this.list.length - 1) {
        const nx = this.list[this.idx + 1];
        let left = 10;
        const card = $('next-card');
        const draw = () => {
          card.innerHTML = 'Следующая серия через <span class="ring">' + left + '</span><b>' + esc(epCode(nx) + ' · ' + nx.title) +
            '</b>OK — сейчас · Назад — выйти';
        };
        draw();
        card.classList.remove('hidden');
        this.ending = true;
        clearInterval(this.nextTimer);
        this.nextTimer = setInterval(() => {
          left--;
          draw();
          if (left <= 0) { clearInterval(this.nextTimer); this.load(this.idx + 1, true); }
        }, 1000);
      } else {
        this.close();
        toast(this.show ? 'Это была последняя серия' : 'Фильм закончился');
      }
    },
    showError(msg) {
      $('player').classList.remove('loading');
      const m = $('player-msg');
      m.innerHTML = '<b>Не получается воспроизвести</b>' + (HAS_AVPLAY
        ? 'Телевизор не поддерживает формат этого файла.'
        : 'Браузер не умеет этот формат (часто MKV/HEVC/AC3). В приложении на ТВ он, скорее всего, заиграет.') +
        '<br><small>' + esc(msg) + '</small><br><br>Назад — выйти';
      m.classList.remove('hidden');
    },

    close() {
      clearInterval(this.tick);
      clearInterval(this.nextTimer);
      clearTimeout(this.seekTimer);
      clearTimeout(this.osdTimer);
      if (this.seekTarget == null) this.saveProgress();
      this.seekTarget = null;
      this.engine.destroy();
      this.active = false;
      this.item = null;
      $('player').classList.add('hidden');
      $('player').classList.remove('osd-on', 'loading');
      document.documentElement.classList.remove('playing', 'av-mode', 'video-mode');
      modalScope = this.prevScope;
      // обновим экран под плеером (прогресс, «продолжить»)
      const cur = currentScreen();
      if (cur) { cur.focusKey = this.prevFocus && this.prevFocus.dataset.key; cur.load(true); }
    },

    key(k) {
      if (this.ending) {
        if (k === 'enter') { clearInterval(this.nextTimer); this.load(this.idx + 1, true); }
        if (k === 'back' || k === 'stop') { clearInterval(this.nextTimer); this.close(); }
        return;
      }
      if (!$('player-msg').classList.contains('hidden')) {
        if (k === 'back' || k === 'enter' || k === 'stop') this.close();
        return;
      }
      switch (k) {
        case 'playpause': return this.togglePause();
        case 'play': this.engine.play(); return this.showOsd();
        case 'pause': this.engine.pause(); return this.showOsd();
        case 'stop': return this.close();
        case 'ff': return this.seekBy(1);
        case 'rw': return this.seekBy(-1);
        case 'next': if (this.idx < this.list.length - 1) this.load(this.idx + 1, true); return;
        case 'prev': if (this.idx > 0) this.load(this.idx - 1, true); return;
      }
      if (!this.osdVisible()) {
        if (k === 'left') return this.seekBy(-1);
        if (k === 'right') return this.seekBy(1);
        if (k === 'enter') return this.togglePause();
        if (k === 'back') return this.close();
        return this.showOsd('play');
      }
      if (k === 'back') { $('player').classList.remove('osd-on'); return; }
      if (focused === $('seekbar') && (k === 'left' || k === 'right')) return this.seekBy(k === 'left' ? -1 : 1);
      if (k === 'enter') {
        if (focused === $('seekbar')) return this.togglePause();
        if (focused && focused.tvSelect) focused.tvSelect();
        return this.showOsd();
      }
      if (k === 'up' && focused !== $('seekbar')) { focus($('seekbar')); return this.showOsd(); }
      move(k);
      this.showOsd();
    },
  };
  $('seekbar').tvSelect = () => Player.togglePause();

  // ---------------------------------------------------------------- клавиши пульта
  const KEYS = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter', 10009: 'back', 27: 'back', 8: 'back',
    10252: 'playpause', 32: 'playpause', 415: 'play', 19: 'pause', 413: 'stop',
    417: 'ff', 412: 'rw', 10233: 'next', 10232: 'prev',
  };
  if (IS_TIZEN) {
    try {
      tizen.tvinputdevice.registerKeyBatch(['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
        'MediaFastForward', 'MediaRewind', 'MediaTrackNext', 'MediaTrackPrevious']);
    } catch (e) { /* ignore */ }
  }

  document.addEventListener('keydown', (e) => {
    const active = document.activeElement;
    if (active && active.tagName === 'INPUT') {
      // экранная клавиатура ТВ: Done=65376, Cancel=65385
      if (e.keyCode === 13 || e.keyCode === 65376 || e.keyCode === 65385 || e.keyCode === 10009 || e.keyCode === 40 || e.keyCode === 38) {
        active.blur();
        if (e.keyCode === 13 || e.keyCode === 65376 || e.keyCode === 40) move('down');
        e.preventDefault();
      }
      return;
    }
    const k = KEYS[e.keyCode];
    if (!k) return;
    e.preventDefault();
    if (Menu.isOpen()) {
      if (k === 'back') Menu.close();
      else if (k === 'enter') { if (focused && focused.tvSelect) focused.tvSelect(); }
      else if (k === 'up' || k === 'down') move(k);
      return;
    }
    if (Player.active) return Player.key(k);

    if (k === 'enter') { if (focused && focused.tvSelect) focused.tvSelect(); return; }
    if (k === 'back') {
      if (popScreen()) return;
      if (activeTab !== 'home') return setTab('home');
      if (IS_TIZEN) { try { tizen.application.getCurrentApplication().exit(); } catch (err) { /* ignore */ } }
      return;
    }
    if (['left', 'right', 'up', 'down'].indexOf(k) >= 0) move(k);
  });

  // мышь — для проверки на ПК
  app.addEventListener('click', (e) => {
    const n = e.target.closest('.focusable');
    if (!n) return;
    if (Player.active && !Menu.isOpen()) Player.showOsd();
    focus(n);
    if (n.tvSelect) n.tvSelect();
  });

  // свернули приложение — ставим плеер на паузу и сохраняем позицию
  document.addEventListener('visibilitychange', () => {
    if (!Player.active) return;
    if (document.hidden) { Player.saveProgress(); Player.engine.suspend(); }
    else Player.engine.restore();
  });

  // ---------------------------------------------------------------- часы и старт
  function clock() {
    const d = new Date();
    $('clock').textContent = d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }
  clock();
  setInterval(clock, 15000);

  if (!API && location.protocol.indexOf('http') !== 0) setupScreen();
  else setTab('home');
})();
