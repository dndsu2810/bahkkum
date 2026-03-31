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

// ─── API: 제출 처리 ────────────────────────────────────────────────────────────
app.post('/api/submit', async (c) => {
  try {
    const body = await c.req.json()
    const { name, item, price, timestamp } = body

    if (!name || !item) {
      return c.json({ success: false, error: '이름과 항목은 필수입니다.' }, 400)
    }

    const results = await Promise.allSettled([
      sendSlackNotification(c.env, { name, item, price, timestamp }),
      saveToNotion(c.env, { name, item, price, timestamp }),
    ])

    const slackOk  = results[0].status === 'fulfilled' && results[0].value
    const notionOk = results[1].status === 'fulfilled' && results[1].value

    return c.json({ success: true, slack: slackOk, notion: notionOk })
  } catch (err: any) {
    console.error('Submit error:', err)
    return c.json({ success: false, error: err.message }, 500)
  }
})

// ─── Slack 알림 ────────────────────────────────────────────────────────────────
async function sendSlackNotification(
  env: Bindings,
  data: { name: string; item: string; price: number; timestamp: string }
): Promise<boolean> {
  if (!env.SLACK_WEBHOOK_URL) { console.warn('SLACK_WEBHOOK_URL not set'); return false }

  const isFine = data.price > 0
  const emoji  = isFine ? '🚨' : '✅'
  const color  = isFine ? '#ef4444' : '#22c55e'
  const header = isFine
    ? `${emoji} 벌금 항목이 기록되었습니다`
    : `${emoji} 학습 활동이 기록되었습니다`

  const payload = {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `바꿈수학 키오스크 알림`, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${header}\n\n*👤 학생 이름:* ${data.name}\n*📋 항목:* ${data.item}\n*💰 금액:* ${data.price > 0 ? `₩${data.price.toLocaleString()}` : '무료'}`,
        },
        accessory: {
          type: 'image',
          image_url: isFine
            ? 'https://em-content.zobj.net/source/microsoft/319/warning_26a0-fe0f.png'
            : 'https://em-content.zobj.net/source/microsoft/319/check-mark-button_2705.png',
          alt_text: 'status',
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `⏰ ${data.timestamp}` }],
      },
      { type: 'divider' },
    ],
  }

  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(`Slack: ${res.status} ${t}`) }
  return true
}

// ─── Notion 저장 ───────────────────────────────────────────────────────────────
async function saveToNotion(
  env: Bindings,
  data: { name: string; item: string; price: number; timestamp: string }
): Promise<boolean> {
  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) {
    console.warn('Notion credentials not set'); return false
  }

  const isFine  = data.price > 0
  const category = isFine ? '벌금' : '학습 활동'

  const payload = {
    parent: { database_id: env.NOTION_DATABASE_ID },
    properties: {
      '학생 이름': { title: [{ text: { content: data.name } }] },
      '항목':     { rich_text: [{ text: { content: data.item } }] },
      '금액':     { number: data.price },
      '구분':     { select: { name: category } },
      '접수 일시': { date: { start: new Date().toISOString() } },
      '상태':     { select: { name: '접수 완료' } },
    },
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(`Notion: ${res.status} ${t}`) }
  return true
}

// ─── 헬스 체크 ────────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({
  status: 'ok',
  slack:  !!c.env.SLACK_WEBHOOK_URL,
  notion: !!(c.env.NOTION_API_KEY && c.env.NOTION_DATABASE_ID),
  timestamp: new Date().toISOString(),
}))

// ─── 메인 HTML ────────────────────────────────────────────────────────────────
app.get('/', (c) => {
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>바꿈수학 키오스크</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📐</text></svg>"/>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700;800;900&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --bg:        #0d0d14;
      --surface:   #16161f;
      --surface2:  #1e1e2a;
      --border:    rgba(255,255,255,0.08);
      --accent:    #7c6af7;
      --accent2:   #a78bfa;
      --green:     #34d399;
      --red:       #f87171;
      --yellow:    #fbbf24;
      --text:      #f0f0f5;
      --text-sub:  rgba(240,240,245,0.5);
      --radius-xl: 28px;
      --radius-lg: 20px;
      --radius-md: 14px;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      width: 100%; height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: 'Noto Sans KR', sans-serif;
      overflow: hidden;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }

    /* ── 공통 레이아웃 ── */
    .screen {
      position: fixed; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      opacity: 0; pointer-events: none;
      transition: opacity 0.35s ease;
    }
    .screen.active { opacity: 1; pointer-events: all; }

    /* ── 배경 그래디언트 파티클 ── */
    .bg-glow {
      position: fixed; inset: 0; z-index: 0;
      background:
        radial-gradient(ellipse 60% 40% at 20% 15%, rgba(124,106,247,0.12) 0%, transparent 60%),
        radial-gradient(ellipse 50% 35% at 80% 80%, rgba(167,139,250,0.08) 0%, transparent 55%),
        radial-gradient(ellipse 40% 30% at 50% 50%, rgba(52,211,153,0.04) 0%, transparent 50%);
      pointer-events: none;
    }

    /* ── 상단 헤더 바 ── */
    .top-bar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 10;
      height: 72px;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 36px;
      background: rgba(13,13,20,0.85);
      backdrop-filter: blur(20px);
      border-bottom: 1px solid var(--border);
    }
    .top-bar .logo {
      display: flex; align-items: center; gap: 12px;
    }
    .top-bar .logo-icon {
      width: 40px; height: 40px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
    }
    .top-bar .logo-text {
      font-size: 22px; font-weight: 800; letter-spacing: -0.5px;
      background: linear-gradient(90deg, var(--text), var(--accent2));
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .top-bar .logo-sub { font-size: 13px; color: var(--text-sub); margin-top: 1px; }
    .top-bar .clock {
      font-size: 18px; font-weight: 600; color: var(--text-sub);
      font-variant-numeric: tabular-nums;
    }

    /* ── [화면 0] 스플래시 ── */
    #splash { cursor: pointer; z-index: 5; }
    .splash-inner {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 32px; text-align: center;
    }
    .splash-ring {
      width: 160px; height: 160px; border-radius: 50%;
      background: linear-gradient(135deg, rgba(124,106,247,0.2), rgba(167,139,250,0.1));
      border: 2px solid rgba(124,106,247,0.4);
      display: flex; align-items: center; justify-content: center;
      animation: breathe 3s ease-in-out infinite;
      box-shadow: 0 0 60px rgba(124,106,247,0.2);
    }
    .splash-ring i { font-size: 60px; color: var(--accent2); }
    @keyframes breathe {
      0%,100% { transform: scale(1);   box-shadow: 0 0 60px rgba(124,106,247,0.2); }
      50%      { transform: scale(1.06); box-shadow: 0 0 80px rgba(124,106,247,0.35); }
    }
    .splash-title {
      font-size: clamp(36px, 5vw, 56px);
      font-weight: 900; line-height: 1.15; letter-spacing: -1px;
    }
    .splash-title span {
      background: linear-gradient(135deg, var(--accent2), #c4b5fd, var(--green));
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .splash-sub { font-size: 18px; color: var(--text-sub); }
    .tap-hint {
      display: flex; align-items: center; gap-x: 10px;
      padding: 14px 36px;
      border: 1.5px solid rgba(124,106,247,0.4);
      border-radius: 100px;
      font-size: 17px; font-weight: 500; color: var(--accent2);
      animation: pulse-border 2s ease-in-out infinite;
      margin-top: 8px;
    }
    .tap-hint i { animation: tap-anim 2s ease-in-out infinite; margin-right: 10px; }
    @keyframes pulse-border {
      0%,100% { border-color: rgba(124,106,247,0.4); box-shadow: none; }
      50%      { border-color: rgba(124,106,247,0.8); box-shadow: 0 0 20px rgba(124,106,247,0.2); }
    }
    @keyframes tap-anim {
      0%,100% { transform: scale(1); }
      40%      { transform: scale(1.25); }
      60%      { transform: scale(0.9); }
    }

    /* ── [화면 1] 이름 입력 ── */
    #name-screen { z-index: 5; }
    .name-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 48px 52px;
      width: min(580px, 92vw);
      box-shadow: 0 24px 80px rgba(0,0,0,0.5);
    }
    .screen-title {
      font-size: 30px; font-weight: 800; letter-spacing: -0.5px;
      margin-bottom: 8px;
    }
    .screen-sub { font-size: 16px; color: var(--text-sub); margin-bottom: 36px; }

    .kiosk-input {
      width: 100%;
      background: var(--surface2);
      border: 2px solid var(--border);
      border-radius: var(--radius-md);
      color: var(--text);
      font-family: inherit;
      font-size: 26px; font-weight: 700;
      padding: 22px 24px;
      text-align: center;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      caret-color: var(--accent2);
    }
    .kiosk-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px rgba(124,106,247,0.15);
    }
    .kiosk-input::placeholder { color: rgba(255,255,255,0.2); font-size: 18px; font-weight: 400; }

    /* 키보드 그리드 */
    .kbd-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-top: 24px;
    }
    .kbd-row-3 { grid-template-columns: repeat(3, 1fr); }

    .kbd-btn {
      background: var(--surface2);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-md);
      color: var(--text);
      font-family: inherit;
      font-size: 20px; font-weight: 700;
      padding: 18px 10px;
      cursor: pointer;
      transition: all 0.15s ease;
      -webkit-tap-highlight-color: transparent;
    }
    .kbd-btn:hover  { background: rgba(124,106,247,0.15); border-color: var(--accent); }
    .kbd-btn:active { transform: scale(0.93); }
    .kbd-btn.wide  { grid-column: span 2; }
    .kbd-btn.del   { background: rgba(248,113,113,0.1); border-color: rgba(248,113,113,0.25); font-size: 16px; }
    .kbd-btn.del:hover { background: rgba(248,113,113,0.25); }
    .kbd-btn.space { grid-column: span 2; font-size: 14px; color: var(--text-sub); }

    .btn-next {
      width: 100%;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      border: none; border-radius: var(--radius-lg);
      color: white; font-family: inherit;
      font-size: 20px; font-weight: 700;
      padding: 22px;
      cursor: pointer;
      margin-top: 20px;
      transition: all 0.2s ease;
      box-shadow: 0 8px 30px rgba(124,106,247,0.35);
    }
    .btn-next:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 12px 36px rgba(124,106,247,0.5); }
    .btn-next:disabled { opacity: 0.35; cursor: not-allowed; }
    .btn-next:active:not(:disabled) { transform: translateY(0); }

    /* ── [화면 2] 메뉴 선택 ── */
    #menu-screen { padding-top: 72px; align-items: stretch; justify-content: flex-start; z-index: 5; overflow-y: auto; }
    .menu-wrap {
      width: 100%; max-width: 980px;
      padding: 32px 28px 40px;
      margin: 0 auto;
    }
    .menu-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 28px;
    }
    .menu-greeting { font-size: 26px; font-weight: 800; }
    .menu-greeting span { color: var(--accent2); }
    .btn-back {
      background: var(--surface);
      border: 1.5px solid var(--border);
      border-radius: 100px;
      color: var(--text-sub);
      font-family: inherit;
      font-size: 14px; font-weight: 600;
      padding: 10px 20px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-back:hover { border-color: var(--accent); color: var(--accent2); }

    .section-label {
      font-size: 12px; font-weight: 700; letter-spacing: 2px;
      text-transform: uppercase; color: var(--text-sub);
      margin-bottom: 14px; padding-left: 4px;
    }

    /* 메뉴 그리드 */
    .menu-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin-bottom: 18px;
    }

    .menu-btn {
      position: relative;
      background: var(--surface);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 28px 20px 24px;
      cursor: pointer;
      display: flex; flex-direction: column;
      align-items: center; gap: 14px;
      transition: all 0.22s ease;
      text-align: center;
      overflow: hidden;
      -webkit-tap-highlight-color: transparent;
    }
    .menu-btn::before {
      content: '';
      position: absolute; inset: 0;
      background: linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.03));
      pointer-events: none;
    }
    .menu-btn:hover {
      transform: translateY(-4px);
      box-shadow: 0 16px 48px rgba(0,0,0,0.4);
    }
    .menu-btn:active { transform: translateY(-1px) scale(0.98); }

    /* 학습 활동 - 퍼플/그린 계열 */
    .menu-btn.type-learn {
      border-color: rgba(124,106,247,0.25);
      background: linear-gradient(160deg, #16161f, #1a1825);
    }
    .menu-btn.type-learn:hover {
      border-color: rgba(124,106,247,0.6);
      background: linear-gradient(160deg, #1c1b2e, #201d32);
      box-shadow: 0 16px 48px rgba(124,106,247,0.15);
    }
    /* 벌금 항목 - 레드/오렌지 계열 */
    .menu-btn.type-fine {
      border-color: rgba(248,113,113,0.2);
      background: linear-gradient(160deg, #1c1616, #1f1718);
    }
    .menu-btn.type-fine:hover {
      border-color: rgba(248,113,113,0.55);
      background: linear-gradient(160deg, #221b1b, #251c1c);
      box-shadow: 0 16px 48px rgba(248,113,113,0.12);
    }

    .menu-icon-wrap {
      width: 68px; height: 68px; border-radius: 22px;
      display: flex; align-items: center; justify-content: center;
      font-size: 30px;
      flex-shrink: 0;
    }
    .type-learn .menu-icon-wrap {
      background: rgba(124,106,247,0.15);
      border: 1.5px solid rgba(124,106,247,0.3);
    }
    .type-fine .menu-icon-wrap {
      background: rgba(248,113,113,0.12);
      border: 1.5px solid rgba(248,113,113,0.25);
    }

    .menu-label {
      font-size: 17px; font-weight: 800; line-height: 1.3;
      letter-spacing: -0.3px;
    }
    .menu-price {
      font-size: 15px; font-weight: 700;
      padding: 5px 14px;
      border-radius: 100px;
    }
    .type-learn .menu-price {
      background: rgba(52,211,153,0.12);
      color: var(--green);
      border: 1px solid rgba(52,211,153,0.2);
    }
    .type-fine .menu-price {
      background: rgba(248,113,113,0.12);
      color: var(--red);
      border: 1px solid rgba(248,113,113,0.2);
    }

    /* ── [화면 3] 확인/완료 ── */
    #confirm-screen { z-index: 5; }
    .confirm-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 44px 48px;
      width: min(520px, 92vw);
      box-shadow: 0 24px 80px rgba(0,0,0,0.5);
      text-align: center;
    }
    .confirm-icon {
      width: 96px; height: 96px; border-radius: 32px;
      display: flex; align-items: center; justify-content: center;
      font-size: 44px;
      margin: 0 auto 24px;
    }
    .confirm-icon.fine-icon {
      background: rgba(248,113,113,0.12);
      border: 2px solid rgba(248,113,113,0.3);
    }
    .confirm-icon.learn-icon {
      background: rgba(52,211,153,0.12);
      border: 2px solid rgba(52,211,153,0.3);
    }
    .confirm-item-name {
      font-size: 26px; font-weight: 900; margin-bottom: 8px;
    }
    .confirm-price-tag {
      display: inline-flex; align-items: center;
      font-size: 22px; font-weight: 800;
      padding: 10px 24px; border-radius: 100px;
      margin-bottom: 28px;
    }
    .confirm-price-tag.free  { background: rgba(52,211,153,0.12); color: var(--green); border: 1.5px solid rgba(52,211,153,0.25); }
    .confirm-price-tag.paid  { background: rgba(248,113,113,0.12); color: var(--red);   border: 1.5px solid rgba(248,113,113,0.25); }

    .confirm-detail {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 20px 24px;
      margin-bottom: 28px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .confirm-row {
      display: flex; align-items: center; justify-content: space-between;
    }
    .confirm-row-label { font-size: 14px; color: var(--text-sub); display: flex; align-items: center; gap: 8px; }
    .confirm-row-value { font-size: 16px; font-weight: 700; }

    .confirm-btns { display: flex; gap: 12px; }
    .btn-cancel {
      flex: 1; background: var(--surface2);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-lg);
      color: var(--text-sub); font-family: inherit;
      font-size: 17px; font-weight: 600;
      padding: 18px;
      cursor: pointer; transition: all 0.2s;
    }
    .btn-cancel:hover { border-color: var(--red); color: var(--red); }
    .btn-submit {
      flex: 2; background: linear-gradient(135deg, var(--accent), var(--accent2));
      border: none; border-radius: var(--radius-lg);
      color: white; font-family: inherit;
      font-size: 17px; font-weight: 700;
      padding: 18px;
      cursor: pointer; transition: all 0.2s;
      box-shadow: 0 8px 24px rgba(124,106,247,0.35);
      display: flex; align-items: center; justify-content: center; gap: 10px;
    }
    .btn-submit:hover { transform: translateY(-2px); box-shadow: 0 12px 32px rgba(124,106,247,0.5); }
    .btn-submit:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .spinner {
      width: 20px; height: 20px;
      border: 3px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── [화면 4] 완료 ── */
    #done-screen { z-index: 5; }
    .done-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 52px 48px;
      width: min(500px, 92vw);
      box-shadow: 0 24px 80px rgba(0,0,0,0.5);
      text-align: center;
    }
    .done-icon {
      width: 110px; height: 110px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 28px;
      animation: pop-in 0.6s cubic-bezier(0.34,1.56,0.64,1);
    }
    .done-icon.success {
      background: radial-gradient(circle, rgba(52,211,153,0.25), rgba(52,211,153,0.05));
      border: 2.5px solid rgba(52,211,153,0.5);
      font-size: 50px;
      box-shadow: 0 0 50px rgba(52,211,153,0.2);
    }
    @keyframes pop-in {
      from { transform: scale(0.3); opacity: 0; }
      to   { transform: scale(1);   opacity: 1; }
    }
    .done-title { font-size: 34px; font-weight: 900; margin-bottom: 10px; }
    .done-sub   { font-size: 17px; color: var(--text-sub); line-height: 1.6; margin-bottom: 32px; }

    .status-chips {
      display: flex; gap: 10px; justify-content: center;
      margin-bottom: 32px; flex-wrap: wrap;
    }
    .chip {
      display: flex; align-items: center; gap: 7px;
      padding: 10px 18px; border-radius: 100px;
      font-size: 14px; font-weight: 600;
    }
    .chip.ok   { background: rgba(52,211,153,0.1); color: var(--green); border: 1px solid rgba(52,211,153,0.25); }
    .chip.fail { background: rgba(248,113,113,0.1); color: var(--red);   border: 1px solid rgba(248,113,113,0.25); }
    .chip.skip { background: rgba(255,255,255,0.05); color: var(--text-sub); border: 1px solid var(--border); }

    .btn-home {
      width: 100%;
      background: var(--surface2);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-lg);
      color: var(--text); font-family: inherit;
      font-size: 18px; font-weight: 700;
      padding: 20px;
      cursor: pointer; transition: all 0.2s;
    }
    .btn-home:hover { border-color: var(--accent); color: var(--accent2); background: rgba(124,106,247,0.08); }

    .done-summary {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 18px 22px;
      margin-bottom: 28px;
      text-align: left;
    }
    .done-sum-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; }
    .done-sum-label { font-size: 13px; color: var(--text-sub); }
    .done-sum-val   { font-size: 15px; font-weight: 700; }

    /* ── 전환 애니메이션 ── */
    .fade-in  { animation: fadeIn  0.35s ease both; }
    .slide-up { animation: slideUp 0.4s cubic-bezier(0.34,1.3,0.64,1) both; }
    @keyframes fadeIn  { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(28px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
  </style>
</head>
<body>

<!-- 배경 글로우 -->
<div class="bg-glow"></div>

<!-- 상단 헤더 -->
<div class="top-bar">
  <div class="logo">
    <div class="logo-icon">📐</div>
    <div>
      <div class="logo-text">바꿈수학</div>
      <div class="logo-sub">학습 지원 키오스크</div>
    </div>
  </div>
  <div class="clock" id="clock">--:--:--</div>
</div>

<!-- ── 화면 0: 스플래시 ── -->
<div class="screen active" id="splash" onclick="goToName()">
  <div class="splash-inner slide-up">
    <div class="splash-ring">
      <i class="fas fa-graduation-cap"></i>
    </div>
    <div>
      <div class="splash-title">바꿈수학<br/><span>학습 지원</span></div>
      <div class="splash-sub" style="margin-top:10px">수학의 즐거움을 함께해요</div>
    </div>
    <div class="tap-hint">
      <i class="fas fa-hand-pointer"></i>
      화면을 탭해서 시작하세요
    </div>
  </div>
</div>

<!-- ── 화면 1: 이름 입력 ── -->
<div class="screen" id="name-screen">
  <div class="name-card slide-up">
    <div class="screen-title">👋 안녕하세요!</div>
    <div class="screen-sub">이름을 입력하고 항목을 선택하세요</div>

    <input id="nameInput" class="kiosk-input" type="text"
           placeholder="이름을 입력하세요" maxlength="10" readonly
           oninput="onNameChange()"/>

    <!-- 한글 가상 키보드 -->
    <div id="kbd-wrap">
      <div class="kbd-grid" style="grid-template-columns:repeat(5,1fr);margin-top:20px;">
        ${['ㄱ','ㄴ','ㄷ','ㄹ','ㅁ','ㅂ','ㅅ','ㅇ','ㅈ','ㅊ'].map(c=>`<button class="kbd-btn" onclick="appendChar('${c}')">${c}</button>`).join('')}
      </div>
      <div class="kbd-grid" style="grid-template-columns:repeat(5,1fr);margin-top:10px;">
        ${['ㅋ','ㅌ','ㅍ','ㅎ','ㅏ','ㅑ','ㅓ','ㅕ','ㅗ','ㅛ'].map(c=>`<button class="kbd-btn" onclick="appendChar('${c}')">${c}</button>`).join('')}
      </div>
      <div class="kbd-grid" style="grid-template-columns:repeat(5,1fr);margin-top:10px;">
        ${['ㅜ','ㅠ','ㅡ','ㅣ','ㅐ','ㅔ','1','2','3','4'].map(c=>`<button class="kbd-btn" onclick="appendChar('${c}')">${c}</button>`).join('')}
      </div>
      <div class="kbd-grid" style="grid-template-columns:repeat(4,1fr);margin-top:10px;">
        ${['5','6','7','8'].map(c=>`<button class="kbd-btn" onclick="appendChar('${c}')">${c}</button>`).join('')}
      </div>
      <div class="kbd-grid" style="grid-template-columns:2fr 2fr 1fr;margin-top:10px;">
        <button class="kbd-btn" onclick="appendChar(' ')" style="font-size:14px;color:var(--text-sub)">space</button>
        <button class="kbd-btn" onclick="clearName()" style="font-size:13px;color:var(--yellow)"><i class="fas fa-rotate-left"></i> 전체 지우기</button>
        <button class="kbd-btn del" onclick="delChar()"><i class="fas fa-delete-left"></i></button>
      </div>
    </div>

    <button id="nameNextBtn" class="btn-next" onclick="goToMenu()" disabled>
      <i class="fas fa-arrow-right" style="margin-right:8px"></i>항목 선택하기
    </button>
  </div>
</div>

<!-- ── 화면 2: 메뉴 선택 ── -->
<div class="screen" id="menu-screen">
  <div class="menu-wrap">
    <div class="menu-header">
      <div>
        <div class="menu-greeting"><span id="greet-name">이름</span>님, 무엇을 기록할까요?</div>
        <div style="font-size:14px;color:var(--text-sub);margin-top:4px">항목을 선택해 주세요</div>
      </div>
      <button class="btn-back" onclick="goToName()">
        <i class="fas fa-chevron-left" style="margin-right:6px"></i>이름 변경
      </button>
    </div>

    <div class="section-label" style="color:rgba(52,211,153,0.7)">
      <i class="fas fa-check-circle" style="margin-right:6px"></i>학습 활동
    </div>
    <div class="menu-grid" id="learn-grid"></div>

    <div class="section-label" style="color:rgba(248,113,113,0.7);margin-top:8px">
      <i class="fas fa-triangle-exclamation" style="margin-right:6px"></i>벌금 항목
    </div>
    <div class="menu-grid" id="fine-grid"></div>
  </div>
</div>

<!-- ── 화면 3: 확인 ── -->
<div class="screen" id="confirm-screen">
  <div class="confirm-card slide-up" id="confirm-card">
    <div class="confirm-icon" id="confirm-icon"></div>
    <div class="confirm-item-name" id="confirm-item-name"></div>
    <div class="confirm-price-tag" id="confirm-price-tag"></div>

    <div class="confirm-detail">
      <div class="confirm-row">
        <div class="confirm-row-label"><i class="fas fa-user"></i> 학생 이름</div>
        <div class="confirm-row-value" id="cd-name"></div>
      </div>
      <div style="height:1px;background:var(--border)"></div>
      <div class="confirm-row">
        <div class="confirm-row-label"><i class="fas fa-clock"></i> 접수 시각</div>
        <div class="confirm-row-value" id="cd-time"></div>
      </div>
    </div>

    <div class="confirm-btns">
      <button class="btn-cancel" onclick="goToMenu()">
        <i class="fas fa-xmark" style="margin-right:6px"></i>취소
      </button>
      <button class="btn-submit" id="submitBtn" onclick="doSubmit()">
        <i class="fas fa-paper-plane"></i>
        <span>확인 제출</span>
      </button>
    </div>
  </div>
</div>

<!-- ── 화면 4: 완료 ── -->
<div class="screen" id="done-screen">
  <div class="done-card">
    <div class="done-icon success" id="done-icon">✅</div>
    <div class="done-title">기록 완료!</div>
    <div class="done-sub" id="done-sub"></div>

    <div class="done-summary" id="done-summary"></div>
    <div class="status-chips" id="done-chips"></div>

    <button class="btn-home" onclick="goToSplash()">
      <i class="fas fa-house" style="margin-right:8px"></i>처음으로 돌아가기
    </button>
  </div>
</div>

<script>
(function(){
  // ── 데이터 ─────────────────────────────────────────────────────────────────
  const MENU = {
    learn: [
      { id:'study',    icon:'📖', label:'자습 인증하기',       price:0 },
      { id:'homework', icon:'✏️', label:'숙제 제출 완료',      price:0 },
      { id:'question', icon:'🙋', label:'질문하기',            price:0 },
      { id:'record',   icon:'📝', label:'모르는 문제 기록하기', price:0 },
      { id:'material', icon:'📄', label:'추가 학습지 요청',    price:0 },
    ],
    fine: [
      { id:'callteacher', icon:'🔔', label:'지현쌤 호출',   price:3500 },
      { id:'lostwork',    icon:'😰', label:'숙제 분실',     price:4000 },
      { id:'nohomework',  icon:'🚫', label:'숙제 안함',     price:5500 },
    ],
  }

  // ── 상태 ────────────────────────────────────────────────────────────────────
  let state = {
    name:       '',
    selected:   null,   // { id, icon, label, price }
    submitting: false,
    screen:     'splash',  // splash | name | menu | confirm | done
  }

  // ── 시계 ────────────────────────────────────────────────────────────────────
  function updateClock() {
    const now = new Date()
    document.getElementById('clock').textContent =
      now.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
  }
  setInterval(updateClock, 1000); updateClock()

  // ── 화면 전환 ───────────────────────────────────────────────────────────────
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.remove('active')
    })
    const target = document.getElementById(id)
    target.classList.add('active')
    state.screen = id
  }

  // ── 스플래시 → 이름 입력 ───────────────────────────────────────────────────
  window.goToName = function() {
    showScreen('name-screen')
    setTimeout(()=>{ document.getElementById('nameInput').focus() }, 200)
  }

  // ── 이름 입력 → 메뉴 ───────────────────────────────────────────────────────
  window.goToMenu = function() {
    if (!state.name.trim()) return
    document.getElementById('greet-name').textContent = state.name
    renderMenuGrid()
    showScreen('menu-screen')
  }

  // ── 메뉴 → 확인 화면 ───────────────────────────────────────────────────────
  window.selectItem = function(id) {
    const all = [...MENU.learn, ...MENU.fine]
    state.selected = all.find(m => m.id === id)
    if (!state.selected) return

    const isFine = state.selected.price > 0
    const now = new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})

    // 아이콘
    const iconEl = document.getElementById('confirm-icon')
    iconEl.textContent = state.selected.icon.trim()
    iconEl.className = 'confirm-icon ' + (isFine ? 'fine-icon' : 'learn-icon')

    // 항목명
    document.getElementById('confirm-item-name').textContent =
      state.selected.label.replace('\\n',' ')

    // 금액 태그
    const priceEl = document.getElementById('confirm-price-tag')
    priceEl.className = 'confirm-price-tag ' + (isFine ? 'paid' : 'free')
    priceEl.innerHTML = isFine
      ? \`<i class="fas fa-won-sign" style="margin-right:6px"></i>₩\${state.selected.price.toLocaleString()}\`
      : \`<i class="fas fa-check-circle" style="margin-right:6px"></i>무료\`

    // 상세
    document.getElementById('cd-name').textContent = state.name
    document.getElementById('cd-time').textContent = now

    // 제출 버튼 초기화
    const sb = document.getElementById('submitBtn')
    sb.disabled = false
    sb.innerHTML = '<i class="fas fa-paper-plane"></i><span>확인 제출</span>'

    showScreen('confirm-screen')
  }

  // ── 제출 ────────────────────────────────────────────────────────────────────
  window.doSubmit = async function() {
    if (state.submitting || !state.selected) return
    state.submitting = true

    const sb = document.getElementById('submitBtn')
    sb.disabled = true
    sb.innerHTML = '<div class="spinner"></div><span>전송 중...</span>'

    const timestamp = new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})

    try {
      const res = await fetch('/api/submit',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          name:  state.name,
          item:  state.selected.label.replace('\\n',' '),
          price: state.selected.price,
          timestamp,
        }),
      })
      const data = await res.json()
      renderDone(data.slack, data.notion)
    } catch(e) {
      renderDone(false, false)
    } finally {
      state.submitting = false
    }
  }

  // ── 완료 화면 렌더링 ────────────────────────────────────────────────────────
  function renderDone(slackOk, notionOk) {
    const isFine = state.selected?.price > 0
    const label  = (state.selected?.label||'').replace('\\n',' ')
    const price  = state.selected?.price || 0

    document.getElementById('done-sub').innerHTML =
      \`<strong>\${state.name}</strong>님의\` +
      (isFine
        ? \`<br/><span style="color:var(--red)">\${label}</span> 항목이 기록되었어요\`
        : \`<br/><span style="color:var(--green)">\${label}</span> 활동이 기록되었어요\`)

    const summary = document.getElementById('done-summary')
    summary.innerHTML = \`
      <div class="done-sum-row">
        <span class="done-sum-label">학생 이름</span>
        <span class="done-sum-val">\${state.name}</span>
      </div>
      <div class="done-sum-row">
        <span class="done-sum-label">항목</span>
        <span class="done-sum-val">\${label}</span>
      </div>
      <div class="done-sum-row">
        <span class="done-sum-label">금액</span>
        <span class="done-sum-val" style="color:\${isFine?'var(--red)':'var(--green)'}">
          \${isFine ? '₩'+price.toLocaleString() : '무료'}
        </span>
      </div>
    \`

    const chips = document.getElementById('done-chips')
    chips.innerHTML = \`
      <div class="chip \${slackOk?'ok':'fail'}">
        <i class="fab fa-slack"></i>
        슬랙 알림 \${slackOk?'전송됨':'실패'}
      </div>
      <div class="chip \${notionOk?'ok':'fail'}">
        <i class="fas fa-database"></i>
        노션 저장 \${notionOk?'완료':'실패'}
      </div>
    \`

    showScreen('done-screen')
    // 20초 후 자동 홈
    setTimeout(goToSplash, 20000)
  }

  // ── 홈으로 ─────────────────────────────────────────────────────────────────
  window.goToSplash = function() {
    state.name = ''
    state.selected = null
    document.getElementById('nameInput').value = ''
    document.getElementById('nameNextBtn').disabled = true
    showScreen('splash')
  }

  // ── 메뉴 그리드 렌더링 ─────────────────────────────────────────────────────
  function renderMenuGrid() {
    const lg = document.getElementById('learn-grid')
    const fg = document.getElementById('fine-grid')

    lg.innerHTML = MENU.learn.map(m => \`
      <button class="menu-btn type-learn" onclick="selectItem('\${m.id}')">
        <div class="menu-icon-wrap">\${m.icon}</div>
        <div class="menu-label">\${m.label.replace('\\n','<br/>')}</div>
        <div class="menu-price">무료</div>
      </button>
    \`).join('')

    fg.innerHTML = MENU.fine.map(m => \`
      <button class="menu-btn type-fine" onclick="selectItem('\${m.id}')">
        <div class="menu-icon-wrap">\${m.icon}</div>
        <div class="menu-label">\${m.label}</div>
        <div class="menu-price">₩\${m.price.toLocaleString()}</div>
      </button>
    \`).join('')
  }

  // ── 가상 키보드 ─────────────────────────────────────────────────────────────
  // 한글 조합 로직 (간단 자모 조합)
  const CHO  = ['ㄱ','ㄴ','ㄷ','ㄹ','ㅁ','ㅂ','ㅅ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']
  const JUNG = ['ㅏ','ㅑ','ㅓ','ㅕ','ㅗ','ㅛ','ㅜ','ㅠ','ㅡ','ㅣ','ㅐ','ㅔ']
  const CHO_IDX  = {ㄱ:0,ㄴ:2,ㄷ:3,ㄹ:5,ㅁ:6,ㅂ:7,ㅅ:9,ㅇ:11,ㅈ:12,ㅊ:14,ㅋ:15,ㅌ:16,ㅍ:17,ㅎ:18}
  const JUNG_IDX = {ㅏ:0,ㅑ:1,ㅓ:2,ㅕ:3,ㅗ:4,ㅛ:5,ㅜ:6,ㅠ:7,ㅡ:8,ㅣ:9,ㅐ:10,ㅔ:11}
  const JONG_LIST = ['','ㄱ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']
  const JONG_IDX = {'':0,ㄱ:1,ㄴ:3,ㄷ:6,ㄹ:7,ㅁ:15,ㅂ:16,ㅅ:18,ㅇ:19,ㅈ:20,ㅊ:21,ㅋ:22,ㅌ:23,ㅍ:24,ㅎ:25}

  function combineHangul(cho, jung, jong) {
    const base = 0xAC00
    const c = CHO_IDX[cho] ?? null
    const j = JUNG_IDX[jung] ?? null
    if (c === null || j === null) return cho + (jung||'') + (jong||'')
    const jj = JONG_IDX[jong||''] ?? 0
    return String.fromCharCode(base + c*21*28 + j*28 + jj)
  }

  let compose = { cho:'', jung:'', jong:'' }
  let composing = false

  function getInputEl() { return document.getElementById('nameInput') }

  window.appendChar = function(ch) {
    const inp = getInputEl()
    if (inp.value.length >= 10 && !composing) return
    if (inp.value.length >= 10) {
      flushCompose(); return
    }

    const isCho  = CHO.includes(ch)
    const isJung = JUNG.includes(ch)
    const isNum  = /[0-9]/.test(ch)
    const isSpace = ch === ' '

    if (isNum || isSpace) {
      flushCompose()
      if (inp.value.length < 10) inp.value += ch
    } else if (isCho) {
      if (!composing) {
        // 새 초성 시작
        compose = { cho:ch, jung:'', jong:'' }
        composing = true
        inp.value += ch  // 임시 표시
      } else {
        if (!compose.jung) {
          // 초성만 있는 상태에서 또 자음 → 완성 없이 새 자음
          flushCompose()
          compose = { cho:ch, jung:'', jong:'' }
          composing = true
          inp.value += ch
        } else if (!compose.jong) {
          // 초성+중성 있을 때 자음 → 종성 후보
          compose.jong = ch
          updateCompose()
        } else {
          // 이미 종성 있음 → 다음 글자 초성으로
          flushCompose()
          compose = { cho:ch, jung:'', jong:'' }
          composing = true
          inp.value += ch
        }
      }
    } else if (isJung) {
      if (!composing) {
        // 모음만 단독
        inp.value += ch
      } else {
        if (!compose.jung) {
          compose.jung = ch
          updateCompose()
        } else if (compose.jong) {
          // 종성을 다음 글자 초성으로 분리
          const savedJong = compose.jong
          compose.jong = ''
          const prevChar = combineHangul(compose.cho, compose.jung, '')
          inp.value = inp.value.slice(0, -1) + prevChar
          compose = { cho:savedJong, jung:ch, jong:'' }
          updateCompose()
        } else {
          // 이미 초성+중성 → 완성 후 모음 단독
          flushCompose()
          inp.value += ch
        }
      }
    }

    state.name = inp.value
    updateNameBtn()
  }

  function updateCompose() {
    const inp = getInputEl()
    const ch = combineHangul(compose.cho, compose.jung, compose.jong)
    inp.value = inp.value.slice(0,-1) + ch
    state.name = inp.value
  }

  function flushCompose() {
    composing = false
    compose = { cho:'', jung:'', jong:'' }
  }

  window.delChar = function() {
    const inp = getInputEl()
    if (composing) {
      if (compose.jong) {
        compose.jong = ''
        updateCompose()
        return
      } else if (compose.jung) {
        compose.jung = ''
        updateCompose()
        return
      } else {
        inp.value = inp.value.slice(0,-1)
        flushCompose()
      }
    } else {
      inp.value = inp.value.slice(0,-1)
    }
    state.name = inp.value
    updateNameBtn()
  }

  window.clearName = function() {
    const inp = getInputEl()
    inp.value = ''
    state.name = ''
    flushCompose()
    updateNameBtn()
  }

  window.onNameChange = function() {
    state.name = getInputEl().value.trim()
    updateNameBtn()
  }

  function updateNameBtn() {
    const btn = document.getElementById('nameNextBtn')
    if (btn) btn.disabled = !state.name.trim()
  }

  // ── 초기화 ──────────────────────────────────────────────────────────────────
  showScreen('splash')
})()
</script>
</body>
</html>`
  return c.html(html)
})

export default app
