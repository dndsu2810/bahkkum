import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  SLACK_WEBHOOK_URL: string
  NOTION_API_KEY: string
  NOTION_DATABASE_ID: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/static/*', serveStatic({ root: './' }))
app.use('/api/*', cors())

// ── 기본 데이터 (KV 없을 때 폴백) ─────────────────────────────────────────────
const DEFAULT_STUDENTS = [
  '김민준', '이서연', '박지우', '최하은', '정도윤',
  '강서현', '윤민서', '장준혁', '임지원', '한소율',
  '오현우', '신예린', '류재원', '노은지', '문성훈',
]

const DEFAULT_MENU = {
  learn: [
    { id: 'study',    icon: '📖', label: '자습 인증하기',      price: 0 },
    { id: 'homework', icon: '✏️', label: '숙제 제출 완료',     price: 0 },
    { id: 'question', icon: '🙋', label: '질문하기',           price: 0 },
    { id: 'record',   icon: '📝', label: '모르는 문제 기록하기', price: 0 },
    { id: 'material', icon: '📄', label: '추가 학습지 요청',   price: 0 },
  ],
  fine: [
    { id: 'callteacher', icon: '🔔', label: '선생님 호출',  price: 3500 },
    { id: 'lostwork',    icon: '😰', label: '숙제 분실',    price: 4000 },
    { id: 'nohomework',  icon: '🚫', label: '숙제 안함',    price: 5500 },
  ],
}

// ── API: 설정 조회 ─────────────────────────────────────────────────────────────
app.get('/api/config', (c) => {
  return c.json({ students: DEFAULT_STUDENTS, menu: DEFAULT_MENU })
})

// ── API: 제출 처리 ─────────────────────────────────────────────────────────────
app.post('/api/submit', async (c) => {
  try {
    const body = await c.req.json()
    const { name, item, price, timestamp } = body
    if (!name || !item) return c.json({ success: false, error: '이름과 항목은 필수입니다.' }, 400)

    const [slackR, notionR] = await Promise.allSettled([
      sendSlack(c.env, { name, item, price, timestamp }),
      saveNotion(c.env, { name, item, price, timestamp }),
    ])

    return c.json({
      success: true,
      slack:  slackR.status  === 'fulfilled' && slackR.value,
      notion: notionR.status === 'fulfilled' && notionR.value,
    })
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500)
  }
})

// ── Slack ──────────────────────────────────────────────────────────────────────
async function sendSlack(env: Bindings, d: { name: string; item: string; price: number; timestamp: string }) {
  if (!env.SLACK_WEBHOOK_URL) return false
  const isFine = d.price > 0
  const payload = {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `바꿈영수학원 키오스크 알림`, emoji: true } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${isFine ? '🚨 *벌금 항목* 기록' : '✅ *학습 활동* 기록'}\n\n*👤 학생:* ${d.name}\n*📋 항목:* ${d.item}\n*💰 금액:* ${d.price > 0 ? `₩${d.price.toLocaleString()}` : '무료'}`,
        },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `⏰ ${d.timestamp}` }] },
      { type: 'divider' },
    ],
  }
  const res = await fetch(env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  if (!res.ok) throw new Error(`Slack ${res.status}`)
  return true
}

// ── Notion ─────────────────────────────────────────────────────────────────────
async function saveNotion(env: Bindings, d: { name: string; item: string; price: number; timestamp: string }) {
  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) return false
  const payload = {
    parent: { database_id: env.NOTION_DATABASE_ID },
    properties: {
      '학생 이름': { title: [{ text: { content: d.name } }] },
      '항목':      { rich_text: [{ text: { content: d.item } }] },
      '금액':      { number: d.price },
      '구분':      { select: { name: d.price > 0 ? '벌금' : '학습 활동' } },
      '접수 일시': { date: { start: new Date().toISOString() } },
      '상태':      { select: { name: '접수 완료' } },
    },
  }
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.NOTION_API_KEY}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Notion ${res.status}`)
  return true
}

// ── Health ──────────────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({
  status: 'ok',
  slack:  !!c.env.SLACK_WEBHOOK_URL,
  notion: !!(c.env.NOTION_API_KEY && c.env.NOTION_DATABASE_ID),
}))

// ── 메인 HTML ──────────────────────────────────────────────────────────────────
app.get('/', (c) => c.html(getMainHTML()))
app.get('/admin', (c) => c.html(getAdminHTML()))

// ══════════════════════════════════════════════════════════════════════════════
//  메인 키오스크 HTML
// ══════════════════════════════════════════════════════════════════════════════
function getMainHTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
  <title>바꿈영수학원 키오스크</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐋</text></svg>"/>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700;800;900&display=swap" rel="stylesheet"/>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/>
  <style>
    :root {
      --blue:      #29ABE2;
      --blue-dark: #1a8abf;
      --blue-soft: #e8f6fd;
      --blue-mid:  #b3dff5;
      --white:     #ffffff;
      --gray-50:   #f8fafc;
      --gray-100:  #f1f5f9;
      --gray-200:  #e2e8f0;
      --gray-400:  #94a3b8;
      --gray-600:  #475569;
      --gray-800:  #1e293b;
      --red:       #ef4444;
      --red-soft:  #fef2f2;
      --green:     #22c55e;
      --green-soft:#f0fdf4;
      --shadow-sm: 0 1px 3px rgba(41,171,226,0.08), 0 1px 2px rgba(0,0,0,0.04);
      --shadow-md: 0 4px 16px rgba(41,171,226,0.12), 0 2px 6px rgba(0,0,0,0.06);
      --shadow-lg: 0 12px 40px rgba(41,171,226,0.15), 0 4px 12px rgba(0,0,0,0.08);
      --radius-xl: 24px;
      --radius-lg: 16px;
      --radius-md: 12px;
      --radius-sm: 8px;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 16px; }
    body {
      font-family: 'Noto Sans KR', sans-serif;
      background: var(--gray-50);
      color: var(--gray-800);
      min-height: 100vh;
      overflow-x: hidden;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }

    /* ── 배경 장식 ── */
    .bg-decoration {
      position: fixed; top: 0; left: 0; right: 0;
      height: 320px; z-index: 0; pointer-events: none;
      background: linear-gradient(160deg, #e8f6fd 0%, #f0f9ff 40%, var(--gray-50) 100%);
      overflow: hidden;
    }
    .bg-decoration::before {
      content: '';
      position: absolute; top: -80px; right: -60px;
      width: 360px; height: 360px; border-radius: 50%;
      background: radial-gradient(circle, rgba(41,171,226,0.12) 0%, transparent 70%);
    }
    .bg-decoration::after {
      content: '';
      position: absolute; bottom: 0; left: -40px;
      width: 250px; height: 250px; border-radius: 50%;
      background: radial-gradient(circle, rgba(41,171,226,0.08) 0%, transparent 70%);
    }

    /* ── 상단 헤더 ── */
    .header {
      position: relative; z-index: 10;
      background: var(--white);
      border-bottom: 1.5px solid var(--gray-200);
      box-shadow: var(--shadow-sm);
      padding: 0 clamp(16px, 4vw, 40px);
      height: clamp(64px, 9vw, 80px);
      display: flex; align-items: center; justify-content: space-between;
    }
    .header-logo {
      display: flex; align-items: center; gap: 12px;
    }
    .header-logo img {
      height: clamp(36px, 5vw, 48px);
      width: auto; object-fit: contain;
    }
    .header-right {
      display: flex; align-items: center; gap: clamp(10px, 2vw, 20px);
    }
    .header-clock {
      font-size: clamp(14px, 2vw, 18px);
      font-weight: 600; color: var(--blue);
      font-variant-numeric: tabular-nums;
      background: var(--blue-soft);
      padding: 6px 14px; border-radius: 100px;
    }
    .btn-admin {
      display: flex; align-items: center; gap: 6px;
      font-size: clamp(12px, 1.5vw, 14px); font-weight: 600;
      color: var(--gray-400); text-decoration: none;
      padding: 7px 14px; border-radius: 100px;
      border: 1.5px solid var(--gray-200);
      background: var(--white);
      transition: all 0.2s;
    }
    .btn-admin:hover { color: var(--blue); border-color: var(--blue-mid); background: var(--blue-soft); }

    /* ── 화면 컨테이너 ── */
    .screen { display: none; }
    .screen.active { display: block; }

    /* ── [화면 0] 스플래시 ── */
    #splash {
      min-height: calc(100vh - clamp(64px, 9vw, 80px));
      display: none; flex-direction: column;
      align-items: center; justify-content: center;
      padding: clamp(24px, 5vw, 60px) 20px;
      cursor: pointer; position: relative;
    }
    #splash.active { display: flex; }
    .splash-logo {
      margin-bottom: clamp(20px, 4vw, 36px);
      animation: float 4s ease-in-out infinite;
    }
    .splash-logo img {
      width: clamp(140px, 22vw, 220px);
      height: auto; filter: drop-shadow(0 8px 24px rgba(41,171,226,0.25));
    }
    @keyframes float {
      0%,100% { transform: translateY(0); }
      50%      { transform: translateY(-12px); }
    }
    .splash-title {
      font-size: clamp(28px, 5vw, 52px);
      font-weight: 900; color: var(--blue); letter-spacing: -1px;
      margin-bottom: 10px; text-align: center;
    }
    .splash-sub {
      font-size: clamp(14px, 2vw, 20px);
      color: var(--gray-400); margin-bottom: clamp(28px, 5vw, 48px);
      text-align: center;
    }
    .splash-tap {
      display: flex; align-items: center; gap: 10px;
      background: var(--blue);
      color: white; font-size: clamp(16px, 2.2vw, 22px); font-weight: 700;
      padding: clamp(14px, 2.5vw, 20px) clamp(28px, 5vw, 48px);
      border-radius: 100px;
      box-shadow: 0 8px 32px rgba(41,171,226,0.35);
      animation: pulse-btn 2.5s ease-in-out infinite;
    }
    @keyframes pulse-btn {
      0%,100% { box-shadow: 0 8px 32px rgba(41,171,226,0.35); transform: scale(1); }
      50%      { box-shadow: 0 12px 40px rgba(41,171,226,0.55); transform: scale(1.03); }
    }
    .splash-tap i { animation: tap-shake 2.5s ease-in-out infinite; }
    @keyframes tap-shake {
      0%,100% { transform: scale(1) rotate(0deg); }
      30%      { transform: scale(1.3) rotate(-15deg); }
      60%      { transform: scale(0.9) rotate(10deg); }
    }
    .splash-made {
      position: absolute; bottom: 20px;
      font-size: 12px; color: var(--gray-400);
    }

    /* ── [화면 1] 학생 선택 ── */
    #student-screen {
      min-height: calc(100vh - clamp(64px, 9vw, 80px));
      padding: clamp(20px, 3vw, 40px) clamp(16px, 4vw, 40px);
      display: none; flex-direction: column;
    }
    #student-screen.active { display: flex; }
    .page-header {
      display: flex; align-items: center; gap: 14px;
      margin-bottom: clamp(16px, 3vw, 28px);
    }
    .btn-back-circle {
      width: 44px; height: 44px; border-radius: 50%;
      background: var(--white); border: 1.5px solid var(--gray-200);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; font-size: 16px; color: var(--gray-600);
      transition: all 0.2s; flex-shrink: 0; box-shadow: var(--shadow-sm);
    }
    .btn-back-circle:hover { border-color: var(--blue); color: var(--blue); background: var(--blue-soft); }
    .page-title { font-size: clamp(20px, 3vw, 28px); font-weight: 800; color: var(--gray-800); }
    .page-sub   { font-size: clamp(12px, 1.5vw, 15px); color: var(--gray-400); margin-top: 2px; }

    /* 검색창 */
    .search-wrap {
      position: relative; margin-bottom: clamp(14px, 2.5vw, 24px);
    }
    .search-input {
      width: 100%;
      background: var(--white);
      border: 2px solid var(--gray-200);
      border-radius: var(--radius-lg);
      padding: clamp(12px, 2vw, 16px) 16px clamp(12px, 2vw, 16px) 48px;
      font-family: inherit; font-size: clamp(15px, 2vw, 18px); font-weight: 500;
      color: var(--gray-800); outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      box-shadow: var(--shadow-sm);
    }
    .search-input:focus {
      border-color: var(--blue);
      box-shadow: 0 0 0 3px rgba(41,171,226,0.15);
    }
    .search-input::placeholder { color: var(--gray-400); font-weight: 400; }
    .search-icon {
      position: absolute; left: 16px; top: 50%; transform: translateY(-50%);
      color: var(--gray-400); font-size: 16px;
    }

    /* 학생 그리드 */
    .student-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(clamp(100px, 18vw, 150px), 1fr));
      gap: clamp(8px, 1.5vw, 14px);
      overflow-y: auto;
      padding-bottom: 16px;
      flex: 1;
    }
    .student-btn {
      background: var(--white);
      border: 2px solid var(--gray-200);
      border-radius: var(--radius-lg);
      padding: clamp(14px, 2.5vw, 22px) 10px;
      cursor: pointer;
      display: flex; flex-direction: column;
      align-items: center; gap: 8px;
      transition: all 0.18s ease;
      box-shadow: var(--shadow-sm);
      text-align: center;
    }
    .student-btn:hover {
      border-color: var(--blue);
      background: var(--blue-soft);
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }
    .student-btn:active { transform: translateY(0) scale(0.97); }
    .student-avatar {
      width: clamp(40px, 6vw, 56px); height: clamp(40px, 6vw, 56px);
      border-radius: 50%;
      background: linear-gradient(135deg, var(--blue-soft), var(--blue-mid));
      border: 2px solid var(--blue-mid);
      display: flex; align-items: center; justify-content: center;
      font-size: clamp(16px, 2.5vw, 22px); font-weight: 800; color: var(--blue);
    }
    .student-name { font-size: clamp(13px, 1.8vw, 16px); font-weight: 700; color: var(--gray-800); }
    .student-btn.hidden { display: none; }

    /* ── [화면 2] 메뉴 선택 ── */
    #menu-screen {
      min-height: calc(100vh - clamp(64px, 9vw, 80px));
      padding: clamp(16px, 2.5vw, 32px) clamp(16px, 4vw, 40px);
      display: none; flex-direction: column;
    }
    #menu-screen.active { display: flex; }

    /* 선택된 학생 뱃지 */
    .selected-student-bar {
      display: flex; align-items: center; gap: 12px;
      background: var(--blue);
      color: white;
      padding: clamp(12px, 2vw, 16px) clamp(16px, 3vw, 24px);
      border-radius: var(--radius-lg);
      margin-bottom: clamp(16px, 2.5vw, 28px);
      box-shadow: 0 4px 16px rgba(41,171,226,0.3);
    }
    .selected-avatar {
      width: clamp(38px, 5vw, 48px); height: clamp(38px, 5vw, 48px);
      border-radius: 50%;
      background: rgba(255,255,255,0.25);
      display: flex; align-items: center; justify-content: center;
      font-size: clamp(15px, 2.2vw, 20px); font-weight: 800;
      flex-shrink: 0;
    }
    .selected-info { flex: 1; }
    .selected-name-text { font-size: clamp(16px, 2.2vw, 22px); font-weight: 800; }
    .selected-sub { font-size: clamp(11px, 1.5vw, 14px); opacity: 0.8; margin-top: 2px; }
    .btn-change-student {
      background: rgba(255,255,255,0.2); border: 1.5px solid rgba(255,255,255,0.4);
      color: white; font-family: inherit; font-size: clamp(11px, 1.5vw, 13px); font-weight: 600;
      padding: 8px 14px; border-radius: 100px; cursor: pointer; transition: all 0.2s;
      white-space: nowrap;
    }
    .btn-change-student:hover { background: rgba(255,255,255,0.35); }

    /* 섹션 라벨 */
    .section-divider {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: clamp(10px, 1.8vw, 16px);
    }
    .section-badge {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: clamp(11px, 1.5vw, 13px); font-weight: 700; letter-spacing: 0.5px;
      padding: 5px 12px; border-radius: 100px;
    }
    .badge-learn { background: var(--green-soft); color: var(--green); border: 1px solid rgba(34,197,94,0.2); }
    .badge-fine  { background: var(--red-soft);   color: var(--red);   border: 1px solid rgba(239,68,68,0.2); }

    /* 메뉴 그리드 */
    .menu-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(clamp(130px, 20vw, 190px), 1fr));
      gap: clamp(8px, 1.5vw, 14px);
      margin-bottom: clamp(12px, 2vw, 20px);
    }
    .menu-btn {
      background: var(--white);
      border: 2px solid var(--gray-200);
      border-radius: var(--radius-xl);
      padding: clamp(16px, 2.5vw, 26px) clamp(12px, 2vw, 18px);
      cursor: pointer;
      display: flex; flex-direction: column;
      align-items: center; gap: clamp(8px, 1.2vw, 12px);
      transition: all 0.2s ease;
      box-shadow: var(--shadow-sm);
      text-align: center;
      position: relative; overflow: hidden;
    }
    .menu-btn::after {
      content: '';
      position: absolute; inset: 0; opacity: 0;
      background: linear-gradient(135deg, rgba(41,171,226,0.05), transparent);
      transition: opacity 0.2s;
    }
    .menu-btn:hover::after { opacity: 1; }
    .menu-btn:active { transform: scale(0.97); }

    .menu-btn.type-learn:hover {
      border-color: var(--blue); background: #f0f9ff;
      transform: translateY(-3px); box-shadow: var(--shadow-md);
    }
    .menu-btn.type-fine:hover {
      border-color: var(--red); background: var(--red-soft);
      transform: translateY(-3px); box-shadow: 0 4px 16px rgba(239,68,68,0.1);
    }

    .menu-icon-box {
      width: clamp(52px, 8vw, 72px); height: clamp(52px, 8vw, 72px);
      border-radius: clamp(14px, 2vw, 20px);
      display: flex; align-items: center; justify-content: center;
      font-size: clamp(22px, 3.5vw, 32px);
    }
    .type-learn .menu-icon-box {
      background: linear-gradient(135deg, var(--blue-soft), #dbeafe);
      border: 1.5px solid var(--blue-mid);
    }
    .type-fine .menu-icon-box {
      background: var(--red-soft);
      border: 1.5px solid rgba(239,68,68,0.2);
    }
    .menu-label {
      font-size: clamp(13px, 1.8vw, 16px); font-weight: 800;
      color: var(--gray-800); line-height: 1.3;
    }
    .menu-price-tag {
      font-size: clamp(12px, 1.5vw, 14px); font-weight: 700;
      padding: 4px 12px; border-radius: 100px;
    }
    .type-learn .menu-price-tag { background: var(--green-soft); color: var(--green); border: 1px solid rgba(34,197,94,0.2); }
    .type-fine  .menu-price-tag { background: var(--red-soft); color: var(--red); border: 1px solid rgba(239,68,68,0.2); }

    /* ── [화면 3] 확인 모달 ── */
    .modal-overlay {
      position: fixed; inset: 0; z-index: 100;
      background: rgba(15, 23, 42, 0.35);
      backdrop-filter: blur(4px);
      display: none; align-items: center; justify-content: center;
      padding: 20px;
      animation: fadeOverlay 0.2s ease;
    }
    .modal-overlay.active { display: flex; }
    @keyframes fadeOverlay { from { opacity: 0; } to { opacity: 1; } }

    .modal-card {
      background: var(--white);
      border-radius: var(--radius-xl);
      padding: clamp(24px, 4vw, 44px) clamp(20px, 4vw, 40px);
      width: min(500px, 95vw);
      box-shadow: 0 24px 80px rgba(0,0,0,0.15);
      animation: slideUp 0.3s cubic-bezier(0.34,1.3,0.64,1);
    }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(30px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    .modal-icon {
      width: clamp(72px, 12vw, 96px); height: clamp(72px, 12vw, 96px);
      border-radius: clamp(20px, 3vw, 28px);
      display: flex; align-items: center; justify-content: center;
      font-size: clamp(32px, 5vw, 44px);
      margin: 0 auto clamp(14px, 2.5vw, 20px);
    }
    .modal-icon.learn-icon { background: var(--blue-soft); border: 2px solid var(--blue-mid); }
    .modal-icon.fine-icon  { background: var(--red-soft);  border: 2px solid rgba(239,68,68,0.25); }

    .modal-item  { font-size: clamp(20px, 3vw, 28px); font-weight: 900; text-align: center; color: var(--gray-800); margin-bottom: 6px; }
    .modal-price {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: clamp(16px, 2.2vw, 20px); font-weight: 800;
      padding: 8px 20px; border-radius: 100px;
      margin: 0 auto 20px; display: flex; justify-content: center;
    }
    .modal-price.free { color: var(--green); background: var(--green-soft); border: 1.5px solid rgba(34,197,94,0.25); }
    .modal-price.paid { color: var(--red);   background: var(--red-soft);   border: 1.5px solid rgba(239,68,68,0.25); }

    .modal-detail {
      background: var(--gray-50); border: 1px solid var(--gray-200);
      border-radius: var(--radius-lg); padding: clamp(14px, 2vw, 20px);
      margin-bottom: clamp(16px, 2.5vw, 24px);
      display: flex; flex-direction: column; gap: 10px;
    }
    .modal-row { display: flex; align-items: center; justify-content: space-between; }
    .modal-row-label { font-size: 13px; color: var(--gray-400); display: flex; align-items: center; gap: 6px; }
    .modal-row-value { font-size: 15px; font-weight: 700; color: var(--gray-800); }
    .modal-divider   { height: 1px; background: var(--gray-200); }

    .modal-btns { display: flex; gap: 10px; }
    .btn-modal-cancel {
      flex: 1; background: var(--gray-100); border: 1.5px solid var(--gray-200);
      border-radius: var(--radius-lg); color: var(--gray-600);
      font-family: inherit; font-size: clamp(14px, 2vw, 17px); font-weight: 600;
      padding: clamp(14px, 2.2vw, 18px);
      cursor: pointer; transition: all 0.2s;
    }
    .btn-modal-cancel:hover { background: var(--gray-200); }
    .btn-modal-submit {
      flex: 2; background: linear-gradient(135deg, var(--blue), var(--blue-dark));
      border: none; border-radius: var(--radius-lg);
      color: white; font-family: inherit;
      font-size: clamp(14px, 2vw, 17px); font-weight: 700;
      padding: clamp(14px, 2.2vw, 18px);
      cursor: pointer; transition: all 0.2s;
      box-shadow: 0 4px 16px rgba(41,171,226,0.35);
      display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .btn-modal-submit:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(41,171,226,0.5); }
    .btn-modal-submit:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
    .spinner {
      width: 18px; height: 18px;
      border: 3px solid rgba(255,255,255,0.35); border-top-color: white;
      border-radius: 50%; animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── [화면 4] 완료 ── */
    #done-screen {
      min-height: calc(100vh - clamp(64px, 9vw, 80px));
      padding: clamp(20px, 4vw, 60px) 20px;
      display: none; flex-direction: column;
      align-items: center; justify-content: center;
    }
    #done-screen.active { display: flex; }
    .done-card {
      background: var(--white);
      border: 1.5px solid var(--gray-200);
      border-radius: var(--radius-xl);
      padding: clamp(28px, 5vw, 52px) clamp(24px, 5vw, 48px);
      width: min(480px, 95vw);
      box-shadow: var(--shadow-lg);
      text-align: center;
      animation: popIn 0.5s cubic-bezier(0.34,1.56,0.64,1);
    }
    @keyframes popIn { from { opacity:0; transform:scale(0.85); } to { opacity:1; transform:scale(1); } }
    .done-check {
      width: clamp(80px, 14vw, 110px); height: clamp(80px, 14vw, 110px);
      border-radius: 50%; background: var(--green-soft);
      border: 3px solid rgba(34,197,94,0.3);
      display: flex; align-items: center; justify-content: center;
      font-size: clamp(36px, 6vw, 52px);
      margin: 0 auto clamp(16px, 3vw, 24px);
      animation: spin-once 0.5s ease 0.2s both;
    }
    @keyframes spin-once { from { transform: scale(0) rotate(-180deg); } to { transform: scale(1) rotate(0deg); } }
    .done-title { font-size: clamp(24px, 4vw, 36px); font-weight: 900; color: var(--gray-800); margin-bottom: 8px; }
    .done-desc  { font-size: clamp(14px, 1.8vw, 18px); color: var(--gray-400); line-height: 1.6; margin-bottom: clamp(20px, 3vw, 32px); }
    .done-summary {
      background: var(--gray-50); border: 1px solid var(--gray-200);
      border-radius: var(--radius-lg); padding: clamp(14px, 2vw, 20px);
      margin-bottom: clamp(16px, 2.5vw, 28px); text-align: left;
      display: flex; flex-direction: column; gap: 10px;
    }
    .done-row { display: flex; justify-content: space-between; align-items: center; }
    .done-label { font-size: 13px; color: var(--gray-400); }
    .done-val   { font-size: 15px; font-weight: 700; }
    .status-row { display: flex; gap: 10px; justify-content: center; margin-bottom: clamp(16px, 2.5vw, 28px); flex-wrap: wrap; }
    .status-chip {
      display: flex; align-items: center; gap: 6px;
      font-size: clamp(12px, 1.5vw, 14px); font-weight: 600;
      padding: 8px 16px; border-radius: 100px;
    }
    .chip-ok   { background: var(--green-soft); color: var(--green); border: 1px solid rgba(34,197,94,0.25); }
    .chip-fail { background: var(--red-soft); color: var(--red); border: 1px solid rgba(239,68,68,0.25); }
    .chip-skip { background: var(--gray-100); color: var(--gray-400); border: 1px solid var(--gray-200); }
    .btn-home-done {
      width: 100%; background: linear-gradient(135deg, var(--blue), var(--blue-dark));
      border: none; border-radius: var(--radius-lg);
      color: white; font-family: inherit;
      font-size: clamp(15px, 2vw, 18px); font-weight: 700;
      padding: clamp(14px, 2.2vw, 18px);
      cursor: pointer; transition: all 0.2s;
      box-shadow: 0 4px 16px rgba(41,171,226,0.3);
    }
    .btn-home-done:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(41,171,226,0.45); }

    /* ── 공통 애니메이션 ── */
    .fade-in  { animation: fadeIn 0.3s ease; }
    @keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }

    /* ── 스크롤바 ── */
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--blue-mid); border-radius: 2px; }

    /* ── 반응형 ── */
    @media (max-width: 480px) {
      .student-grid { grid-template-columns: repeat(3, 1fr); }
      .menu-grid    { grid-template-columns: repeat(2, 1fr); }
    }
    @media (min-width: 481px) and (max-width: 768px) {
      .student-grid { grid-template-columns: repeat(4, 1fr); }
      .menu-grid    { grid-template-columns: repeat(3, 1fr); }
    }
    @media (min-width: 769px) and (max-width: 1024px) {
      .student-grid { grid-template-columns: repeat(5, 1fr); }
      .menu-grid    { grid-template-columns: repeat(4, 1fr); }
    }
    @media (min-width: 1025px) {
      .student-grid { grid-template-columns: repeat(6, 1fr); }
      .menu-grid    { grid-template-columns: repeat(5, 1fr); }
    }
  </style>
