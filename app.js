/* 그집추어탕 주문·매출 앱
 * - 테이블을 누르고 메뉴를 담은 뒤 현금/카드로 결제하면 매출이 기록됩니다.
 * - 매출은 폰 안의 IndexedDB에 저장되고(원본), 클라우드에 연결하면 Firebase에도 자동으로 올라갑니다(cloud.js).
 * - 설정에서 백업/복원할 수 있고, 전체 삭제·복원에는 관리자 비밀번호가 필요합니다.
 */
'use strict';

const APP_VERSION = '1.1.0';
const LS_PIN = 'gujip.pin';
const LS_SETTINGS = 'gujip.settings';
const LS_OPEN = 'gujip.open';
const TAKEOUT_ID = 'takeout';
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const MODE_LABEL = { day: '일', week: '주', month: '월', year: '년' };

/* 가게 도면의 고정 표시(테이블 아님). 위치는 도면 영역의 % 단위 */
const LANDMARKS = [
  { name: '주방', x: 90, y: 3, w: 9, h: 36 },
  { name: '입구', x: 1, y: 78, w: 9, h: 20 },
];

function DEFAULT_SETTINGS() {
  return {
    storeName: '그집추어탕',
    layoutVersion: 4,
    menuVersion: 3,
    /* cashPrice: 현금 결제 때 적용되는 가격. 없으면 현금도 정가(주류·음료) */
    menu: [
      { id: 'm_chueo', name: '추어탕', price: 10000, cashPrice: 9000 },
      { id: 'm_jeyuk', name: '제육정식', price: 10000, cashPrice: 9000 },
      { id: 'm_bangye', name: '반계탕', price: 11000, cashPrice: 10000 },
      { id: 'm_soju', name: '소주', price: 4000 },
      { id: 'm_beer', name: '맥주', price: 4000 },
      { id: 'm_drink', name: '음료', price: 2000 },
    ],
    /* x, y: 도면 영역 안의 위치(%). 주방이 오른쪽 위, 입구가 왼쪽 아래인 도면 기준
     * 열: 왼쪽 11.5 / 가운데 37.5 / 오른쪽 63.5, 행: 3 / 22 / 45 / 69 */
    tables: [
      { id: 'a1', name: '1번', seats: 2, x: 11.5, y: 3 },
      { id: 'a2', name: '2번', seats: 4, x: 37.5, y: 3 },
      { id: 'a3', name: '3번', seats: 4, x: 11.5, y: 22 },
      { id: 'a4', name: '4번', seats: 4, x: 37.5, y: 22 },
      { id: 'a5', name: '5번', seats: 4, x: 11.5, y: 45 },
      { id: 'a6', name: '6번', seats: 4, x: 37.5, y: 45 },
      { id: 'a7', name: '7번', seats: 4, x: 63.5, y: 45 },
      { id: 'a8', name: '8번', seats: 4, x: 11.5, y: 69 },
      { id: 'a9', name: '9번', seats: 4, x: 37.5, y: 69 },
      { id: 'a10', name: '10번', seats: 4, x: 63.5, y: 69 },
    ],
  };
}

/* ---------- 유틸 ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const pad2 = n => String(n).padStart(2, '0');
const won = n => Math.round(n).toLocaleString('ko-KR') + '원';
const uid = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const dateKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const timeLabel = ts => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const vibrate = (ms = 12) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* 지원 안 함 */ } };
const loadJSON = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { alert('저장 공간이 부족해 저장하지 못했습니다.'); } };

function normalizeSettings(raw) {
  const d = DEFAULT_SETTINGS();
  const s = Object.assign({}, d, raw && typeof raw === 'object' ? raw : {});
  s.storeName = String(s.storeName || d.storeName);
  delete s.cashDiscount; // 예전 '할인율' 방식은 더 이상 쓰지 않음
  // 예전 버전(할인율 + 할인 제외 표시)의 메뉴는 현금가 방식으로 바꿉니다.
  const menuVer = Number(raw && raw.menuVersion) || 1;
  s.menu = (Array.isArray(s.menu) && s.menu.length ? s.menu : d.menu)
    .map(m => {
      const out = { id: String(m.id || uid()), name: String(m.name || '메뉴'), price: Math.max(0, Math.round(Number(m.price) || 0)) };
      let cash = m.cashPrice;
      if (cash == null && menuVer < 3) {
        const base = d.menu.find(x => x.name === m.name);
        const excluded = m.noDiscount != null ? !!m.noDiscount : !!(base && base.cashPrice == null);
        if (base && base.cashPrice != null) cash = base.cashPrice;        // 기본 메뉴: 정해진 현금가
        else if (!base && !excluded) cash = out.price - 1000;             // 직접 추가한 음식: 1,000원 할인
      }
      cash = Math.round(Number(cash));
      if (isFinite(cash) && cash >= 0 && cash < out.price) out.cashPrice = cash;
      return out;
    });
  s.menuVersion = d.menuVersion;
  // 도면 배치가 바뀌기 전(버전 3 미만)의 테이블 설정은 새 도면 기본값으로 바꿉니다.
  const layoutVer = Number(raw && raw.layoutVersion) || 1;
  s.tables = (layoutVer >= 3 && Array.isArray(s.tables) && s.tables.length ? s.tables : d.tables)
    .map(t => {
      const out = { id: String(t.id || uid()), name: String(t.name || '테이블') };
      const seats = Math.round(Number(t.seats) || 0);
      if (seats > 0) out.seats = seats;
      if (t.x != null && t.y != null && isFinite(Number(t.x)) && isFinite(Number(t.y))) { out.x = Number(t.x); out.y = Number(t.y); }
      return out;
    });
  // 버전 4: 3번 테이블은 4인석(2026-10-27 확인). 다른 테이블 설정은 그대로 둡니다.
  if (layoutVer < 4) {
    const t3 = s.tables.find(t => t.id === 'a3');
    if (t3 && t3.seats === 2) t3.seats = 4;
  }
  s.layoutVersion = d.layoutVersion;
  return s;
}

/* ---------- 저장소 (IndexedDB) ----------
 * sales : 매출 기록(이 폰의 원본). 기록마다 고유번호 uid가 있어 기기 사이에서 같은 기록을 알아봅니다.
 * outbox: 클라우드에 아직 올리지 못한 변경(기록 uid마다 1건). 클라우드에 연결된 동안에만 쌓입니다. */
