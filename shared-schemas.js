/* Сгенерировано из schema/schemas.json */
window.PL = window.PL || {};
PL.schemas = {
 "user": {
  "description": "Пользователь. Роль определяет доступ (RBAC). passwordHash/passwordSalt никогда не отдаются через API.",
  "type": "object",
  "required": [
   "id",
   "email",
   "fullName",
   "role",
   "status",
   "createdAt"
  ],
  "additionalProperties": false,
  "properties": {
   "id": {
    "type": "string",
    "pattern": "^usr_"
   },
   "email": {
    "type": "string",
    "format": "email",
    "pattern": "^[A-Za-z0-9][\\w.%+-]*@[A-Za-z0-9][\\w.-]*\\.[A-Za-z]{2,}$"
   },
   "fullName": {
    "type": "string",
    "minLength": 2,
    "maxLength": 120
   },
   "role": {
    "enum": [
     "student",
     "admin"
    ]
   },
   "status": {
    "enum": [
     "active",
     "blocked"
    ]
   },
   "school": {
    "type": "string",
    "maxLength": 120
   },
   "grade": {
    "type": "integer",
    "minimum": 1,
    "maximum": 11
   },
   "passwordSalt": {
    "type": "string"
   },
   "passwordHash": {
    "type": "string"
   },
   "createdAt": {
    "type": "string",
    "format": "date-time"
   }
  }
 },
 "contest": {
  "description": "Конкурс. bank — ключ банка задач (в продакшене: id набора задач на сервере).",
  "type": "object",
  "required": [
   "id",
   "title",
   "track",
   "bank",
   "taskCount",
   "durationMin",
   "status",
   "createdAt"
  ],
  "additionalProperties": false,
  "properties": {
   "id": {
    "type": "string",
    "pattern": "^con_"
   },
   "title": {
    "type": "string",
    "minLength": 3,
    "maxLength": 120
   },
   "track": {
    "enum": [
     "phys",
     "math",
     "info"
    ]
   },
   "description": {
    "type": "string",
    "maxLength": 1000
   },
   "grade": {
    "type": "integer",
    "minimum": 1,
    "maximum": 11
   },
   "bank": {
    "type": "string"
   },
   "taskCount": {
    "type": "integer",
    "minimum": 0
   },
   "durationMin": {
    "type": "integer",
    "minimum": 10,
    "maximum": 600
   },
   "status": {
    "enum": [
     "draft",
     "open",
     "closed"
    ]
   },
   "createdAt": {
    "type": "string",
    "format": "date-time"
   },
   "updatedAt": {
    "type": "string",
    "format": "date-time"
   }
  }
 },
 "participation": {
  "description": "Участие ученика в конкурсе (связь user × contest, уникальна). source: self — прошёл онлайн, import — загружено администратором.",
  "type": "object",
  "required": [
   "id",
   "userId",
   "contestId",
   "status",
   "source",
   "startedAt"
  ],
  "additionalProperties": false,
  "properties": {
   "id": {
    "type": "string",
    "pattern": "^par_"
   },
   "userId": {
    "type": "string"
   },
   "contestId": {
    "type": "string"
   },
   "status": {
    "enum": [
     "in_progress",
     "finished"
    ]
   },
   "source": {
    "enum": [
     "self",
     "import"
    ]
   },
   "startedAt": {
    "type": "string",
    "format": "date-time"
   },
   "finishedAt": {
    "type": "string",
    "format": "date-time"
   },
   "spentSec": {
    "type": "integer",
    "minimum": 0
   },
   "answersCount": {
    "type": "integer",
    "minimum": 0
   },
   "score": {
    "type": "integer",
    "minimum": 0
   },
   "maxScore": {
    "type": "integer",
    "minimum": 0
   },
   "manualPending": {
    "type": "integer",
    "minimum": 0
   },
   "createdAt": {
    "type": "string",
    "format": "date-time"
   }
  }
 },
 "diploma": {
  "description": "Диплом. Выдаётся автоматически при завершении участия; один диплом на одно участие.",
  "type": "object",
  "required": [
   "id",
   "number",
   "userId",
   "contestId",
   "participationId",
   "degree",
   "percent",
   "issuedAt"
  ],
  "additionalProperties": false,
  "properties": {
   "id": {
    "type": "string",
    "pattern": "^dip_"
   },
   "number": {
    "type": "string",
    "pattern": "^PL-\\d{4}-\\d{4}$"
   },
   "userId": {
    "type": "string"
   },
   "contestId": {
    "type": "string"
   },
   "participationId": {
    "type": "string"
   },
   "degree": {
    "enum": [
     "I",
     "II",
     "III",
     "participant"
    ]
   },
   "percent": {
    "type": "integer",
    "minimum": 0,
    "maximum": 100
   },
   "issuedAt": {
    "type": "string",
    "format": "date-time"
   }
  }
 }
};
