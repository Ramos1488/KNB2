// ═══════════════════════════════════════════════
//  KNB script.js  —  API + Ранги сообществ
//  Сервер: https://knb-production-c9aa.up.railway.app
// ═══════════════════════════════════════════════

const API     = '/api';
const WS_URL  = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
const OWNER_EMAIL = 'foxi@knb.com';

// ── Состояние ────────────────────────────────────
let me = null;
let token = localStorage.getItem('knb_token') || null;

let PAGE    = 'feed';
let ADMTAB  = 'overview';
let chatId  = null;
let cmtPostId  = null;
let postCommId = null;

let ws = null;
let localStream = null;
let pc = null;
let callFrom = null;
let callType = null;
let pendingCall = null;
let muted = false;
let camOff = false;
let mrec = null;
let mrChunks = [];
let voiceCid = null;

// Данные
let allUsers       = [];
let allPosts       = [];
let allComms       = [];
let allFriendships = [];
let allNotifs      = [];
let allGroups      = [];
let commMembers    = {};   // { [commId]: [{uid, rank, ts}] }

// Ранги: иерархия прав
const RANKS = {
  owner:     { label: 'Владелец',  color: '#f59e0b', icon: '👑', canPost: true,  canManage: true  },
  admin:     { label: 'Админ',     color: '#ef4444', icon: '🛡️', canPost: true,  canManage: true  },
  moderator: { label: 'Модератор', color: '#a855f7', icon: '⚡', canPost: true,  canManage: false },
  member:    { label: 'Участник',  color: '#6b7280', icon: '👤', canPost: false, canManage: false },
};

const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ── Хелперы рангов ───────────────────────────────
function getMemberRank(commId, userId) {
  const list = commMembers[commId];
  if (!list) return null;
  const c = fc(commId);
  if (c && c.createdBy === userId) return 'owner';
  const m = list.find(x => x.uid === userId);
  return m ? (m.rank || 'member') : null;
}

function canPostInComm(commId) {
  if (!me) return false;
  if (isOwner()) return true;
  const c = fc(commId);
  if (c && c.createdBy === me.id) return true;
  const rank = getMemberRank(commId, me.id);
  return rank !== null && RANKS[rank] && RANKS[rank].canPost;
}

function canManageComm(commId) {
  if (!me) return false;
  if (isOwner()) return true;
  const c = fc(commId);
  if (c && c.createdBy === me.id) return true;
  const rank = getMemberRank(commId, me.id);
  return rank !== null && RANKS[rank] && RANKS[rank].canManage;
}

function rankBadge(rank) {
  const r = RANKS[rank];
  if (!r || rank === 'member') return '';
  return `<span style="font-size:.72rem;font-weight:700;color:${r.color}">${r.icon} ${r.label}</span>`;
}

// ── API ───────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) opts.body = JSON.stringify(body);
  let r;
  try {
    r = await fetch(API + path, opts);
  } catch {
    throw new Error('Нет соединения с сервером');
  }
  let data;
  try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) throw new Error(data.error || 'Ошибка ' + r.status);
  return data;
}

const GET  = p      => api('GET',    p);
const POST = (p, b) => api('POST',   p, b);
const PUT  = (p, b) => api('PUT',    p, b);
const DEL  = p      => api('DELETE', p);

async function loadAll() {
  if (!token) return;
  try {
    const [users, posts, comms, friendships, notifs, groups] = await Promise.all([
      GET('/users'),
      GET('/posts'),
      GET('/communities'),
      GET('/friendships'),
      GET('/notifications'),
      GET('/groups').catch(() => [])
    ]);
    allUsers       = users       || [];
    allPosts       = posts       || [];
    allComms       = comms       || [];
    allFriendships = friendships || [];
    allNotifs      = notifs      || [];
    allGroups      = groups      || [];
  } catch (e) { console.error('loadAll:', e.message); }
}

// ── Утилиты ──────────────────────────────────────
function fu(id)  { return allUsers.find(u => u.id === id); }
function fc(id)  { return allComms.find(c => c.id === id); }
function isOwner() { return me && me.email === OWNER_EMAIL; }

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function ago(ts) {
  const d = (Date.now() - new Date(ts)) / 1000;
  if (d < 60)    return 'только что';
  if (d < 3600)  return Math.floor(d / 60)   + ' мин.';
  if (d < 86400) return Math.floor(d / 3600) + ' ч.';
  return new Date(ts).toLocaleDateString('ru-RU');
}

function ava(name) {
  return 'https://ui-avatars.com/api/?name=' + encodeURIComponent(name || '?') + '&background=4f8ef7&color=fff&size=80';
}

function rf(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Ошибка чтения файла'));
    reader.readAsDataURL(file);
  });
}

function OM(id) { const el = document.getElementById(id); if (el) el.classList.add('open');    }
function CM(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }

function openLB(src) {
  document.getElementById('lb-img').src = src;
  document.getElementById('lb').classList.add('open');
}

function toggleTheme() { document.body.classList.toggle('light'); }

// ── WebSocket ─────────────────────────────────────
function connectWS() {
  if (!token) return;
  try { ws = new WebSocket(WS_URL); } catch { setTimeout(connectWS, 5000); return; }
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
  };
  ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }

    if (m.type === 'new_post') {
      allPosts.unshift(m.post);
      if (PAGE === 'feed') renderPage();
    }
    if (m.type === 'new_message' && chatId && m.message.chatId === chatId) {
      appendMsg(m.message);
    }
    if (m.type === 'notification') {
      const n = { id: '_n' + Date.now(), uid: me ? me.id : '', text: m.text, read: false, ts: new Date().toISOString() };
      allNotifs.unshift(n);
      renderHdr();
      renderRP();
    }
    if (m.type === 'call_incoming')  { pendingCall = m; showIncoming(m); }
    if (m.type === 'call_answer' && pc) pc.setRemoteDescription(new RTCSessionDescription(m.answer)).catch(() => {});
    if (m.type === 'call_ice'    && pc) pc.addIceCandidate(new RTCIceCandidate(m.candidate)).catch(() => {});
    if (m.type === 'call_rejected') { document.getElementById('cs-st').textContent = 'Звонок отклонён'; setTimeout(endCall, 1500); }
    if (m.type === 'call_ended') endCall();
    if (m.type === 'banned') { alert('🚫 Аккаунт заблокирован'); doLogout(); }
    if (m.type === 'verified') { if (me) { me.verified = true; renderHdr(); } }
    if (m.type === 'friend_request' || m.type === 'friend_accepted') {
      loadAll().then(() => { renderPage(); renderRP(); });
    }
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => {};
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ── Отрисовка ─────────────────────────────────────
function render() {
  renderHdr();
  renderNav();
  renderRP();
  renderPage();
}

function renderHdr() {
  const el = document.getElementById('hdr-r');
  if (!el) return;
  if (!me) {
    el.innerHTML = `<button class="btn bp bsm" onclick="OM('m-auth');showLi()">Войти</button>`;
    return;
  }
  const unread = allNotifs.filter(n => !n.read).length;
  el.innerHTML = `
    <button class="hbtn" title="Тема" onclick="toggleTheme()"><i class="fas fa-circle-half-stroke"></i></button>
    <button class="hbtn" onclick="goPage('notifications')" style="position:relative">
      <i class="fas fa-bell"></i>
      ${unread ? `<span class="bdg">${unread}</span>` : ''}
    </button>
    <img class="hava" src="${me.avatar || ava(me.name)}" onclick="goPage('profile')"
         onerror="this.src='${ava(me.name)}'" title="${esc(me.name)}">`;
}

function renderNav() {
  document.querySelectorAll('.ni[data-p]').forEach(b => {
    b.classList.toggle('active', b.dataset.p === PAGE);
  });
  const admbtn = document.getElementById('admbtn');
  if (admbtn) admbtn.style.display = isOwner() ? 'flex' : 'none';
}

function renderRP() {
  const rps = document.getElementById('rps');
  const rpn = document.getElementById('rpn');
  if (!me || !rps) return;

  const friends = me.friends || [];
  const suggestions = allUsers.filter(u => u.id !== me.id && !friends.includes(u.id)).slice(0, 5);
  rps.innerHTML = suggestions.map(u => `
    <div class="fr" onclick="viewUser('${u.id}')">
      <img class="avsm" src="${u.avatar || ava(u.name)}" onerror="this.src='${ava(u.name)}'">
      <div>
        <div style="font-weight:700;font-size:.85rem">${esc(u.name)}</div>
        <div style="color:var(--txt2);font-size:.75rem">${esc(u.username)}</div>
      </div>
    </div>`).join('') || `<p style="color:var(--txt2);font-size:.85rem">Нет рекомендаций</p>`;

  if (rpn) {
    rpn.innerHTML = allNotifs.slice(0, 5).map(n =>
      `<div style="font-size:.82rem;padding:.4rem 0;border-bottom:1px solid var(--border);color:var(--txt2)">${esc(n.text)}</div>`
    ).join('') || `<p style="color:var(--txt2);font-size:.85rem">Нет</p>`;
  }
}