</head>
<body>

<!-- 배경 -->
<div class="bg-decoration"></div>

<!-- 헤더 -->
<header class="header">
  <div class="header-logo">
    <img src="/static/logo_horizontal.png" alt="바꿈영수학원"/>
  </div>
  <div class="header-right">
    <div class="header-clock" id="clock">--:--</div>
    <a href="/admin" class="btn-admin">
      <i class="fas fa-sliders"></i>
      <span>관리</span>
    </a>
  </div>
</header>

<!-- ── 화면 0: 스플래시 ── -->
<div class="screen active" id="splash" onclick="goTo('student')">
  <div class="splash-logo">
    <img src="/static/logo_square.png" alt="바꿈영수학원 로고"/>
  </div>
  <div class="splash-title">바꿈영수학원</div>
  <div class="splash-sub">초등수학 학습 지원 키오스크</div>
  <div class="splash-tap">
    <i class="fas fa-hand-pointer"></i>
    화면을 탭해서 시작하세요
  </div>
  <div class="splash-made">Made with ❤️ by 이지현</div>
</div>

<!-- ── 화면 1: 학생 선택 ── -->
<div class="screen" id="student-screen">
  <div class="page-header">
    <button class="btn-back-circle" onclick="goTo('splash')">
      <i class="fas fa-chevron-left"></i>
    </button>
    <div>
      <div class="page-title">학생 선택</div>
      <div class="page-sub">내 이름을 찾아 선택해 주세요</div>
    </div>
  </div>
  <div class="search-wrap">
    <i class="fas fa-magnifying-glass search-icon"></i>
    <input class="search-input" type="text" placeholder="이름 검색..." id="searchInput"
           oninput="filterStudents(this.value)" autocomplete="off" spellcheck="false"/>
  </div>
  <div class="student-grid" id="studentGrid"></div>
