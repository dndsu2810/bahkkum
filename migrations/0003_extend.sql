-- queue 테이블 상태 컬럼 확장 (0=대기, 1=답변중, 2=완료)
-- called 컬럼은 이미 있으므로 status 컬럼만 추가
ALTER TABLE queue ADD COLUMN status TEXT DEFAULT 'waiting';

-- 요청사항 테이블 (학생 요청 이력 DB 저장)
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_name TEXT NOT NULL,
  message TEXT NOT NULL,
  photo_base64 TEXT,
  status TEXT DEFAULT 'pending',
  admin_note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 주문/제출 이력 테이블
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_name TEXT NOT NULL,
  items_json TEXT NOT NULL,
  total_cost INTEGER DEFAULT 0,
  currency TEXT DEFAULT '포인트',
  category TEXT DEFAULT 'learn',
  comment TEXT,
  has_photo INTEGER DEFAULT 0,
  slack_ok INTEGER DEFAULT 0,
  notion_ok INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_orders_student ON orders(student_name);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