function renderPage() {
  const c = document.getElementById('cnt');
  if (!c) return;
  if (!me) {
    c.innerHTML = `<div class="wlc">
      <h1>KNB</h1>
      <p>Социальная сеть нового поколения. Общайся, создавай сообщества, звони друзьям.</p>
      <div style="display:flex;gap:.75rem;flex-wrap:wrap;justify-content:center">
        <button class="btn bp" onclick="OM('m-auth');showLi()">Войти</button>
        <button class="btn bs" onclick="OM('m-auth');showReg()">Регистрация</button>
      </div>
    </div>`;
    return;
  }
  switch (PAGE) {
    case 'feed':          renderFeed();             break;
    case 'profile':       c.innerHTML = buildProfile(me, true); break;
    case 'friends':       c.innerHTML = buildFriends();    break;
    case 'messages':      renderMessages();          break;
    case 'communities':   c.innerHTML = buildComms();      break;
    case 'notifications': c.innerHTML = buildNotifs(); markNotifsRead(); break;
    case 'settings':      c.innerHTML = buildSettings();   break;
    case 'admin':         renderAdmin();             break;
    case 'search':        c.innerHTML = buildSearch(window._searchQ || ''); break;
  }
}

function goPage(p) {
  PAGE = p;
  if (p !== 'messages') chatId = null;
  renderNav();
  renderHdr();
  renderPage();
}

// ── ЛЕНТА ────────────────────────────────────────
function renderFeed() {
  const c = document.getElementById('cnt');
  let h = `<div style="margin-bottom:1rem">
    <button class="btn bp" onclick="openPostModal()"><i class="fas fa-plus"></i> Создать пост</button>
  </div>`;

  const sorted = [...allPosts].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  if (!sorted.length) {
    c.innerHTML = h + `<p style="color:var(--txt2);text-align:center;margin-top:3rem">Нет постов. Будь первым! 🚀</p>`;
    return;
  }

  sorted.forEach(p => {
    const isCommPost = !!p.communityId;
    const author = isCommPost ? fc(p.communityId) : fu(p.authorId);
    if (!author) return;
    const liked = (p.likes || []).includes(me.id);
    const canDel = isOwner() || p.authorId === me.id;
    const authorRank = isCommPost ? getMemberRank(p.communityId, p.authorId) : null;

    h += `<div class="pc">
      <div class="ph" onclick="${isCommPost ? `viewComm('${p.communityId}')` : `viewUser('${p.authorId}')`}">
        <img class="ava" src="${author.avatar || ava(author.name)}" onerror="this.src='${ava(author.name)}'">
        <div>
          <div class="pan">
            ${isCommPost ? `<i class="fas fa-users" style="color:var(--blue);font-size:.8rem"></i> ` : ''}
            ${esc(author.name)}
            ${author.verified ? '<i class="fas fa-check-circle vc"></i>' : ''}
          </div>
          <div class="pm">
            ${isCommPost ? `${esc(fc(p.communityId) ? fc(p.communityId).name : '')} · ` : ''}
            ${ago(p.ts)}
            ${isCommPost && authorRank && authorRank !== 'member' ? ` · ${rankBadge(authorRank)}` : ''}
          </div>
        </div>
      </div>
      ${p.text ? `<div class="ptxt">${esc(p.text)}</div>` : ''}
      ${p.media ? buildMediaEl(p.media) : ''}
      <div class="pact">
        <button class="ab${liked ? ' liked' : ''}" onclick="likePost('${p.id}')">
          <i class="fas fa-heart"></i> ${(p.likes || []).length}
        </button>
        <button class="ab" onclick="showCmts('${p.id}')">
          <i class="fas fa-comment"></i> ${(p.comments || []).length}
        </button>
        ${canDel ? `<button class="ab db" onclick="delPost('${p.id}')"><i class="fas fa-trash"></i></button>` : ''}
      </div>
    </div>`;
  });
  c.innerHTML = h;
}

function buildMediaEl(media) {
  if (!media) return '';
  const url = media.url || media;
  const type = media.t || '';
  if (type.startsWith('video')) {
    return `<video class="pimg" controls src="${url}" style="max-height:320px"></video>`;
  }
  return `<img class="pimg" src="${url}" onclick="openLB(this.src)" onerror="this.style.display='none'">`;
}

function openPostModal(cid = null) {
  postCommId = cid;
  const cw = document.getElementById('pt-cw');
  if (cid && cw) {
    const c = fc(cid);
    cw.style.display = '';
    document.getElementById('pt-cn').textContent = c ? c.name : '';
  } else if (cw) {
    cw.style.display = 'none';
  }
  const tx = document.getElementById('pt-tx');
  const mf = document.getElementById('pt-mf');
  if (tx) tx.value = '';
  if (mf) mf.value = '';
  OM('m-post');
}

async function publishPost() {
  const text = (document.getElementById('pt-tx').value || '').trim();
  const file = document.getElementById('pt-mf').files[0];
  if (!text && !file) { alert('Добавьте текст или медиа'); return; }

  const btn = document.getElementById('pt-b');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';

  let media = null;
  if (file) {
    try { media = { url: await rf(file), t: file.type }; }
    catch { alert('Ошибка загрузки файла'); btn.disabled = false; btn.innerHTML = 'Опубликовать'; return; }
  }

  try {
    const post = await POST('/posts', { text, media, communityId: postCommId || undefined });
    allPosts.unshift(post);
    CM('m-post');
    postCommId = null;
    renderPage();
  } catch (e) { alert(e.message); }

  btn.disabled = false;
  btn.innerHTML = 'Опубликовать';
}

async function likePost(pid) {
  try {
    const updated = await POST('/posts/' + pid + '/like');
    const i = allPosts.findIndex(p => p.id === pid);
    if (i >= 0) allPosts[i] = updated;
    renderPage();
  } catch (e) { console.error('likePost:', e.message); }
}

async function delPost(pid) {
  if (!confirm('Удалить пост?')) return;
  try {
    await DEL('/posts/' + pid);
    allPosts = allPosts.filter(p => p.id !== pid);
    renderPage();
  } catch (e) { alert(e.message); }
}

// ── КОММЕНТАРИИ ───────────────────────────────────
function showCmts(pid) {
  cmtPostId = pid;
  const p = allPosts.find(x => x.id === pid);
  if (!p) return;
  drawCmts(p);
  OM('m-cmt');
}

function drawCmts(p) {
  const el = document.getElementById('cmt-l');
  if (!el) return;
  el.innerHTML = (p.comments || []).map(c => {
    const u = fu(c.uid);
    return `<div style="display:flex;gap:.5rem;margin-bottom:.75rem">
      <img class="avsm" src="${u ? u.avatar || ava(u.name) : ava('?')}" onerror="this.src='${ava('?')}'">
      <div>
        <div style="font-weight:700;font-size:.82rem">${u ? esc(u.name) : '?'}</div>
        <div style="font-size:.9rem">${esc(c.text)}</div>
        <div style="color:var(--txt2);font-size:.72rem">${ago(c.ts)}</div>
      </div>
    </div>`;
  }).join('') || `<p style="color:var(--txt2);font-size:.85rem;text-align:center">Нет комментариев</p>`;
}

async function addCmt() {
  const inp = document.getElementById('cmt-i');
  const text = (inp.value || '').trim();
  if (!text || !cmtPostId) return;
  try {
    const updated = await POST('/posts/' + cmtPostId + '/comment', { text });
    const i = allPosts.findIndex(p => p.id === cmtPostId);
    if (i >= 0) allPosts[i] = updated;
    drawCmts(updated);
    inp.value = '';
  } catch (e) { alert(e.message); }
}