const newRecordId = () => (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  : JSON.stringify(v === undefined ? null : v);
const DB = (() => {
  let dbp = null;
  let tracking = false;
  const W = ['sales', 'outbox'];
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const entry = (uid, op) => ({ uid, op, at: newRecordId() });
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const req = indexedDB.open('gujip-pos', 2);
    req.onupgradeneeded = ev => {
      const db = req.result;
      const sales = ev.oldVersion < 1
        ? db.createObjectStore('sales', { keyPath: 'id', autoIncrement: true })
        : req.transaction.objectStore('sales');
      if (ev.oldVersion < 1) sales.createIndex('ts', 'ts');
      if (ev.oldVersion < 2) {
        sales.createIndex('uid', 'uid');
        db.createObjectStore('outbox', { keyPath: 'uid' });
        // 예전 기록에도 고유번호를 붙여 둡니다.
        sales.openCursor().onsuccess = e => {
          const c = e.target.result; if (!c) return;
          if (!c.value.uid) { const v = c.value; v.uid = newRecordId(); c.update(v); }
          c.continue();
        };
      }
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); res(db); };
    req.onerror = () => rej(req.error || new Error('DB를 열 수 없습니다'));
  }));
  // 트랜잭션 하나 안에서 fn(stores)를 실행하고, 트랜잭션이 끝나면 fn의 결과를 돌려줍니다.
  async function tx(names, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(names, mode);
      const s = {};
      [].concat(names).forEach(n => { s[n] = t.objectStore(n); });
      let out, err = null;
      fn(s).then(v => { out = v; }, e => { err = e; try { t.abort(); } catch (x) { /* 이미 끝남 */ } });
      t.oncomplete = () => (err ? rej(err) : res(out));
      t.onerror = () => rej(err || t.error || new Error('저장 실패'));
      t.onabort = () => rej(err || t.error || new Error('저장 취소됨'));
    });
  }
  const api = {
    onTracked: null,                        // 클라우드에 올릴 변경이 생기면 호출
    setTracking(on) { tracking = !!on; },
    isTracking: () => tracking,
    async add(rec) {
      if (!rec.uid) rec.uid = newRecordId();
      const id = await tx(W, 'readwrite', async s => {
        const newId = await reqP(s.sales.add(rec));
        if (tracking) s.outbox.put(entry(rec.uid, 'put'));
        return newId;
      });
      changed();
      return id;
    },
    range: (a, b) => tx('sales', 'readonly', s => reqP(s.sales.index('ts').getAll(IDBKeyRange.bound(a, b, false, true)))),
    all: () => tx('sales', 'readonly', s => reqP(s.sales.getAll())),
    getByUid: u => tx('sales', 'readonly', s => reqP(s.sales.index('uid').get(u))),
    async remove(id) {
      await tx(W, 'readwrite', async s => {
        const rec = await reqP(s.sales.get(id));
        if (!rec) return;
        s.sales.delete(id);
        if (tracking && rec.uid) s.outbox.put(entry(rec.uid, 'del'));
      });
      changed();
    },
    /* 전체 삭제: 클라우드에 연결되어 있으면 클라우드 기록도 삭제 표시 */
    async clearAll() {
      await tx(W, 'readwrite', async s => {
        if (tracking) (await reqP(s.sales.getAll())).forEach(r => { if (r.uid) s.outbox.put(entry(r.uid, 'del')); });
        s.sales.clear();
      });
      changed();
    },
    /* 백업 복원: 지금 기록을 모두 지우고 백업 내용으로 바꿈 */
    async replaceAll(list) {
      await tx(W, 'readwrite', async s => {
        if (tracking) (await reqP(s.sales.getAll())).forEach(r => { if (r.uid) s.outbox.put(entry(r.uid, 'del')); });
        s.sales.clear();
        for (const r0 of list) {
          const r = Object.assign({}, r0);
          delete r.id;
          if (!r.uid) r.uid = newRecordId();
          s.sales.add(r);
          if (tracking) s.outbox.put(entry(r.uid, 'put'));
        }
      });
      changed();
    },
    /* 처음 클라우드에 연결할 때: 이 폰의 기록을 모두 올릴 대상으로 */
    markAllForUpload: () => tx(W, 'readwrite', async s => {
      (await reqP(s.sales.getAll())).forEach(r => {
        if (!r.uid) { r.uid = newRecordId(); s.sales.put(r); }
        s.outbox.put(entry(r.uid, 'put'));
      });
    }),
    outboxList: n => tx('outbox', 'readonly', s => reqP(s.outbox.getAll(null, n))),
    outboxCount: () => tx('outbox', 'readonly', s => reqP(s.outbox.count())),
    outboxClear: () => tx('outbox', 'readwrite', async s => { s.outbox.clear(); }),
    /* 올리기에 성공한 항목만 지움(그 사이에 또 바뀐 항목은 남김) */
    outboxDone: entries => tx('outbox', 'readwrite', async s => {
      for (const e of entries) {
        const cur = await reqP(s.outbox.get(e.uid));
        if (cur && cur.at === e.at) s.outbox.delete(e.uid);
      }
    }),
    /* 다른 기기에서 받아온 변경 반영. 바뀐 건수를 돌려줌 */
    applyRemote: docs => tx(W, 'readwrite', async s => {
      let n = 0;
      for (const d of docs) {
        if (await reqP(s.outbox.get(d.uid))) continue;   // 이 폰에서 아직 올리지 못한 변경이 우선
        const local = await reqP(s.sales.index('uid').getAll(d.uid));
        if (d.deleted) {
          local.forEach(r => s.sales.delete(r.id));
          n += local.length;
          continue;
        }
        const rec = Object.assign({}, d.rec, { uid: d.uid });
        if (local.length) {
          const mine = Object.assign({}, local[0]); delete mine.id;
          local.slice(1).forEach(r => { s.sales.delete(r.id); n++; });
          if (canon(mine) === canon(rec)) continue;
          rec.id = local[0].id;
          s.sales.put(rec);
        } else {
          s.sales.add(rec);
        }
        n++;
      }
      return n;
    }),
  };
  function changed() { if (tracking && api.onTracked) { try { api.onTracked(); } catch (e) { /* 무시 */ } } }
  return api;
})();

/* ---------- 상태 ---------- */
let settings = normalizeSettings(loadJSON(LS_SETTINGS, null));
let open = loadJSON(LS_OPEN, {});
if (!open || typeof open !== 'object') open = {};
const saveSettings = () => saveJSON(LS_SETTINGS, settings);
const saveOpen = () => saveJSON(LS_OPEN, open);

const state = {
  view: 'tables',          // tables | order | sales | settings
  tableId: null,
  payOpen: false,
  paying: false,
  sales: { mode: 'day', anchor: new Date() },
  installPrompt: null,
  persisted: null,
  cloud: null,             // 클라우드 상태(cloud.js가 알려 줌)
};

