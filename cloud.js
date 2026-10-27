/* 클라우드 자동 저장 (Firebase Firestore)
 * - 폰 안의 IndexedDB가 원본입니다. 바뀐 기록은 outbox에 쌓였다가 Firestore로 올라갑니다(push).
 * - 다른 기기에서 생긴 변경은 updatedAt 순서로 받아옵니다(pull).
 * - 인터넷이 끊기면 기다렸다가 연결되면 올립니다. 영업(주문·결제)에는 영향이 없습니다.
 * 저장 위치: users/{로그인 계정 uid}/sales/{기록 uid}. 삭제는 문서를 지우지 않고 deleted:true로 표시합니다.
 */
'use strict';

window.Cloud = (() => {
  const SDK_BASE = 'https://www.gstatic.com/firebasejs/12.0.0/';
  const LS_LINK = 'gujip.cloud.link';      // 이 폰이 연결된 계정 { uid, email }
  const LS_SINCE = 'gujip.cloud.since';    // 마지막으로 받아온 변경 시각 { s, n }
  const LS_LAST = 'gujip.cloud.lastSync';  // 마지막으로 성공한 저장 시각(ms)
  const BATCH = 400, PAGE = 500, TIMEOUT = 30000, PERIOD = 60000;

  let opts = {};   // { config, loader, db, onStatus, onRemoteChange }
  let fb = null, auth = null, fs = null, user = null, unsubAuth = null;
  let starting = null, timer = null, busy = false, again = false, gen = 0;
  const st = { phase: 'off', error: '', pending: 0, lastSync: 0 };

  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 무시 */ } };
  const link = () => lsGet(LS_LINK);
  st.lastSync = Number(lsGet(LS_LAST)) || 0;

  function status() {
    const l = link();
    return Object.assign({}, st, {
      busy, configured: !!opts.config, linked: !!l, signedIn: !!user,
      email: user ? user.email : (l && l.email) || null,
    });
  }
  function emit() { try { if (opts.onStatus) opts.onStatus(status()); } catch (e) { /* 화면 갱신 실패는 무시 */ } }
  async function refreshPending() {
    try { st.pending = opts.db ? await opts.db.outboxCount() : 0; } catch (e) { /* 무시 */ }
    emit();
  }

  const withTimeout = (p, ms = TIMEOUT) => Promise.race([p, new Promise((_, rej) =>
    setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), ms))]);

  function describe(e) {
    const c = String((e && e.code) || '');
    const m = String((e && e.message) || e || '');
    if (/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(c)) return '이메일 또는 비밀번호가 맞지 않습니다';
    if (/too-many-requests/.test(c)) return '시도가 너무 많아 잠시 막혔습니다. 몇 분 뒤 다시 해 주세요';
    if (/user-disabled/.test(c)) return '사용이 중지된 계정입니다';
    if (/permission-denied/.test(c)) return '저장 권한이 없습니다. Firestore 보안 규칙을 확인해 주세요';
    if (/unauthenticated|user-token-expired|requires-recent-login/.test(c)) return '로그인이 풀렸습니다. 다시 로그인해 주세요';
    if (/network|unavailable|timeout|deadline/.test(c) || /offline|network|timeout/i.test(m)) return '인터넷 연결이 없어 기다리는 중입니다';
    return m || '알 수 없는 오류';
  }

  const defaultLoader = async () => {
    const mods = await Promise.all(['app', 'auth', 'firestore'].map(n => import(SDK_BASE + 'firebase-' + n + '.js')));
    return Object.assign({}, ...mods);
  };

  /* 시작: 설정(config)이 있으면 Firebase를 불러오고 로그인 상태를 확인합니다. */
  function start(o) {
    opts = Object.assign({}, opts, o || {});
    const myGen = ++gen;
    // 연결된 적이 있는 폰은 로그인 확인 전에도 바뀐 기록을 쌓아 둡니다(인터넷 없이 켜도 빠짐없이 올라가도록).
    if (opts.db) opts.db.setTracking(!!(opts.config && link()));
    refreshPending();
    if (!opts.config) { st.phase = 'off'; emit(); return Promise.resolve(); }
    st.phase = 'loading'; st.error = ''; emit();
    starting = (async () => {
      try {
        const lib = await (opts.loader || defaultLoader)();
        if (myGen !== gen) return;
        fb = lib;
        const app = myGen === 1 ? fb.initializeApp(opts.config) : fb.initializeApp(opts.config, 'gujip-' + myGen);
        auth = fb.getAuth(app);
        fs = fb.getFirestore(app);
        unsubAuth = fb.onAuthStateChanged(auth, u => { onAuth(u, myGen); });
      } catch (e) {
        if (myGen !== gen) return;
        fb = auth = fs = null;
        st.phase = 'error';
        st.error = navigator.onLine === false ? '인터넷이 연결되면 클라우드를 다시 불러옵니다' : 'Firebase를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요';
        emit();
      } finally {
        if (myGen === gen) starting = null;
      }
    })();
    return starting;
  }

  function stop() {
    gen++;
    clearTimeout(timer);
    if (unsubAuth) { try { unsubAuth(); } catch (e) { /* 무시 */ } }
    unsubAuth = null; fb = auth = fs = user = null; busy = false; again = false; starting = null;
  }

  async function onAuth(u, myGen) {
    if (myGen !== gen) return;
    user = u || null;
    if (user) {
      const l = link();
      opts.db.setTracking(true);
      if (!l || l.uid !== user.uid) {
        // 처음 연결(또는 다른 계정): 이 폰의 기록을 모두 올리고, 클라우드 기록은 처음부터 받아옵니다.
        lsSet(LS_SINCE, null);
        await opts.db.markAllForUpload();
        lsSet(LS_LINK, { uid: user.uid, email: user.email });
      }
      st.phase = 'ready'; st.error = '';
      emit();
      kick(0);
    } else {
      st.phase = link() ? 'signedout' : 'login';
      st.error = link() ? '로그인이 풀렸습니다. 다시 로그인해 주세요' : '';
      emit();
    }
  }

  function kick(delay = 1500) {
    clearTimeout(timer);
    timer = setTimeout(sync, delay);
    refreshPending();
  }

  async function sync() {
    if (!user || !fs) return;
    if (busy) { again = true; return; }
    busy = true; emit();
    try {
      if (navigator.onLine === false) throw Object.assign(new Error('offline'), { code: 'unavailable' });
      await push();
      const changed = await pull();
      st.lastSync = Date.now(); lsSet(LS_LAST, st.lastSync);
      st.error = '';
      if (changed && opts.onRemoteChange) opts.onRemoteChange();
    } catch (e) {
      st.error = describe(e);
    } finally {
      busy = false;
      await refreshPending();
      if (again) { again = false; kick(500); }
    }
  }

  /* 올리기: outbox에 쌓인 변경을 400건씩 묶어서 저장 */
  async function push() {
    for (;;) {
      const entries = await opts.db.outboxList(BATCH);
      if (!entries.length) return;
      const batch = fb.writeBatch(fs);
      for (const e of entries) {
        const ref = fb.doc(fs, 'users', user.uid, 'sales', e.uid);
        const rec = e.op === 'put' ? await opts.db.getByUid(e.uid) : null;
        if (rec) {
          const data = JSON.parse(JSON.stringify(rec)); // undefined 값 제거
          delete data.id;
          data.deleted = false;
          data.updatedAt = fb.serverTimestamp();
          batch.set(ref, data);
        } else {
          batch.set(ref, { deleted: true, updatedAt: fb.serverTimestamp() }, { merge: true });
        }
      }
      await withTimeout(batch.commit());
      await opts.db.outboxDone(entries);
    }
  }

  /* 받아오기: 마지막으로 받은 시각 이후에 바뀐 기록만 */
  async function pull() {
    const col = fb.collection(fs, 'users', user.uid, 'sales');
    let since = lsGet(LS_SINCE);
    let changed = 0;
    for (;;) {
      const cons = [fb.orderBy('updatedAt'), fb.limit(PAGE)];
      if (since) cons.unshift(fb.where('updatedAt', '>', new fb.Timestamp(since.s, since.n)));
      const snap = await withTimeout(fb.getDocsFromServer(fb.query(col, ...cons)));
      const docs = snap.docs.map(d => {
        const v = d.data();
        const u = v.updatedAt;
        const rec = Object.assign({}, v);
        delete rec.updatedAt; delete rec.deleted; delete rec.id;
        return { uid: d.id, deleted: !!v.deleted, rec, at: u ? { s: u.seconds, n: u.nanoseconds } : null };
      });
      if (!docs.length) break;
      changed += await opts.db.applyRemote(docs);
      for (const d of docs) {
        if (d.at && (!since || d.at.s > since.s || (d.at.s === since.s && d.at.n > since.n))) since = d.at;
      }
      lsSet(LS_SINCE, since);
      if (docs.length < PAGE) break;
    }
    return changed;
  }

  async function waitReady() {
    if (starting) await starting;
    if (!auth) throw new Error(st.error || '클라우드를 아직 불러오지 못했습니다');
  }

  async function login(email, password) {
    await waitReady();
    try {
      await withTimeout(fb.signInWithEmailAndPassword(auth, String(email).trim(), String(password)));
    } catch (e) {
      throw new Error(describe(e));
    }
  }

  async function logout() {
    lsSet(LS_LINK, null); lsSet(LS_SINCE, null);
    if (opts.db) { opts.db.setTracking(false); await opts.db.outboxClear(); }
    if (auth) { try { await fb.signOut(auth); } catch (e) { /* 무시 */ } }
    user = null;
    st.phase = opts.config ? 'login' : 'off'; st.error = ''; st.pending = 0;
    emit();
  }

  /* 관리자 비밀번호를 잊었을 때: 클라우드 계정 비밀번호로 본인 확인 */
  async function verifyPassword(password) {
    if (!user || !fb) throw new Error('클라우드에 로그인되어 있지 않습니다');
    try {
      await withTimeout(fb.reauthenticateWithCredential(user, fb.EmailAuthProvider.credential(user.email, String(password))));
      return true;
    } catch (e) {
      throw new Error(describe(e));
    }
  }

  window.addEventListener('online', () => {
    if (opts.config && !fb && !starting) start();
    else kick(500);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(500); });
  setInterval(() => { if (user && document.visibilityState === 'visible') kick(0); }, PERIOD);

  return { start, stop, kick, sync, login, logout, verifyPassword, status };
})();
