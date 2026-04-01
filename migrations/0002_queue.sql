-- 번호표 테이블
-- number: 오늘 발급된 순번
-- student_id: 뽑은 학생 (NULL 허용 - 비회원도 가능하지만 현재는 학생만)
-- date: 발급 날짜 (YYYY-MM-DD, KST)
-- called: 호출 여부 (0=대기, 1=호출됨, 2=완료)
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  student_id INTEGER,
  student_name TEXT NOT NULL,
  date TEXT NOT NULL,
  called INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (student_id) REFERENCES students(id)
);

CREATE INDEX IF NOT EXISTS idx_queue_date ON queue(date);
