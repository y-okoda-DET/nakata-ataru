// 文癖：みんなのキャラ（ランダム対戦）用のAPI
// Cloudflare Worker（D1 を "DB"、秘密の文字列を "IP_SALT" という名前でつないで使う）。worker/index.js から呼ばれる。
//
//   GET    /api/buntai/health                     動作確認
//   GET    /api/buntai/beasts/random?n=3&exclude=No  登録されたキャラをランダムに返す
//   POST   /api/buntai/beasts      {code, token}   キャラを登録（本人の同意はゲーム画面で確認済み）
//   DELETE /api/buntai/beasts/:id  (X-Delete-Token) 登録を取り消す（登録した本人だけ）
//   POST   /api/buntai/report      {id, reason}    通報（3件で自動的に非表示）
//   POST   /api/buntai/battles     {id, t, k, won} 対戦結果（登録キャラが勝ったか）。t,k は対戦券
//   GET    /api/buntai/beasts/:id/stats         登録キャラが、ほかの人に挑まれた対戦の通算成績
//   GET    /api/buntai/boss                        昨日（日本時間）いちばん勝ったキャラ＝「昨日のボス」
//   POST   /api/buntai/links       {code}          対戦リンクを短くする（?b=ID）。ランダム対戦には出ない
//   GET    /api/buntai/links/:id                   短いリンクのキャラコードを返す
//
// 元の文章はここには届かない。届くのは「キャラコード」（キャラの設定・ステータス・技の一文）だけ。

const LIMIT_REGISTER_PER_DAY = 5;   // 1人（1回線）あたり1日に登録できる数
const LIMIT_REPORT_PER_DAY = 20;    // 1人あたり1日に通報できる数
const HIDE_AFTER_REPORTS = 3;       // この数の通報で自動的に非表示
const MAX_CODE_LENGTH = 6000;       // キャラコードの長さの上限（文字）
const DAY = 24 * 60 * 60 * 1000;
const TICKET_TTL = 60 * 60 * 1000;  // 対戦券の有効時間（1時間）
const LIMIT_BATTLES_PER_DAY = 300;  // 1人あたり1日に記録する対戦の数
const KEEP_BATTLES_DAYS = 30;       // 対戦記録を残す日数
const LIMIT_LINKS_PER_DAY = 50;     // 1人あたり1日に作れる短いリンクの数

// ---- 不適切な言葉（ひらがな・漢字で書く。カタカナや全角/半角の違いは自動でそろえて照合する）----
// 必要に応じて足したり消したりしてください。短すぎる言葉は、ふつうの言葉の一部に誤って当たるので避けています。
const NG_WORDS = [
  // 性的な言葉
  'せっくす', 'ちんこ', 'ちんぽ', 'まんこ', 'ぺにす', 'おっぱい', 'ふぇら', 'れいぷ', '強姦', '痴漢', '売春', '援交', '援助交際',
  'ぱぱかつ', '中出し', '射精', '勃起', '自慰', 'おなにー', '乳首', '陰毛', 'えろ動画', 'あだると',
  // 暴力・脅し
  '死ね', '殺す', 'ころす', '殺害予告', '爆破予告', '自殺しろ', '殺してやる',
  // 差別的な言葉
  'きちがい', '気違い', '基地外', 'がいじ', '池沼', '支那人', '黒んぼ', '穢多', '部落民'
];
// 個人情報や宣伝につながる書き方（URL・メールアドレス・電話番号・SNSのID・郵便番号）
const NG_PATTERNS = [
  /https?:\/\//i, /www\./i, /[\w.+-]+@[\w-]+\.[\w.]+/, /0\d{1,4}[-ー－\s]?\d{1,4}[-ー－\s]?\d{3,4}/, /@[A-Za-z0-9_]{4,}/, /〒?\d{3}[-ー－]\d{4}/
];

