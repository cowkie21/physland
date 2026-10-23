"""PhysLand Telegram-бот (aiogram 3 + asyncpg).

Что умеет:
  1. 🏆 Мой рейтинг            — XP, уровень, место среди учеников, топ-5.
  2. ➕ Добавить достижение    — выбор из пройденных конкурсов, отправка жюри на проверку.
  3. 🔔 Уведомление о верификации — как только администратор подтвердил/отклонил достижение на сайте,
                                   бот присылает сообщение.

Бот работает с той же базой PostgreSQL, что и сайт (таблицы создаёт server.js при запуске).
Аккаунт привязывается одноразовым кодом из личного кабинета (вкладка «Достижения»).

Запуск:  pip install -r requirements.txt && python bot.py
"""
import asyncio
import html
import logging
import os
import re
import secrets
import ssl
import time

import asyncpg
from aiohttp import web
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramAPIError, TelegramForbiddenError, TelegramRetryAfter
from aiogram.filters import Command, CommandObject, CommandStart, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup, default_state
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, Message, ReplyKeyboardMarkup

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
DATABASE_URL = os.environ.get("DATABASE_URL", "")

# Должны совпадать с сайтом (server.js: PL.LEVELS, PL.ACH_XP) и с VIEW ratings в schema.sql
LEVELS = [(0, "Новичок"), (40, "Ученик"), (100, "Решатель"), (200, "Знаток"), (350, "Мастер")]
ACH_XP = 20
MAX_PENDING = 10          # как на сайте
NOTIFY_EVERY_SEC = 10     # как часто бот проверяет, появились ли решения жюри

BTN_RATING, BTN_ADD, BTN_MY = "🏆 Мой рейтинг", "➕ Добавить достижение", "📋 Мои достижения"
MENU = ReplyKeyboardMarkup(
    keyboard=[[KeyboardButton(text=BTN_RATING)], [KeyboardButton(text=BTN_ADD), KeyboardButton(text=BTN_MY)]],
    resize_keyboard=True,
)
STATUS_LABEL = {"pending": "⏳ на проверке", "verified": "✅ подтверждено", "rejected": "❌ отклонено"}

router = Router()
router.message.filter(F.chat.type == "private")
pool: asyncpg.Pool
log = logging.getLogger("physland-bot")
esc = lambda s: html.escape(str(s or ""))


# ───────────────────────── вспомогательное ─────────────────────────
def db_ssl():
    if os.environ.get("PGSSL") == "disable" or re.search(r"localhost|127\.0\.0\.1", DATABASE_URL):
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def level_of(xp: int):
    idx = max(i for i, (t, _) in enumerate(LEVELS) if xp >= t)
    nxt = LEVELS[idx + 1] if idx + 1 < len(LEVELS) else None
    return idx + 1, LEVELS[idx][1], nxt


def short_name(full: str) -> str:
    p = (full or "").split()
    return f"{p[0]} {p[1][0]}." if len(p) > 1 else (p[0] if p else "—")


async def get_user(chat_id: int):
    return await pool.fetchrow(
        "SELECT u.id, u.full_name, u.role FROM telegram_links t JOIN users u ON u.id = t.user_id "
        "WHERE t.chat_id = $1 AND u.status = 'active'", chat_id)


NOT_LINKED = ("Аккаунт не привязан.\n\nНа сайте откройте <b>Личный кабинет → Достижения → "
              "«Получить код подключения»</b> и отправьте мне 6-значный код.")

_fails: dict[int, list[float]] = {}   # защита кода от перебора: 5 ошибок за 10 минут


def too_many_fails(chat_id: int) -> bool:
    now = time.time()
    _fails[chat_id] = [t for t in _fails.get(chat_id, []) if now - t < 600]
    return len(_fails[chat_id]) >= 5