</div>

<!-- ── 화면 2: 메뉴 선택 ── -->
<div class="screen" id="menu-screen">
  <div class="selected-student-bar" id="selectedBar">
    <div class="selected-avatar" id="selectedAvatar"></div>
    <div class="selected-info">
      <div class="selected-name-text" id="selectedName"></div>
      <div class="selected-sub">항목을 선택해 주세요</div>
    </div>
    <button class="btn-change-student" onclick="goTo('student')">
      <i class="fas fa-exchange-alt" style="margin-right:5px"></i>변경
    </button>
  </div>

  <div class="section-divider">
    <div class="section-badge badge-learn">
      <i class="fas fa-check-circle"></i> 학습 활동
    </div>
  </div>
  <div class="menu-grid" id="learnGrid"></div>

  <div class="section-divider" style="margin-top:4px">
    <div class="section-badge badge-fine">
      <i class="fas fa-triangle-exclamation"></i> 벌금 항목
    </div>
  </div>
  <div class="menu-grid" id="fineGrid"></div>
</div>

<!-- ── 화면 3: 확인 모달 ── -->
<div class="modal-overlay" id="confirmModal">
  <div class="modal-card">
    <div class="modal-icon" id="modalIcon"></div>
    <div class="modal-item" id="modalItem"></div>
    <div class="modal-price" id="modalPrice"></div>
    <div class="modal-detail">
      <div class="modal-row">
        <div class="modal-row-label"><i class="fas fa-user"></i> 학생 이름</div>
        <div class="modal-row-value" id="modalName"></div>
      </div>
      <div class="modal-divider"></div>
      <div class="modal-row">
        <div class="modal-row-label"><i class="fas fa-clock"></i> 접수 시각</div>
        <div class="modal-row-value" id="modalTime"></div>
      </div>
    </div>
    <div class="modal-btns">
      <button class="btn-modal-cancel" onclick="closeModal()">
        <i class="fas fa-xmark" style="margin-right:6px"></i>취소
      </button>
      <button class="btn-modal-submit" id="submitBtn" onclick="doSubmit()">
        <i class="fas fa-paper-plane"></i>
        <span id="submitBtnText">확인 제출</span>
      </button>
    </div>
  </div>