// ---- ゲーム側と同じ値の一覧（これ以外の値は受け付けない）----
const ATTRS = ['heat', 'logic', 'sorrow', 'humor', 'grace', 'chaos'];
const FXS = ['strike', 'heavy', 'combo', 'stun', 'guard', 'heal', 'fortify', 'pierce', 'counter', 'crit', 'wild', 'drain', 'confuse', 'charge', 'charm', 'mirror', 'taunt'];
const BODIES = ['blob', 'tall', 'wide', 'orb', 'drop', 'star', 'box', 'crag'];
const PARTS = ['horns', 'antenna', 'wings', 'tail', 'crown', 'halo', 'glasses', 'hat', 'ribbon', 'spikes', 'arms', 'fangs', 'steam', 'cape'];
const EYES = ['round', 'sleepy', 'sharp', 'sparkle', 'dots', 'one', 'many', 'closed'];
const MOUTHS = ['shout', 'smile', 'flat', 'wavy', 'fang', 'o', 'cat', 'none'];
const PATTERNS = ['words', 'stripes', 'spots', 'checker', 'plain'];
const SAMPLE_NOS = ['C548F8', '648EA0', '839158', 'A3D126']; // 例文4体のキャラ番号（ゲーム側の例文を変えたらここも変える）
const STAT_RANGE = [[100, 231], [12, 38], [4, 32], [6, 38], [6, 36]]; // ボス級（+5%）の分まで

// ================= 入口 =================
export async function onRequest(context) {
  const { request, env, params } = context;
  try {
    if (!env.DB) return json({ error: 'データベースがつながっていません（D1の "DB" の設定を確認してください）' }, 500);
    const path = (params.path || []).join('/');
    const m = request.method;
    if (m === 'GET' && path === 'health') return json({ ok: true });
    if (m === 'GET' && path === 'beasts/random') return randomBeasts(request, env);
    if (m === 'POST' && path === 'beasts') return registerBeast(request, env);
    if (m === 'DELETE' && path.startsWith('beasts/')) return deleteBeast(request, env, path.slice(7));
    const st = m === 'GET' && path.match(/^beasts\/([a-z0-9]{8,32})\/stats$/);
    if (st) return beastStats(env, st[1]);
    if (m === 'POST' && path === 'report') return reportBeast(request, env);
    if (m === 'POST' && path === 'battles') return recordBattle(request, env);
    if (m === 'GET' && path === 'boss') return yesterdaysBoss(request, env);
    if (m === 'POST' && path === 'links') return createLink(request, env);
    if (m === 'GET' && path.startsWith('links/')) return getLink(env, path.slice(6));
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: 'サーバーでエラーが起きました' }, 500);
  }
}

// ================= ランダムに返す =================
async function randomBeasts(request, env) {
  const url = new URL(request.url);
  const n = Math.min(6, Math.max(1, parseInt(url.searchParams.get('n') || '3', 10) || 3));
  const exclude = String(url.searchParams.get('exclude') || '').slice(0, 12);
  const { results } = await env.DB
    .prepare('SELECT id, code FROM beasts WHERE hidden = 0 AND no <> ?1 ORDER BY RANDOM() LIMIT ?2')
    .bind(exclude, n).all();
  const ip = await ipHash(request, env);
  const beasts = await Promise.all((results || []).map(async r => ({ ...r, ...(await makeTicket(env, r.id, ip)) })));
  return json({ beasts }, 200, { 'Cache-Control': 'no-store' });
}

