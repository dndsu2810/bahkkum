-- fines 테이블에 fine_type 컬럼 추가 (point/time/sheet)
ALTER TABLE fines ADD COLUMN fine_type TEXT NOT NULL DEFAULT 'point';

-- 기존 벌금 데이터: unit에 '시간' 포함이면 time, '장' 포함이면 sheet, 나머지 point
UPDATE fines SET fine_type = CASE
  WHEN unit LIKE '%시간%' THEN 'time'
  WHEN unit LIKE '%장%' THEN 'sheet'
  ELSE 'point'
END;

-- requests 테이블: read_at 컬럼 (읽은 시간 - 시간/장수 벌금은 읽으면 처리 완료)
ALTER TABLE requests ADD COLUMN read_at DATETIME DEFAULT NULL;
