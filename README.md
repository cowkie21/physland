# PhysLand (Node.js + PostgreSQL)

- `server.js` — сервер и API (`/api/...`), раздаёт сайт 
- `schema.sql` — таблицы базы (создаются автоматически при запуске)
- `shared-*.js` — задачи, ключи ответов, проверка ответов (остаются только на сервере)
- `index.html` — сам сайт

Переменные окружения:
- `DATABASE_URL` — адрес базы PostgreSQL (обязательно)
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` — логин и пароль администратора (создаётся при первом запуске)
- `SEED_DEMO=1` — добавить демо-учеников (по желанию)

Запуск у себя: `npm install`, затем `DATABASE_URL=... node server.js` и откройте http://localhost:3000