const orderTotal = o => sum(o.items, i => i.price * i.qty);
const hasItems = o => !!o && Array.isArray(o.items) && o.items.some(i => i.qty > 0);
const itemSummary = (o, max = 3) => {
  const p = o.items.filter(i => i.qty > 0).map(i => `${i.name} ${i.qty}`);
  return p.slice(0, max).join(', ') + (p.length > max ? ` 외 ${p.length - max}` : '');
};
const tableName = id => id === TAKEOUT_ID ? '포장' : ((settings.tables.find(t => t.id === id) || {}).name || '테이블');
/* 현금 결제 때의 단가: 주문에 담을 때 기록된 현금가 → 현재 메뉴 설정의 현금가 → 정가 순서 */
const cashUnitOf = i => {
  if (i.cashPrice != null) return i.cashPrice;
  if (i.noDiscount === true) return i.price;            // 예전 버전에서 담아 둔 주문
  const m = settings.menu.find(x => x.id === i.menuId);
  return m && m.cashPrice != null ? m.cashPrice : i.price;
};
const cashTotalOf = items => items.reduce((acc, i) => acc + cashUnitOf(i) * i.qty, 0);
const todayLabel = () => { const d = new Date(); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAYS[d.getDay()]})`; };

/* ---------- 화면 스타일(테마) ---------- */
const THEMES = {
  green: { label: '그린', color: '#1f6b4a', swatch: 'linear-gradient(135deg,#1f6b4a 50%,#f3f1ea 50%)' },
  orange: { label: '오렌지', color: '#d9531e', swatch: 'linear-gradient(135deg,#d9531e 50%,#f5f2ec 50%)' },
  white: { label: '화이트', color: '#ffffff', swatch: 'linear-gradient(135deg,#ffffff 50%,#ea580c 50%)' },
  dark: { label: '다크', color: '#1f2126', swatch: 'linear-gradient(135deg,#1f2126 50%,#ff7a3d 50%)' },
};
const DEFAULT_THEME = 'green';           // 2026-10-27 시안 D(딥 그린)로 확정
const LS_THEME = 'gujip.theme.v2';       // 시안 고르기 전에 저장된 값은 무시
function applyTheme(name, persist) {
  const t = THEMES[name] ? name : DEFAULT_THEME;
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEMES[t].color;
  if (persist) { try { localStorage.setItem(LS_THEME, t); } catch (e) { /* 무시 */ } }
  return t;
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(LS_THEME); } catch (e) { /* 무시 */ }
  const fromUrl = new URLSearchParams(location.search).get('theme');
  applyTheme(fromUrl || saved || DEFAULT_THEME, !!fromUrl);
})();

/* ---------- 화면 ---------- */
const SVG = (body, w = 2) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  tables: SVG('<rect x="3" y="3" width="7.5" height="7.5" rx="1.8"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.8"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.8"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.8"/>'),
  sales: SVG('<path d="M5 20v-8"/><path d="M12 20V5"/><path d="M19 20v-5"/><path d="M3 20h18" stroke-width="2"/>', 3),
  settings: SVG('<path d="M4 7h8"/><path d="M19 7h1"/><circle cx="15.5" cy="7" r="2.3"/><path d="M4 12h1"/><path d="M12 12h8"/><circle cx="8.5" cy="12" r="2.3"/><path d="M4 17h8"/><path d="M19 17h1"/><circle cx="15.5" cy="17" r="2.3"/>'),
  back: SVG('<path d="M15 18l-6-6 6-6"/>', 2.6),
  chevron: SVG('<path d="M9 6l6 6-6 6"/>', 2.6),
  bag: SVG('<path d="M6 8h12l1 13H5L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
};
function nav(active) {
  const item = (v, label) => `<button class="nav-btn ${active === v ? 'active' : ''}" data-action="nav" data-view="${v}">${ICONS[v]}<span>${label}</span></button>`;
  return `<nav class="bottom-nav">${item('tables', '테이블')}${item('sales', '매출')}${item('settings', '설정')}</nav>`;
}

async function viewTables() {
  const s = startOfDay(new Date());
  let todayTotal = 0, todayCount = 0;
  try {
    const recs = await DB.range(s.getTime(), addDays(s, 1).getTime());
    todayTotal = sum(recs, r => r.total); todayCount = recs.length;
  } catch (e) { /* 표시만 생략 */ }
  const card = (t, extra = '', style = '') => {
    const o = open[t.id]; const busy = hasItems(o);
    const isTakeout = t.id === TAKEOUT_ID;
    const onFloor = extra === 'on-floor';
    const emptyLabel = isTakeout ? '포장 주문 받기'
      : onFloor ? (t.seats ? `${t.seats}인석` : '비어 있음')
      : (t.seats ? `${t.seats}인석 · 비어 있음` : '비어 있음');
    return `<button class="table-card ${busy ? 'busy' : ''} ${extra}" data-action="open-table" data-id="${t.id}"${style ? ` style="${style}"` : ''}>
      <span class="table-name">${isTakeout ? ICONS.bag : ''}${esc(t.name)}</span>
      ${busy
        ? `<span class="table-amount">${won(orderTotal(o))}</span><span class="table-items">${esc(itemSummary(o, onFloor ? 2 : 3))}</span>`
        : `<span class="table-empty">${emptyLabel}</span>`}
    </button>`;
  };
  const placed = settings.tables.filter(t => t.x != null && t.y != null);
  const unplaced = settings.tables.filter(t => t.x == null || t.y == null);
  const floor = placed.length ? `<div class="floor">
      ${LANDMARKS.map(l => `<div class="landmark" style="left:${l.x}%;top:${l.y}%;width:${l.w}%;height:${l.h}%"><span>${esc(l.name)}</span></div>`).join('')}
      ${placed.map(t => card(t, 'on-floor', `left:${t.x}%;top:${t.y}%`)).join('')}
    </div>` : '';
  const cs = state.cloud;
  const dot = cs && cs.linked ? `<span id="cloud-dot" class="cloud-dot ${cloudDotClass(cs)}"></span>` : '';
  return `<header class="topbar"><h1>${esc(settings.storeName)}</h1><span class="topbar-sub">${todayLabel()}${dot}</span></header>
  <main class="content">
    <button class="today-strip" data-action="nav" data-view="sales"><span><span class="label">오늘 매출</span><strong>${won(todayTotal)}</strong></span><span class="count">${todayCount}건 ${ICONS.chevron}</span></button>
    <div class="table-grid">${card({ id: TAKEOUT_ID, name: '포장' }, 'takeout wide')}</div>
    ${floor}
    ${unplaced.length ? `<div class="table-grid ${unplaced.length > 8 ? 'cols-3' : ''}">${unplaced.map(t => card(t)).join('')}</div>` : ''}
  </main>${nav('tables')}`;
}

function viewOrder() {
  const o = open[state.tableId] || { items: [] };
  const qtyOf = mid => { const it = o.items.find(i => i.menuId === mid); return it ? it.qty : 0; };
  const total = orderTotal(o);
  const filled = hasItems(o);
  const name = tableName(state.tableId);
  const title = state.tableId === TAKEOUT_ID ? '포장 주문' : `${name} 테이블`;
  return `<header class="topbar order-top">
      <button class="back-btn" data-action="nav" data-view="tables">${ICONS.back}테이블</button>
      <h1>${esc(title)}</h1>
      <button class="text-btn danger" data-action="clear-table" ${filled ? '' : 'disabled'}>비우기</button>
    </header>
    <main class="content order-content">
      <section class="menu-grid">
        ${settings.menu.map(m => {
          const q = qtyOf(m.id);
          return `<button class="menu-btn ${q ? 'picked' : ''}" data-action="add-item" data-id="${m.id}">
            <span class="menu-name">${esc(m.name)}</span><span class="menu-price">${won(m.price)}</span>${q ? `<span class="qty-badge">${q}</span>` : ''}</button>`;
        }).join('')}
      </section>
      <section class="order-list">
        ${filled ? o.items.filter(i => i.qty > 0).map(i => `<div class="order-row">
            <span class="order-name">${esc(i.name)}</span>
            <span class="qty-ctl"><button class="qty-btn" data-action="dec-item" data-id="${i.menuId}">−</button><span class="qty">${i.qty}</span><button class="qty-btn" data-action="inc-item" data-id="${i.menuId}">+</button></span>
            <span class="order-amt">${won(i.price * i.qty)}</span></div>`).join('')
          : '<p class="hint">위의 메뉴를 누르면 주문에 담깁니다.</p>'}
      </section>
    </main>
    <footer class="order-footer">
      <div class="total-line"><span>합계</span><strong>${won(total)}</strong></div>
      <button class="btn pay-btn" data-action="open-pay" ${filled ? '' : 'disabled'}>결제하기</button>
    </footer>
    ${state.payOpen ? payModal(o) : ''}`;
}

function payModal(o) {
  const items = o.items.filter(i => i.qty > 0);
  const total = orderTotal(o);
  const cash = cashTotalOf(items);
  const saved = total - cash;
  const note = saved > 0 ? `현금가 적용 · ${won(saved)} 할인` : '';
  return `<div class="overlay" data-action="close-pay"><div class="modal" data-action="noop">
    <h2>결제</h2>
    <p class="modal-amount">주문 금액 <strong>${won(total)}</strong></p>
    <button class="btn cash" data-action="pay" data-method="cash">현금 ${won(cash)}${note ? `<small>${note}</small>` : ''}</button>
    <button class="btn card" data-action="pay" data-method="card">카드 ${won(total)}</button>
    <button class="btn ghost" data-action="close-pay">돌아가기</button>
  </div></div>`;
}

/* --- 매출 --- */
function periodRange(mode, anchor) {
  const s = startOfDay(anchor); let e;
  if (mode === 'day') e = addDays(s, 1);
  else if (mode === 'week') { s.setDate(s.getDate() - (s.getDay() + 6) % 7); e = addDays(s, 7); }
  else if (mode === 'month') { s.setDate(1); e = new Date(s); e.setMonth(e.getMonth() + 1); }
  else { s.setMonth(0, 1); e = new Date(s); e.setFullYear(e.getFullYear() + 1); }
  return [s, e];
}
function periodLabel(mode, s, e) {
  if (mode === 'day') return `${s.getFullYear()}년 ${s.getMonth() + 1}월 ${s.getDate()}일 (${DAYS[s.getDay()]})`;
  if (mode === 'week') { const l = addDays(e, -1); return `${s.getMonth() + 1}월 ${s.getDate()}일 ~ ${l.getMonth() + 1}월 ${l.getDate()}일`; }
  if (mode === 'month') return `${s.getFullYear()}년 ${s.getMonth() + 1}월`;
  return `${s.getFullYear()}년`;
}
function shiftAnchor(dir) {
  const a = new Date(state.sales.anchor); const m = state.sales.mode;
  if (m === 'day') a.setDate(a.getDate() + dir);
  else if (m === 'week') a.setDate(a.getDate() + 7 * dir);
  else if (m === 'month') { a.setDate(1); a.setMonth(a.getMonth() + dir); }
  else { a.setMonth(0, 1); a.setFullYear(a.getFullYear() + dir); }
  state.sales.anchor = a;
}
function buckets(mode, s, e, recs) {
  const out = [];
  if (mode === 'week' || mode === 'month') {
    for (let d = new Date(s); d < e; d = addDays(d, 1)) {
      const label = mode === 'week' ? `${d.getMonth() + 1}/${d.getDate()} (${DAYS[d.getDay()]})` : `${d.getDate()}일 (${DAYS[d.getDay()]})`;
      out.push({ label, s: d.getTime(), e: addDays(d, 1).getTime(), total: 0, count: 0 });
    }
  } else if (mode === 'year') {
    for (let m = 0; m < 12; m++) {
      out.push({ label: `${m + 1}월`, s: new Date(s.getFullYear(), m, 1).getTime(), e: new Date(s.getFullYear(), m + 1, 1).getTime(), total: 0, count: 0 });
    }
  }
  for (const r of recs) { const b = out.find(x => r.ts >= x.s && r.ts < x.e); if (b) { b.total += r.total; b.count++; } }
  return out;
}

async function viewSales() {
  const { mode, anchor } = state.sales;
  const [s, e] = periodRange(mode, anchor);
  const recs = await DB.range(s.getTime(), e.getTime());
  const total = sum(recs, r => r.total);
  const cash = recs.filter(r => r.method === 'cash'), card = recs.filter(r => r.method === 'card');
  const discount = sum(recs, r => r.discount || 0);
  const byItem = new Map();
  for (const r of recs) for (const i of r.items) {
    const b = byItem.get(i.name) || { qty: 0, amount: 0 };
    b.qty += i.qty; b.amount += i.qty * i.price; byItem.set(i.name, b);
  }
  const items = [...byItem.entries()].sort((a, b) => b[1].amount - a[1].amount);
  const bks = buckets(mode, s, e, recs);
  const maxB = Math.max(1, ...bks.map(b => b.total));
  const bucketTitle = { week: '요일별 매출', month: '일별 매출', year: '월별 매출' }[mode];
  return `<header class="topbar"><h1>매출</h1></header>
  <main class="content">
    <div class="seg">${Object.keys(MODE_LABEL).map(m => `<button class="seg-btn ${mode === m ? 'active' : ''}" data-action="sales-mode" data-mode="${m}">${MODE_LABEL[m]}</button>`).join('')}</div>
    <div class="period-nav">
      <button class="nav-arrow" data-action="sales-shift" data-dir="-1">◀</button>
      <div class="period-label">${periodLabel(mode, s, e)}</div>
      <button class="nav-arrow" data-action="sales-shift" data-dir="1">▶</button>
    </div>
    <div class="period-tools">
      <button class="chip" data-action="sales-today">오늘</button>
      ${mode === 'day' ? `<input type="date" class="date-input" data-field="sales-date" value="${dateKey(s)}">` : ''}
    </div>
    <section class="card">
      <div class="summary-total"><span class="label">총 매출</span><strong>${won(total)}</strong></div>
      <div class="summary-row"><span>주문 ${recs.length}건</span><span>현금 ${won(sum(cash, r => r.total))} (${cash.length}건)</span><span>카드 ${won(sum(card, r => r.total))} (${card.length}건)</span></div>
      ${discount ? `<div class="summary-row muted"><span>현금 할인 합계 ${won(discount)}</span></div>` : ''}
    </section>
    ${bks.length ? `<section class="card"><h2>${bucketTitle}</h2>${bks.map(b => `<div class="bar-row ${b.total ? '' : 'zero'}"><span class="bar-label">${b.label}</span><span class="bar"><span class="bar-fill" style="width:${Math.round(b.total / maxB * 100)}%"></span></span><span class="bar-amt">${b.total ? won(b.total) : '-'}</span></div>`).join('')}</section>` : ''}
    <section class="card"><h2>메뉴별 판매</h2>
      ${items.length ? items.map(([n, b]) => `<div class="item-row"><span>${esc(n)}</span><span>${b.qty}개</span><span>${won(b.amount)}</span></div>`).join('') : '<p class="hint">판매 내역이 없습니다.</p>'}
    </section>
    ${mode === 'day' ? `<section class="card"><h2>주문 내역</h2>
      ${recs.length ? recs.slice().reverse().map(r => `<div class="sale-row">
        <div class="sale-main"><span class="sale-time">${timeLabel(r.ts)}</span><span class="sale-table">${esc(r.tableName)}</span><span class="badge ${r.method}">${r.method === 'cash' ? '현금' : '카드'}</span><span class="sale-amt">${won(r.total)}</span></div>
        <div class="sale-sub"><span>${esc(r.items.map(i => `${i.name} ${i.qty}`).join(', '))}</span><button class="text-btn danger" data-action="void-sale" data-id="${r.id}">취소</button></div>
      </div>`).join('') : '<p class="hint">주문 내역이 없습니다.</p>'}
    </section>` : ''}
  </main>${nav('sales')}`;
}

/* --- 설정 --- */
function viewSettings() {
  const tools = (kind, x, i, n) => `<button class="icon-btn" data-action="move" data-kind="${kind}" data-id="${x.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="icon-btn" data-action="move" data-kind="${kind}" data-id="${x.id}" data-dir="1" ${i === n - 1 ? 'disabled' : ''}>▼</button>
      <button class="icon-btn danger" data-action="del" data-kind="${kind}" data-id="${x.id}">✕</button>`;
  const menuList = settings.menu.map((x, i) => `<div class="edit-row menu-row" data-id="${x.id}">
      <input type="text" class="edit-name" data-field="menu-name" data-id="${x.id}" value="${esc(x.name)}" placeholder="메뉴 이름">
      <div class="price-pair">
        <label class="with-unit"><span class="lbl">정가</span><input type="number" class="edit-num" inputmode="numeric" step="100" min="0" data-field="menu-price" data-id="${x.id}" value="${x.price}" placeholder="가격">원</label>
        <label class="with-unit"><span class="lbl">현금가</span><input type="number" class="edit-num" inputmode="numeric" step="100" min="0" data-field="menu-cash" data-id="${x.id}" value="${x.cashPrice != null ? x.cashPrice : ''}" placeholder="없음">원</label>
      </div>
      <div class="row-tools">${tools('menu', x, i, settings.menu.length)}</div>
    </div>`).join('');
  const tableList = settings.tables.map((x, i) => `<div class="edit-row stack" data-id="${x.id}">
      <input type="text" class="edit-name" data-field="table-name" data-id="${x.id}" value="${esc(x.name)}" placeholder="테이블 이름">
      <span class="with-unit"><input type="number" class="edit-num" inputmode="numeric" min="1" max="20" data-field="table-seats" data-id="${x.id}" value="${x.seats || ''}" placeholder="인원">인석</span>
      ${tools('table', x, i, settings.tables.length)}
    </div>`).join('');
  return `<header class="topbar"><h1>설정</h1></header>
  <main class="content settings">
    <section class="card"><h2>가게</h2>
      <label class="field"><span>가게 이름</span><input type="text" data-field="storeName" value="${esc(settings.storeName)}"></label>
    </section>
    <section class="card"><h2>메뉴 (정가 · 현금가)</h2>
      ${menuList}
      <button class="btn outline" data-action="add" data-kind="menu">+ 메뉴 추가</button>
      <p class="help">현금으로 결제하면 '현금가'로 계산됩니다. 현금가를 비워 두면 현금도 정가로 받습니다(소주·맥주·음료).</p>
    </section>
    <section class="card"><h2>테이블 (이름 · 인원)</h2>
      ${tableList}
      <button class="btn outline" data-action="add" data-kind="table">+ 테이블 추가</button>
      <p class="help">테이블 위치는 가게 도면에 맞춰 고정되어 있습니다(주방 오른쪽 위, 입구 왼쪽 아래). 새로 추가한 테이블은 도면 아래에 따로 표시됩니다. 배치를 바꾸려면 Claude에게 요청하세요.</p>
    </section>
    <section class="card"><h2>화면 스타일</h2>
      <div class="theme-row">${Object.entries(THEMES).map(([k, t]) => `<button class="theme-btn ${document.documentElement.dataset.theme === k ? 'active' : ''}" data-action="theme" data-theme="${k}"><span class="theme-swatch" style="background:${t.swatch}"></span>${t.label}</button>`).join('')}</div>
    </section>
    ${cloudCard()}
    <section class="card"><h2>관리자 비밀번호</h2>
      <p class="muted">${hasPin() ? '설정되어 있습니다.' : '아직 정하지 않았습니다.'} '매출 기록 전체 삭제'와 '백업 파일 복원' 때 필요합니다.</p>
      <button class="btn outline" data-action="pin-set">${hasPin() ? '비밀번호 바꾸기' : '비밀번호 정하기'}</button>
    </section>
    <section class="card"><h2>데이터</h2>
      <button class="btn outline" data-action="export-json">백업 파일 내보내기</button>
      <button class="btn outline" data-action="export-csv">엑셀용(CSV) 내보내기</button>
      <label class="btn outline">백업 파일 복원<input type="file" accept=".json,application/json" data-field="restore-file" hidden></label>
      <button class="btn outline danger" data-action="wipe">매출 기록 전체 삭제</button>
      <p class="help">${state.cloud && state.cloud.linked
        ? '클라우드에 자동 저장되고 있습니다. 백업 파일은 한 번 더 안전하게 보관하고 싶을 때만 내보내면 됩니다.'
        : "백업 파일은 카카오톡 '나에게 보내기'나 구글 드라이브에 보관해 두세요. 폰이 고장 나도 복원할 수 있습니다."}</p>
    </section>
    <section class="card"><h2>앱 정보</h2>
      ${state.installPrompt ? '<button class="btn primary" data-action="install">홈 화면에 앱 설치</button>' : ''}
      <p class="muted">버전 ${APP_VERSION}<br>저장 공간 보호: ${state.persisted === null ? '확인 중' : state.persisted ? '됨' : '안 됨 (홈 화면에 설치하면 보호됩니다)'}</p>
    </section>
  </main>${nav('settings')}`;
}

/* --- 클라우드 표시 --- */
function syncTimeLabel(ms) {
  const d = new Date(ms), t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return dateKey(d) === dateKey(new Date()) ? `오늘 ${t}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${t}`;
}
function cloudDotClass(s) {
  if (!s || !s.linked) return '';
  if (s.phase === 'signedout' || /권한|로그인/.test(s.error || '')) return 'err';
  if (s.phase !== 'ready' || s.pending > 0 || s.error) return 'wait';
  return 'ok';
}
function cloudStatusHtml(s) {
  if (!s || !s.configured) return '';
  const lines = [];
  if (s.phase === 'loading') lines.push('<span class="muted">클라우드를 불러오는 중…</span>');
  if (s.signedIn) lines.push(`<span class="ok">연결됨 · ${esc(s.email || '')}</span>`);
  else if (s.phase === 'signedout') lines.push('<span class="err">다시 로그인이 필요합니다</span>');
  else if (s.phase === 'login') lines.push('<span class="muted">아직 연결하지 않았습니다</span>');
  if (s.linked) {
    lines.push(`<span>마지막 저장: ${s.lastSync ? syncTimeLabel(s.lastSync) : '아직 없음'}</span>`);
    lines.push(s.pending > 0 ? `<span class="warn">올릴 대기: ${s.pending}건</span>` : '<span>올릴 대기: 없음</span>');
    if (s.busy) lines.push('<span class="muted">저장하는 중…</span>');
  }
  if (s.error) lines.push(`<span class="err">${esc(s.error)}</span>`);
  return lines.join('');
}
function cloudCard() {
  const s = state.cloud || {};
  const statusBox = `<div id="cloud-status" class="cloud-status">${cloudStatusHtml(s)}</div>`;
  let body;
  if (!s.configured) {
    body = '<p class="muted">아직 클라우드 설정 전입니다. 설정을 마치면 여기에서 로그인할 수 있습니다. 설정 전에도 앱은 폰 저장만으로 정상 동작합니다.</p>';
  } else if (s.signedIn) {
    body = `${statusBox}
      <button class="btn outline" data-action="cloud-sync">지금 저장하기</button>
      <button class="btn outline danger" data-action="cloud-logout">로그아웃</button>`;
  } else if (s.phase === 'loading') {
    body = statusBox;
  } else if (s.phase === 'error') {
    body = `${statusBox}<button class="btn outline" data-action="cloud-retry">다시 시도</button>`;
  } else {
    body = `${statusBox}
      <label class="field"><span>가게 계정 이메일</span><input type="email" id="cloud-email" autocomplete="username" value="${esc(s.email || '')}"></label>
      <label class="field"><span>비밀번호</span><input type="password" id="cloud-pw" autocomplete="current-password"></label>
      <button class="btn primary" data-action="cloud-login">로그인</button>`;
  }
  return `<section class="card"><h2>클라우드 자동 저장</h2>${body}
    <p class="help">로그인해 두면 결제할 때마다 매출이 클라우드에도 저장됩니다. 폰이 고장 나도 새 폰에서 같은 계정으로 로그인하면 매출이 그대로 돌아옵니다.</p></section>`;
}
let cloudKey = '';
function onCloudStatus(s) {
  state.cloud = s;
  const key = [s.configured, s.linked, s.signedIn, s.phase].join('|');
  const structural = key !== cloudKey;
  cloudKey = key;
  if (structural && (state.view === 'settings' || state.view === 'tables')) { render(); return; }
  const box = document.getElementById('cloud-status');
  if (box) box.innerHTML = cloudStatusHtml(s);
  const dot = document.getElementById('cloud-dot');
  if (dot) dot.className = 'cloud-dot ' + cloudDotClass(s);
}

/* ---------- 렌더링 ---------- */
let renderSeq = 0, lastView = null;
async function render() {
  const seq = ++renderSeq;
  let html;
  try {
    if (state.view === 'tables') html = await viewTables();
    else if (state.view === 'order') html = viewOrder();
    else if (state.view === 'sales') html = await viewSales();
    else html = viewSettings();
  } catch (e) {
    html = `<header class="topbar"><h1>오류</h1></header><main class="content"><p class="hint">화면을 그리는 중 문제가 생겼습니다.<br>${esc(e.message || e)}</p></main>${nav(state.view)}`;
  }
  if (seq !== renderSeq) return;
  const y = window.scrollY;
  $('#app').innerHTML = html;
  window.scrollTo(0, lastView === state.view ? y : 0);
  lastView = state.view;
}

/* ---------- 모달 / 토스트 ---------- */
function ask(message, okLabel = '확인', danger = true) {
  return new Promise(res => {
    const root = $('#modal-root');
    root.innerHTML = `<div class="overlay"><div class="modal">
      <p class="modal-msg">${esc(message)}</p>
      <div class="modal-btns"><button class="btn ghost" data-ask="0">아니오</button><button class="btn ${danger ? 'red' : 'primary'}" data-ask="1">${esc(okLabel)}</button></div>
    </div></div>`;
    root.onclick = ev => {
      const b = ev.target.closest('[data-ask]'); if (!b) return;
      root.innerHTML = ''; root.onclick = null; vibrate();
      res(b.dataset.ask === '1');
    };
  });
}
/* 비밀번호 입력 창. 확인 → 입력값, 취소 → null, 보조 버튼 → { extra: true } */
function promptSecret(title, message, { numeric = true, extra = null } = {}) {
  return new Promise(res => {
    const root = $('#modal-root');
    root.innerHTML = `<div class="overlay center"><div class="modal">
      <h2>${esc(title)}</h2>
      ${message ? `<p class="modal-msg small">${esc(message)}</p>` : ''}
      <input class="secret-input ${numeric ? 'pin' : ''}" type="password" ${numeric ? 'inputmode="numeric" pattern="[0-9]*" maxlength="8"' : ''} autocomplete="off" placeholder="${numeric ? '숫자 4~8자리' : '비밀번호'}">
      <div class="modal-btns"><button class="btn ghost" data-sec="cancel">취소</button><button class="btn primary" data-sec="ok">확인</button></div>
      ${extra ? `<button class="text-btn" data-sec="extra">${esc(extra)}</button>` : ''}
    </div></div>`;
    const input = root.querySelector('.secret-input');
    setTimeout(() => { try { input.focus(); } catch (e) { /* 무시 */ } }, 60);
    const done = v => { root.innerHTML = ''; root.onclick = null; vibrate(); res(v); };
    root.onclick = ev => {
      const b = ev.target.closest('[data-sec]'); if (!b) return;
      const k = b.dataset.sec;
      done(k === 'cancel' ? null : k === 'extra' ? { extra: true } : input.value.trim());
    };
    input.onkeydown = ev => { if (ev.key === 'Enter') done(input.value.trim()); };
  });
}

/* ---------- 관리자 비밀번호 ---------- */
const hasPin = () => { try { return !!localStorage.getItem(LS_PIN); } catch (e) { return false; } };
const validPin = p => /^\d{4,8}$/.test(p);
async function pinHash(p) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('gujip-pos:' + p));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function setupPin() {
  const a = await promptSecret('새 관리자 비밀번호', '숫자 4~8자리로 정해 주세요.');
  if (a == null) return false;
  if (!validPin(a)) { alert('숫자 4~8자리로 입력해 주세요.'); return false; }
  const b = await promptSecret('비밀번호 확인', '한 번 더 입력해 주세요.');
  if (b == null) return false;
  if (a !== b) { alert('두 번 입력한 비밀번호가 다릅니다.\n다시 해 주세요.'); return false; }
  localStorage.setItem(LS_PIN, await pinHash(a));
  toast('관리자 비밀번호를 정했습니다', 'ok');
  return true;
}
/* 관리자 비밀번호 확인. 통과하면 true(새로 정한 경우 'new') */
async function checkPin(purpose) {
  if (!hasPin()) {
    if (!await ask(`${purpose}에는 관리자 비밀번호가 필요합니다.\n아직 정하지 않았으니 지금 정할까요?`, '정하기', false)) return false;
    return (await setupPin()) ? 'new' : false;
  }
  const canReset = !!(state.cloud && state.cloud.signedIn);
  const v = await promptSecret('관리자 비밀번호', `${purpose} 전에 비밀번호를 입력해 주세요.`, { extra: canReset ? '비밀번호를 잊었어요' : null });
  if (v == null) return false;
  if (typeof v === 'object') return resetPinViaCloud();
  if (await pinHash(v) === localStorage.getItem(LS_PIN)) return true;
  alert('비밀번호가 맞지 않습니다.');
  return false;
}
/* 잊었을 때: 클라우드 계정 비밀번호로 본인 확인 후 새로 정함 */
async function resetPinViaCloud() {
  const pw = await promptSecret('본인 확인', '클라우드 가게 계정의 비밀번호를 입력해 주세요.', { numeric: false });
  if (!pw) return false;
  try { await Cloud.verifyPassword(pw); } catch (e) { alert('확인하지 못했습니다.\n' + e.message); return false; }
  localStorage.removeItem(LS_PIN);
  return (await setupPin()) ? 'new' : false;
}

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast ' + kind; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

/* ---------- 주문 / 결제 ---------- */
function changeQty(menuId, delta) {
  const m = settings.menu.find(x => x.id === menuId);
  const o = open[state.tableId] || (open[state.tableId] = { items: [], startedAt: Date.now() });
  let it = o.items.find(i => i.menuId === menuId);
  if (!it) {
    if (!m || delta <= 0) return;
    it = { menuId, name: m.name, price: m.price, qty: 0 };
    if (m.cashPrice != null) it.cashPrice = m.cashPrice;
    o.items.push(it);
  }
  it.qty = Math.max(0, it.qty + delta);
  if (it.qty === 0) o.items = o.items.filter(i => i !== it);
  if (!o.items.length) delete open[state.tableId]; else o.updatedAt = Date.now();
  saveOpen(); vibrate(); render();
}

async function pay(method) {
  if (state.paying) return;
  const o = open[state.tableId];
  if (!hasItems(o)) return;
  state.paying = true;
  try {
    const items = o.items.filter(i => i.qty > 0);
    const subtotal = orderTotal(o);
    const total = method === 'cash' ? cashTotalOf(items) : subtotal;
    const now = new Date();
    await DB.add({
      uid: newRecordId(),
      ts: now.getTime(), dateKey: dateKey(now),
      tableId: state.tableId, tableName: tableName(state.tableId),
      items: items.map(i => ({ name: i.name, price: i.price, qty: i.qty, unit: method === 'cash' ? cashUnitOf(i) : i.price })),
      subtotal, discount: subtotal - total, total, method,
    });
    delete open[state.tableId]; saveOpen();
    state.payOpen = false; state.view = 'tables'; state.tableId = null;
    vibrate(40);
    await render();
    toast(`결제 완료 · ${method === 'cash' ? '현금' : '카드'} ${won(total)}`, 'ok');
  } catch (e) {
    alert('결제 저장에 실패했습니다.\n' + (e.message || e));
  } finally {
    state.paying = false;
  }
}

/* ---------- 백업 / 복원 ---------- */
async function shareOrDownload(blob, name) {
  try {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function exportJSON() {
  const sales = await DB.all();
  const data = { app: 'gujip-pos', version: APP_VERSION, exportedAt: new Date().toISOString(), settings, sales };
  await shareOrDownload(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${settings.storeName}-백업-${dateKey(new Date())}.json`);
  toast(`백업 ${sales.length}건 내보냄`);
}
async function exportCSV() {
  const sales = await DB.all();
  const rows = [['일시', '테이블', '메뉴', '주문금액', '할인', '결제금액', '결제수단']];
  for (const r of sales) {
    rows.push([`${dateKey(new Date(r.ts))} ${timeLabel(r.ts)}`, r.tableName, r.items.map(i => `${i.name} ${i.qty}`).join(' / '), r.subtotal, r.discount, r.total, r.method === 'cash' ? '현금' : '카드']);
  }
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  await shareOrDownload(new Blob([csv], { type: 'text/csv' }), `${settings.storeName}-매출-${dateKey(new Date())}.csv`);
  toast(`매출 ${sales.length}건 내보냄`);
}
async function restoreFromFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== 'gujip-pos' || !Array.isArray(data.sales)) throw new Error('이 앱의 백업 파일이 아닙니다.');
    const when = (data.exportedAt || '').slice(0, 10);
    if (!await checkPin('백업 파일 복원')) return;
    const cloudNote = state.cloud && state.cloud.linked ? '\n클라우드에 저장된 기록도 백업 내용으로 바뀝니다.' : '';
    if (!await ask(`백업(${data.sales.length}건, ${when})으로 되돌릴까요?\n지금 있는 매출 기록은 모두 지워집니다.${cloudNote}`, '복원')) return;
    await DB.replaceAll(data.sales);
    if (data.settings) { settings = normalizeSettings(data.settings); saveSettings(); }
    toast('복원 완료', 'ok'); render();
  } catch (e) {
    alert('복원하지 못했습니다.\n' + (e.message || e));
  }
}

