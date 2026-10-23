'use strict';
/* PhysLand: сервер (Node.js + PostgreSQL).
 * Раздаёт сайт из папки public/ и API по адресу /api/*.
 * Права и проверка ответов — здесь, на сервере (ключи ответов браузеру не отправляются). */
const http = require('http'), fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { Pool, types } = require('pg');

types.setTypeParser(1184, v => new Date(v).toISOString()); // timestamptz -> строка ISO, как раньше в браузере

/* ---------- Общий код сайта: схемы, банк задач, проверка ответов, CSV ---------- */
const sandbox = { console }; sandbox.window = sandbox; vm.createContext(sandbox);
for (const f of ['schemas', 'csv', 'bank', 'checker'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'shared-' + f + '.js'), 'utf8'), sandbox, { filename: f + '.js' });
const PL = sandbox.PL;
PL.ROLE = { student: 'Ученик', admin: 'Администратор' };
PL.STATUS = { draft: 'Черновик', open: 'Открыт', closed: 'Закрыт' };
PL.DEGREE = { I: 'Диплом I степени', II: 'Диплом II степени', III: 'Диплом III степени', participant: 'Сертификат участника' };
PL.LEVELS = [[0, 'Новичок'], [40, 'Ученик'], [100, 'Решатель'], [200, 'Знаток'], [350, 'Мастер']];
PL.ACH_XP = 20; // XP за подтверждённое достижение (то же число в bot/bot.py и во VIEW ratings)
const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');

/* ---------- База данных ---------- */
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('Не задана переменная окружения DATABASE_URL (адрес базы PostgreSQL).'); process.exit(1); }
const pool = new Pool({
  connectionString: DB_URL, max: 10,
  ssl: process.env.PGSSL === 'disable' || /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false }
});
pool.on('error', e => console.error('Ошибка соединения с БД:', e.message));

async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ } throw e; }
  finally { c.release(); }
}

/* ---------- Утилиты ---------- */
const EMAIL = /^[A-Za-z0-9][\w.%+-]*@[A-Za-z0-9][\w.-]*\.[A-Za-z]{2,}$/;
const now = () => new Date().toISOString();
const uid = p => p + '_' + crypto.randomBytes(5).toString('hex');
class ApiError extends Error { constructor(s, m) { super(m); this.status = s; } }
const E = (s, m) => new ApiError(s, m);
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snake = s => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const out = r => r && Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [camel(k), v]));
const pub = r => { const { passwordHash, ...u } = out(r); return u; };
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const all = async (db, sql, params) => (await db.query(sql, params)).rows;

function validate(name, o) {
  const s = PL.schemas[name], errs = [];
  (s.required || []).forEach(k => { if (o[k] == null || o[k] === '') errs.push(k + ': обязательное поле'); });
  Object.entries(o).forEach(([k, v]) => {
    const p = s.properties[k];
    if (!p) return errs.push(k + ': неизвестное поле');
    if (v == null) return;
    if (p.enum) { if (!p.enum.includes(v)) errs.push(k + ': недопустимое значение'); return; }
    const ok = p.type === 'integer' ? Number.isInteger(v) : p.type === 'number' ? typeof v === 'number' : typeof v === p.type;
    if (!ok) return errs.push(k + ': ожидается ' + p.type);
    if (p.minLength && v.length < p.minLength) errs.push(k + ': слишком короткое значение');
    if (p.maxLength && v.length > p.maxLength) errs.push(k + ': слишком длинное значение');
    if (p.minimum !== undefined && v < p.minimum) errs.push(k + ': не меньше ' + p.minimum);
    if (p.maximum !== undefined && v > p.maximum) errs.push(k + ': не больше ' + p.maximum);
    if (p.pattern && !new RegExp(p.pattern).test(v)) errs.push(k + ': неверный формат');
  });
  if (errs.length) throw E(422, errs.join('; '));
  return o;
}

/* Пароли: scrypt + случайная соль (встроено в Node, ничего ставить не нужно). */
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  new Promise((ok, no) => crypto.scrypt(String(pw), salt, 64, (e, k) => e ? no(e) : ok(salt + ':' + k.toString('hex'))));
async function checkPw(pw, stored) {
  const [salt, h] = String(stored).split(':'); if (!salt || !h) return false;
  const c = (await hashPw(pw, salt)).split(':')[1];
  return c.length === h.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(h));
}