// ── ПРОФИЛЬ ───────────────────────────────────────
function buildProfile(user, isSelf) {
  const friends  = me.friends || [];
  const isFriend = friends.includes(user.id);
  const outReq   = allFriendships.find(f => f.from === me.id && f.to === user.id && f.status === 'pending');
  const incReq   = allFriendships.find(f => f.from === user.id && f.to === me.id && f.status === 'pending');
  const userPosts = allPosts.filter(p => p.authorId === user.id && !p.communityId)
                            .sort((a, b) => new Date(b.ts) - new Date(a.ts));

  return `
    <div class="pban" style="${user.banner ? `background-image:url('${user.banner}')` : ''}"></div>
    <div class="paw">
      <img class="pava" src="${user.avatar || ava(user.name)}" onerror="this.src='${ava(user.name)}'">
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;padding-bottom:.5rem">
        ${isSelf  ? `<button class="btn bs bsm" onclick="goPage('settings')"><i class="fas fa-pen"></i> Редактировать</button>` : ''}
        ${!isSelf && !isFriend && !outReq && !incReq
          ? `<button class="btn bp bsm" onclick="addFriend('${user.id}')"><i class="fas fa-user-plus"></i> Добавить</button>` : ''}
        ${!isSelf && outReq ? `<button class="btn bs bsm" disabled>Заявка отправлена</button>` : ''}
        ${!isSelf && incReq ? `<button class="btn bg2c bsm" onclick="accFriendship('${incReq.id}')"><i class="fas fa-check"></i> Принять</button>` : ''}
        ${!isSelf && isFriend ? `<button class="btn bs bsm" disabled><i class="fas fa-check"></i> В друзьях</button>` : ''}
        ${!isSelf ? `<button class="btn bs bsm" onclick="startChat('${user.id}')"><i class="fas fa-envelope"></i> Написать</button>` : ''}
        ${!isSelf && isOwner() ? `<button class="btn bd bsm" onclick="adm_ban('${user.id}')"><i class="fas fa-ban"></i></button>` : ''}
      </div>
    </div>
    <div class="pinfo">
      <div class="pname">${esc(user.name)}${user.verified ? '<i class="fas fa-check-circle vc"></i>' : ''}</div>
      <div class="puname">${esc(user.username)}</div>
      ${user.bio ? `<p class="pbio">${esc(user.bio)}</p>` : ''}
      <div style="display:flex;gap:1.5rem;margin-top:.5rem">
        <div><b>${(user.friends || []).length}</b> <span style="color:var(--txt2);font-size:.85rem">друзей</span></div>
        <div><b>${userPosts.length}</b> <span style="color:var(--txt2);font-size:.85rem">постов</span></div>
      </div>
    </div>
    <h3 style="margin:.5rem 0 1rem;font-family:'Unbounded',sans-serif;font-size:.9rem">Посты</h3>
    ${userPosts.map(p => `<div class="pc">
      ${p.text ? `<div class="ptxt">${esc(p.text)}</div>` : ''}
      ${p.media ? buildMediaEl(p.media) : ''}
      <div style="color:var(--txt2);font-size:.78rem;margin-top:.5rem">${ago(p.ts)} · ❤️ ${(p.likes || []).length}</div>
    </div>`).join('') || `<p style="color:var(--txt2)">Нет постов</p>`}`;
}

function viewUser(uid2) {
  const u = fu(uid2);
  if (!u) return;
  document.getElementById('cnt').innerHTML = buildProfile(u, u.id === me.id);
  document.querySelectorAll('.ni').forEach(b => b.classList.remove('active'));
}

async function addFriend(uid2) {
  try {
    const f = await POST('/friendships', { to: uid2 });
    allFriendships.push(f);
    viewUser(uid2);
  } catch (e) { alert(e.message); }
}

async function accFriendship(fid) {
  try {
    await PUT('/friendships/' + fid + '/accept');
    await loadAll();
    me = allUsers.find(u => u.id === me.id) || me;
    renderPage();
    renderHdr();
  } catch (e) { alert(e.message); }
}

// ── ДРУЗЬЯ ───────────────────────────────────────
function buildFriends() {
  const myFriends = (me.friends || []).map(id => fu(id)).filter(Boolean);
  const incoming  = allFriendships
    .filter(f => f.to === me.id && f.status === 'pending')
    .map(f => ({ ...f, user: fu(f.from) }))
    .filter(f => f.user);

  let h = `<h2 style="font-family:'Unbounded',sans-serif;font-size:1rem;margin-bottom:1.5rem">Друзья</h2>`;

  if (incoming.length) {
    h += `<p style="font-weight:700;margin-bottom:.75rem;color:var(--txt2);font-size:.82rem">ЗАЯВКИ (${incoming.length})</p>`;
    h += incoming.map(r => `<div class="ur">
      <img class="ava" src="${r.user.avatar || ava(r.user.name)}" onerror="this.src='${ava(r.user.name)}'">
      <div class="uri">
        <div class="un">${esc(r.user.name)}</div>
        <div class="us">${esc(r.user.username)}</div>
      </div>
      <div class="ura">
        <button class="btn bg2c bsm" onclick="accFriendship('${r.id}')"><i class="fas fa-check"></i></button>
        <button class="btn bs bsm" onclick="rejFriendship('${r.id}')"><i class="fas fa-times"></i></button>
      </div>
    </div>`).join('');
    h += `<div class="nsep"></div>`;
  }

  h += `<p style="font-weight:700;margin-bottom:.75rem;color:var(--txt2);font-size:.82rem">МОИ ДРУЗЬЯ (${myFriends.length})</p>`;
  h += myFriends.map(u => `<div class="ur">
    <img class="ava" src="${u.avatar || ava(u.name)}" onerror="this.src='${ava(u.name)}'">
    <div class="uri" style="cursor:pointer" onclick="viewUser('${u.id}')">
      <div class="un">${esc(u.name)}${u.verified ? '<i class="fas fa-check-circle vc"></i>' : ''}</div>
      <div class="us">${esc(u.username)}</div>
    </div>
    <div class="ura">
      <button class="btn bs bsm" onclick="startChat('${u.id}')"><i class="fas fa-envelope"></i></button>
      <button class="btn bs bsm" style="color:var(--red)" onclick="remFriend('${u.id}')"><i class="fas fa-user-minus"></i></button>
    </div>
  </div>`).join('') || `<p style="color:var(--txt2)">Пока нет друзей. Найди их в поиске!</p>`;

  return h;
}

async function rejFriendship(fid) {
  try {
    await DEL('/friendships/' + fid);
    allFriendships = allFriendships.filter(f => f.id !== fid);
    renderPage();
  } catch (e) { alert(e.message); }
}

async function remFriend(uid2) {
  if (!confirm('Удалить из друзей?')) return;
  const f = allFriendships.find(x =>
    (x.from === me.id && x.to === uid2) || (x.from === uid2 && x.to === me.id)
  );
  if (!f) return;
  try {
    await DEL('/friendships/' + f.id);
    await loadAll();
    me = allUsers.find(u => u.id === me.id) || me;
    renderPage();
    renderHdr();
  } catch (e) { alert(e.message); }
}

// ── СООБЩЕНИЯ ────────────────────────────────────
function chatId2(a, b) {
  return 'chat_' + [a, b].sort().join('_');
}

function startChat(uid2) {
  chatId = chatId2(me.id, uid2);
  goPage('messages');
}

function openChat(cid) {
  chatId = cid;
  goPage('messages');
}

function getChatInfo(cid) {
  if (cid.startsWith('g_')) {
    const g = allGroups.find(x => x.id === cid);
    return { title: g ? g.name : 'Группа', isGroup: true };
  }
  if (cid.startsWith('cc_')) {
    const commId = cid.replace('cc_', '');
    const c = fc(commId);
    return { title: c ? c.name : 'Сообщество', isComm: true, commId };
  }
  // личный чат
  const parts = cid.replace(/^chat_/, '').split('_');
  const otherId = parts.find(p => p !== me.id);
  const other = fu(otherId);
  return { title: other ? other.name : 'Чат', other, otherId };
}

