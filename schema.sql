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