const need = (m, role) => { if (!m) throw E(401, 'Требуется вход в систему'); if (role && m.role !== role) throw E(403, 'Недостаточно прав для этого действия'); };
const maxOf = c => PL.bank[c.bank] ? PL.checker.maxScore(PL.bank[c.bank].a) : 0;
const degreeOf = p => p >= 80 ? 'I' : p >= 60 ? 'II' : p >= 40 ? 'III' : 'participant';
const getContest = async (db, id) => out(await one(db, 'SELECT * FROM contests WHERE id=$1', [id]));
const getUser = async (db, id) => out(await one(db, 'SELECT * FROM users WHERE id=$1', [id]));

async function insertUser(db, u, password) {
  await db.query('INSERT INTO users (id,email,full_name,role,status,school,grade,password_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [u.id, u.email, u.fullName, u.role, u.status, u.school ?? null, u.grade ?? null, await hashPw(password), u.createdAt]);
}
async function insertContest(db, c) {
  await db.query('INSERT INTO contests (id,title,track,description,grade,bank,task_count,duration_min,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [c.id, c.title, c.track, c.description ?? null, c.grade ?? null, c.bank, c.taskCount, c.durationMin, c.status, c.createdAt, c.updatedAt]);
}
async function savePart(db, p) {
  await db.query(`INSERT INTO participations (id,user_id,contest_id,status,source,started_at,finished_at,spent_sec,answers_count,score,max_score,manual_pending,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, finished_at=EXCLUDED.finished_at, spent_sec=EXCLUDED.spent_sec,
      answers_count=EXCLUDED.answers_count, score=EXCLUDED.score, max_score=EXCLUDED.max_score, manual_pending=EXCLUDED.manual_pending`,
    [p.id, p.userId, p.contestId, p.status, p.source, p.startedAt, p.finishedAt ?? null, p.spentSec ?? null, p.answersCount ?? null,
      p.score ?? null, p.maxScore ?? null, p.manualPending ?? null, p.createdAt || now()]);
}

/* Завершение участия + автоматическая выдача диплома (единственное место, где это происходит). Вызывать внутри tx(). */
async function finalize(db, part, c, score, spentSec) {
  const max = maxOf(c);
  Object.assign(part, { status: 'finished', finishedAt: now(), spentSec, score, maxScore: max, manualPending: c.taskCount - max });
  validate('participation', part);
  await db.query('SELECT pg_advisory_xact_lock(7001)'); // чтобы номера дипломов не повторялись
  await savePart(db, part);
  const pct = max ? Math.round(score / max * 100) : 0;
  await db.query('DELETE FROM diplomas WHERE participation_id=$1', [part.id]);
  const { n } = await one(db, 'SELECT COALESCE(MAX(right(number,4)::int),0)+1 AS n FROM diplomas');
  const d = validate('diploma', { id: uid('dip'), number: `PL-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`, userId: part.userId, contestId: part.contestId, participationId: part.id, degree: degreeOf(pct), percent: pct, issuedAt: now() });
  await db.query('INSERT INTO diplomas (id,number,user_id,contest_id,participation_id,degree,percent,issued_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [d.id, d.number, d.userId, d.contestId, d.participationId, d.degree, d.percent, d.issuedAt]);
  return d;
}

/* Изменение полей записи: разрешены только перечисленные в allowed (имена колонок берутся из этого списка, не от пользователя). */
async function patchRow(db, table, entity, id, body, allowed) {
  const row = await one(db, `SELECT * FROM ${table} WHERE id=$1`, [id]);
  if (!row) throw E(404, 'Запись не найдена');
  const r = out(row); delete r.passwordHash;
  const cols = allowed.filter(k => body[k] !== undefined);
  cols.forEach(k => { r[k] = body[k]; });
  if (entity === 'contest') { r.updatedAt = now(); cols.push('updatedAt'); }
  validate(entity, r);
  if (cols.length) await db.query(`UPDATE ${table} SET ${cols.map((k, i) => `${snake(k)}=$${i + 2}`).join(',')} WHERE id=$1`, [id, ...cols.map(k => r[k] ?? null)]);
  return r;
}

/* ---------- Маршруты ---------- */
const routes = [];
const route = (m, p, h) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h });
const loginAttempts = new Map(); // простая защита от подбора пароля

// auth
route('POST', '/auth/register', async ({ body, startSession }) => {
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw E(422, 'Введите корректный email, например name@example.com.');
  if (String(body.password || '').length < 8) throw E(422, 'Пароль должен быть не короче 8 символов.');
  if (String(body.fullName || '').trim().length < 2) throw E(422, 'Укажите ФИО (оно будет в дипломе).');
  if (await one(pool, 'SELECT 1 FROM users WHERE email=$1', [email])) throw E(409, 'Этот email уже зарегистрирован. Перейдите на вкладку «Вход».');
  // Роль при саморегистрации всегда student — админов создаёт только админ.
  const u = validate('user', { id: uid('usr'), email, fullName: body.fullName.trim(), role: 'student', status: 'active', createdAt: now() });
  await insertUser(pool, u, body.password);
  await startSession(u.id);
  return u;
});
route('POST', '/auth/login', async ({ body, ip, startSession }) => {
  const email = String(body.email || '').trim().toLowerCase(), key = ip + '|' + email, a = loginAttempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 10 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) throw E(429, 'Слишком много попыток входа. Подождите 10 минут.');
  const u = out(await one(pool, 'SELECT * FROM users WHERE email=$1', [email]));
  if (!u || !(await checkPw(body.password || '', u.passwordHash))) { a.n++; loginAttempts.set(key, a); throw E(401, 'Неверный email или пароль.'); }
  if (u.status === 'blocked') throw E(403, 'Аккаунт заблокирован администратором.');
  loginAttempts.delete(key);
  await startSession(u.id);
  const { passwordHash, ...p } = u; return p;
});
route('POST', '/auth/logout', async ({ endSession }) => { await endSession(); return null; });
route('GET', '/auth/me', async ({ me }) => me ? (({ passwordHash, ...u }) => u)(me) : null);