// ================= 対戦結果の記録 =================
// 対戦券（サーバーが相手を渡すときに発行した印）がある対戦だけを記録する。
// 同じ人（同じ回線）が同じキャラと何回戦っても、1日1回ぶんしか数えない。登録した本人の回線からの対戦は数えない。
async function recordBattle(request, env) {
  const body = await readJson(request, 1000);
  const id = body && String(body.id || '');
  if (!/^[a-z0-9]{8,32}$/.test(id) || typeof body.won !== 'boolean') return json({ error: '送られてきた内容が正しくありません' }, 400);
  const ip = await ipHash(request, env);
  const t = Number(body.t);
  if (!t || Date.now() - t > TICKET_TTL || t > Date.now() + 60000) return json({ error: '対戦券の期限が切れています' }, 400);
  if (String(body.k || '') !== (await makeTicket(env, id, ip, t)).k) return json({ error: '対戦券が正しくありません' }, 403);
  const beast = await env.DB.prepare('SELECT ip_hash FROM beasts WHERE id = ?1 AND hidden = 0').bind(id).first();
  if (!beast) return json({ ok: true, counted: false });
  if (beast.ip_hash === ip) return json({ ok: true, counted: false, reason: 'own' });
  const day = jstDay(Date.now());
  const used = await env.DB.prepare('SELECT COUNT(*) AS c FROM battles WHERE ip_hash = ?1 AND day = ?2').bind(ip, day).first();
  if (used && used.c >= LIMIT_BATTLES_PER_DAY) return json({ ok: true, counted: false, reason: 'limit' });
  const r = await env.DB.prepare('INSERT OR IGNORE INTO battles (beast_id, ip_hash, day, won, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, ip, day, body.won ? 1 : 0, Date.now()).run();
  const counted = !!(r.meta && r.meta.changes);
  // 通算成績（マイキャラの「挑まれた対戦」に出す）。日ごとの記録は片づけても、これは残る
  if (counted) await env.DB.prepare('UPDATE beasts SET wins = wins + ?2, losses = losses + ?3 WHERE id = ?1')
    .bind(id, body.won ? 1 : 0, body.won ? 0 : 1).run();
  // ときどき古い記録を片づける
  if (Math.random() < 0.01) await env.DB.prepare('DELETE FROM battles WHERE created_at < ?1').bind(Date.now() - KEEP_BATTLES_DAYS * DAY).run();
  return json({ ok: true, counted });
}

// 登録キャラの通算成績（ほかの人に挑まれた対戦）。非表示・取り消し済みなら found: false
async function beastStats(env, id) {
  const b = await env.DB.prepare('SELECT wins, losses, hidden FROM beasts WHERE id = ?1').bind(id).first();
  if (!b) return json({ found: false });
  return json({ found: true, hidden: !!b.hidden, wins: b.wins || 0, losses: b.losses || 0 });
}

// ================= 短い対戦リンク =================
// キャラコードを保存して短いIDを返す。同じキャラコードなら同じID。ランダム対戦の一覧には出ない。
async function createLink(request, env) {
  const body = await readJson(request, 8000);
  if (!body || typeof body.code !== 'string' || body.code.length > MAX_CODE_LENGTH) return json({ error: '送られてきた内容が正しくありません' }, 400);
  let beast;
  try { beast = normalizeBeast(decodeCode(body.code)); } catch (e) { return json({ error: 'キャラコードを読み取れませんでした' }, 400); }
  const code = encodeCode(beast);
  const hash = await sha256(code);
  const exists = await env.DB.prepare('SELECT id FROM links WHERE code_hash = ?1').bind(hash).first();
  if (exists) return json({ ok: true, id: exists.id });
  const ip = await ipHash(request, env);
  const used = await env.DB.prepare('SELECT COUNT(*) AS c FROM links WHERE ip_hash = ?1 AND created_at > ?2').bind(ip, Date.now() - DAY).first();
  if (used && used.c >= LIMIT_LINKS_PER_DAY) return json({ error: '今日はこれ以上リンクを作れません' }, 429);
  const id = randomId().slice(0, 10);
  await env.DB.prepare('INSERT INTO links (id, code, code_hash, name, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(id, code, hash, beast.n, ip, Date.now()).run();
  return json({ ok: true, id });
}
async function getLink(env, id) {
  if (!/^[a-z0-9]{6,32}$/.test(id)) return json({ error: 'not found' }, 404);
  const row = await env.DB.prepare('SELECT code FROM links WHERE id = ?1').bind(id).first();
  if (!row) return json({ error: 'リンクが見つかりません' }, 404);
  return json({ code: row.code }, 200, { 'Cache-Control': 'public, max-age=86400' });
}

// ================= 昨日のボス =================
// 日本時間の「昨日」に、いちばん多く勝ったキャラ（勝ち数が同じなら、対戦数が少ない＝勝率が高いほう、次に先に登録したほう）
async function yesterdaysBoss(request, env) {
  const day = jstDay(Date.now() - DAY);
  const row = await env.DB.prepare(
    'SELECT b.id AS id, b.code AS code, SUM(t.won) AS wins, COUNT(*) AS games FROM battles t JOIN beasts b ON b.id = t.beast_id ' +
    'WHERE t.day = ?1 AND b.hidden = 0 GROUP BY t.beast_id HAVING SUM(t.won) > 0 ORDER BY wins DESC, games ASC, b.created_at ASC LIMIT 1'
  ).bind(day).first();
  if (!row) return json({ boss: null, day }, 200, { 'Cache-Control': 'no-store' });
  const ip = await ipHash(request, env);
  return json({ boss: { id: row.id, code: row.code, wins: row.wins, games: row.games, ...(await makeTicket(env, row.id, ip)) }, day }, 200, { 'Cache-Control': 'no-store' });
}

// ================= 登録 =================
async function registerBeast(request, env) {
  const body = await readJson(request, 8000);
  if (!body || typeof body.code !== 'string' || typeof body.token !== 'string') return json({ error: '送られてきた内容が正しくありません' }, 400);
  if (body.code.length > MAX_CODE_LENGTH || body.token.length < 16 || body.token.length > 100) return json({ error: '送られてきた内容が長すぎるか短すぎます' }, 400);

  let beast;
  try { beast = normalizeBeast(decodeCode(body.code)); } catch (e) { return json({ error: 'キャラコードを読み取れませんでした' }, 400); }

  // 例文から作ったキャラ（だれが作っても同じキャラ）は登録しない
  if (SAMPLE_NOS.includes(beast.no)) return json({ error: '例文から作ったキャラは登録できません。自分の文章からキャラを作ってください。' }, 422);
  const bad = findNg(beast);
  if (bad) return json({ error: `「${bad.field}」に登録できない言葉や書き方が含まれています。${bad.field.includes('一文') ? '「技で飛ばす一文も公開する」を外すと登録できる場合があります。' : ''}`, field: bad.field }, 422);

  const ip = await ipHash(request, env);
  const since = Date.now() - DAY;
  const used = await env.DB.prepare('SELECT COUNT(*) AS c FROM beasts WHERE ip_hash = ?1 AND created_at > ?2').bind(ip, since).first();
  if (used && used.c >= LIMIT_REGISTER_PER_DAY) return json({ error: `登録できるのは1日${LIMIT_REGISTER_PER_DAY}体までです。明日また登録してください。` }, 429);

  const exists = await env.DB.prepare('SELECT id FROM beasts WHERE no = ?1').bind(beast.no).first();
  if (exists) return json({ error: 'このキャラはもう登録されています。' }, 409);

  const id = randomId();
  const deleteHash = await sha256(body.token);
  await env.DB.prepare('INSERT INTO beasts (id, no, code, name, ip_hash, delete_hash, reports, hidden, bk, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7, ?8)')
    .bind(id, beast.no, encodeCode(beast), beast.n, ip, deleteHash, beast.bk, Date.now()).run();
  return json({ ok: true, id });
}

// ================= 取り消し =================
async function deleteBeast(request, env, id) {
  if (!/^[a-z0-9]{8,32}$/.test(id)) return json({ error: 'not found' }, 404);
  const token = request.headers.get('X-Delete-Token') || '';
  const row = await env.DB.prepare('SELECT delete_hash FROM beasts WHERE id = ?1').bind(id).first();
  if (!row) return json({ ok: true }); // もう無い
  if (row.delete_hash !== await sha256(token)) return json({ error: '登録した本人ではないため取り消せません' }, 403);
  await env.DB.prepare('DELETE FROM beasts WHERE id = ?1').bind(id).run();
  await env.DB.prepare('DELETE FROM reports WHERE beast_id = ?1').bind(id).run();
  await env.DB.prepare('DELETE FROM battles WHERE beast_id = ?1').bind(id).run();
  return json({ ok: true });
}

// ================= 通報 =================
async function reportBeast(request, env) {
  const body = await readJson(request, 2000);
  const id = body && String(body.id || '');
  const reason = body && ['words', 'privacy', 'other'].includes(body.reason) ? body.reason : 'other';
  if (!/^[a-z0-9]{8,32}$/.test(id)) return json({ error: '送られてきた内容が正しくありません' }, 400);
  const ip = await ipHash(request, env);
  const since = Date.now() - DAY;
  const used = await env.DB.prepare('SELECT COUNT(*) AS c FROM reports WHERE ip_hash = ?1 AND created_at > ?2').bind(ip, since).first();
  if (used && used.c >= LIMIT_REPORT_PER_DAY) return json({ error: '今日はこれ以上通報できません' }, 429);
  const r = await env.DB.prepare('INSERT OR IGNORE INTO reports (beast_id, ip_hash, reason, created_at) VALUES (?1, ?2, ?3, ?4)').bind(id, ip, reason, Date.now()).run();
  if (r.meta && r.meta.changes) {
    await env.DB.prepare('UPDATE beasts SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= ?2 THEN 1 ELSE hidden END WHERE id = ?1').bind(id, HIDE_AFTER_REPORTS).run();
  }
  return json({ ok: true });
}

// ================= キャラコードの読み書き（ゲーム側と同じ形式） =================
function decodeCode(code) {
  let b = code.trim().replace(/^BB\d-/, '').replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const bin = atob(b);
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function encodeCode(o) {
  const bytes = new TextEncoder().encode(JSON.stringify(o));
  let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); });
  return 'BB4-' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const cut = (v, n) => (typeof v === 'string' ? [...v.trim()].slice(0, n).join('') : '');
const pick = (v, list, d) => (list.includes(v) ? v : d);
// 知らない項目は捨て、長さと値の範囲をそろえ直す（ゲームが読める形だけを保存する）
function normalizeBeast(o) {
  if (!o || (o.v !== 3 && o.v !== 4) || !Array.isArray(o.s) || !Array.isArray(o.m)) throw new Error('bad');
  const vi = o.vi && typeof o.vi === 'object' ? o.vi : {};
  const hex = c => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null);
  const colors = (Array.isArray(vi.colors) ? vi.colors.map(hex).filter(Boolean) : []).slice(0, 2);
  while (colors.length < 2) colors.push(colors.length ? '#D62839' : '#9AA5B1');
  const moves = o.m.slice(0, 3).map(m => [pick(m && m[0], FXS, 'strike'), cut(m && m[1], 14) || '体当たり', cut(m && m[2], 30), cut(m && m[3], 40)]);
  if (moves.length < 2) throw new Error('bad');
  const no = cut(o.no, 6);
  if (!/^[0-9A-F]{6}$/.test(no)) throw new Error('bad');
  return {
    v: 4, n: cut(o.n, 12) || 'ナナシ', e: cut(o.e, 16), a: pick(o.a, ATTRS, 'chaos'), sp: cut(o.sp, 34), pe: cut(o.pe, 40), ca: cut(o.ca, 30),
    no, lv: Math.min(99, Math.max(5, Number(o.lv) || 10)),
    s: o.s.slice(0, 5).map((x, i) => Math.min(STAT_RANGE[i][1], Math.max(STAT_RANGE[i][0], Math.round(Number(x) || STAT_RANGE[i][0])))),
    vi: {
      body: pick(vi.body, BODIES, 'blob'), colors,
      parts: Array.isArray(vi.parts) ? [...new Set(vi.parts.filter(p => PARTS.includes(p)))].slice(0, 3) : [],
      eyes: pick(vi.eyes, EYES, 'round'), mouth: pick(vi.mouth, MOUTHS, 'flat'), pattern: pick(vi.pattern, PATTERNS, 'plain'),
      emblem: [...cut(vi.emblem, 2) || '文'][0],
      mark: ['shine', 'tear', 'anger', 'sweat'].includes(vi.mark) ? vi.mark : ''
    },
    m: moves, c: cut(o.c, 8), d: (Number(o.d) >>> 0), bk: o.bk === 1 ? 1 : 0
  };
}

