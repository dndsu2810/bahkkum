-- 학생별 수업 시간표 테이블
CREATE TABLE IF NOT EXISTS student_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL UNIQUE,
  schedule_json TEXT NOT NULL DEFAULT '[]',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);

-- shop_unlock_requests 에 student_id 컬럼 추가 (없으면 추가)
ALTER TABLE shop_unlock_requests ADD COLUMN student_id INTEGER DEFAULT NULL;