// users
route('GET', '/users', async ({ me, q }) => {
  need(me, 'admin');
  const rows = await all(pool, `SELECT u.id,u.email,u.full_name,u.role,u.status,u.school,u.grade,u.created_at,
      (SELECT count(*)::int FROM participations p WHERE p.user_id=u.id) AS participations
    FROM users u WHERE $1::text = '' OR position(lower($1) in lower(u.email || ' ' || u.full_name)) > 0 ORDER BY u.created_at`, [q.q || '']);
  return rows.map(out);
});
route('POST', '/users', async ({ me, body }) => {
  need(me, 'admin'); const email = String(body.email || '').trim().toLowerCase();
  if (await one(pool, 'SELECT 1 FROM users WHERE email=$1', [email])) throw E(409, 'Email уже занят');
  const u = validate('user', { id: uid('usr'), email, fullName: (body.fullName || '').trim(), role: body.role || 'student', status: 'active', createdAt: now() });
  await insertUser(pool, u, body.password || crypto.randomBytes(9).toString('hex')); return u;
});
route('GET', '/users/:id', async ({ me, p }) => {
  need(me); if (me.role !== 'admin' && me.id !== p.id) throw E(403, 'Чужой профиль недоступен');
  const u = await getUser(pool, p.id); if (!u) throw E(404, 'Пользователь не найден'); delete u.passwordHash; return u;
});
route('PATCH', '/users/:id', async ({ me, p, body }) => {
  need(me); const adm = me.role === 'admin';
  if (!adm && me.id !== p.id) throw E(403, 'Чужой профиль недоступен');
  if (adm && me.id === p.id && (body.role || body.status)) throw E(409, 'Нельзя менять собственную роль или статус');
  return patchRow(pool, 'users', 'user', p.id, body, adm ? ['fullName', 'school', 'grade', 'role', 'status'] : ['fullName', 'school', 'grade']);
});
route('DELETE', '/users/:id', async ({ me, p }) => {
  need(me, 'admin'); if (me.id === p.id) throw E(409, 'Нельзя удалить самого себя');
  const r = await pool.query('DELETE FROM users WHERE id=$1', [p.id]); // участия, дипломы и сессии удаляются каскадом
  if (!r.rowCount) throw E(404, 'Пользователь не найден'); return null;
});

