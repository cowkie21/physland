-- Таблицы PhysLand. Сервер выполняет этот файл при каждом запуске (IF NOT EXISTS — повторно ничего не ломается).

CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  role          text NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  status        text NOT NULL DEFAULT 'active'  CHECK (status IN ('active', 'blocked')),
  school        text,
  grade         integer,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contests (
  id           text PRIMARY KEY,
  title        text NOT NULL,
  track        text NOT NULL CHECK (track IN ('phys', 'math', 'info')),
  description  text,
  grade        integer,
  bank         text NOT NULL,
  task_count   integer NOT NULL,
  duration_min integer NOT NULL,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participations (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  contest_id     text NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  status         text NOT NULL CHECK (status IN ('in_progress', 'finished')),
  source         text NOT NULL CHECK (source IN ('self', 'import')),
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  spent_sec      integer,
  answers_count  integer,
  score          integer,
  max_score      integer,
  manual_pending integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, contest_id)            -- один конкурс — одна попытка
);

CREATE TABLE IF NOT EXISTS diplomas (
  id               text PRIMARY KEY,
  number           text NOT NULL UNIQUE,
  user_id          text NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  contest_id       text NOT NULL REFERENCES contests(id)       ON DELETE CASCADE,
  participation_id text NOT NULL REFERENCES participations(id) ON DELETE CASCADE,
  degree           text NOT NULL CHECK (degree IN ('I', 'II', 'III', 'participant')),
  percent          integer NOT NULL,
  issued_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_part_user    ON participations(user_id);
CREATE INDEX IF NOT EXISTS idx_part_contest ON participations(contest_id);
CREATE INDEX IF NOT EXISTS idx_dip_user     ON diplomas(user_id);

-- ===== Достижения и Telegram-бот =====
CREATE TABLE IF NOT EXISTS achievements (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  admin_comment text,
  source        text NOT NULL DEFAULT 'site' CHECK (source IN ('site', 'telegram')),
  notified      boolean NOT NULL DEFAULT false,   -- ученику уже отправлено уведомление о решении в Telegram
  created_at    timestamptz NOT NULL DEFAULT now(),
  verified_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ach_user   ON achievements(user_id);
CREATE INDEX IF NOT EXISTS idx_ach_notify ON achievements(notified, status);

-- привязка аккаунта сайта к чату Telegram
CREATE TABLE IF NOT EXISTS telegram_links (
  user_id   text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat_id   bigint NOT NULL UNIQUE,
  linked_at timestamptz NOT NULL DEFAULT now()
);
-- одноразовые коды привязки (15 минут)
CREATE TABLE IF NOT EXISTS telegram_codes (
  code       text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Рейтинг учеников: XP как на сайте (баллы*10 + 20 за участие + бонус за диплом) + 20 за каждое подтверждённое достижение
CREATE OR REPLACE VIEW ratings AS
SELECT u.id AS user_id, u.full_name,
  COALESCE((SELECT SUM(p.score * 10 + 20) FROM participations p WHERE p.user_id = u.id AND p.status = 'finished'), 0)
  + COALESCE((SELECT SUM(CASE d.degree WHEN 'I' THEN 50 WHEN 'II' THEN 30 WHEN 'III' THEN 15 ELSE 0 END) FROM diplomas d WHERE d.user_id = u.id), 0)
  + 20 * (SELECT count(*) FROM achievements a WHERE a.user_id = u.id AND a.status = 'verified') AS xp
FROM users u WHERE u.role = 'student' AND u.status = 'active';