// ================= 不適切な言葉のチェック =================
function norm(t) {
  return String(t).normalize('NFKC').toLowerCase().replace(/\s+/g, '')
    .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60)); // カタカナ→ひらがな
}
function findNg(b) {
  const fields = [['名前', b.n], ['二つ名', b.e], ['正体', b.sp], ['性格', b.pe], ['決めゼリフ', b.ca], ['胸の文字', b.vi.emblem], ['体の模様の文字', b.c]];
  b.m.forEach((m, i) => { fields.push([`技${i + 1}の名前`, m[1]], [`技${i + 1}の説明`, m[2]], [`技${i + 1}で飛ばす一文`, m[3]]); });
  for (const [field, raw] of fields) {
    if (!raw) continue;
    const t = norm(raw);
    if (NG_WORDS.some(w => t.includes(norm(w)))) return { field };
    if (NG_PATTERNS.some(re => re.test(String(raw).normalize('NFKC')))) return { field };
  }
  return null;
}

// ================= 小物 =================
async function readJson(request, max) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > max) return null;
  const text = await request.text();
  if (text.length > max) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// IPアドレスはそのまま保存せず、秘密の文字列と混ぜたハッシュだけを保存する
async function ipHash(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return sha256(ip + '|' + (env.IP_SALT || 'change-me'));
}
// 対戦券：どのキャラを・だれに・いつ渡したかを、秘密の文字列で署名したもの
async function makeTicket(env, id, ip, t = Date.now()) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('ticket|' + (env.IP_SALT || 'change-me')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}|${ip}|${t}`));
  return { t, k: [...new Uint8Array(sig)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('') };
}
// 日本時間の日付（YYYY-MM-DD）
function jstDay(ms) { return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function randomId() {
  const a = new Uint8Array(12); crypto.getRandomValues(a);
  return [...a].map(b => (b % 36).toString(36)).join('');
}
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