// contests
route('GET', '/contests', async ({ me, q }) => {
  need(me);
  if (me.role === 'admin') {
    return (await all(pool, `SELECT c.*, (SELECT count(*)::int FROM participations p WHERE p.contest_id=c.id) AS participants
      FROM contests c WHERE $1::text = '' OR c.status=$1 ORDER BY c.created_at`, [q.status || ''])).map(out);
  }
  return (await all(pool, `SELECT c.* FROM contests c WHERE c.status='open'
    OR c.id IN (SELECT contest_id FROM participations WHERE user_id=$1) ORDER BY c.created_at`, [me.id])).map(out);
});
route('POST', '/contests', async ({ me, body }) => {
  need(me, 'admin'); const bank = PL.bank[body.track];
  const c = validate('contest', { id: uid('con'), title: (body.title || '').trim(), track: body.track, description: body.description || '', grade: +body.grade || 9, bank: body.track, taskCount: bank ? bank.q.length : 0, durationMin: +body.durationMin || 120, status: body.status || 'draft', createdAt: now(), updatedAt: now() });
  await insertContest(pool, c); return c;
});
route('GET', '/contests/:id', async ({ me, p }) => { need(me); const c = await getContest(pool, p.id); if (!c) throw E(404, 'Конкурс не найден'); return c; });
route('PATCH', '/contests/:id', async ({ me, p, body }) => {
  need(me, 'admin'); ['grade', 'durationMin'].forEach(k => { if (body[k] !== undefined) body[k] = +body[k]; });
  return patchRow(pool, 'contests', 'contest', p.id, body, ['title', 'description', 'grade', 'durationMin', 'status', 'track']);
});
route('DELETE', '/contests/:id', async ({ me, p, q }) => {
  need(me, 'admin'); if (!await getContest(pool, p.id)) throw E(404, 'Конкурс не найден');
  const has = await one(pool, 'SELECT 1 FROM participations WHERE contest_id=$1 LIMIT 1', [p.id]);
  if (has && !q.force) throw E(409, 'У конкурса есть участия. Подтвердите каскадное удаление (force=1).');
  await pool.query('DELETE FROM contests WHERE id=$1', [p.id]); return null;
});
// Условия задач выдаются только участнику с активной попыткой (ключи ответов клиенту не отправляются).
route('GET', '/contests/:id/tasks', async ({ me, p }) => {
  need(me); const c = await getContest(pool, p.id); if (!c) throw E(404, 'Конкурс не найден');
  if (me.role !== 'admin' && !await one(pool, "SELECT 1 FROM participations WHERE user_id=$1 AND contest_id=$2 AND status='in_progress'", [me.id, c.id])) throw E(403, 'Сначала начните участие');
  if (!PL.bank[c.bank]) throw E(409, 'Задачи конкурса ещё не загружены');
  return { durationMin: c.durationMin, questions: PL.bank[c.bank].q.map(s => { const [title, html] = s.split('::'); return { title, html }; }) };
});

// participations
route('GET', '/participations', async ({ me, q }) => {
  need(me);
  const rows = await all(pool, `SELECT p.*, d.id AS diploma_id FROM participations p LEFT JOIN diplomas d ON d.participation_id=p.id
    WHERE ($1::boolean OR p.user_id=$2) AND ($3::text = '' OR p.user_id=$3) AND ($4::text = '' OR p.contest_id=$4) ORDER BY p.created_at`,
    [me.role === 'admin', me.id, me.role === 'admin' ? (q.userId || '') : '', q.contestId || '']);
  return rows.map(out);
});
route('POST', '/participations', async ({ me, body }) => { // начать участие
  need(me, 'student'); const c = await getContest(pool, body.contestId);
  if (!c || c.status !== 'open') throw E(404, 'Конкурс недоступен');
  if (!PL.bank[c.bank]) throw E(409, 'Задачи конкурса ещё не загружены');
  if (await one(pool, 'SELECT 1 FROM participations WHERE user_id=$1 AND contest_id=$2', [me.id, c.id])) throw E(409, 'Попытка уже использована');
  const part = validate('participation', { id: uid('par'), userId: me.id, contestId: c.id, status: 'in_progress', source: 'self', startedAt: now(), createdAt: now() });
  await savePart(pool, part); return part;
});
route('POST', '/participations/import', async ({ me, body }) => { // загрузка списка участников
  need(me, 'admin'); const c = await getContest(pool, body.contestId);
  if (!c) throw E(404, 'Конкурс не найден'); if (!Array.isArray(body.rows)) throw E(422, 'rows: ожидается массив');
  const max = maxOf(c), seen = new Set();
  const res = { total: body.rows.length, created: 0, newUsers: 0, skipped: 0, errors: [], dryRun: !!body.dryRun, max };
  await tx(async db => {
    for (const [i, r] of body.rows.entries()) {
      const row = i + 2, email = String(r.email || '').trim().toLowerCase(), score = Number(String(r.score).replace(',', '.'));
      const bad = msg => { res.skipped++; res.errors.push({ row, message: msg }); };
      if (!EMAIL.test(email)) { bad('Некорректный email'); continue; }
      if (r.score === '' || !Number.isInteger(score) || score < 0 || score > max) { bad(`Балл должен быть целым от 0 до ${max}`); continue; }
      let u = out(await one(db, 'SELECT * FROM users WHERE email=$1', [email]));
      if ((u && await one(db, 'SELECT 1 FROM participations WHERE user_id=$1 AND contest_id=$2', [u.id, c.id])) || seen.has(email)) { bad('Участие уже есть — пропущено'); continue; }
      if (!u && String(r.fullName || '').trim().length < 2) { bad('Для нового ученика нужно ФИО'); continue; }
      seen.add(email); if (!u) res.newUsers++; res.created++;
      if (body.dryRun) continue;
      if (!u) { // новый ученик получает случайный пароль
        u = validate('user', { id: uid('usr'), email, fullName: r.fullName.trim(), role: 'student', status: 'active', ...(r.school ? { school: r.school } : {}), createdAt: now() });
        await insertUser(db, u, crypto.randomBytes(9).toString('hex'));
      }
      await finalize(db, { id: uid('par'), userId: u.id, contestId: c.id, status: 'in_progress', source: 'import', startedAt: now(), createdAt: now() }, c, score, 0);
    }
  });
  return res;
});
route('PATCH', '/participations/:id', async ({ me, p, body }) => { // ручная корректировка балла (после проверки жюри)
  need(me, 'admin');
  return tx(async db => {
    const part = out(await one(db, 'SELECT * FROM participations WHERE id=$1 FOR UPDATE', [p.id]));
    if (!part) throw E(404, 'Участие не найдено'); const c = await getContest(db, part.contestId), s = Number(body.score);
    if (!Number.isInteger(s) || s < 0 || s > maxOf(c)) throw E(422, 'Некорректный балл'); // защита от ложного повышения
    await finalize(db, part, c, s, part.spentSec || 0); return part;
  });
});
route('DELETE', '/participations/:id', async ({ me, p }) => {
  need(me, 'admin'); await pool.query('DELETE FROM participations WHERE id=$1', [p.id]); return null; // диплом удаляется каскадом
});
// Проверка ответов — только здесь, на сервере.
route('POST', '/participations/:id/submit', async ({ me, p, body }) => {
  need(me, 'student');
  return tx(async db => {
    const part = out(await one(db, 'SELECT * FROM participations WHERE id=$1 AND user_id=$2 FOR UPDATE', [p.id, me.id]));
    if (!part) throw E(404, 'Участие не найдено'); if (part.status !== 'in_progress') throw E(409, 'Работа уже сдана');
    const c = await getContest(db, part.contestId), keys = PL.bank[c.bank].a, ans = (Array.isArray(body.answers) ? body.answers : []).map(a => String(a || ''));
    const score = keys.filter((k, i) => k !== null && ans[i] && ans[i].trim() && PL.checker.isRight(ans[i], k)).length;
    part.answersCount = ans.filter(a => a.trim()).length;
    const spent = Math.min(c.durationMin * 60, Math.round((Date.now() - Date.parse(part.startedAt)) / 1000));
    const d = await finalize(db, part, c, score, spent); return { participation: part, diploma: d };
  });
});

