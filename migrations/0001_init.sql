-- 학생 테이블
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  photo_url TEXT DEFAULT NULL,
  points INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 벌금 내역 테이블
CREATE TABLE IF NOT EXISTS fines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  amount INTEGER NOT NULL,
  unit TEXT NOT NULL DEFAULT '포인트',
  paid INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id)
);

-- 포인트 이력 테이블
CREATE TABLE IF NOT EXISTS point_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'learn',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id)
);

-- 기본 학생 데이터
INSERT OR IGNORE INTO students (name, points) VALUES
  ('민서준', 0),
  ('김하린', 0),
  ('박재이', 0),
  ('정시우', 0),
  ('정시원', 0),
  ('최다연', 0),
  ('안하윤', 0);