# ───────────────────────── привязка аккаунта ─────────────────────────
async def link_account(m: Message, code: str):
    if too_many_fails(m.chat.id):
        return await m.answer("Слишком много неверных кодов. Подождите 10 минут.")
    row = await pool.fetchrow("DELETE FROM telegram_codes WHERE code = $1 AND expires_at > now() RETURNING user_id", code)
    if not row:
        _fails.setdefault(m.chat.id, []).append(time.time())
        return await m.answer("Код неверный или истёк. Получите новый в личном кабинете на сайте.")
    async with pool.acquire() as c, c.transaction():
        await c.execute("DELETE FROM telegram_links WHERE chat_id = $1 OR user_id = $2", m.chat.id, row["user_id"])
        await c.execute("INSERT INTO telegram_links (user_id, chat_id) VALUES ($1, $2)", row["user_id"], m.chat.id)
        # старые решения жюри не рассылаем — уведомления только о новых
        await c.execute("UPDATE achievements SET notified = true WHERE user_id = $1 AND status <> 'pending'", row["user_id"])
    u = await get_user(m.chat.id)
    await m.answer(f"✅ Готово! Аккаунт <b>{esc(u['full_name'])}</b> подключён.\n"
                   "Я буду присылать уведомления, когда жюри проверит ваши достижения.", reply_markup=MENU)


@router.message(CommandStart())
async def cmd_start(m: Message, command: CommandObject, state: FSMContext):
    await state.clear()
    if command.args and re.fullmatch(r"\d{6}", command.args.strip()):
        return await link_account(m, command.args.strip())
    if await get_user(m.chat.id):
        return await m.answer("Привет! Выберите действие в меню 👇", reply_markup=MENU)
    await m.answer("Привет! Я бот <b>PhysLand</b>: показываю рейтинг, принимаю достижения и сообщаю о проверке.\n\n" + NOT_LINKED,
                   reply_markup=MENU)


@router.message(Command("link"))
async def cmd_link(m: Message, command: CommandObject):
    if command.args and re.fullmatch(r"\d{6}", command.args.strip()):
        return await link_account(m, command.args.strip())
    await m.answer("Использование: <code>/link 123456</code> (код берётся в личном кабинете на сайте).")


@router.message(Command("unlink"))
async def cmd_unlink(m: Message, state: FSMContext):
    await state.clear()
    await pool.execute("DELETE FROM telegram_links WHERE chat_id = $1", m.chat.id)
    await m.answer("Аккаунт отключён. Чтобы подключить снова, получите новый код на сайте.")


@router.message(Command("help"))
async def cmd_help(m: Message):
    await m.answer("<b>Команды</b>\n/rating — мой рейтинг\n/add — добавить достижение\n/my — мои достижения\n"
                   "/cancel — отменить ввод\n/unlink — отключить аккаунт", reply_markup=MENU)


@router.message(Command("cancel"), StateFilter("*"))
async def cmd_cancel(m: Message, state: FSMContext):
    await state.clear()
    await m.answer("Отменено.", reply_markup=MENU)


# ───────────────────────── 1. рейтинг ─────────────────────────
RANKED = "SELECT user_id, full_name, xp, RANK() OVER (ORDER BY xp DESC) AS place FROM ratings"


@router.message(Command("rating"), StateFilter("*"))
@router.message(F.text == BTN_RATING, StateFilter("*"))
async def show_rating(m: Message, state: FSMContext):
    await state.clear()
    u = await get_user(m.chat.id)
    if not u:
        return await m.answer(NOT_LINKED)
    me = await pool.fetchrow(f"SELECT * FROM ({RANKED}) r WHERE user_id = $1", u["id"])
    if not me:
        return await m.answer("Рейтинг доступен только ученикам.")
    top = await pool.fetch(f"SELECT * FROM ({RANKED}) r ORDER BY place, full_name LIMIT 5")
    total = await pool.fetchval("SELECT count(*) FROM ratings")
    st = await pool.fetchrow(
        "SELECT (SELECT count(*) FROM participations WHERE user_id = $1 AND status = 'finished') AS finished,"
        "       (SELECT count(*) FROM diplomas WHERE user_id = $1) AS diplomas,"
        "       (SELECT count(*) FROM achievements WHERE user_id = $1 AND status = 'verified') AS ach", u["id"])
    xp = int(me["xp"])
    lvl, name, nxt = level_of(xp)
    medals = {1: "🥇", 2: "🥈", 3: "🥉"}
    lines = [f"{medals.get(r['place'], str(r['place']) + '.')} {esc(short_name(r['full_name']))} — {r['xp']} XP"
             + (" <b>(вы)</b>" if r["user_id"] == u["id"] else "") for r in top]
    text = (f"🏆 <b>Ваш рейтинг</b>\n\nМесто: <b>{me['place']}</b> из {total}\n"
            f"XP: <b>{xp}</b> · Уровень {lvl} «{name}»\n"
            + (f"До уровня «{nxt[1]}» — {nxt[0] - xp} XP\n" if nxt else "Достигнут максимальный уровень 🎉\n")
            + f"\nКонкурсов пройдено: {st['finished']} · Дипломов: {st['diplomas']} · Достижений: {st['ach']}\n"
            + "\n<b>Топ-5</b>\n" + "\n".join(lines))
    if me["place"] > 5:
        text += f"\n…\n{me['place']}. {esc(short_name(me['full_name']))} — {xp} XP <b>(вы)</b>"
    await m.answer(text, reply_markup=MENU)