// diplomas (выдаются автоматически)
route('GET', '/diplomas', async ({ me, q }) => {
  need(me);
  return (await all(pool, `SELECT * FROM diplomas WHERE ($1::boolean OR user_id=$2) AND ($3::text = '' OR user_id=$3) ORDER BY issued_at DESC`,
    [me.role === 'admin', me.id, me.role === 'admin' ? (q.userId || '') : ''])).map(out);
});
route('GET', '/diplomas/:id', async ({ me, p }) => {
  need(me); const d = out(await one(pool, 'SELECT * FROM diplomas WHERE id=$1', [p.id])); if (!d) throw E(404, 'Диплом не найден');
  if (me.role !== 'admin' && d.userId !== me.id) throw E(403, 'Чужой диплом недоступен');
  const u = await getUser(pool, d.userId); delete u.passwordHash;
  return { diploma: d, user: u, contest: await getContest(pool, d.contestId) };
});
route('DELETE', '/diplomas/:id', async ({ me, p }) => { need(me, 'admin'); await pool.query('DELETE FROM diplomas WHERE id=$1', [p.id]); return null; });

// достижения: ученик добавляет -> администратор подтверждает/отклоняет -> бот присылает уведомление
route('GET', '/achievements', async ({ me, q }) => {
  need(me);
  return (await all(pool, `SELECT a.*, u.full_name, u.email FROM achievements a JOIN users u ON u.id=a.user_id
    WHERE ($1::boolean OR a.user_id=$2) AND ($3::text = '' OR a.status=$3) ORDER BY (a.status='pending') DESC, a.created_at DESC`,
    [me.role === 'admin', me.id, q.status || ''])).map(out);
});
route('POST', '/achievements', async ({ me, body }) => {
  need(me, 'student');
  const title = String(body.title || '').trim(), description = String(body.description || '').trim();
  if (title.length < 3 || title.length > 120) throw E(422, 'Название: от 3 до 120 символов.');
  if (description.length > 500) throw E(422, 'Описание: не длиннее 500 символов.');
  const { n } = await one(pool, "SELECT count(*)::int AS n FROM achievements WHERE user_id=$1 AND status='pending'", [me.id]);
  if (n >= 10) throw E(429, 'Слишком много достижений на проверке (максимум 10). Дождитесь решения жюри.');
  const id = uid('ach');
  await pool.query("INSERT INTO achievements (id,user_id,title,description,source) VALUES ($1,$2,$3,$4,'site')", [id, me.id, title, description || null]);
  return out(await one(pool, 'SELECT * FROM achievements WHERE id=$1', [id]));
});
route('PATCH', '/achievements/:id', async ({ me, p, body }) => { // верификация (notified=false -> бот отправит уведомление)
  need(me, 'admin');
  if (!['verified', 'rejected'].includes(body.status)) throw E(422, 'status: verified или rejected');
  const comment = String(body.adminComment || '').trim().slice(0, 300);
  const r = await one(pool, 'UPDATE achievements SET status=$2, admin_comment=$3, verified_at=now(), notified=false WHERE id=$1 RETURNING *', [p.id, body.status, comment || null]);
  if (!r) throw E(404, 'Достижение не найдено'); return out(r);
});
route('DELETE', '/achievements/:id', async ({ me, p }) => {
  need(me);
  const r = await pool.query("DELETE FROM achievements WHERE id=$1 AND ($2::boolean OR (user_id=$3 AND status='pending'))", [p.id, me.role === 'admin', me.id]);
  if (!r.rowCount) throw E(404, 'Запись не найдена или её уже нельзя удалить'); return null;
});