</div>

<!-- ── 화면 4: 완료 ── -->
<div class="screen" id="done-screen">
  <div class="done-card">
    <div class="done-check">✅</div>
    <div class="done-title">기록 완료!</div>
    <div class="done-desc" id="doneDesc"></div>
    <div class="done-summary" id="doneSummary"></div>
    <div class="status-row" id="doneChips"></div>
    <button class="btn-home-done" onclick="goTo('splash')">
      <i class="fas fa-house" style="margin-right:8px"></i>처음으로 돌아가기
    </button>
  </div>
</div>

<script>
(function(){
  /* ── 상태 ── */
  let config  = { students: [], menu: { learn: [], fine: [] } }
  let current = { student: null, item: null, submitting: false }
  let autoTimer = null

  /* ── 시계 ── */
  function tick() {
    const now = new Date()
    const h = String(now.getHours()).padStart(2,'0')
    const m = String(now.getMinutes()).padStart(2,'0')
    const s = String(now.getSeconds()).padStart(2,'0')
    document.getElementById('clock').textContent = h+':'+m+':'+s
  }
  setInterval(tick,1000); tick()

  /* ── 화면 전환 ── */
  function goTo(id) {
    clearAuto()
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
    const t = document.getElementById(
      id === 'splash'   ? 'splash' :
      id === 'student'  ? 'student-screen' :
      id === 'menu'     ? 'menu-screen' :
      'done-screen'
    )
    if (t) { t.classList.add('active'); t.classList.add('fade-in'); setTimeout(()=>t.classList.remove('fade-in'),400) }
    if (id === 'student') { document.getElementById('searchInput').value = ''; filterStudents('') }
  }
  window.goTo = goTo

  /* ── 설정 불러오기 ── */
  async function loadConfig() {
    try {
      const r = await fetch('/api/config')
      const d = await r.json()
      // localStorage 우선 (관리자 변경사항)
      const local = localStorage.getItem('kiosk_config')
      if (local) {
        try { config = JSON.parse(local) }
        catch { config = d }
      } else {
        config = d
      }
    } catch { /* 기본값 사용 */ }
    renderStudentGrid()
    renderMenuGrid()
  }

  /* ── 학생 그리드 ── */
  function getAvatar(name) { return name ? name[0] : '?' }

  function renderStudentGrid() {
    const g = document.getElementById('studentGrid')
    g.innerHTML = config.students.map(name => {
      const s = name.trim()
      return \`<button class="student-btn" data-name="\${s}" onclick="selectStudent('\${s}')">
        <div class="student-avatar">\${getAvatar(s)}</div>
        <div class="student-name">\${s}</div>
      </button>\`
    }).join('')
  }

  window.filterStudents = function(q) {
    const kw = q.trim()
    document.querySelectorAll('#studentGrid .student-btn').forEach(b => {
      const name = b.dataset.name
      b.classList.toggle('hidden', !!kw && !name.includes(kw))
    })
  }

  window.selectStudent = function(name) {
    current.student = name
    document.getElementById('selectedName').textContent = name
    document.getElementById('selectedAvatar').textContent = getAvatar(name)
    goTo('menu')
  }

  /* ── 메뉴 그리드 ── */
  function renderMenuGrid() {
    const lg = document.getElementById('learnGrid')
    const fg = document.getElementById('fineGrid')
    lg.innerHTML = config.menu.learn.map(m => menuBtnHTML(m, 'learn')).join('')
    fg.innerHTML = config.menu.fine.map(m  => menuBtnHTML(m, 'fine')).join('')
  }

  function menuBtnHTML(m, type) {
    const priceText = m.price > 0 ? '₩'+m.price.toLocaleString() : '무료'
    return \`<button class="menu-btn type-\${type}" onclick="selectItem('\${m.id}')">
      <div class="menu-icon-box">\${m.icon}</div>
      <div class="menu-label">\${m.label}</div>
      <div class="menu-price-tag">\${priceText}</div>
    </button>\`
  }

  /* ── 항목 선택 → 확인 모달 ── */
  window.selectItem = function(id) {
    const all = [...config.menu.learn, ...config.menu.fine]
    const item = all.find(m => m.id === id)
    if (!item) return
    current.item = item

    const isFine = item.price > 0
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })

    const iconEl = document.getElementById('modalIcon')
    iconEl.textContent = item.icon
    iconEl.className = 'modal-icon ' + (isFine ? 'fine-icon' : 'learn-icon')

    document.getElementById('modalItem').textContent = item.label
    const priceEl = document.getElementById('modalPrice')
    priceEl.className = 'modal-price ' + (isFine ? 'paid' : 'free')
    priceEl.innerHTML = isFine
      ? '<i class="fas fa-won-sign"></i> ₩'+item.price.toLocaleString()
      : '<i class="fas fa-check-circle"></i> 무료'

    document.getElementById('modalName').textContent = current.student
    document.getElementById('modalTime').textContent = now

    const sb = document.getElementById('submitBtn')
    sb.disabled = false
    document.getElementById('submitBtnText').textContent = '확인 제출'
    sb.querySelector('.spinner')?.remove()

    document.getElementById('confirmModal').classList.add('active')
  }

  window.closeModal = function() {
    document.getElementById('confirmModal').classList.remove('active')
    current.item = null
    current.submitting = false
  }

  /* ── 제출 ── */
  window.doSubmit = async function() {
    if (current.submitting || !current.item) return
    current.submitting = true

    const sb = document.getElementById('submitBtn')
    sb.disabled = true
    const spinner = document.createElement('div')
    spinner.className = 'spinner'
    document.getElementById('submitBtnText').textContent = '전송 중...'
    sb.insertBefore(spinner, sb.firstChild)

    const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })

    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:  current.student,
          item:  current.item.label,
          price: current.item.price,
          timestamp: ts,
        }),
      })
      const data = await res.json()
      document.getElementById('confirmModal').classList.remove('active')
      renderDone(data.slack, data.notion, ts)
    } catch {
      document.getElementById('confirmModal').classList.remove('active')
      renderDone(false, false, ts)
    } finally {
      current.submitting = false
    }
  }

  /* ── 완료 화면 ── */
  function renderDone(slackOk, notionOk, ts) {
    const isFine = current.item.price > 0
    const label  = current.item.label
    const price  = current.item.price

    document.getElementById('doneDesc').innerHTML =
      '<strong>'+current.student+'</strong>님의 '+
      (isFine
        ? '<span style="color:var(--red)">'+label+'</span> 항목이 기록되었습니다'
        : '<span style="color:var(--green)">'+label+'</span> 활동이 기록되었습니다')

    document.getElementById('doneSummary').innerHTML =
      row('학생 이름', current.student) +
      '<div class="done-row" style="height:1px;background:var(--gray-200);margin:2px 0"></div>' +
      row('항목', label) +
      '<div class="done-row" style="height:1px;background:var(--gray-200);margin:2px 0"></div>' +
      rowColor('금액', isFine?'₩'+price.toLocaleString():'무료', isFine?'var(--red)':'var(--green)')

    document.getElementById('doneChips').innerHTML =
      chip(slackOk, 'fab fa-slack', '슬랙 알림') +
      chip(notionOk, 'fas fa-database', '노션 저장')

    goTo('done')
    clearAuto()
    autoTimer = setTimeout(() => goTo('splash'), 20000)
  }

  function row(label, val) {
    return \`<div class="done-row"><span class="done-label">\${label}</span><span class="done-val">\${val}</span></div>\`
  }
  function rowColor(label, val, color) {
    return \`<div class="done-row"><span class="done-label">\${label}</span><span class="done-val" style="color:\${color}">\${val}</span></div>\`
  }
  function chip(ok, icon, label) {
    const cls = ok ? 'chip-ok' : 'chip-fail'
    const mark = ok ? '✓' : '✗'
    return \`<div class="status-chip \${cls}"><i class="\${icon}"></i> \${label} \${mark}</div>\`
  }

  function clearAuto() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null }
  }

  /* ── 초기화 ── */
  loadConfig()
})()
</script>
</body>
</html>`
}

// ══════════════════════════════════════════════════════════════════════════════
//  관리자 페이지 HTML
// ══════════════════════════════════════════════════════════════════════════════
function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>관리자 - 바꿈영수학원</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚙️</text></svg>"/>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800&display=swap" rel="stylesheet"/>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/>
  <style>
    :root {
      --blue:      #29ABE2;
      --blue-dark: #1a8abf;
      --blue-soft: #e8f6fd;
      --blue-mid:  #b3dff5;
      --white:     #ffffff;
      --gray-50:   #f8fafc;
      --gray-100:  #f1f5f9;
      --gray-200:  #e2e8f0;
      --gray-400:  #94a3b8;
      --gray-600:  #475569;
      --gray-800:  #1e293b;
      --red:       #ef4444;
      --red-soft:  #fef2f2;
      --green:     #22c55e;
      --green-soft:#f0fdf4;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Noto Sans KR', sans-serif;
      background: var(--gray-50);
      color: var(--gray-800);
      min-height: 100vh;
    }
    .header {
      background: var(--white);
      border-bottom: 1.5px solid var(--gray-200);
      padding: 0 clamp(16px,4vw,40px);
      height: 68px;
      display: flex; align-items: center; justify-content: space-between;
      position: sticky; top: 0; z-index: 10;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .header-left img { height: 38px; width: auto; }
    .header-title { font-size: 18px; font-weight: 800; color: var(--blue); }
    .btn-kiosk {
      display: flex; align-items: center; gap: 6px;
      background: var(--blue); color: white;
      text-decoration: none; font-size: 14px; font-weight: 600;
      padding: 9px 18px; border-radius: 100px;
      transition: all 0.2s;
      box-shadow: 0 2px 8px rgba(41,171,226,0.3);
    }
    .btn-kiosk:hover { background: var(--blue-dark); transform: translateY(-1px); }

    .admin-wrap {
      max-width: 960px; margin: 0 auto;
      padding: clamp(20px,3vw,40px) clamp(16px,4vw,40px);
      display: flex; flex-direction: column; gap: 28px;
    }

    .section-card {
      background: var(--white);
      border: 1.5px solid var(--gray-200);
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 1px 4px rgba(0,0,0,0.05);
    }
    .section-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 20px 24px;
      border-bottom: 1px solid var(--gray-200);
      background: var(--gray-50);
    }
    .section-head-title {
      display: flex; align-items: center; gap: 10px;
      font-size: 17px; font-weight: 800;
    }
    .section-head-icon {
      width: 36px; height: 36px; border-radius: 10px;
      background: var(--blue-soft); color: var(--blue);
      display: flex; align-items: center; justify-content: center;
      font-size: 16px;
    }
    .section-body { padding: 20px 24px; }

    /* 학생 목록 */
    .student-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
    .student-item {
      display: flex; align-items: center; justify-content: space-between;
      background: var(--gray-50); border: 1px solid var(--gray-200);
      border-radius: 12px; padding: 12px 16px;
      transition: all 0.2s;
    }
    .student-item:hover { border-color: var(--blue-mid); background: var(--blue-soft); }
    .student-item-name { font-size: 15px; font-weight: 700; }
    .student-item-avatar {
      width: 32px; height: 32px; border-radius: 50%;
      background: var(--blue-soft); border: 1.5px solid var(--blue-mid);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 800; color: var(--blue);
      margin-right: 10px; flex-shrink: 0;
    }
    .student-left { display: flex; align-items: center; }

    /* 추가 입력 */
    .add-row { display: flex; gap: 8px; }
    .add-input {
      flex: 1; background: var(--gray-50);
      border: 2px solid var(--gray-200); border-radius: 12px;
      padding: 12px 16px; font-family: inherit; font-size: 15px;
      outline: none; transition: all 0.2s; color: var(--gray-800);
    }
    .add-input:focus { border-color: var(--blue); background: var(--blue-soft); box-shadow: 0 0 0 3px rgba(41,171,226,0.1); }
    .btn-add {
      background: var(--blue); color: white;
      border: none; border-radius: 12px;
      font-family: inherit; font-size: 14px; font-weight: 700;
      padding: 12px 20px; cursor: pointer; transition: all 0.2s;
      white-space: nowrap;
    }
    .btn-add:hover { background: var(--blue-dark); }
    .btn-del {
      width: 32px; height: 32px; border-radius: 8px;
      background: var(--red-soft); border: 1px solid rgba(239,68,68,0.2);
      color: var(--red); cursor: pointer; transition: all 0.2s;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px;
    }
    .btn-del:hover { background: var(--red); color: white; }

    /* 메뉴 항목 */
    .menu-item {
      display: grid;
      grid-template-columns: 48px 1fr 120px 80px 40px;
      align-items: center; gap: 10px;
      background: var(--gray-50); border: 1px solid var(--gray-200);
      border-radius: 12px; padding: 12px 14px;
      margin-bottom: 8px; transition: all 0.2s;
    }
    .menu-item:hover { border-color: var(--blue-mid); }
    .icon-input, .label-input, .price-input {
      background: var(--white); border: 1.5px solid var(--gray-200);
      border-radius: 8px; padding: 8px 10px;
      font-family: inherit; font-size: 14px; outline: none;
      transition: all 0.2s; width: 100%; color: var(--gray-800);
    }
    .icon-input { text-align: center; font-size: 20px; width: 48px; }
    .icon-input:focus, .label-input:focus, .price-input:focus {
      border-color: var(--blue); box-shadow: 0 0 0 2px rgba(41,171,226,0.1);
    }
    .price-input { text-align: right; }
    .menu-type-badge {
      font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 6px;
      text-align: center; white-space: nowrap;
    }
    .learn-badge { background: var(--green-soft); color: var(--green); border: 1px solid rgba(34,197,94,0.2); }
    .fine-badge  { background: var(--red-soft);   color: var(--red);   border: 1px solid rgba(239,68,68,0.2); }

    .add-menu-row {
      display: grid;
      grid-template-columns: 48px 1fr 120px 40px;
      align-items: center; gap: 10px; margin-top: 12px;
    }
    .select-type {
      background: var(--white); border: 1.5px solid var(--gray-200);
      border-radius: 8px; padding: 8px 10px;
      font-family: inherit; font-size: 14px; outline: none;
      color: var(--gray-800); cursor: pointer;
    }
    .select-type:focus { border-color: var(--blue); }

    /* 저장 버튼 */
    .save-bar {
      background: var(--white);
      border: 1.5px solid var(--gray-200);
      border-radius: 20px;
      padding: 20px 24px;
      display: flex; align-items: center; justify-content: space-between;
      box-shadow: 0 1px 4px rgba(0,0,0,0.05);
    }
    .save-hint { font-size: 13px; color: var(--gray-400); }
    .btn-save {
      background: linear-gradient(135deg, var(--blue), var(--blue-dark));
      color: white; border: none; border-radius: 12px;
      font-family: inherit; font-size: 16px; font-weight: 700;
      padding: 14px 32px; cursor: pointer; transition: all 0.2s;
      box-shadow: 0 4px 16px rgba(41,171,226,0.3);
      display: flex; align-items: center; gap: 8px;
    }
    .btn-save:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(41,171,226,0.45); }
    .btn-reset {
      background: var(--gray-100); color: var(--gray-600);
      border: 1.5px solid var(--gray-200); border-radius: 12px;
      font-family: inherit; font-size: 14px; font-weight: 600;
      padding: 12px 20px; cursor: pointer; transition: all 0.2s;
      margin-right: 10px;
    }
    .btn-reset:hover { background: var(--gray-200); }

    .toast {
      position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
      background: var(--gray-800); color: white;
      font-size: 14px; font-weight: 600;
      padding: 12px 24px; border-radius: 100px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
      z-index: 999; opacity: 0; transition: all 0.3s;
      white-space: nowrap;
    }
    .toast.show { opacity: 1; }

    @media (max-width: 600px) {
      .menu-item { grid-template-columns: 40px 1fr 90px 36px; }
      .add-menu-row { grid-template-columns: 40px 1fr 90px 36px; }
      .menu-type-badge { display: none; }
    }
  </style>
</head>
<body>

<header class="header">
  <div class="header-left">
    <img src="/static/logo_horizontal.png" alt="바꿈영수학원"/>
    <div class="header-title">관리자 설정</div>
  </div>
  <a href="/" class="btn-kiosk">
    <i class="fas fa-display"></i> 키오스크로
  </a>
</header>

<div class="admin-wrap">

  <!-- 학생 목록 -->
  <div class="section-card">
    <div class="section-head">
      <div class="section-head-title">
        <div class="section-head-icon"><i class="fas fa-users"></i></div>
        학생 목록 관리
      </div>
      <span style="font-size:13px;color:var(--gray-400)" id="studentCount"></span>
    </div>
    <div class="section-body">
      <div class="student-list" id="studentList"></div>
      <div class="add-row">
        <input class="add-input" id="newStudentInput" type="text"
               placeholder="학생 이름 추가..." maxlength="10"
               onkeydown="if(event.key==='Enter') addStudent()"/>
        <button class="btn-add" onclick="addStudent()">
          <i class="fas fa-plus" style="margin-right:5px"></i>추가
        </button>
      </div>
    </div>
  </div>

  <!-- 학습 활동 항목 -->
  <div class="section-card">
    <div class="section-head">
      <div class="section-head-title">
        <div class="section-head-icon" style="background:var(--green-soft);color:var(--green)">
          <i class="fas fa-check-circle"></i>
        </div>
        학습 활동 항목
      </div>
    </div>
    <div class="section-body">
      <div id="learnItems"></div>
      <div class="add-menu-row" id="addLearnRow">
        <input class="icon-input" id="newLearnIcon" placeholder="📖" maxlength="4"/>
        <input class="label-input" id="newLearnLabel" placeholder="항목 이름" maxlength="20"
               onkeydown="if(event.key==='Enter') addMenuItem('learn')"/>
        <div style="font-size:13px;color:var(--gray-400);text-align:center">무료</div>
        <button class="btn-add" style="padding:8px" onclick="addMenuItem('learn')">
          <i class="fas fa-plus"></i>
        </button>
      </div>
    </div>
  </div>

  <!-- 벌금 항목 -->
  <div class="section-card">
    <div class="section-head">
      <div class="section-head-title">
        <div class="section-head-icon" style="background:var(--red-soft);color:var(--red)">
          <i class="fas fa-triangle-exclamation"></i>
        </div>
        벌금 항목
      </div>
    </div>
    <div class="section-body">
      <div id="fineItems"></div>
      <div class="add-menu-row">
        <input class="icon-input" id="newFineIcon" placeholder="🔔" maxlength="4"/>
        <input class="label-input" id="newFineLabel" placeholder="항목 이름" maxlength="20"
               onkeydown="if(event.key==='Enter') addMenuItem('fine')"/>
        <input class="price-input" id="newFinePrice" type="number" placeholder="3500" min="0" step="100"/>
        <button class="btn-add" style="padding:8px;background:var(--red)" onclick="addMenuItem('fine')">
          <i class="fas fa-plus"></i>
        </button>
      </div>
    </div>
  </div>

  <!-- 저장 -->
  <div class="save-bar">
    <div class="save-hint">💾 변경사항은 이 기기에 저장됩니다</div>
    <div style="display:flex;align-items:center">
      <button class="btn-reset" onclick="resetToDefault()">
        <i class="fas fa-rotate-left" style="margin-right:6px"></i>기본값으로
      </button>
      <button class="btn-save" onclick="saveConfig()">
        <i class="fas fa-floppy-disk"></i> 저장하기
      </button>
    </div>
  </div>

</div>

<div class="toast" id="toast"></div>

<script>
(function(){
  const DEFAULT = {
    students: ['김민준','이서연','박지우','최하은','정도윤','강서현','윤민서','장준혁','임지원','한소율','오현우','신예린','류재원','노은지','문성훈'],
    menu: {
      learn: [
        { id:'study',    icon:'📖', label:'자습 인증하기',       price:0 },
        { id:'homework', icon:'✏️', label:'숙제 제출 완료',      price:0 },
        { id:'question', icon:'🙋', label:'질문하기',            price:0 },
        { id:'record',   icon:'📝', label:'모르는 문제 기록하기', price:0 },
        { id:'material', icon:'📄', label:'추가 학습지 요청',    price:0 },
      ],
      fine: [
        { id:'callteacher', icon:'🔔', label:'선생님 호출',  price:3500 },
        { id:'lostwork',    icon:'😰', label:'숙제 분실',    price:4000 },
        { id:'nohomework',  icon:'🚫', label:'숙제 안함',    price:5500 },
      ],
    },
  }

  let config = JSON.parse(JSON.stringify(DEFAULT))

  function load() {
    const s = localStorage.getItem('kiosk_config')
    if (s) {
      try { config = JSON.parse(s) }
      catch { config = JSON.parse(JSON.stringify(DEFAULT)) }
    }
    render()
  }

  /* ── 학생 렌더 ── */
  function render() {
    renderStudents()
    renderMenuItems('learn')
    renderMenuItems('fine')
    document.getElementById('studentCount').textContent = config.students.length + '명'
  }

  function renderStudents() {
    const list = document.getElementById('studentList')
    list.innerHTML = config.students.map((name, i) => \`
      <div class="student-item">
        <div class="student-left">
          <div class="student-item-avatar">\${name[0]}</div>
          <div class="student-item-name">\${name}</div>
        </div>
        <button class="btn-del" onclick="delStudent(\${i})" title="삭제">
          <i class="fas fa-trash-can"></i>
        </button>
      </div>
    \`).join('')
    document.getElementById('studentCount').textContent = config.students.length + '명'
  }

  window.addStudent = function() {
    const inp = document.getElementById('newStudentInput')
    const name = inp.value.trim()
    if (!name) return
    if (config.students.includes(name)) { showToast('이미 있는 학생입니다'); return }
    config.students.push(name)
    inp.value = ''
    renderStudents()
    showToast('학생 추가됨: ' + name)
  }

  window.delStudent = function(i) {
    const name = config.students[i]
    if (!confirm(name + ' 학생을 삭제할까요?')) return
    config.students.splice(i, 1)
    renderStudents()
  }

  /* ── 메뉴 렌더 ── */
  function renderMenuItems(type) {
    const el = document.getElementById(type === 'learn' ? 'learnItems' : 'fineItems')
    el.innerHTML = config.menu[type].map((m, i) => \`
      <div class="menu-item">
        <input class="icon-input" value="\${m.icon}" maxlength="4"
               onchange="updateMenu('\${type}',\${i},'icon',this.value)"/>
        <input class="label-input" value="\${m.label}"
               onchange="updateMenu('\${type}',\${i},'label',this.value)"/>
        \${type === 'fine'
          ? \`<input class="price-input" type="number" value="\${m.price}" min="0" step="100"
                   onchange="updateMenu('\${type}',\${i},'price',parseInt(this.value)||0)"/>\`
          : \`<div style="font-size:13px;color:var(--gray-400);text-align:center">무료</div>\`
        }
        <button class="btn-del" onclick="delMenuItem('\${type}',\${i})">
          <i class="fas fa-trash-can"></i>
        </button>
      </div>
    \`).join('')
  }

  window.updateMenu = function(type, i, field, val) {
    config.menu[type][i][field] = val
  }

  window.addMenuItem = function(type) {
    const iconId = type === 'learn' ? 'newLearnIcon' : 'newFineIcon'
    const iconEl = document.getElementById(iconId)
    const icon  = iconEl ? iconEl.value.trim() : ''
    const label = document.getElementById(type === 'learn' ? 'newLearnLabel' : 'newFineLabel').value.trim()
    const price = type === 'fine' ? parseInt(document.getElementById('newFinePrice').value || '0') : 0

    if (!label) { showToast('항목 이름을 입력하세요'); return }

    const id = type + '_' + Date.now()
    config.menu[type].push({ id, icon: icon || (type === 'learn' ? '📋' : '💰'), label, price })

    document.getElementById(type === 'learn' ? 'newLearnIcon' : 'newFineIcon').value = ''
    document.getElementById(type === 'learn' ? 'newLearnLabel' : 'newFineLabel').value = ''
    if (type === 'fine') document.getElementById('newFinePrice').value = ''
    renderMenuItems(type)
    showToast('항목 추가됨: ' + label)
  }

  window.delMenuItem = function(type, i) {
    const label = config.menu[type][i].label
    if (!confirm(label + ' 항목을 삭제할까요?')) return
    config.menu[type].splice(i, 1)
    renderMenuItems(type)
  }

  /* ── 저장 ── */
  window.saveConfig = function() {
    localStorage.setItem('kiosk_config', JSON.stringify(config))
    showToast('✅ 저장되었습니다!')
  }

  window.resetToDefault = function() {
    if (!confirm('기본값으로 초기화할까요?')) return
    config = JSON.parse(JSON.stringify(DEFAULT))
    localStorage.removeItem('kiosk_config')
    render()
    showToast('기본값으로 초기화되었습니다')
  }

  /* ── 토스트 ── */
  function showToast(msg) {
    const t = document.getElementById('toast')
    t.textContent = msg
    t.classList.add('show')
    setTimeout(() => t.classList.remove('show'), 2500)
  }

  load()
})()
</script>
</body>
</html>`
}

export default app