# ───────────────────────── 2. добавление достижения ─────────────────────────
DEGREE = {"I": "Диплом I степени", "II": "Диплом II степени", "III": "Диплом III степени", "participant": "Сертификат участника"}
BASE_SQL = ("SELECT p.id, p.score, p.max_score, c.title AS contest, d.degree, d.percent FROM participations p "
            "JOIN contests c ON c.id = p.contest_id LEFT JOIN diplomas d ON d.participation_id = p.id ")


def ach_title(r) -> str:
    return f"{DEGREE[r['degree']]} — {r['contest']}" if r["degree"] else f"Участие: {r['contest']}"


def ach_desc(r) -> str:
    return f"Результат: {r['score']} из {r['max_score']}" + (f" ({r['percent']}%)" if r["percent"] is not None else "")


async def pending_count(user_id: str) -> int:
    return await pool.fetchval("SELECT count(*) FROM achievements WHERE user_id = $1 AND status = 'pending'", user_id)


@router.message(Command("add"), StateFilter("*"))
@router.message(F.text == BTN_ADD, StateFilter("*"))
async def add_start(m: Message, state: FSMContext):
    await state.clear()
    u = await get_user(m.chat.id)
    if not u:
        return await m.answer(NOT_LINKED)
    if u["role"] != "student":
        return await m.answer("Добавлять достижения могут только ученики.")
    pending = await pending_count(u["id"])
    if pending >= MAX_PENDING:
        return await m.answer(f"На проверке уже {pending} достижений (максимум {MAX_PENDING}). Дождитесь решения жюри.")
    rows = await pool.fetch(BASE_SQL + "WHERE p.user_id = $1 AND p.status = 'finished' "
                            "AND NOT EXISTS (SELECT 1 FROM achievements a WHERE a.participation_id = p.id) "
                            "ORDER BY p.finished_at DESC LIMIT 10", u["id"])
    if not rows:
        return await m.answer("Нет завершённых конкурсов, которые ещё можно добавить. Пройдите конкурс на сайте — и он появится здесь.")
    kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(
        text=f"{ach_title(r)} · {r['score']}/{r['max_score']}"[:60], callback_data="ach:" + r["id"])] for r in rows])
    await m.answer("Выберите достижение, которое отправить жюри на проверку:", reply_markup=kb)


@router.callback_query(F.data.startswith("ach:"))
async def add_pick(cb: CallbackQuery):
    u = await get_user(cb.from_user.id)
    if not u:
        return await cb.answer("Аккаунт не привязан", show_alert=True)
    r = await pool.fetchrow(BASE_SQL + "WHERE p.id = $1 AND p.user_id = $2 AND p.status = 'finished'", cb.data[4:], u["id"])
    if not r:
        return await cb.answer("Недоступно", show_alert=True)
    if await pending_count(u["id"]) >= MAX_PENDING:
        return await cb.answer(f"На проверке уже {MAX_PENDING} достижений", show_alert=True)
    try:
        await pool.execute(
            "INSERT INTO achievements (id, user_id, title, description, participation_id, source) VALUES ($1, $2, $3, $4, $5, 'telegram')",
            "ach_" + secrets.token_hex(5), u["id"], ach_title(r), ach_desc(r), r["id"])
    except asyncpg.UniqueViolationError:
        return await cb.answer("Это достижение уже добавлено", show_alert=True)
    await cb.answer("Отправлено на проверку")
    await cb.message.edit_text(f"📨 «{esc(ach_title(r))}» отправлено на проверку.\nКак только жюри примет решение, я пришлю уведомление.")