/* ---------- 동작 (버튼) ---------- */
const actions = {
  noop() {},
  nav(el) { state.view = el.dataset.view; state.payOpen = false; vibrate(); render(); },
  'open-table'(el) { state.tableId = el.dataset.id; state.view = 'order'; state.payOpen = false; vibrate(); render(); },
  'add-item'(el) { changeQty(el.dataset.id, 1); },
  'inc-item'(el) { changeQty(el.dataset.id, 1); },
  'dec-item'(el) { changeQty(el.dataset.id, -1); },
  async 'clear-table'() {
    if (!await ask('이 테이블의 주문을 모두 지울까요?', '비우기')) return;
    delete open[state.tableId]; saveOpen(); render(); toast('주문을 지웠습니다');
  },
  'open-pay'() { if (!hasItems(open[state.tableId])) return; state.payOpen = true; vibrate(); render(); },
  'close-pay'() { state.payOpen = false; render(); },
  pay(el) { return pay(el.dataset.method); },
  'sales-mode'(el) { state.sales.mode = el.dataset.mode; vibrate(); render(); },
  'sales-shift'(el) { shiftAnchor(Number(el.dataset.dir)); vibrate(); render(); },
  'sales-today'() { state.sales.anchor = new Date(); vibrate(); render(); },
  async 'void-sale'(el) {
    if (!await ask('이 결제를 취소(삭제)할까요?\n매출에서 빠집니다.', '결제 취소')) return;
    await DB.remove(Number(el.dataset.id)); toast('결제를 취소했습니다'); render();
  },
  async add(el) {
    const isMenu = el.dataset.kind === 'menu';
    const item = isMenu ? { id: uid(), name: '새 메뉴', price: 0 } : { id: uid(), name: `${settings.tables.length + 1}번`, seats: 4 };
    (isMenu ? settings.menu : settings.tables).push(item);
    saveSettings(); await render();
    const input = document.querySelector(`.edit-row[data-id="${item.id}"] input`);
    if (input) { input.scrollIntoView({ block: 'center' }); input.focus(); input.select(); }
  },
  async del(el) {
    const isMenu = el.dataset.kind === 'menu';
    const list = isMenu ? settings.menu : settings.tables;
    const item = list.find(x => x.id === el.dataset.id); if (!item) return;
    if (!isMenu && hasItems(open[item.id])) { alert('주문이 남아 있는 테이블은 삭제할 수 없습니다.\n먼저 결제하거나 비워 주세요.'); return; }
    if (list.length <= 1) { alert('최소 1개는 남겨 두어야 합니다.'); return; }
    if (!await ask(`'${item.name}'을(를) 삭제할까요?`, '삭제')) return;
    list.splice(list.indexOf(item), 1); saveSettings(); render();
  },
  move(el) {
    const list = el.dataset.kind === 'menu' ? settings.menu : settings.tables;
    const i = list.findIndex(x => x.id === el.dataset.id); const j = i + Number(el.dataset.dir);
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]]; saveSettings(); render();
  },
  theme(el) { applyTheme(el.dataset.theme, true); vibrate(); render(); },
  'export-json'() { return exportJSON(); },
  'export-csv'() { return exportCSV(); },
  async wipe() {
    if (!await checkPin('매출 기록 전체 삭제')) return;
    const cloudNote = state.cloud && state.cloud.linked ? '\n클라우드에 저장된 기록도 함께 지워집니다.' : '';
    if (!await ask(`매출 기록을 전부 삭제할까요?${cloudNote}\n되돌릴 수 없습니다.`, '전체 삭제')) return;
    await DB.clearAll(); toast('매출 기록을 삭제했습니다'); render();
  },
  async 'pin-set'() {
    if (!hasPin()) { if (await setupPin()) render(); return; }
    const r = await checkPin('비밀번호 변경');
    if (!r) return;
    if (r === 'new' || await setupPin()) render();
  },
  async 'cloud-login'() {
    const email = ($('#cloud-email') || {}).value || '';
    const pw = ($('#cloud-pw') || {}).value || '';
    if (!email.trim() || !pw) { alert('이메일과 비밀번호를 입력해 주세요.'); return; }
    try {
      await Cloud.login(email, pw);
      toast('클라우드에 연결했습니다', 'ok');
    } catch (e) {
      alert('로그인하지 못했습니다.\n' + e.message);
    }
  },
  async 'cloud-logout'() {
    const n = state.cloud ? state.cloud.pending : 0;
    const warn = n > 0 ? `\n아직 올리지 못한 기록 ${n}건이 있습니다.` : '';
    if (!await ask(`클라우드에서 로그아웃할까요?${warn}\n로그아웃하면 이 폰의 매출은 더 이상 클라우드에 저장되지 않습니다.`, '로그아웃')) return;
    await Cloud.logout(); toast('로그아웃했습니다');
  },
  async 'cloud-sync'() {
    await Cloud.sync();
    const s = Cloud.status();
    if (s.error) toast(s.error);
    else toast(s.pending ? `올릴 대기 ${s.pending}건` : '클라우드에 모두 저장되어 있습니다', s.pending ? '' : 'ok');
  },
  'cloud-retry'() { return Cloud.start(); },
  async install() {
    const p = state.installPrompt; if (!p) return;
    p.prompt();
    try { await p.userChoice; } catch (e) { /* 사용자가 닫음 */ }
    state.installPrompt = null; render();
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  const r = fn(el);
  if (r && typeof r.catch === 'function') r.catch(err => alert('오류가 생겼습니다.\n' + (err.message || err)));
});