function renderMessages() {
  const c = document.getElementById('cnt');
  if (chatId) {
    c.innerHTML = buildChatUI(chatId);
    loadChatMsgs(chatId);
  } else {
    c.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem">
      <h2 style="font-family:'Unbounded',sans-serif;font-size:1rem">Сообщения</h2>
      <button class="btn bs bsm" onclick="createGroup()"><i class="fas fa-users"></i> Создать группу</button>
    </div><div id="chat-list"></div>`;
    renderChatList();
  }
}

function renderChatList() {
  const el = document.getElementById('chat-list');
  if (!el) return;

  const items = [];
  (me.friends || []).forEach(uid2 => {
    const u = fu(uid2);
    if (u) items.push({ id: chatId2(me.id, uid2), title: u.name, avatar: u.avatar || ava(u.name), type: 'dm' });
  });
  allGroups.forEach(g => {
    items.push({ id: g.id, title: g.name, avatar: null, type: 'group' });
  });
  allComms.forEach(comm => {
    const rank = getMemberRank(comm.id, me.id);
    if (rank) {
      items.push({ id: 'cc_' + comm.id, title: comm.name, avatar: comm.avatar || ava(comm.name), type: 'comm', rank });
    }
  });

  if (!items.length) {
    el.innerHTML = `<p style="color:var(--txt2)">Нет диалогов. Добавь друзей или вступи в сообщество!</p>`;
    return;
  }

  el.innerHTML = items.map(item => {
    const avatarHtml = item.avatar
      ? `<img class="ava" src="${item.avatar}" onerror="this.src='${ava(item.title)}'">`
      : `<div class="ava" style="background:var(--blue);display:flex;align-items:center;justify-content:center;color:#fff;border-radius:50%"><i class="fas fa-users"></i></div>`;
    const badge = item.type === 'group' ? `<span class="tag tb">группа</span>` : item.type === 'comm' ? `<span class="tag tb">сообщество</span>` : '';
    return `<div class="ur" style="cursor:pointer" onclick="openChat('${item.id}')">
      ${avatarHtml}
      <div class="uri">
        <div class="un">${esc(item.title)} ${badge}</div>
        ${item.type === 'comm' && item.rank ? `<div class="us">${rankBadge(item.rank)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function buildChatUI(cid) {
  const info = getChatInfo(cid);
  const isCommChat = cid.startsWith('cc_');
  const commId = isCommChat ? cid.replace('cc_', '') : null;
  const canWrite = !isCommChat || canPostInComm(commId);
  const myRank = isCommChat ? getMemberRank(commId, me.id) : null;

  const avatarHtml = info.other
    ? `<img class="avsm" src="${info.other.avatar || ava(info.other.name)}" onerror="this.src='${ava(info.other.name)}'">`
    : `<div class="avsm" style="background:var(--blue);display:flex;align-items:center;justify-content:center;color:#fff;border-radius:50%"><i class="fas fa-users"></i></div>`;

  const inputArea = canWrite
    ? `<div class="ciw">
        <div class="cim">
          <input id="ci" placeholder="Написать..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMsg('${cid}');}">
          <label class="cib" title="Фото">
            <i class="fas fa-image"></i>
            <input type="file" accept="image/*" style="display:none" onchange="sendImg(this,'${cid}')">
          </label>
          <button class="cib" id="vbtn" title="Голосовое" onmousedown="startVoice('${cid}')" onmouseup="stopVoice()" ontouchstart="startVoice('${cid}')" ontouchend="stopVoice()">
            <i class="fas fa-microphone"></i>
          </button>
        </div>
        <button class="sbtn" onclick="sendMsg('${cid}')"><i class="fas fa-paper-plane"></i></button>
      </div>`
    : `<div style="padding:.75rem 1.25rem;background:var(--bg2);border-top:1px solid var(--border);text-align:center;color:var(--txt2);font-size:.85rem">
        🔒 Только <b>Owner / Admin / Moderator</b> могут писать в этот чат
        ${myRank ? ` · Ваш ранг: ${rankBadge(myRank)}` : ''}
      </div>`;

  return `
    <button class="btn bs bsm" style="margin-bottom:.75rem" onclick="chatId=null;goPage('messages')">
      <i class="fas fa-arrow-left"></i> Назад
    </button>
    <div class="cw">
      <div class="chdr">
        ${avatarHtml}
        <div style="flex:1;min-width:0">
          <div style="font-weight:700">${esc(info.title)}</div>
          ${isCommChat ? `<div style="font-size:.75rem;color:var(--txt2)">Чат сообщества · только Admin+ могут писать</div>` : ''}
        </div>
        ${!isCommChat && info.other ? `
          <button class="btn bs bsm" onclick="startCall('${cid}','audio')"><i class="fas fa-phone"></i></button>
          <button class="btn bs bsm" onclick="startCall('${cid}','video')"><i class="fas fa-video"></i></button>` : ''}
        ${info.isGroup ? `<button class="btn bs bsm" onclick="addGroupMember('${cid}')"><i class="fas fa-user-plus"></i></button>` : ''}
      </div>
      <div class="cmsg" id="cmsg"></div>
      ${inputArea}
    </div>`;
}

async function loadChatMsgs(cid) {
  const el = document.getElementById('cmsg');
  if (!el) return;
  el.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--txt2)"><span class="spin"></span></div>`;
  try {
    const msgs = await GET('/messages?chatId=' + encodeURIComponent(cid));
    const info = getChatInfo(cid);
    if (!msgs.length) {
      el.innerHTML = `<p style="text-align:center;color:var(--txt2);margin-top:2rem">Нет сообщений. Напишите первым!</p>`;
      return;
    }
    el.innerHTML = msgs.map(m => buildMsgHtml(m, info, cid)).join('');
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    el.innerHTML = `<p style="color:var(--red);padding:1rem">Ошибка: ${esc(e.message)}</p>`;
  }
}

function buildMsgHtml(m, info, cid) {
  const isMe = m.senderId === me.id;
  const sender = fu(m.senderId);
  const commId = info.commId || null;
  const rank = commId ? getMemberRank(commId, m.senderId) : null;

  const showName = !isMe && (info.isGroup || info.isComm);

  return `<div class="mw ${isMe ? 'me' : 'them'}">
    ${showName ? `<div class="mauth">${sender ? esc(sender.name) : '?'}${rank && rank !== 'member' ? ' ' + rankBadge(rank) : ''}</div>` : ''}
    <div class="msg ${isMe ? 'me' : 'them'}">
      ${m.text ? `<div>${esc(m.text)}</div>` : ''}
      ${m.img ? `<img class="mimg" src="${m.img}" onclick="openLB(this.src)" onerror="this.style.display='none'">` : ''}
      ${m.voice ? `<div class="mvoice"><i class="fas fa-microphone" style="color:${isMe?'rgba(255,255,255,.7)':'var(--blue)'}"></i><audio controls src="${m.voice}"></audio></div>` : ''}
      <div class="mtime">${ago(m.ts)}</div>
      ${isMe ? `<button class="mdel" onclick="delMsg('${m.id}','${cid}')"><i class="fas fa-times"></i></button>` : ''}
    </div>
  </div>`;
}

function appendMsg(m) {
  const el = document.getElementById('cmsg');
  if (!el || !chatId) return;
  const info = getChatInfo(chatId);
  el.insertAdjacentHTML('beforeend', buildMsgHtml(m, info, chatId));
  el.scrollTop = el.scrollHeight;
}

async function sendMsg(cid) {
  const inp = document.getElementById('ci');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  try {
    const m = await POST('/messages', { chatId: cid, text });
    appendMsg(m);
  } catch (e) { alert(e.message); inp.value = text; }
}

async function sendImg(input, cid) {
  const f = input.files[0];
  if (!f) return;
  input.value = '';
  let img;
  try { img = await rf(f); }
  catch (e) { alert('Ошибка файла'); return; }
  try {
    const m = await POST('/messages', { chatId: cid, img });
    appendMsg(m);
  } catch (e) { alert(e.message); }
}

async function delMsg(mid, cid) {
  try { await DEL('/messages/' + mid); loadChatMsgs(cid); }
  catch (e) { console.error('delMsg:', e.message); }
}

function startVoice(cid) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Микрофон недоступен'); return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(stream => {
      voiceCid = cid;
      mrChunks = [];
      const btn = document.getElementById('vbtn');
      if (btn) btn.classList.add('rec');
      mrec = new MediaRecorder(stream);
      mrec.ondataavailable = e => { if (e.data.size > 0) mrChunks.push(e.data); };
      mrec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (btn) btn.classList.remove('rec');
        if (!mrChunks.length) return;
        const blob = new Blob(mrChunks, { type: 'audio/webm' });
        let voice;
        try { voice = await rf(blob); } catch { return; }
        try {
          const m = await POST('/messages', { chatId: voiceCid, voice });
          appendMsg(m);
        } catch (e) { console.error('voice send:', e.message); }
      };
      mrec.start();
    })
    .catch(() => alert('Нет доступа к микрофону'));
}

function stopVoice() {
  if (mrec && mrec.state !== 'inactive') mrec.stop();
}

async function createGroup() {
  const name = prompt('Название группы:');
  if (!name || !name.trim()) return;
  try {
    const g = await POST('/groups', { name: name.trim() });
    allGroups.push(g);
    openChat(g.id);
  } catch (e) { alert(e.message); }
}

async function addGroupMember(gid) {
  const friends = (me.friends || []).map(id => fu(id)).filter(Boolean);
  if (!friends.length) { alert('Нет друзей для добавления'); return; }
  const list = friends.map(u => u.username + ' — ' + u.name).join('\n');
  const input = prompt('Введите @username:\n' + list);
  if (!input) return;
  const normalized = input.startsWith('@') ? input.trim() : '@' + input.trim();
  const u = allUsers.find(x => x.username === normalized);
  if (!u) { alert('Пользователь не найден'); return; }
  try {
    await POST('/groups/' + gid + '/add', { userId: u.id });
    alert(u.name + ' добавлен!');
  } catch (e) { alert(e.message); }
}