@router.message(Command("my"), StateFilter("*"))
@router.message(F.text == BTN_MY, StateFilter("*"))
async def my_achievements(m: Message, state: FSMContext):
    await state.clear()
    u = await get_user(m.chat.id)
    if not u:
        return await m.answer(NOT_LINKED)
    rows = await pool.fetch("SELECT title, status, admin_comment FROM achievements WHERE user_id = $1 "
                            "ORDER BY created_at DESC LIMIT 15", u["id"])
    if not rows:
        return await m.answer("Достижений пока нет. Нажмите «➕ Добавить достижение».", reply_markup=MENU)
    lines = [f"{STATUS_LABEL[r['status']]} — {esc(r['title'])}" + (f"\n   💬 {esc(r['admin_comment'])}" if r["admin_comment"] else "")
             for r in rows]
    await m.answer("📋 <b>Мои достижения</b>\n\n" + "\n".join(lines), reply_markup=MENU)


# ───────────────────────── код привязки сообщением / прочее ─────────────────────────
@router.message(StateFilter(default_state), F.text.regexp(r"^\s*\d{6}\s*$"))
async def code_message(m: Message):
    await link_account(m, m.text.strip())


@router.message(StateFilter(default_state))
async def fallback(m: Message):
    await m.answer("Не понял. Воспользуйтесь меню или командой /help.", reply_markup=MENU)


# ───────────────────────── 3. уведомления о верификации ─────────────────────────
async def notifier(bot: Bot):
    """Раз в NOTIFY_EVERY_SEC секунд берёт решения жюри, о которых ученик ещё не уведомлён, и шлёт сообщение."""
    while True:
        try:
            rows = await pool.fetch(
                "SELECT a.id, a.title, a.status, a.admin_comment, t.chat_id FROM achievements a "
                "JOIN telegram_links t ON t.user_id = a.user_id "
                "WHERE a.notified = false AND a.status IN ('verified', 'rejected') ORDER BY a.verified_at LIMIT 50")
            for r in rows:
                if r["status"] == "verified":
                    text = (f"✅ <b>Достижение подтверждено!</b>\n«{esc(r['title'])}»\n+{ACH_XP} XP к рейтингу 🎉"
                            + (f"\n\n💬 {esc(r['admin_comment'])}" if r["admin_comment"] else ""))
                else:
                    text = (f"❌ <b>Достижение отклонено</b>\n«{esc(r['title'])}»"
                            + (f"\n\n💬 Комментарий жюри: {esc(r['admin_comment'])}" if r["admin_comment"] else ""))
                try:
                    await bot.send_message(r["chat_id"], text)
                except TelegramForbiddenError:      # пользователь заблокировал бота — повторять бессмысленно
                    log.warning("chat %s заблокировал бота", r["chat_id"])
                except TelegramRetryAfter as e:     # лимит Telegram: подождём и повторим со следующего круга
                    await asyncio.sleep(e.retry_after)
                    break
                except TelegramAPIError as e:
                    log.error("не удалось отправить уведомление %s: %s", r["id"], e)
                    continue
                # status=$2: если жюри успело изменить решение, уведомление уйдёт ещё раз
                await pool.execute("UPDATE achievements SET notified = true WHERE id = $1 AND status = $2", r["id"], r["status"])
        except Exception:
            log.exception("ошибка в notifier")
        await asyncio.sleep(NOTIFY_EVERY_SEC)


# ───────────────────────── запуск ─────────────────────────
async def main():
    global pool
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not BOT_TOKEN or not DATABASE_URL:
        raise SystemExit("Задайте переменные окружения BOT_TOKEN и DATABASE_URL (см. .env.example).")
    pool = await asyncpg.create_pool(DATABASE_URL, ssl=db_ssl(), min_size=1, max_size=5)
    bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher(storage=MemoryStorage())
    dp.include_router(router)
    task = asyncio.create_task(notifier(bot))
    runner = None
    if os.environ.get("PORT"):  # на Render (Web Service) нужен открытый порт; сайт для проверки «жив ли бот»
        app = web.Application()
        app.router.add_get("/", lambda r: web.Response(text="ok"))
        app.router.add_get("/healthz", lambda r: web.Response(text="ok"))
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, "0.0.0.0", int(os.environ["PORT"])).start()
    try:
        log.info("Бот запущен: @%s", (await bot.get_me()).username)
        await dp.start_polling(bot)
    finally:
        task.cancel()
        if runner:
            await runner.cleanup()
        await pool.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