document.addEventListener('change', e => {
  const el = e.target.closest('[data-field]'); if (!el) return;
  const f = el.dataset.field, id = el.dataset.id;
  if (f === 'sales-date') {
    const [y, m, d] = el.value.split('-').map(Number);
    if (y && m && d) { state.sales.anchor = new Date(y, m - 1, d); render(); }
    return;
  }
  if (f === 'restore-file') {
    const file = el.files && el.files[0]; el.value = '';
    if (file) restoreFromFile(file);
    return;
  }
  if (f === 'storeName') { settings.storeName = el.value.trim() || DEFAULT_SETTINGS().storeName; el.value = settings.storeName; }
  else if (f === 'menu-name' || f === 'table-name') {
    const x = (f === 'menu-name' ? settings.menu : settings.tables).find(v => v.id === id); if (!x) return;
    x.name = el.value.trim() || x.name; el.value = x.name;
  }
  else if (f === 'menu-price') {
    const x = settings.menu.find(v => v.id === id); if (!x) return;
    x.price = Math.max(0, Math.round(Number(el.value) || 0)); el.value = x.price;
  }
  else if (f === 'menu-cash') {
    const x = settings.menu.find(v => v.id === id); if (!x) return;
    const v = el.value.trim() === '' ? NaN : Math.round(Number(el.value));
    if (isFinite(v) && v >= 0 && v < x.price) x.cashPrice = v; else delete x.cashPrice;
    el.value = x.cashPrice != null ? x.cashPrice : '';
  }
  else if (f === 'table-seats') {
    const x = settings.tables.find(v => v.id === id); if (!x) return;
    const seats = Math.min(20, Math.max(0, Math.round(Number(el.value) || 0)));
    if (seats > 0) x.seats = seats; else delete x.seats;
    el.value = x.seats || '';
  }
  else return;
  saveSettings();
});

/* ---------- 시작 ---------- */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); state.installPrompt = e;
  if (state.view === 'settings') render();
});
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') state.wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* 화면 켜짐 유지 미지원 */ }
}
document.addEventListener('visibilitychange', keepAwake);

(async function init() {
  if (window.Cloud) {
    DB.onTracked = () => Cloud.kick();
    Cloud.start({
      config: window.GUJIP_FIREBASE_CONFIG || null,
      db: DB,
      onStatus: onCloudStatus,
      onRemoteChange: () => { if (state.view === 'tables' || state.view === 'sales') render(); },
    });
  }
  render();
  keepAwake();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* 오프라인 캐시 없이 동작 */ });
  }
  try {
    if (navigator.storage && navigator.storage.persist) {
      state.persisted = await navigator.storage.persist();
      if (state.view === 'settings') render();
    }
  } catch (e) { state.persisted = false; }
})();
