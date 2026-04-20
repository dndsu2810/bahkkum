-- 학원 허브: 상담 기록 테이블
CREATE TABLE IF NOT EXISTS consultations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_name TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,           -- 'YYYY-MM-DD'
  memo TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,        -- 0 | 1
  completed_at TEXT DEFAULT NULL,         -- KST 'YYYY-MM-DD HH:MM:SS'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_consultations_done_date
  ON consultations(done, scheduled_date);

-- 학원 허브: 비품 (소모품) 테이블
CREATE TABLE IF NOT EXISTS supplies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  needs_restock INTEGER NOT NULL DEFAULT 0, -- 0 | 1  (구매 필요 체크)
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_supplies_restock
  ON supplies(needs_restock, name);