// привязка Telegram: код из кабинета вводится в боте
route('GET', '/me/telegram', async ({ me }) => {
  need(me, 'student');
  return { linked: !!await one(pool, 'SELECT 1 FROM telegram_links WHERE user_id=$1', [me.id]), botUsername: BOT_USERNAME || null };
});
route('POST', '/me/telegram-code', async ({ me }) => {
  need(me, 'student');
  await pool.query('DELETE FROM telegram_codes WHERE user_id=$1 OR expires_at < now()', [me.id]);
  for (let i = 0; i < 5; i++) {
    const code = String(crypto.randomInt(100000, 1000000));
    try {
      await pool.query("INSERT INTO telegram_codes (code,user_id,expires_at) VALUES ($1,$2, now() + interval '15 minutes')", [code, me.id]);
      return { code, expiresInMin: 15, botUsername: BOT_USERNAME || null };
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  throw E(500, 'Не удалось создать код. Попробуйте ещё раз.');
});
route('DELETE', '/me/telegram', async ({ me }) => { need(me, 'student'); await pool.query('DELETE FROM telegram_links WHERE user_id=$1', [me.id]); return null; });

// прогресс ученика: XP, уровни
route('GET', '/me/progress', async ({ me }) => {
  need(me, 'student');
  const ps = (await all(pool, "SELECT * FROM participations WHERE user_id=$1 AND status='finished'", [me.id])).map(out), ds = (await all(pool, 'SELECT * FROM diplomas WHERE user_id=$1', [me.id])).map(out);
  const bonus = { I: 50, II: 30, III: 15, participant: 0 };
  const av = (await one(pool, "SELECT count(*)::int AS n FROM achievements WHERE user_id=$1 AND status='verified'", [me.id])).n;
  const xp = ps.reduce((s, p) => s + p.score * 10 + 20, 0) + ds.reduce((s, d) => s + bonus[d.degree], 0) + av * PL.ACH_XP;
  let lv = 0; PL.LEVELS.forEach(([t], i) => { if (xp >= t) lv = i; }); const nx = PL.LEVELS[lv + 1];
  const { n } = await one(pool, "SELECT count(*)::int AS n FROM contests WHERE status='open'");
  return { xp, level: lv + 1, levelName: PL.LEVELS[lv][1], floor: PL.LEVELS[lv][0], nextAt: nx ? nx[0] : null, nextName: nx ? nx[1] : null,
    finished: ps.length, totalContests: n, diplomas: ds.length, bestPercent: Math.max(0, ...ds.map(d => d.percent)) };
});
route('GET', '/stats', async ({ me }) => {
  need(me, 'admin');
  const r = await one(pool, `SELECT (SELECT count(*)::int FROM users WHERE role='student') AS students, (SELECT count(*)::int FROM contests) AS contests,
    (SELECT count(*)::int FROM participations) AS participations, (SELECT count(*)::int FROM diplomas) AS diplomas`);
  return r;
});

// отчёты (CSV)
route('GET', '/reports/:type', async ({ me, p, q }) => {
  need(me, 'admin');
  const US = (await all(pool, 'SELECT * FROM users ORDER BY created_at')).map(out), CS = (await all(pool, 'SELECT * FROM contests ORDER BY created_at')).map(out), DS = (await all(pool, 'SELECT * FROM diplomas')).map(out);
  const PS = (await all(pool, 'SELECT * FROM participations ORDER BY created_at')).map(out).filter(x => !q.contestId || x.contestId === q.contestId);
  let columns, rows;
  if (p.type === 'participations') {
    columns = ['Конкурс', 'Участник', 'Email', 'Школа', 'Баллы', 'Макс. баллов', 'Процент', 'Статус', 'Диплом', 'Дата завершения', 'Источник'];
    rows = PS.map(x => { const u = US.find(y => y.id === x.userId) || {}, c = CS.find(y => y.id === x.contestId) || {}, d = DS.find(y => y.participationId === x.id);
      return [c.title, u.fullName, u.email, u.school || '', x.score ?? '', x.maxScore ?? '', d ? d.percent : '', x.status === 'finished' ? 'завершено' : 'не завершено', d ? PL.DEGREE[d.degree] : '', x.finishedAt ? x.finishedAt.slice(0, 10) : '', x.source === 'import' ? 'импорт' : 'онлайн']; });
  } else if (p.type === 'summary') {
    columns = ['Конкурс', 'Статус', 'Участий', 'Завершено', 'Средний %', 'Лучший %', 'Дипломов I', 'Дипломов II', 'Дипломов III', 'Сертификатов'];
    rows = CS.filter(c => !q.contestId || c.id === q.contestId).map(c => { const ds = DS.filter(d => d.contestId === c.id), pc = ds.map(d => d.percent);
      return [c.title, PL.STATUS[c.status], PS.filter(x => x.contestId === c.id).length, PS.filter(x => x.contestId === c.id && x.status === 'finished').length, pc.length ? Math.round(pc.reduce((a, b) => a + b, 0) / pc.length) : 0, Math.max(0, ...pc), ...['I', 'II', 'III', 'participant'].map(g => ds.filter(d => d.degree === g).length)]; });
  } else if (p.type === 'users') {
    columns = ['Email', 'ФИО', 'Роль', 'Школа', 'Статус', 'Участий', 'Регистрация'];
    rows = US.map(u => [u.email, u.fullName, PL.ROLE[u.role], u.school || '', u.status === 'active' ? 'активен' : 'заблокирован', PS.filter(x => x.userId === u.id).length, u.createdAt.slice(0, 10)]);
  } else throw E(404, 'Неизвестный тип отчёта');
  return { filename: `physland-${p.type}-${new Date().toISOString().slice(0, 10)}.csv`, mime: 'text/csv;charset=utf-8', columns, rows, content: PL.csv.stringify(columns, rows) };
});

/* ---------- Начальные данные ---------- */
async function seed() {
  const t = Date.now();
  const { n: users } = await one(pool, 'SELECT count(*)::int AS n FROM users');
  if (!users) {
    const email = (process.env.ADMIN_EMAIL || 'admin@physland.ru').trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || 'admin12345';
    if (!process.env.ADMIN_PASSWORD) console.warn('ВНИМАНИЕ: задан пароль администратора по умолчанию (admin12345). Задайте переменную ADMIN_PASSWORD и смените его!');
    await insertUser(pool, { id: uid('usr'), email, fullName: 'Администратор PhysLand', role: 'admin', status: 'active', createdAt: new Date(t).toISOString() }, pw);
    console.log('Создан администратор:', email);
  }
  const { n: cs } = await one(pool, 'SELECT count(*)::int AS n FROM contests');
  if (!cs) {
    let i = 0;
    for (const [k, m] of Object.entries(PL.meta)) {
      const ts = new Date(t + i++).toISOString();
      await insertContest(pool, { id: 'con_' + k, title: m.t, track: k, description: m.d, grade: 9, bank: k, taskCount: PL.bank[k].q.length, durationMin: m.m || 120, status: 'open', createdAt: ts, updatedAt: ts });
    }
    console.log('Созданы конкурсы:', Object.keys(PL.meta).join(', '));
  }
  if (process.env.SEED_DEMO === '1' && !(await one(pool, "SELECT 1 FROM users WHERE email='anna@demo.ru'"))) {
    const demo = [['anna@demo.ru', 'Анна Смирнова', 'Лицей №7', [.9, .6, null]], ['boris@demo.ru', 'Борис Кузнецов', 'Гимназия №3', [.7, .8, .5]], ['vera@demo.ru', 'Вера Лебедева', 'Лицей №7', [.4, null, .75]]];
    const contests = (await all(pool, "SELECT * FROM contests WHERE id LIKE 'con\\_%' ORDER BY created_at")).map(out);
    await tx(async db => {
      for (const [email, name, school, fr] of demo) {
        const u = { id: uid('usr'), email, fullName: name, role: 'student', status: 'active', school, createdAt: now() };
        await insertUser(db, u, 'student123');
        for (const [i, c] of contests.entries()) if (fr[i] != null) await finalize(db, { id: uid('par'), userId: u.id, contestId: c.id, status: 'in_progress', source: 'self', startedAt: now(), createdAt: now(), answersCount: 0 }, c, Math.round(fr[i] * maxOf(c)), 1500 + i * 700);
      }
    });
    console.log('Добавлены демо-ученики (пароль student123)');
  }
}
async function initDb() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await seed();
}

/* ---------- HTTP ---------- */
const COOKIE = 'pl_session', MAX_AGE = 30 * 24 * 3600;

function send(res, status, obj, headers = {}) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(b);
}
const readCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))]; }));
const readBody = req => new Promise((ok, no) => {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > 5e6) { no(E(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { no(E(400, 'Некорректный JSON')); } });
  req.on('error', no);
});

