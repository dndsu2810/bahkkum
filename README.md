# 🎓 학습 키오스크 (Learning Kiosk)

## 프로젝트 개요
- **이름**: 학습 키오스크
- **목표**: 방문자가 키오스크에서 학습 과정을 신청하면 슬랙으로 실시간 알림 전송 + 노션 DB에 자동 저장
- **플랫폼**: Cloudflare Pages (Edge 배포)
- **기술 스택**: Hono + TypeScript + TailwindCSS (CDN) + Cloudflare Workers

---

## ✅ 구현된 기능

### 프론트엔드 (키오스크 UI)
- **6단계 스텝 위저드** - 직관적인 단계별 신청 흐름
- **대형 터치 버튼** - 키오스크 환경에 최적화된 UI
- **숫자 넘패드** - 전화번호 직접 입력 (터치 친화적)
- **과목 선택** - 6개 카드 버튼 (코딩, 수학, 영어, 예술, 비즈니스, 기타)
- **수준 선택** - 3단계 레벨 (입문 / 중급 / 고급)
- **실시간 진행 표시** - 프로그레스바 + 단계 도트
- **최종 확인 화면** - 제출 전 내용 검토
- **완료 화면** - 슬랙/노션 전송 성공 여부 표시

### 백엔드 API
| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/` | GET | 키오스크 메인 페이지 |
| `/api/submit` | POST | 폼 제출 → 슬랙 + 노션 동시 처리 |
| `/api/health` | GET | 서비스 상태 + 환경변수 설정 확인 |

### POST /api/submit 요청 형식
```json
{
  "name": "홍길동",
  "phone": "01012345678",
  "course": "coding",
  "level": "beginner",
  "message": "주말 수업 원합니다",
  "timestamp": "2024-01-01 12:00:00"
}
```

---

## 🔧 환경변수 설정 (필수)

### .dev.vars (로컬 개발용)
```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 슬랙 웹훅 설정 방법
1. https://api.slack.com/apps → Create New App
2. Incoming Webhooks → Activate → Add New Webhook to Workspace
3. 원하는 채널 선택 → Webhook URL 복사

### 노션 설정 방법
1. https://www.notion.so/my-integrations → New Integration 생성
2. API Key 복사 → `NOTION_API_KEY`에 입력
3. 노션에서 새 데이터베이스 생성 (아래 컬럼 필요)
4. 데이터베이스 → Share → Integration 연결
5. DB URL에서 ID 추출 → `NOTION_DATABASE_ID`에 입력

### 노션 데이터베이스 필수 컬럼
| 컬럼명 | 타입 |
|--------|------|
| 이름 | Title |
| 연락처 | Rich Text |
| 수강 과목 | Select |
| 학습 수준 | Select |
| 추가 메시지 | Rich Text |
| 접수 일시 | Date |
| 상태 | Select |

---

## 🚀 로컬 개발

```bash
# 의존성 설치
npm install

# .dev.vars 파일 작성 (API 키 입력)
cp .dev.vars.example .dev.vars

# 빌드
npm run build

# PM2로 실행
pm2 start ecosystem.config.cjs

# 테스트
curl http://localhost:3000/api/health
```

---

## ☁️ Cloudflare Pages 배포

```bash
# 빌드 및 배포
npm run deploy:prod

# 환경변수 설정
npx wrangler pages secret put SLACK_WEBHOOK_URL --project-name webapp
npx wrangler pages secret put NOTION_API_KEY --project-name webapp
npx wrangler pages secret put NOTION_DATABASE_ID --project-name webapp
```

---

## 📊 데이터 흐름

```
[키오스크 사용자] 
  → [폼 입력 (이름/전화번호/과목/수준/메시지)]
  → [POST /api/submit]
  → [Promise.allSettled 병렬 처리]
    ├── [슬랙 Incoming Webhook → 채널 메시지]
    └── [노션 API → 데이터베이스 레코드 생성]
  → [결과 표시 (성공/실패 각각 표시)]
```

---

## 📅 배포 상태
- **플랫폼**: Cloudflare Pages
- **상태**: 🔄 개발 중 (로컬 테스트 완료)
- **마지막 업데이트**: 2026-03-31
