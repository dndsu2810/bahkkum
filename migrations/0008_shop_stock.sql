-- Migration 0008: 상점 월별 재고 및 일별 구매 한도 추적

-- 월별 재고 테이블
CREATE TABLE IF NOT EXISTS shop_stock (
  item_id TEXT NOT NULL,
  month_key TEXT NOT NULL,        -- YYYY-MM 형식 (예: 2026-04)
  initial_stock INTEGER DEFAULT 0, -- 이번 달 처음 설정한 재고
  remaining_stock INTEGER DEFAULT 0, -- 남은 재고
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (item_id, month_key)
);

-- 일별 구매 기록 (하루 한도 체크용)
CREATE TABLE IF NOT EXISTS shop_purchase_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  student_id INTEGER,
  student_name TEXT,
  qty INTEGER DEFAULT 1,
  purchase_date TEXT NOT NULL,    -- YYYY-MM-DD 형식
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_spl_item_date ON shop_purchase_log(item_id, purchase_date);
CREATE INDEX IF NOT EXISTS idx_spl_stu_date ON shop_purchase_log(student_name, purchase_date);