async function handleApi(req, res, url) {
  const secure = req.headers['x-forwarded-proto'] === 'https';
  const cookie = (v, age) => `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  let setCookie = null;
  try {
    const pn = url.pathname.slice(4), r = routes.find(x => x.m === req.method && x.re.test(pn));
    if (!r) throw E(404, 'Маршрут не найден');
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const token = readCookies(req)[COOKIE];
    const me = token ? out(await one(pool, "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND u.status='active'", [token])) : null;
    const data = await r.h({
      p: pn.match(r.re).groups || {}, q: Object.fromEntries(url.searchParams), body, me, ip: req.socket.remoteAddress || '',
      startSession: async userId => { const t = crypto.randomBytes(32).toString('hex'); await pool.query('INSERT INTO sessions (token,user_id) VALUES ($1,$2)', [t, userId]); setCookie = cookie(t, MAX_AGE); },
      endSession: async () => { if (token) await pool.query('DELETE FROM sessions WHERE token=$1', [token]); setCookie = cookie('', 0); }
    });
    send(res, 200, { ok: true, status: 200, data }, setCookie ? { 'Set-Cookie': setCookie } : {});
  } catch (e) {
    let status = e.status || 500, msg = e.message;
    if (!e.status) { console.error(e); msg = e.code === '23505' ? 'Такая запись уже существует.' : 'Внутренняя ошибка сервера.'; if (e.code === '23505') status = 409; }
    send(res, status, { ok: false, status, error: msg });
  }
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (url.pathname !== '/' && url.pathname !== '/index.html') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
  fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
    if (err) { res.writeHead(500); return res.end('Ошибка'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { ok: false, status: 500, error: 'Внутренняя ошибка сервера.' }); });
  serveStatic(req, res, url);
});

/* ---------- Telegram-бот: запускается вместе с сайтом (если задан BOT_TOKEN) ---------- */
function startBot() {
  if (!process.env.BOT_TOKEN) return console.log('Telegram-бот не запущен: не задана переменная BOT_TOKEN.');
  const { spawn } = require('child_process');
  // бот может лежать в папке bot/ или прямо в корне репозитория
  const botDir = fs.existsSync(path.join(__dirname, 'bot', 'bot.py')) ? path.join(__dirname, 'bot') : __dirname;
  const botFile = path.join(botDir, 'bot.py');
  if (!fs.existsSync(botFile)) return console.error('Файл bot.py не найден, бот не запущен.');
  const venv = path.join(botDir, '.venv', 'bin', 'python');
  const py = process.env.PYTHON_BIN || (fs.existsSync(venv) ? venv : 'python3');
  let child = null, stopping = false;
  const run = () => {
    // PORT убираем: порт занят сайтом, боту отдельный HTTP-порт не нужен
    child = spawn(py, [botFile], { stdio: 'inherit', env: { ...process.env, PORT: '' } });
    child.on('error', e => console.error('Не удалось запустить бота (' + py + '):', e.message));
    child.on('exit', code => { if (!stopping) { console.error(`Бот остановился (код ${code}), перезапуск через 10 с`); setTimeout(run, 10000); } });
  };
  run();
  const stop = () => { stopping = true; if (child) child.kill(); };
  process.on('exit', stop);
  ['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => { stop(); process.exit(0); }));
}

module.exports = { server, initDb, routes, PL };
if (require.main === module) {
  initDb().then(() => {
    const port = process.env.PORT || 3000;
    server.listen(port, () => { console.log(`PhysLand запущен: http://localhost:${port}`); startBot(); });
  }).catch(e => { console.error('Не удалось запустить сервер:', e.message); process.exit(1); });
}
