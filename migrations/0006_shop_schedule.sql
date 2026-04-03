-- 상점 잠금 해제 요청 테이블
CREATE TABLE IF NOT EXISTS shop_unlock_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_name TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | expired
  requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  unlocked_at  DATETIME,
  expires_at   DATETIME
);