// ── СООБЩЕСТВА ────────────────────────────────────
function buildComms() {
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem">
      <h2 style="font-family:'Unbounded',sans-serif;font-size:1rem">Сообщества</h2>
      <button class="btn bp bsm" onclick="OM('m-cm')"><i class="fas fa-plus"></i> Создать</button>
    </div>
    ${allComms.map(c => {
      const myRank = getMemberRank(c.id, me.id);
      return `<div class="cc" onclick="viewComm('${c.id}')">
        <img class="cca" src="${c.avatar || ava(c.name)}" onerror="this.src='${ava(c.name)}'">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;display:flex;align-items:center;gap:.4rem">
            ${esc(c.name)}${c.verified ? '<i class="fas fa-check-circle vc"></i>' : ''}
          </div>
          <div style="color:var(--txt2);font-size:.82rem">${esc(c.description || '')}</div>
          ${myRank ? `<div style="margin-top:.3rem">${rankBadge(myRank)}</div>` : ''}
        </div>
      </div>`;
    }).join('') || `<p style="color:var(--txt2)">Нет сообществ. Создайте первое!</p>`}`;
}

async function viewComm(commId) {
  const c = fc(commId);
  if (!c) return;

  // Загрузить участников
  let members = [];
  try { members = await GET('/communities/' + commId + '/members'); commMembers[commId] = members; }
  catch (e) { console.error('members:', e.message); }

  const isMember    = members.some(m => m.uid === me.id);
  const myRank      = getMemberRank(commId, me.id);
  const canPost     = canPostInComm(commId);
  const canManage   = canManageComm(commId);
  const commPosts   = allPosts.filter(p => p.communityId === commId)
                              .sort((a, b) => new Date(b.ts) - new Date(a.ts));

  document.getElementById('cnt').innerHTML = `
    <button class="btn bs bsm" style="margin-bottom:.75rem" onclick="goPage('communities')">
      <i class="fas fa-arrow-left"></i> Назад
    </button>
    <div class="pban" style="${c.banner ? `background-image:url('${c.banner}')` : ''}"></div>
    <div class="paw">
      <img class="pava" src="${c.avatar || ava(c.name)}" style="border-radius:14px" onerror="this.src='${ava(c.name)}'">
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;padding-bottom:.5rem">
        ${!isMember
          ? `<button class="btn bp bsm" onclick="joinComm('${commId}')"><i class="fas fa-sign-in-alt"></i> Вступить</button>`
          : `<button class="btn bs bsm" onclick="leaveComm('${commId}')">Покинуть</button>
             <button class="btn bs bsm" onclick="openChat('cc_${commId}')"><i class="fas fa-comment"></i> Чат</button>
             ${canPost   ? `<button class="btn bs bsm" onclick="openPostModal('${commId}')"><i class="fas fa-pen"></i> Пост</button>` : ''}
             ${canManage ? `<button class="btn bs bsm" onclick="openRankManager('${commId}')"><i class="fas fa-cog"></i> Управление</button>` : ''}`}
      </div>
    </div>
    <div class="pinfo">
      <div class="pname">${esc(c.name)}${c.verified ? '<i class="fas fa-check-circle vc"></i>' : ''}</div>
      ${c.description ? `<p class="pbio">${esc(c.description)}</p>` : ''}
      <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-top:.4rem">
        <div><b>${members.length}</b> <span style="color:var(--txt2);font-size:.85rem">участников</span></div>
        ${myRank ? `<div>${rankBadge(myRank)}</div>` : ''}
      </div>
    </div>

    <!-- Участники с рангами -->
    <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:1rem;margin-bottom:1.25rem">
      <div style="font-weight:700;font-size:.8rem;color:var(--txt2);margin-bottom:.75rem;letter-spacing:.5px">УЧАСТНИКИ</div>
      <div style="display:flex;flex-wrap:wrap;gap:.5rem">
        ${members.slice(0, 12).map(m => {
          const u = fu(m.uid);
          if (!u) return '';
          const rank = (c.createdBy === m.uid) ? 'owner' : (m.rank || 'member');
          const r = RANKS[rank] || RANKS.member;
          return `<div style="display:flex;align-items:center;gap:.35rem;padding:.3rem .65rem;background:var(--bg3);border-radius:20px;font-size:.8rem" title="${r.label}">
            <img style="width:20px;height:20px;border-radius:50%;object-fit:cover" src="${u.avatar || ava(u.name)}" onerror="this.src='${ava(u.name)}'">
            <span>${esc(u.name)}</span>
            <span style="color:${r.color}">${r.icon}</span>
          </div>`;
        }).join('')}
        ${members.length > 12 ? `<div style="padding:.3rem .65rem;color:var(--txt2);font-size:.8rem">+${members.length - 12} ещё</div>` : ''}
      </div>
    </div>

    <!-- Посты -->
    <h3 style="font-family:'Unbounded',sans-serif;font-size:.9rem;margin-bottom:1rem">Посты сообщества</h3>
    ${commPosts.map(p => {
      const au = fu(p.authorId);
      const aRank = getMemberRank(commId, p.authorId);
      return `<div class="pc">
        <div class="ph" onclick="viewUser('${p.authorId}')">
          <img class="avsm" src="${au ? au.avatar || ava(au.name) : ava('?')}" onerror="this.src='${ava('?')}'">
          <div>
            <div style="font-weight:700;font-size:.85rem;display:flex;align-items:center;gap:.4rem">
              ${au ? esc(au.name) : '?'}
              ${aRank && aRank !== 'member' ? rankBadge(aRank) : ''}
            </div>
            <div style="color:var(--txt2);font-size:.75rem">${ago(p.ts)}</div>
          </div>
        </div>
        ${p.text ? `<div class="ptxt">${esc(p.text)}</div>` : ''}
        ${p.media ? buildMediaEl(p.media) : ''}
        <div class="pact">
          <button class="ab${(p.likes || []).includes(me.id) ? ' liked' : ''}" onclick="likePost('${p.id}')">
            <i class="fas fa-heart"></i> ${(p.likes || []).length}
          </button>
          <button class="ab" onclick="showCmts('${p.id}')">
            <i class="fas fa-comment"></i> ${(p.comments || []).length}
          </button>
          ${isOwner() || p.authorId === me.id ? `<button class="ab db" onclick="delPost('${p.id}');viewComm('${commId}')"><i class="fas fa-trash"></i></button>` : ''}
        </div>
      </div>`;
    }).join('') || `<p style="color:var(--txt2)">Нет постов</p>`}`;

  document.querySelectorAll('.ni').forEach(b => b.classList.remove('active'));
}

function openRankManager(commId) {
  const c = fc(commId);
  if (!c) return;
  const members = commMembers[commId] || [];

  const rankOpts = Object.entries(RANKS)
    .filter(([k]) => k !== 'owner')
    .map(([k, v]) => `<option value="${k}">${v.icon} ${v.label}</option>`)
    .join('');

  const rows = members.map(m => {
    const u = fu(m.uid);
    if (!u) return '';
    const isCreator = c.createdBy === m.uid;
    const rank = isCreator ? 'owner' : (m.rank || 'member');
    const r = RANKS[rank] || RANKS.member;

    if (isCreator) {
      return `<div class="ur">
        <img class="ava" src="${u.avatar || ava(u.name)}" onerror="this.src='${ava(u.name)}'">
        <div class="uri">
          <div class="un">${esc(u.name)}</div>
          <div class="us">${esc(u.username)}</div>
        </div>
        <span style="color:${r.color};font-weight:700">${r.icon} Основатель</span>
      </div>`;
    }

    return `<div class="ur">
      <img class="ava" src="${u.avatar || ava(u.name)}" onerror="this.src='${ava(u.name)}'">
      <div class="uri">
        <div class="un">${esc(u.name)}</div>
        <div class="us">${esc(u.username)}</div>
      </div>
      <select
        style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:.3rem .6rem;color:var(--txt);font-family:'Manrope',sans-serif;font-size:.82rem;cursor:pointer"
        onchange="setMemberRank('${commId}','${m.uid}',this.value,this)">
        ${Object.entries(RANKS).filter(([k]) => k !== 'owner').map(([k, v]) =>
          `<option value="${k}" ${rank === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`
        ).join('')}
      </select>
    </div>`;
  }).join('');

  // Удалить старый если есть
  const old = document.getElementById('rank-modal');
  if (old) old.remove();

  const div = document.createElement('div');
  div.id = 'rank-modal';
  div.className = 'mo open';
  div.addEventListener('click', e => { if (e.target === div) div.remove(); });
  div.innerHTML = `<div class="mb" style="max-width:560px">
    <button class="mc" onclick="document.getElementById('rank-modal').remove()"><i class="fas fa-times"></i></button>
    <h2>⚙️ Управление: ${esc(c.name)}</h2>
    <p style="color:var(--txt2);font-size:.85rem;margin-bottom:1.25rem">
      Назначайте ранги участникам.<br>
      <span style="color:var(--yellow)">👑 Owner</span> — только создатель &nbsp;|&nbsp;
      <span style="color:var(--red)">🛡️ Admin</span> — полное управление &nbsp;|&nbsp;
      <span style="color:var(--purple)">⚡ Moderator</span> — может писать посты и в чат &nbsp;|&nbsp;
      <span style="color:var(--txt2)">👤 Участник</span> — только читать
    </p>
    <div style="max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:.4rem">
      ${rows || '<p style="color:var(--txt2)">Нет участников</p>'}
    </div>
  </div>`;
  document.body.appendChild(div);
}

async function setMemberRank(commId, userId, rank, selectEl) {
  try {
    await POST('/communities/' + commId + '/rank', { userId, rank });
    // Обновить кэш
    if (commMembers[commId]) {
      const m = commMembers[commId].find(x => x.uid === userId);
      if (m) m.rank = rank;
    }
    // Показать индикатор
    const orig = selectEl.style.borderColor;
    selectEl.style.borderColor = 'var(--green)';
    setTimeout(() => selectEl.style.borderColor = orig, 1000);
  } catch (e) {
    alert(e.message);
    // Откатить визуально
    selectEl.value = getMemberRank(commId, userId) || 'member';
  }
}

async function joinComm(commId) {
  try {
    await POST('/communities/' + commId + '/join');
    await loadAll();
    const members = await GET('/communities/' + commId + '/members');
    commMembers[commId] = members;
    viewComm(commId);
  } catch (e) { alert(e.message); }
}

async function leaveComm(commId) {
  const c = fc(commId);
  if (c && c.createdBy === me.id) { alert('Создатель не может покинуть сообщество'); return; }
  if (!confirm('Покинуть сообщество?')) return;
  try {
    await POST('/communities/' + commId + '/leave');
    await loadAll();
    commMembers[commId] = (commMembers[commId] || []).filter(m => m.uid !== me.id);
    viewComm(commId);
  } catch (e) { alert(e.message); }
}

async function createComm() {
  const name = (document.getElementById('cm-nm').value || '').trim();
  if (!name) { alert('Введите название'); return; }
  const btn = document.getElementById('cm-b');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';

  let avatar = '';
  const f = document.getElementById('cm-av').files[0];
  if (f) { try { avatar = await rf(f); } catch {} }

  try {
    const comm = await POST('/communities', {
      name,
      description: (document.getElementById('cm-ds').value || '').trim(),
      avatar
    });
    allComms.push(comm);
    commMembers[comm.id] = [{ uid: me.id, rank: 'owner' }];
    CM('m-cm');
    renderPage();
  } catch (e) { alert(e.message); }

  btn.disabled = false;
  btn.innerHTML = 'Создать';
}

// ── ЗВОНКИ (WebRTC) ───────────────────────────────
function getPeerId(cid) {
  const parts = cid.replace(/^chat_/, '').split('_');
  return parts.find(p => p !== me.id);
}

async function startCall(cid, type) {
  callType = type;
  const info = getChatInfo(cid);
  const peerId = info.otherId || getPeerId(cid);
  if (!peerId) { alert('Не могу определить собеседника'); return; }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: type === 'video', audio: true });
  } catch { alert('Разрешите доступ к камере/микрофону'); return; }

  document.getElementById('vloc').srcObject = localStream;
  document.getElementById('cs-nm').textContent = info.title;
  document.getElementById('cs-st').textContent = 'Вызов...';
  document.getElementById('b-cam').style.display = type === 'video' ? 'flex' : 'none';
  document.getElementById('callscr').classList.add('active');
  muted = false; camOff = false;

  pc = new RTCPeerConnection(STUN);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = e => {
    document.getElementById('vrem').srcObject = e.streams[0];
    document.getElementById('cs-st').textContent = 'Соединено ✓';
  };
  pc.onicecandidate = e => {
    if (e.candidate) wsSend({ type: 'call_ice', to: peerId, candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) endCall();
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: 'call_offer', to: peerId, offer, callType: type });
  callFrom = peerId;
}

function showIncoming(m) {
  document.getElementById('ic-av').src = m.callerAva || ava(m.callerName || '?');
  document.getElementById('ic-nm').textContent = m.callerName || '?';
  document.getElementById('ic-tp').textContent = m.callType === 'video' ? '📹 Видеозвонок' : '📞 Аудиозвонок';
  document.getElementById('inc').classList.add('show');
}

async function acceptCall() {
  document.getElementById('inc').classList.remove('show');
  if (!pendingCall) return;
  const { from, offer, callType: ct, callerName } = pendingCall;
  callFrom = from; callType = ct; pendingCall = null;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: ct === 'video', audio: true });
  } catch { alert('Нет доступа к камере/микрофону'); return; }

  document.getElementById('vloc').srcObject = localStream;
  document.getElementById('cs-nm').textContent = callerName || '?';
  document.getElementById('cs-st').textContent = 'Соединение...';
  document.getElementById('b-cam').style.display = ct === 'video' ? 'flex' : 'none';
  document.getElementById('callscr').classList.add('active');
  muted = false; camOff = false;

  pc = new RTCPeerConnection(STUN);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = e => {
    document.getElementById('vrem').srcObject = e.streams[0];
    document.getElementById('cs-st').textContent = 'Соединено ✓';
  };
  pc.onicecandidate = e => {
    if (e.candidate) wsSend({ type: 'call_ice', to: from, candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) endCall();
  };

  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type: 'call_answer', to: from, answer });
}

function rejectCall() {
  document.getElementById('inc').classList.remove('show');
  if (pendingCall) { wsSend({ type: 'call_reject', to: pendingCall.from }); pendingCall = null; }
}

function endCall() {
  if (pc)          { try { pc.close(); } catch {} pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (callFrom)    { wsSend({ type: 'call_end', to: callFrom }); callFrom = null; }
  document.getElementById('callscr').classList.remove('active');
  document.getElementById('vrem').srcObject = null;
  document.getElementById('vloc').srcObject = null;
}

function toggleMute() {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach(t => t.enabled = !muted);
  const b = document.getElementById('b-mu');
  b.innerHTML = muted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
  b.classList.toggle('muted', muted);
}

function toggleCam() {
  if (!localStream) return;
  camOff = !camOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !camOff);
  const b = document.getElementById('b-cam');
  b.innerHTML = camOff ? '<i class="fas fa-video-slash"></i>' : '<i class="fas fa-video"></i>';
  b.classList.toggle('muted', camOff);
}

// ── УВЕДОМЛЕНИЯ ───────────────────────────────────
function buildNotifs() {
  if (!allNotifs.length) return `<h2 style="font-family:'Unbounded',sans-serif;font-size:1rem;margin-bottom:1.5rem">Уведомления</h2><p style="color:var(--txt2)">Нет уведомлений</p>`;
  return `<h2 style="font-family:'Unbounded',sans-serif;font-size:1rem;margin-bottom:1.5rem">Уведомления</h2>
    <div style="background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden">
      ${allNotifs.map(n => `<div class="ni2">
        <div class="nd${n.read ? ' r' : ''}"></div>
        <div>
          <div style="font-size:.9rem">${esc(n.text)}</div>
          <div style="color:var(--txt2);font-size:.75rem;margin-top:.15rem">${ago(n.ts)}</div>
        </div>
      </div>`).join('')}
    </div>`;
}

async function markNotifsRead() {
  try {
    await POST('/notifications/read');
    allNotifs.forEach(n => n.read = true);
    renderHdr();
  } catch {}
}

// ── НАСТРОЙКИ ─────────────────────────────────────
function buildSettings() {
  return `<h2 style="font-family:'Unbounded',sans-serif;font-size:1rem;margin-bottom:1.5rem">Настройки</h2>
    <div class="fg"><label>Имя</label><input id="st-nm" value="${esc(me.name)}"></div>
    <div class="fg"><label>@username</label><input id="st-un" value="${esc(me.username)}"></div>
    <div class="fg"><label>О себе</label><textarea id="st-bi" rows="3">${esc(me.bio || '')}</textarea></div>
    <div class="fg"><label>Новый пароль <span style="color:var(--txt2);font-size:.8rem">(оставьте пустым чтобы не менять)</span></label>
      <input id="st-pw" type="password"></div>
    <div class="fg"><label>Аватар</label><input id="st-av" type="file" accept="image/*"></div>
    <div class="fg"><label>Баннер профиля</label><input id="st-bn" type="file" accept="image/*"></div>
    <div style="display:flex;gap:.75rem;flex-wrap:wrap">
      <button class="btn bp" id="st-b" onclick="saveSettings()"><i class="fas fa-save"></i> Сохранить</button>
      <button class="btn bs" onclick="reqVerify()"><i class="fas fa-check-circle"></i> Заявка на верификацию</button>
      <button class="btn bs" style="color:var(--red);border-color:var(--red)" onclick="doLogout()"><i class="fas fa-sign-out-alt"></i> Выйти</button>
    </div>`;
}

async function saveSettings() {
  const btn = document.getElementById('st-b');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';

  const body = {
    name:     (document.getElementById('st-nm').value || '').trim(),
    username: (document.getElementById('st-un').value || '').trim(),
    bio:      (document.getElementById('st-bi').value || '').trim(),
  };
  const pw = document.getElementById('st-pw').value;
  if (pw) body.password = pw;

  try {
    const avF = document.getElementById('st-av').files[0];
    const bnF = document.getElementById('st-bn').files[0];
    if (avF) body.avatar = await rf(avF);
    if (bnF) body.banner = await rf(bnF);

    const updated = await PUT('/users/' + me.id, body);
    me = updated;
    const i = allUsers.findIndex(u => u.id === me.id);
    if (i >= 0) allUsers[i] = me;
    localStorage.setItem('knb_me', JSON.stringify(me));
    render();
    alert('✅ Сохранено!');
  } catch (e) { alert(e.message); }

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-save"></i> Сохранить';
}

async function reqVerify() {
  try { await POST('/verify-request'); alert('✅ Заявка отправлена!'); }
  catch (e) { alert(e.message); }
}

// ── АДМИН ПАНЕЛЬ ──────────────────────────────────
async function renderAdmin() {
  if (!isOwner()) { document.getElementById('cnt').innerHTML = `<p style="color:var(--red)">Доступ запрещён</p>`; return; }

  let stats = {}, vrs = [];
  try { stats = await GET('/admin/stats'); } catch {}
  try { vrs   = await GET('/admin/verReqs'); } catch {}

  const tabs = [
    { id: 'overview', l: '📊 Обзор' }, { id: 'verify', l: '✅ Верификация' },
    { id: 'users', l: '👥 Пользователи' }, { id: 'posts', l: '📝 Посты' },
    { id: 'comms', l: '🏘 Сообщества' }
  ];

  let body = '';

  if (ADMTAB === 'overview') {
    body = `<div class="sg">
      ${[['Пользователи', stats.users, 'var(--blue)'],
         ['Посты', stats.posts, 'var(--green)'],
         ['Сообщества', stats.communities, 'var(--purple)'],
         ['Заявки', stats.pendingVerify, 'var(--yellow)'],
         ['Забанено', stats.banned, 'var(--red)'],
         ['Верифиц.', stats.verified, 'var(--green)']
      ].map(([l, v, c]) => `<div class="sc"><div class="sv" style="color:${c}">${v || 0}</div><div class="sl">${l}</div></div>`).join('')}
    </div>
    <p style="font-weight:700;font-size:.82rem;color:var(--txt2);margin-bottom:.75rem">ПОСЛЕДНИЕ ПОЛЬЗОВАТЕЛИ</p>
    ${allUsers.slice(-6).reverse().map(u => `<div class="ur">
      <img class="avsm" src="${u.avatar || ava(u.name)}" onerror="this.src='${ava(u.name)}'">
      <div class="uri"><div class="un">${esc(u.name)}${u.verified ? ' ✅' : ''}</div><div class="us">${esc(u.email)}</div></div>
    </div>`).join('')}`;
  }

  else if (ADMTAB === 'verify') {
    const pend = vrs.filter(r => r.status === 'pending');
    body = `<p style="font-weight:700;font-size:.82rem;color:var(--txt2);margin-bottom:.75rem">ЗАЯВКИ (${pend.length})</p>
    ${pend.map(r => {
      const u = fu(r.uid);
      return u ? `<div class="ur">
        <img class="ava" src="${u.avatar || ava(u.name)}" onerror="this.src='${ava(u.name)}'">
        <div class="uri"><div class="un">${esc(u.name)}</div><div class="us">${esc(u.email)}</div></div>
        <div class="ura">
          <button class="btn bg2c bsm" onclick="adm_approveV('${r.id}')">✅ Принять</button>
          <button class="btn bs bsm"   onclick="adm_rejectV('${r.id}')">❌ Отклонить</button>
        </div>
      </div>` : '';
    }).join('') || `<p style="color:var(--txt2)">Нет заявок</p>`}`;
  }

  else if (ADMTAB === 'users') {
    body = `<div class="fg"><input id="adm-s" placeholder="🔍 Поиск по имени или @username..." oninput="admSearch()" style="width:100%"></div>
    <div id="adm-users">
    ${allUsers.map(u => `<div class="ur adm-urow" data-name="${u.name.toLowerCase()}" data-uname="${u.username.toLowerCase()}">
      <img class="ava" src="${u.avatar || ava(u.name)}" onerror="this.src='${ava(u.name)}'">
      <div class="uri" style="cursor:pointer" onclick="viewUser('${u.id}')">
        <div class="un">${esc(u.name)}${u.verified ? ' ✅' : ''}${u.email === OWNER_EMAIL ? ' 👑' : ''}</div>
        <div class="us">${esc(u.username)} · ${esc(u.email)}</div>
      </div>
      <div class="ura">
        ${u.email !== OWNER_EMAIL ? `
          <button class="btn bsm" style="background:${u.verified ? 'var(--red)' : 'var(--green)'};color:#fff"
            onclick="adm_toggleV('${u.id}')">${u.verified ? '❌ Снять ✅' : '✅'}</button>
          <button class="btn bd bsm" onclick="adm_ban('${u.id}')">🚫 Бан</button>
          <button class="btn bs bsm" style="color:var(--red)" onclick="adm_delUser('${u.id}')">🗑</button>`
        : '<span style="color:var(--txt2);font-size:.8rem">Владелец</span>'}
      </div>
    </div>`).join('')}
    </div>`;
  }

  else if (ADMTAB === 'posts') {
    body = `<p style="color:var(--txt2);margin-bottom:1rem;font-size:.85rem">Всего постов: ${allPosts.length}</p>
    ${allPosts.slice(0, 50).map(p => {
      const au = p.communityId ? fc(p.communityId) : fu(p.authorId);
      return `<div class="ur">
        <div class="uri">
          <div class="un" style="font-size:.85rem">${au ? esc(au.name) : '?'} <span style="color:var(--txt2);font-weight:400">· ${ago(p.ts)}</span></div>
          <div class="us">${esc((p.text || '').substring(0, 100))}</div>
        </div>
        <button class="btn bd bsm" onclick="adm_delPost('${p.id}')">🗑</button>
      </div>`;
    }).join('')}`;
  }

  else if (ADMTAB === 'comms') {
    body = allComms.map(c => `<div class="ur">
      <img class="ava" src="${c.avatar || ava(c.name)}" style="border-radius:10px" onerror="this.src='${ava(c.name)}'">
      <div class="uri"><div class="un">${esc(c.name)}${c.verified ? ' ✅' : ''}</div><div class="us">${esc(c.description || '')}</div></div>
      <div class="ura">
        <button class="btn bsm" style="background:${c.verified ? 'var(--red)' : 'var(--green)'};color:#fff"
          onclick="adm_toggleC('${c.id}')">${c.verified ? '❌ Снять ✅' : '✅'}</button>
        <button class="btn bd bsm" onclick="adm_delComm('${c.id}')">🗑</button>
      </div>
    </div>`).join('') || `<p style="color:var(--txt2)">Нет сообществ</p>`;
  }

  document.getElementById('cnt').innerHTML = `
    <h2 style="font-family:'Unbounded',sans-serif;font-size:1rem;margin-bottom:1.25rem">
      <i class="fas fa-shield-alt" style="color:var(--blue)"></i> Панель администратора
    </h2>
    <div class="atabs">
      ${tabs.map(t => `<button class="at${ADMTAB === t.id ? ' active' : ''}" onclick="setAdmTab('${t.id}')">${t.l}</button>`).join('')}
    </div>
    ${body}`;
}

function setAdmTab(t) { ADMTAB = t; renderAdmin(); }

function admSearch() {
  const q = (document.getElementById('adm-s').value || '').toLowerCase();
  document.querySelectorAll('.adm-urow').forEach(row => {
    row.style.display = (row.dataset.name.includes(q) || row.dataset.uname.includes(q)) ? '' : 'none';
  });
}

async function adm_approveV(rid) { try { await POST('/admin/verReqs/' + rid + '/approve'); await loadAll(); renderAdmin(); } catch (e) { alert(e.message); } }
async function adm_rejectV(rid)  { try { await POST('/admin/verReqs/' + rid + '/reject');  await loadAll(); renderAdmin(); } catch (e) { alert(e.message); } }
async function adm_toggleV(uid2) { try { await POST('/admin/users/' + uid2 + '/verify');  await loadAll(); renderAdmin(); } catch (e) { alert(e.message); } }

async function adm_ban(uid2) {
  const u = fu(uid2);
  if (u && u.email === OWNER_EMAIL) { alert('Нельзя заблокировать владельца!'); return; }
  if (!confirm('Заблокировать пользователя?')) return;
  try { await POST('/admin/users/' + uid2 + '/ban'); await loadAll(); renderAdmin(); } catch (e) { alert(e.message); }
}

async function adm_delUser(uid2) {
  const u = fu(uid2);
  if (u && u.email === OWNER_EMAIL) { alert('Нельзя удалить владельца!'); return; }
  if (!confirm('Удалить пользователя навсегда?')) return;
  try { await DEL('/admin/users/' + uid2); await loadAll(); renderAdmin(); } catch (e) { alert(e.message); }
}

async function adm_delPost(pid) {
  if (!confirm('Удалить пост?')) return;
  try { await DEL('/admin/posts/' + pid); allPosts = allPosts.filter(p => p.id !== pid); renderAdmin(); } catch (e) { alert(e.message); }
}

async function adm_toggleC(cid) { try { await POST('/admin/communities/' + cid + '/verify'); await loadAll(); renderAdmin(); } catch (e) { alert(e.message); } }

async function adm_delComm(cid) {
  if (!confirm('Удалить сообщество?')) return;
  try { await DEL('/admin/communities/' + cid); await loadAll(); renderAdmin(); } catch (e) { alert(e.message); }
}

// ── ПОИСК ────────────────────────────────────────
function buildSearch(q) {
  if (!q || q.length < 2) return `<p style="color:var(--txt2)">Введите минимум 2 символа</p>`;
  const ql = q.toLowerCase();
  const users = allUsers.filter(u => u.name.toLowerCase().includes(ql) || u.username.toLowerCase().includes(ql));
  const comms  = allComms.filter(c => c.name.toLowerCase().includes(ql));
  const posts  = allPosts.filter(p => p.text && p.text.toLowerCase().includes(ql));

  let h = `<h2 style="font-family:'Unbounded',sans-serif;font-size:1rem;margin-bottom:1.5rem">Поиск: «${esc(q)}»</h2>`;
  if (!users.length && !comms.length && !posts.length) return h + `<p style="color:var(--txt2)">Ничего не найдено</p>`;

  if (users.length) {
    h += `<p style="font-weight:700;color:var(--txt2);font-size:.82rem;margin-bottom:.75rem">ПОЛЬЗОВАТЕЛИ</p>`;
    h += users.map(u => `<div class="ur" style="cursor:pointer;margin-bottom:.5rem" onclick="viewUser('${u.id}')">
      <img class="ava" src="${u.avatar || ava(u.name)}" onerror="this.src='${ava(u.name)}'">
      <div><div style="font-weight:700">${esc(u.name)}${u.verified ? '<i class="fas fa-check-circle vc"></i>' : ''}</div>
      <div style="color:var(--txt2);font-size:.82rem">${esc(u.username)}</div></div>
    </div>`).join('');
  }

  if (comms.length) {
    h += `<p style="font-weight:700;color:var(--txt2);font-size:.82rem;margin:1rem 0 .75rem">СООБЩЕСТВА</p>`;
    h += comms.map(c => `<div class="cc" onclick="viewComm('${c.id}')" style="margin-bottom:.5rem">
      <img class="cca" src="${c.avatar || ava(c.name)}" onerror="this.src='${ava(c.name)}'">
      <div><div style="font-weight:700">${esc(c.name)}</div>
      <div style="color:var(--txt2);font-size:.82rem">${esc(c.description || '')}</div></div>
    </div>`).join('');
  }

  if (posts.length) {
    h += `<p style="font-weight:700;color:var(--txt2);font-size:.82rem;margin:1rem 0 .75rem">ПОСТЫ</p>`;
    h += posts.map(p => {
      const au = fu(p.authorId);
      return `<div class="pc" style="margin-bottom:.75rem">
        <div style="font-size:.82rem;color:var(--txt2);margin-bottom:.4rem">${au ? esc(au.name) : '?'} · ${ago(p.ts)}</div>
        <div>${esc(p.text)}</div>
      </div>`;
    }).join('');
  }

  return h;
}

// ── АВТОРИЗАЦИЯ ───────────────────────────────────
function showLi()  { document.getElementById('a-li').style.display = ''; document.getElementById('a-rg').style.display = 'none'; }
function showReg() { document.getElementById('a-li').style.display = 'none'; document.getElementById('a-rg').style.display = ''; }

function showAuthErr(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.style.display = '';
}

async function doLogin() {
  const id = (document.getElementById('li-id').value || '').trim();
  const pw = document.getElementById('li-pw').value;
  const errEl = document.getElementById('li-e');
  errEl.style.display = 'none';

  if (!id || !pw) { showAuthErr('li-e', 'Заполните все поля'); return; }

  const btn = document.getElementById('li-b');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';

  try {
    const data = await POST('/auth/login', { id, password: pw });
    token = data.token;
    me    = data.user;
    localStorage.setItem('knb_token', token);
    localStorage.setItem('knb_me', JSON.stringify(me));
    await loadAll();
    CM('m-auth');
    render();
    connectWS();
  } catch (e) {
    showAuthErr('li-e', e.message);
  }

  btn.disabled = false;
  btn.innerHTML = 'Войти';
}

async function doReg() {
  const email    = (document.getElementById('rg-em').value || '').trim();
  const name     = (document.getElementById('rg-nm').value || '').trim();
  const username = (document.getElementById('rg-un').value || '').trim();
  const password = document.getElementById('rg-pw').value;
  const bio      = (document.getElementById('rg-bi').value || '').trim();
  const errEl    = document.getElementById('rg-e');
  errEl.style.display = 'none';

  if (!email || !name || !username || !password) { showAuthErr('rg-e', 'Заполните все поля'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showAuthErr('rg-e', 'Неверный формат email'); return; }
  if (password.length < 6) { showAuthErr('rg-e', 'Пароль минимум 6 символов'); return; }

  const btn = document.getElementById('rg-b');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';

  let avatar = '';
  try { const f = document.getElementById('rg-av').files[0]; if (f) avatar = await rf(f); } catch {}

  try {
    const data = await POST('/auth/register', { email, password, name, username, bio, avatar });
    token = data.token;
    me    = data.user;
    localStorage.setItem('knb_token', token);
    localStorage.setItem('knb_me', JSON.stringify(me));
    await loadAll();
    CM('m-auth');
    render();
    connectWS();
  } catch (e) {
    showAuthErr('rg-e', e.message);
  }

  btn.disabled = false;
  btn.innerHTML = 'Зарегистрироваться';
}

async function doLogout() {
  if (!confirm('Выйти из аккаунта?')) return;
  token = null; me = null;
  localStorage.removeItem('knb_token');
  localStorage.removeItem('knb_me');
  allUsers = []; allPosts = []; allComms = []; allFriendships = [];
  allNotifs = []; allGroups = []; commMembers = {};
  if (ws) { try { ws.close(); } catch {} ws = null; }
  PAGE = 'feed'; chatId = null;
  render();
}

// ── СОБЫТИЯ ──────────────────────────────────────
document.querySelectorAll('.ni[data-p]').forEach(btn => {
  btn.addEventListener('click', () => {
    const p = btn.dataset.p;
    if (!me && p !== 'feed') { OM('m-auth'); showLi(); return; }
    goPage(p);
  });
});

document.getElementById('mtog').addEventListener('click', () => {
  document.getElementById('lnav').classList.toggle('open');
});

document.addEventListener('click', e => {
  if (window.innerWidth <= 640) {
    const nav = document.getElementById('lnav');
    const tog = document.getElementById('mtog');
    if (nav && tog && !nav.contains(e.target) && !tog.contains(e.target)) {
      nav.classList.remove('open');
    }
  }
});

document.getElementById('si').addEventListener('input', e => {
  const q = e.target.value.trim();
  if (q.length < 2) { if (PAGE === 'search') goPage('feed'); return; }
  window._searchQ = q;
  PAGE = 'search';
  renderPage();
  renderNav();
});

// Закрытие модалок по клику вне
document.querySelectorAll('.mo').forEach(modal => {
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.mo.open').forEach(m => m.classList.remove('open'));
    const rmod = document.getElementById('rank-modal');
    if (rmod) rmod.remove();
    if (document.getElementById('callscr').classList.contains('active')) endCall();
  }
});

document.getElementById('li-pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('li-id').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('cmt-i').addEventListener('keydown', e => { if (e.key === 'Enter') addCmt(); });

// ── ИНИЦИАЛИЗАЦИЯ ─────────────────────────────────
async function init() {
  if (!token) { render(); return; }

  // Показать кешированный профиль пока грузим
  try {
    const cached = localStorage.getItem('knb_me');
    if (cached) me = JSON.parse(cached);
  } catch {}

  render(); // быстрый рендер с кешем

  try {
    await loadAll();
    if (allUsers.length) {
      me = allUsers.find(u => u.id === (me && me.id)) || me;
      if (me) localStorage.setItem('knb_me', JSON.stringify(me));
    }
    if (me) connectWS();
    render(); // финальный рендер с данными сервера
  } catch {
    token = null;
    localStorage.removeItem('knb_token');
    localStorage.removeItem('knb_me');
    me = null;
    render();
  }
}

init();
