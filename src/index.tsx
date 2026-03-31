import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

type Bindings = {
  DB: D1Database
  SLACK_WEBHOOK_URL: string
  NOTION_API_KEY: string
  NOTION_DATABASE_ID: string
  ADMIN_PASSWORD: string
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('/static/*', serveStatic({ root: './' }))
app.use('/api/*', cors())

// ── 관리자 인증 미들웨어 ──────────────────────────────────────────────────────
app.use('/api/admin/*', async (c, next) => {
  const pw = c.req.header('X-Admin-Password') || ''
  const correct = c.env.ADMIN_PASSWORD || '1234'
  if (pw !== correct) return c.json({ success: false, error: '인증 실패' }, 401)
  await next()
})

// ══════════════════════════════════════════════════════════════════════════════
//  API: 공개
// ══════════════════════════════════════════════════════════════════════════════

// 키오스크 기본 설정
app.get('/api/config', (c) => c.json(DEFAULT_CONFIG))

// 학생 목록 (포인트 + 미납 벌금 포함)
app.get('/api/students', async (c) => {
  try {
    const rows = await c.env.DB.prepare(`
      SELECT s.id, s.name, s.photo_url, s.points,
        COALESCE(SUM(CASE WHEN f.paid=0 THEN f.amount ELSE 0 END),0) AS unpaid_fines,
        COUNT(CASE WHEN f.paid=0 THEN 1 END) AS fine_count
      FROM students s
      LEFT JOIN fines f ON f.student_id = s.id
      GROUP BY s.id ORDER BY s.name
    `).all()
    return c.json({ success: true, students: rows.results })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// 학생 상세 (포인트 이력 + 벌금 내역)
app.get('/api/students/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const stu = await c.env.DB.prepare('SELECT * FROM students WHERE id=?').bind(id).first()
    if (!stu) return c.json({ success: false, error: '학생 없음' }, 404)
    const history = await c.env.DB.prepare(
      'SELECT * FROM point_history WHERE student_id=? ORDER BY created_at DESC LIMIT 30'
    ).bind(id).all()
    const fines = await c.env.DB.prepare(
      'SELECT * FROM fines WHERE student_id=? ORDER BY created_at DESC'
    ).bind(id).all()
    return c.json({ success: true, student: stu, history: history.results, fines: fines.results })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// 키오스크 제출 (포인트 자동 반영)
app.post('/api/submit', async (c) => {
  try {
    const body = await c.req.json()
    const { name, items, totalCost, currency, category, timestamp } = body
    if (!name || !items) return c.json({ success: false, error: '필수 값 누락' }, 400)

    // D1: 학생 찾기
    const stu = await c.env.DB.prepare('SELECT * FROM students WHERE name=?').bind(name).first() as any
    if (stu) {
      const delta = -(totalCost) // totalCost가 음수면 획득, 양수면 차감
      await c.env.DB.prepare('UPDATE students SET points = points + ? WHERE id=?').bind(delta, stu.id).run()
      const reason = items.map((x: any) => `${x.icon}${x.label}×${x.qty}`).join(', ')
      await c.env.DB.prepare(
        'INSERT INTO point_history (student_id, delta, reason, category) VALUES (?,?,?,?)'
      ).bind(stu.id, delta, reason, category).run()
      if (category === 'fine') {
        for (const item of items) {
          await c.env.DB.prepare(
            'INSERT INTO fines (student_id, label, amount, unit) VALUES (?,?,?,?)'
          ).bind(stu.id, `${item.icon} ${item.label}`, item.qty, currency).run()
        }
      }
    }

    const [slackR, notionR] = await Promise.allSettled([
      sendSlack(c.env, { name, items, totalCost, currency, category, timestamp }),
      saveNotion(c.env, { name, items, totalCost, currency, category, timestamp }),
    ])
    return c.json({
      success: true,
      slack: slackR.status === 'fulfilled' && slackR.value,
      notion: notionR.status === 'fulfilled' && notionR.value,
    })
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500)
  }
})

app.get('/api/health', (c) => c.json({
  status: 'ok',
  slack: !!c.env.SLACK_WEBHOOK_URL,
  notion: !!(c.env.NOTION_API_KEY && c.env.NOTION_DATABASE_ID),
  db: !!c.env.DB,
  ts: new Date().toISOString()
}))

// ══════════════════════════════════════════════════════════════════════════════
//  API: 관리자 전용
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/students', async (c) => {
  const { name } = await c.req.json()
  if (!name) return c.json({ success: false, error: '이름 필요' }, 400)
  await c.env.DB.prepare('INSERT OR IGNORE INTO students (name) VALUES (?)').bind(name).run()
  return c.json({ success: true })
})

app.delete('/api/admin/students/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM point_history WHERE student_id=?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM fines WHERE student_id=?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM students WHERE id=?').bind(id).run()
  return c.json({ success: true })
})

app.post('/api/admin/students/:id/photo', async (c) => {
  const id = c.req.param('id')
  const { photoBase64 } = await c.req.json()
  await c.env.DB.prepare('UPDATE students SET photo_url=? WHERE id=?').bind(photoBase64, id).run()
  return c.json({ success: true })
})

app.post('/api/admin/students/:id/points', async (c) => {
  const id = c.req.param('id')
  const { delta, reason } = await c.req.json()
  await c.env.DB.prepare('UPDATE students SET points = points + ? WHERE id=?').bind(delta, id).run()
  await c.env.DB.prepare(
    'INSERT INTO point_history (student_id, delta, reason, category) VALUES (?,?,?,?)'
  ).bind(id, delta, reason || '관리자 조정', 'admin').run()
  return c.json({ success: true })
})

app.post('/api/admin/fines/:id/pay', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE fines SET paid=1 WHERE id=?').bind(id).run()
  return c.json({ success: true })
})

app.delete('/api/admin/fines/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM fines WHERE id=?').bind(id).run()
  return c.json({ success: true })
})

// ── Slack ──────────────────────────────────────────────────────────────────────
async function sendSlack(env: Bindings, d: any) {
  if (!env.SLACK_WEBHOOK_URL) return false
  const catEmoji: Record<string, string> = { learn: '✅', fine: '🚨', shop: '🛍️' }
  const catLabel: Record<string, string> = { learn: '학습 활동', fine: '벌금', shop: '보상 교환' }
  const itemList = d.items.map((x: any) => `• ${x.icon} ${x.label} × ${x.qty}`).join('\n')
  const costText = d.totalCost === 0 ? '무료' : d.totalCost < 0
    ? `+${Math.abs(d.totalCost)} ${d.currency} 획득`
    : `-${d.totalCost} ${d.currency} 차감`
  const payload = {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `바꿈수학 키오스크 ${catEmoji[d.category] || '📋'}`, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${catLabel[d.category] || d.category}* 기록\n\n*👤 학생:* ${d.name}\n*📋 항목:*\n${itemList}\n*🏅 합계:* ${costText}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `⏰ ${d.timestamp}` }] },
      { type: 'divider' },
    ],
  }
  const res = await fetch(env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  if (!res.ok) throw new Error(`Slack ${res.status}`)
  return true
}

// ── Notion ─────────────────────────────────────────────────────────────────────
async function saveNotion(env: Bindings, d: any) {
  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) return false
  const catLabel: Record<string, string> = { learn: '학습 활동', fine: '벌금', shop: '보상 교환' }
  const itemList = d.items.map((x: any) => `${x.icon} ${x.label} × ${x.qty}`).join(', ')
  const costText = d.totalCost === 0 ? '무료' : d.totalCost < 0
    ? `+${Math.abs(d.totalCost)} ${d.currency}`
    : `-${d.totalCost} ${d.currency}`
  const payload = {
    parent: { database_id: env.NOTION_DATABASE_ID },
    properties: {
      '학생 이름': { title: [{ text: { content: d.name } }] },
      '항목': { rich_text: [{ text: { content: itemList } }] },
      '금액': { rich_text: [{ text: { content: costText } }] },
      '구분': { multi_select: [{ name: catLabel[d.category] || d.category }] },
      '접수 일시': { date: { start: new Date().toISOString() } },
      '상태': { select: { name: '접수 완료' } },
    },
  }
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.NOTION_API_KEY}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) { const t = await res.text(); throw new Error(`Notion ${res.status}: ${t}`) }
  return true
}

// ── 기본 설정 ──────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  currency: { unit: '포인트', symbol: '🏅', desc: '포인트를 모아서 간식이랑 교환해요!' },
  menu: {
    learn: [
      { id: 'study',    icon: '📖', label: '자습 인증하기',        cost: 0, reward: 2, requirePhoto: true  },
      { id: 'homework', icon: '✏️', label: '숙제 제출하기',        cost: 0, reward: 1, requirePhoto: false },
      { id: 'question', icon: '🙋', label: '질문하기',             cost: 0, reward: 1, requirePhoto: false },
      { id: 'record',   icon: '📝', label: '모르는 문제 기록하기', cost: 0, reward: 2, requirePhoto: true  },
      { id: 'material', icon: '📄', label: '추가 학습지 요청',     cost: 0, reward: 0, requirePhoto: false },
      { id: 'makeup',   icon: '📅', label: '보강 신청',            cost: 0, reward: 0, requirePhoto: false },
      { id: 'consult',  icon: '💬', label: '상담 요청',            cost: 0, reward: 0, requirePhoto: false },
    ],
    fine: [
      { id: 'helpme',     icon: '🆘', label: '지현쌤 Help me!', cost: 3, reward: 0, requirePhoto: false },
      { id: 'lostwork',   icon: '😰', label: '숙제 분실',        cost: 4, reward: 0, requirePhoto: false },
      { id: 'nohomework', icon: '🚫', label: '숙제 안함',        cost: 5, reward: 0, requirePhoto: false },
    ],
    shop: [
      { id: 'choco',      icon: '🍫', label: '초콜릿(달달구리)', cost: 3, reward: 0, requirePhoto: false },
      { id: 'jelly',      icon: '🍬', label: '젤리',             cost: 2, reward: 0, requirePhoto: false },
      { id: 'candy',      icon: '🍭', label: '사탕',             cost: 2, reward: 0, requirePhoto: false },
      { id: 'snack',      icon: '🍿', label: '과자',             cost: 3, reward: 0, requirePhoto: false },
      { id: 'saekkomdal', icon: '🍋', label: '새콤달콤',         cost: 2, reward: 0, requirePhoto: false },
      { id: 'vitaminc',   icon: '💊', label: '비타민C',          cost: 2, reward: 0, requirePhoto: false },
    ],
  },
}

app.get('/', (c) => c.html(MAIN_HTML))
app.get('/admin', (c) => c.html(ADMIN_HTML))

// ══════════════════════════════════════════════════════════════════════════════
//  메인 키오스크 HTML
// ══════════════════════════════════════════════════════════════════════════════
const MAIN_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
  <title>바꿈수학 키오스크</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🐳</text></svg>"/>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800;900&family=Nunito:wght@700;800;900&display=swap" rel="stylesheet"/>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/>
  <style>
    :root{
      --blue:#29ABE2;--blue-d:#1a90c4;--blue-dd:#0f6a96;--blue-soft:#e8f6fd;--blue-mid:#a8d8f0;
      --white:#fff;--sky:#f0f9ff;
      --g50:#f8fafc;--g100:#f1f5f9;--g200:#e2e8f0;--g400:#94a3b8;--g600:#475569;--g800:#1e293b;
      --yellow:#fbbf24;--yellow-d:#f59e0b;--yellow-s:#fffbeb;
      --green:#22c55e;--green-s:#f0fdf4;
      --red:#ef4444;--red-s:#fef2f2;
      --purple:#a855f7;--purple-s:#faf5ff;
      --orange:#f97316;--orange-s:#fff7ed;
      --r-xl:24px;--r-lg:16px;--r-md:12px;
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html{font-size:16px;}
    body{font-family:'Noto Sans KR',sans-serif;background:linear-gradient(160deg,#dff3fc 0%,#f0f9ff 40%,#fafcff 100%);background-attachment:fixed;color:var(--g800);min-height:100vh;overflow-x:hidden;-webkit-tap-highlight-color:transparent;user-select:none;}

    /* 파티클 */
    .bg-particles{position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:0;overflow:hidden;}
    .particle{position:absolute;border-radius:50%;opacity:.1;animation:float-p linear infinite;}
    @keyframes float-p{0%{transform:translateY(100vh) scale(0);opacity:0;}10%{opacity:.15;}90%{opacity:.08;}100%{transform:translateY(-100px) scale(1);opacity:0;}}

    /* 헤더 */
    .hdr{position:relative;z-index:20;background:rgba(255,255,255,.95);backdrop-filter:blur(16px);border-bottom:1.5px solid rgba(41,171,226,.12);box-shadow:0 2px 16px rgba(41,171,226,.08);padding:0 clamp(14px,3vw,32px);height:clamp(56px,7vw,68px);display:flex;align-items:center;justify-content:space-between;}
    .hdr-logo img{height:clamp(28px,4vw,40px);width:auto;}
    .hdr-r{display:flex;align-items:center;gap:8px;}
    .clock{font-size:clamp(11px,1.5vw,14px);font-weight:800;color:var(--blue);background:var(--blue-soft);border:1.5px solid var(--blue-mid);padding:5px 12px;border-radius:100px;font-variant-numeric:tabular-nums;}

    /* 화면 */
    .screen{display:none;position:relative;z-index:5;}
    .screen.active{display:block;}

    /* ── 스플래시 ── */
    #splash{min-height:calc(100vh - clamp(56px,7vw,68px));display:none;flex-direction:column;align-items:center;justify-content:center;padding:clamp(20px,4vw,48px) 20px;gap:clamp(12px,2.5vw,20px);cursor:pointer;text-align:center;}
    #splash.active{display:flex;}
    .sp-logo{width:clamp(90px,16vw,160px);animation:bob 3s ease-in-out infinite;filter:drop-shadow(0 10px 28px rgba(41,171,226,.3));}
    @keyframes bob{0%,100%{transform:translateY(0);}50%{transform:translateY(-14px);}}
    .sp-badge{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,var(--yellow),var(--yellow-d));color:white;font-size:clamp(12px,1.8vw,15px);font-weight:900;padding:8px 22px;border-radius:100px;box-shadow:0 4px 18px rgba(251,191,36,.45);animation:badge-bounce .7s ease-in-out infinite alternate;}
    @keyframes badge-bounce{from{transform:scale(1);}to{transform:scale(1.05) translateY(-3px);}}
    .sp-title{font-family:'Nunito',sans-serif;font-size:clamp(24px,5vw,50px);font-weight:900;color:var(--blue-dd);letter-spacing:-1px;line-height:1.1;}
    .sp-title .hi{background:linear-gradient(135deg,var(--blue),#0ea5e9);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
    .sp-desc{font-size:clamp(12px,1.6vw,15px);color:var(--g400);}
    .fi-row{display:flex;gap:clamp(10px,2vw,18px);flex-wrap:wrap;justify-content:center;}
    .fi{font-size:clamp(22px,4vw,34px);animation:fi-f 2.5s ease-in-out infinite;display:inline-block;}
    .fi:nth-child(1){animation-delay:0s;}.fi:nth-child(2){animation-delay:.3s;}.fi:nth-child(3){animation-delay:.6s;}.fi:nth-child(4){animation-delay:.9s;}.fi:nth-child(5){animation-delay:1.2s;}.fi:nth-child(6){animation-delay:1.5s;}
    @keyframes fi-f{0%,100%{transform:translateY(0) rotate(-5deg);}50%{transform:translateY(-10px) rotate(5deg) scale(1.1);}}
    .tap-btn{background:linear-gradient(135deg,var(--blue),var(--blue-d));color:white;font-size:clamp(14px,2.2vw,20px);font-weight:900;padding:clamp(14px,2vw,20px) clamp(28px,5vw,52px);border-radius:100px;border:none;cursor:pointer;box-shadow:0 8px 30px rgba(41,171,226,.45);animation:pulse-glow 2s ease-in-out infinite;display:flex;align-items:center;gap:10px;font-family:inherit;}
    @keyframes pulse-glow{0%,100%{box-shadow:0 8px 30px rgba(41,171,226,.4);transform:scale(1);}50%{box-shadow:0 14px 40px rgba(41,171,226,.65);transform:scale(1.04);}}
    .sp-footer{font-size:11px;color:var(--g400);}

    /* ── 학생 선택 ── */
    #student-screen{min-height:calc(100vh - clamp(56px,7vw,68px));padding:clamp(14px,2vw,24px) clamp(14px,3vw,28px);}
    .page-top{display:flex;align-items:center;gap:12px;margin-bottom:clamp(10px,1.8vw,18px);}
    .back-btn{width:40px;height:40px;border-radius:50%;background:var(--white);border:1.5px solid var(--g200);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;color:var(--g600);transition:all .2s;flex-shrink:0;}
    .back-btn:hover{border-color:var(--blue);color:var(--blue);background:var(--blue-soft);}
    .page-title{font-family:'Nunito',sans-serif;font-size:clamp(17px,2.8vw,24px);font-weight:900;}
    .page-sub{font-size:clamp(11px,1.4vw,13px);color:var(--g400);margin-top:2px;}
    .search-wrap{position:relative;margin-bottom:clamp(10px,1.6vw,16px);}
    .search-inp{width:100%;background:var(--white);border:2px solid var(--g200);border-radius:var(--r-lg);padding:clamp(10px,1.5vw,13px) 13px clamp(10px,1.5vw,13px) 42px;font-family:inherit;font-size:clamp(14px,1.8vw,16px);font-weight:500;color:var(--g800);outline:none;transition:all .2s;}
    .search-inp:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(41,171,226,.1);}
    .search-ic{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--g400);font-size:14px;}
    .student-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(clamp(110px,16vw,150px),1fr));gap:clamp(8px,1.4vw,12px);}
    .stu-btn{background:var(--white);border:2.5px solid var(--g200);border-radius:var(--r-xl);padding:clamp(14px,2vw,20px) 8px clamp(10px,1.5vw,14px);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;transition:all .18s;box-shadow:0 2px 8px rgba(0,0,0,.04);}
    .stu-btn:hover{border-color:var(--blue);background:var(--blue-soft);transform:translateY(-4px);box-shadow:0 8px 24px rgba(41,171,226,.18);}
    .stu-btn:active{transform:scale(.94);}
    .stu-photo{width:clamp(52px,8vw,72px);height:clamp(52px,8vw,72px);border-radius:50%;object-fit:cover;border:3px solid var(--blue-mid);background:linear-gradient(135deg,var(--blue-soft),#cde9f8);}
    .stu-av{width:clamp(52px,8vw,72px);height:clamp(52px,8vw,72px);border-radius:50%;background:linear-gradient(135deg,var(--blue-soft),#cde9f8);border:3px solid var(--blue-mid);display:flex;align-items:center;justify-content:center;font-size:clamp(18px,3vw,26px);font-weight:900;color:var(--blue-d);}
    .stu-name{font-size:clamp(12px,1.6vw,15px);font-weight:800;color:var(--g800);text-align:center;}
    .stu-pts{font-size:clamp(10px,1.3vw,12px);font-weight:700;background:var(--yellow-s);color:var(--yellow-d);border:1px solid rgba(251,191,36,.3);border-radius:100px;padding:2px 8px;}
    .stu-fine-badge{font-size:clamp(9px,1.2vw,11px);font-weight:700;background:var(--red-s);color:var(--red);border:1px solid rgba(239,68,68,.25);border-radius:100px;padding:2px 7px;}
    .stu-btn.hidden{display:none;}

    /* ── 학생 정보 패널 (메뉴 위) ── */
    #menu-screen{min-height:calc(100vh - clamp(56px,7vw,68px));padding:clamp(12px,1.8vw,20px) clamp(14px,3vw,28px) 110px;}
    .stu-banner{display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,var(--blue),var(--blue-d) 60%,#1680b0);color:white;border-radius:var(--r-xl);padding:clamp(10px,1.6vw,16px) clamp(14px,2.2vw,20px);margin-bottom:clamp(10px,1.6vw,16px);box-shadow:0 6px 22px rgba(41,171,226,.3);position:relative;overflow:hidden;}
    .stu-banner::before{content:'';position:absolute;right:-20px;top:-20px;width:120px;height:120px;border-radius:50%;background:rgba(255,255,255,.06);}
    .stu-banner-photo{width:clamp(42px,6vw,58px);height:clamp(42px,6vw,58px);border-radius:50%;object-fit:cover;border:2.5px solid rgba(255,255,255,.5);flex-shrink:0;}
    .stu-banner-av{width:clamp(42px,6vw,58px);height:clamp(42px,6vw,58px);border-radius:50%;background:rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;font-size:clamp(16px,2.2vw,22px);font-weight:900;border:2.5px solid rgba(255,255,255,.4);flex-shrink:0;}
    .stu-banner-info{flex:1;min-width:0;}
    .stu-banner-name{font-size:clamp(14px,2vw,19px);font-weight:900;}
    .stu-banner-stats{display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;}
    .stat-chip{display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.3);border-radius:100px;padding:3px 10px;font-size:clamp(10px,1.3vw,12px);font-weight:700;white-space:nowrap;}
    .stat-chip.red-chip{background:rgba(239,68,68,.3);border-color:rgba(239,68,68,.4);}
    .btn-change{background:rgba(255,255,255,.18);border:1.5px solid rgba(255,255,255,.35);color:white;font-family:inherit;font-size:clamp(10px,1.3vw,12px);font-weight:700;padding:6px 12px;border-radius:100px;cursor:pointer;transition:all .2s;white-space:nowrap;flex-shrink:0;}
    .btn-change:hover{background:rgba(255,255,255,.3);}

    /* 탭 */
    .tab-row{display:flex;gap:6px;margin-bottom:clamp(10px,1.6vw,16px);overflow-x:auto;padding-bottom:2px;}
    .tab-row::-webkit-scrollbar{display:none;}
    .tab-btn{display:flex;align-items:center;gap:5px;font-family:inherit;font-size:clamp(11px,1.5vw,13px);font-weight:800;padding:clamp(7px,1.1vw,11px) clamp(11px,1.8vw,17px);border-radius:100px;cursor:pointer;transition:all .2s;white-space:nowrap;border:2px solid transparent;background:var(--white);color:var(--g400);box-shadow:0 1px 4px rgba(0,0,0,.05);}
    .tab-dot{width:6px;height:6px;border-radius:50%;background:currentColor;}
    .tab-btn.active-learn{background:var(--green-s);color:var(--green);border-color:rgba(34,197,94,.3);}
    .tab-btn.active-fine{background:var(--red-s);color:var(--red);border-color:rgba(239,68,68,.3);}
    .tab-btn.active-shop{background:var(--purple-s);color:var(--purple);border-color:rgba(168,85,247,.3);}

    /* 메뉴 그리드 */
    .menu-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(clamp(110px,16vw,160px),1fr));gap:clamp(8px,1.4vw,12px);}
    .menu-btn{background:var(--white);border:2.5px solid var(--g200);border-radius:var(--r-xl);padding:clamp(13px,2vw,20px) clamp(9px,1.4vw,13px);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:clamp(5px,.9vw,9px);transition:all .22s;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.04);position:relative;overflow:hidden;}
    .menu-btn:active{transform:scale(.94) !important;}
    .menu-btn.type-learn:hover{border-color:var(--green);background:var(--green-s);transform:translateY(-5px);box-shadow:0 10px 28px rgba(34,197,94,.15);}
    .menu-btn.type-fine:hover{border-color:var(--red);background:var(--red-s);transform:translateY(-5px);box-shadow:0 10px 28px rgba(239,68,68,.12);}
    .menu-btn.type-shop:hover{border-color:var(--purple);background:var(--purple-s);transform:translateY(-5px);box-shadow:0 10px 28px rgba(168,85,247,.15);}
    .menu-btn.in-cart.type-learn{border-color:var(--green);border-width:3px;}
    .menu-btn.in-cart.type-fine{border-color:var(--red);border-width:3px;}
    .menu-btn.in-cart.type-shop{border-color:var(--purple);border-width:3px;}
    .menu-ic-wrap{width:clamp(50px,7.5vw,68px);height:clamp(50px,7.5vw,68px);border-radius:clamp(12px,1.8vw,18px);display:flex;align-items:center;justify-content:center;font-size:clamp(22px,3.5vw,32px);position:relative;}
    .type-learn .menu-ic-wrap{background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1.5px solid rgba(34,197,94,.2);}
    .type-fine  .menu-ic-wrap{background:var(--red-s);border:1.5px solid rgba(239,68,68,.18);}
    .type-shop  .menu-ic-wrap{background:var(--purple-s);border:1.5px solid rgba(168,85,247,.2);}
    .menu-lbl{font-size:clamp(11px,1.5vw,14px);font-weight:800;color:var(--g800);line-height:1.25;}
    .menu-cost-tag{font-size:clamp(10px,1.3vw,12px);font-weight:800;padding:3px 9px;border-radius:100px;}
    .type-learn .menu-cost-tag{background:var(--green-s);color:var(--green);border:1px solid rgba(34,197,94,.2);}
    .type-fine  .menu-cost-tag{background:var(--red-s);color:var(--red);border:1px solid rgba(239,68,68,.2);}
    .type-shop  .menu-cost-tag{background:var(--purple-s);color:var(--purple);border:1px solid rgba(168,85,247,.2);}
    .photo-badge-sm{position:absolute;top:-2px;right:-2px;background:var(--orange);color:white;font-size:9px;font-weight:900;padding:2px 6px;border-radius:100px;}
    .qty-chip{position:absolute;top:-6px;right:-6px;background:var(--blue);color:white;font-size:11px;font-weight:900;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:2px solid white;}
    .type-learn .qty-chip{background:var(--green);}
    .type-fine  .qty-chip{background:var(--red);}
    .type-shop  .qty-chip{background:var(--purple);}

    /* 장바구니 바 */
    .cart-bar{position:fixed;bottom:0;left:0;right:0;z-index:50;background:rgba(255,255,255,.97);backdrop-filter:blur(14px);border-top:1.5px solid var(--g200);box-shadow:0 -4px 24px rgba(0,0,0,.08);padding:clamp(9px,1.6vw,13px) clamp(14px,3vw,28px);display:none;align-items:center;justify-content:space-between;gap:10px;}
    .cart-bar.visible{display:flex;}
    .cart-ic{width:44px;height:44px;border-radius:var(--r-md);background:var(--blue-soft);border:1.5px solid var(--blue-mid);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;position:relative;}
    .cart-badge{position:absolute;top:-7px;right:-7px;background:var(--red);color:white;font-size:10px;font-weight:900;min-width:20px;height:20px;border-radius:10px;display:flex;align-items:center;justify-content:center;border:2px solid white;padding:0 3px;}
    .cart-cnt{font-size:clamp(11px,1.4vw,13px);font-weight:700;color:var(--g600);}
    .cart-preview{font-size:clamp(10px,1.3vw,12px);color:var(--g400);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:clamp(100px,16vw,200px);}
    .cart-btns{display:flex;gap:7px;flex-shrink:0;}
    .btn-cc{background:var(--g100);border:1.5px solid var(--g200);color:var(--g600);font-family:inherit;font-size:clamp(11px,1.4vw,13px);font-weight:600;padding:clamp(9px,1.4vw,12px) clamp(11px,1.8vw,16px);border-radius:var(--r-md);cursor:pointer;transition:all .2s;}
    .btn-cc:hover{background:var(--red-s);color:var(--red);}
    .btn-cs{background:linear-gradient(135deg,var(--blue),var(--blue-d));border:none;color:white;font-family:inherit;font-size:clamp(12px,1.6vw,15px);font-weight:800;padding:clamp(9px,1.4vw,12px) clamp(14px,2.2vw,22px);border-radius:var(--r-md);cursor:pointer;transition:all .2s;box-shadow:0 4px 14px rgba(41,171,226,.35);display:flex;align-items:center;gap:6px;}
    .btn-cs:hover{transform:translateY(-1px);box-shadow:0 6px 22px rgba(41,171,226,.5);}

    /* 모달 */
    .modal-ov{position:fixed;inset:0;z-index:200;background:rgba(15,23,42,.45);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;padding:16px;}
    .modal-ov.open{display:flex;}
    .modal-box{background:var(--white);border-radius:var(--r-xl);padding:clamp(22px,3.5vw,34px) clamp(18px,3.5vw,30px);width:min(490px,96vw);box-shadow:0 28px 80px rgba(0,0,0,.18);animation:mpop .4s cubic-bezier(.34,1.4,.64,1);}
    @keyframes mpop{from{opacity:0;transform:scale(.82) translateY(20px);}to{opacity:1;transform:scale(1) translateY(0);}}
    .modal-title{font-size:clamp(17px,2.4vw,22px);font-weight:900;color:var(--g800);margin-bottom:5px;}
    .modal-sub{font-size:14px;color:var(--g400);}
    .photo-zone{border:2.5px dashed var(--blue-mid);border-radius:var(--r-lg);background:var(--blue-soft);padding:clamp(20px,3.5vw,34px) 20px;text-align:center;cursor:pointer;transition:all .2s;position:relative;overflow:hidden;margin:14px 0;}
    .photo-zone:hover{border-color:var(--blue);background:#d8eef9;}
    .photo-zone input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;}
    .photo-prev{max-width:100%;max-height:200px;border-radius:var(--r-md);object-fit:cover;display:none;margin:0 auto;}
    .photo-ph{pointer-events:none;}
    .photo-ph i{font-size:42px;color:var(--blue);margin-bottom:8px;display:block;}
    .photo-ph p{font-size:15px;font-weight:700;color:var(--blue-d);}
    .photo-ph span{font-size:12px;color:var(--g400);}
    .modal-btns{display:flex;gap:10px;margin-top:14px;}
    .btn-mc{flex:1;background:var(--g100);border:1.5px solid var(--g200);color:var(--g600);font-family:inherit;font-size:14px;font-weight:700;padding:13px;border-radius:var(--r-lg);cursor:pointer;}
    .btn-mok{flex:2;background:linear-gradient(135deg,var(--blue),var(--blue-d));border:none;color:white;font-family:inherit;font-size:14px;font-weight:800;padding:13px;border-radius:var(--r-lg);cursor:pointer;box-shadow:0 4px 14px rgba(41,171,226,.35);display:flex;align-items:center;justify-content:center;gap:8px;transition:all .2s;}
    .btn-mok:disabled{opacity:.4;cursor:not-allowed;}
    .btn-mok:not(:disabled):hover{transform:translateY(-1px);}

    /* 확인 모달 */
    #confirm-modal .modal-box{max-width:530px;}
    .confirm-stu-row{display:flex;align-items:center;gap:10px;background:var(--blue-soft);border:1.5px solid var(--blue-mid);border-radius:var(--r-lg);padding:12px 16px;margin-bottom:14px;}
    .confirm-av{width:42px;height:42px;border-radius:50%;object-fit:cover;border:2px solid var(--blue);}
    .confirm-av-txt{width:42px;height:42px;border-radius:50%;background:var(--blue-mid);border:2px solid var(--blue);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;color:var(--blue-d);}
    .confirm-sn{font-size:17px;font-weight:900;color:var(--blue-d);}
    .order-list{display:flex;flex-direction:column;gap:7px;margin-bottom:13px;}
    .order-item{display:flex;align-items:center;gap:10px;background:var(--g50);border:1px solid var(--g200);border-radius:var(--r-md);padding:9px 13px;}
    .order-emoji{font-size:23px;}
    .order-info{flex:1;}
    .order-lbl{font-size:13px;font-weight:700;}
    .order-qty{font-size:11px;color:var(--g400);margin-top:1px;}
    .order-cost{font-size:13px;font-weight:900;}
    .order-cost.green{color:var(--green);}
    .order-cost.red{color:var(--red);}
    .order-cost.purple{color:var(--purple);}
    .total-row{display:flex;align-items:center;justify-content:space-between;background:var(--g50);border:1.5px solid var(--g200);border-radius:var(--r-lg);padding:13px 16px;margin-bottom:15px;}
    .total-lbl{font-size:13px;font-weight:700;color:var(--g600);}
    .total-val{font-size:20px;font-weight:900;}

    /* 완료 화면 */
    #done-screen{min-height:calc(100vh - clamp(56px,7vw,68px));display:none;flex-direction:column;align-items:center;justify-content:center;padding:clamp(20px,3.5vw,44px) 16px;gap:clamp(12px,2.2vw,18px);}
    #done-screen.active{display:flex;}
    .done-anim{font-size:clamp(44px,7vw,72px);animation:dpop 1s cubic-bezier(.34,1.4,.64,1);}
    @keyframes dpop{from{transform:scale(0) rotate(-30deg);opacity:0;}60%{transform:scale(1.2) rotate(10deg);}to{transform:scale(1) rotate(0);opacity:1;}}
    .done-card{background:var(--white);border-radius:var(--r-xl);padding:clamp(24px,3.5vw,38px) clamp(20px,3.5vw,34px);width:min(500px,96vw);box-shadow:0 14px 56px rgba(41,171,226,.12);text-align:center;border:1.5px solid var(--g200);animation:mpop .5s cubic-bezier(.34,1.4,.64,1);}
    .done-title{font-family:'Nunito',sans-serif;font-size:clamp(20px,3.5vw,32px);font-weight:900;color:var(--g800);margin-bottom:5px;}
    .done-sub{font-size:clamp(13px,1.7vw,16px);color:var(--g400);line-height:1.65;margin-bottom:clamp(14px,2.2vw,22px);}
    .sess-sum{background:linear-gradient(135deg,var(--blue-soft),#e0f4fc);border:1.5px solid var(--blue-mid);border-radius:var(--r-lg);padding:clamp(12px,2vw,18px);margin-bottom:clamp(12px,2vw,18px);text-align:left;}
    .ss-title{font-size:11px;font-weight:800;color:var(--blue-d);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;}
    .ss-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(41,171,226,.12);}
    .ss-row:last-child{border-bottom:none;}
    .ss-lbl{font-size:12px;color:var(--g600);}
    .ss-val{font-size:13px;font-weight:800;}
    .chips-row{display:flex;gap:7px;justify-content:center;margin-bottom:clamp(14px,2.2vw,20px);flex-wrap:wrap;}
    .chip{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:700;padding:6px 14px;border-radius:100px;}
    .chip.ok{background:var(--green-s);color:var(--green);border:1px solid rgba(34,197,94,.25);}
    .chip.fail{background:var(--red-s);color:var(--red);border:1px solid rgba(239,68,68,.25);}
    .done-btns{display:flex;flex-direction:column;gap:9px;width:100%;}
    .btn-cont{width:100%;background:linear-gradient(135deg,var(--blue),var(--blue-d));border:none;color:white;font-family:inherit;font-size:clamp(14px,1.9vw,17px);font-weight:900;padding:clamp(13px,2vw,17px);border-radius:var(--r-lg);cursor:pointer;transition:all .2s;box-shadow:0 4px 18px rgba(41,171,226,.3);display:flex;align-items:center;justify-content:center;gap:8px;}
    .btn-cont:hover{transform:translateY(-1px);}
    .btn-home{width:100%;background:var(--g100);border:1.5px solid var(--g200);color:var(--g600);font-family:inherit;font-size:clamp(13px,1.7vw,15px);font-weight:700;padding:clamp(11px,1.7vw,15px);border-radius:var(--r-lg);cursor:pointer;transition:all .2s;}
    .btn-home:hover{background:var(--g200);}

    /* 피드백 토스트 */
    .fb-toast{position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:var(--g800);color:white;padding:9px 22px;border-radius:100px;font-size:14px;font-weight:700;z-index:9999;animation:fb-in .3s ease;pointer-events:none;white-space:nowrap;}
    @keyframes fb-in{from{opacity:0;transform:translateX(-50%) translateY(10px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}
    .confetti-p{position:fixed;z-index:9998;pointer-events:none;animation:cfly linear forwards;}
    @keyframes cfly{0%{transform:translateY(0) rotate(0) scale(1);opacity:1;}100%{transform:translateY(-60vh) rotate(720deg) scale(0);opacity:0;}}
    .fade-up{animation:fadeUp .3s ease;}
    @keyframes fadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
    .spinner{width:17px;height:17px;border:2.5px solid rgba(255,255,255,.3);border-top-color:white;border-radius:50%;animation:spin .65s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg);}}
    ::-webkit-scrollbar{width:4px;height:4px;}
    ::-webkit-scrollbar-thumb{background:var(--blue-mid);border-radius:2px;}
    @media(max-width:480px){.student-grid{grid-template-columns:repeat(3,1fr);}.menu-grid{grid-template-columns:repeat(2,1fr);}.stat-chip{font-size:9px;}}
    @media(min-width:481px) and (max-width:768px){.student-grid{grid-template-columns:repeat(4,1fr);}.menu-grid{grid-template-columns:repeat(3,1fr);}}
    @media(min-width:769px){.student-grid{grid-template-columns:repeat(5,1fr);}.menu-grid{grid-template-columns:repeat(4,1fr);}}
    @media(min-width:1200px){.menu-grid{grid-template-columns:repeat(5,1fr);}}
  </style>
</head>
<body>
<div class="bg-particles" id="bgP"></div>

<header class="hdr">
  <div class="hdr-logo"><img src="/static/logo_horizontal.png" alt="바꿈수학"/></div>
  <div class="hdr-r">
    <div class="clock" id="clock">--:--:--</div>
  </div>
</header>

<!-- 스플래시 -->
<div id="splash" onclick="goTo('student')">
  <img class="sp-logo" src="/static/logo_square.png" alt="바꿈"/>
  <div class="sp-badge" id="spBadge"><span id="spSym">🏅</span><span id="spDesc">포인트를 모아서 간식이랑 교환해요!</span></div>
  <div class="sp-title">바꿈수학<br/><span class="hi">학습 키오스크</span></div>
  <div class="sp-desc">초등수학 전용 · Made by 이지현 선생님</div>
  <div class="fi-row"><span class="fi">📖</span><span class="fi">🏅</span><span class="fi">🍫</span><span class="fi">🏆</span><span class="fi">🍬</span><span class="fi">🎉</span></div>
  <button class="tap-btn"><i class="fas fa-hand-pointer"></i>화면을 터치해서 시작!</button>
  <div class="sp-footer">Made with ❤️ by 이지현 | 바꿈수학 초등 전용</div>
</div>

<!-- 학생 선택 -->
<div class="screen" id="student-screen">
  <div style="padding:clamp(14px,2vw,24px) clamp(14px,3vw,28px);">
    <div class="page-top">
      <button class="back-btn" onclick="goTo('splash')"><i class="fas fa-chevron-left"></i></button>
      <div>
        <div class="page-title">👋 누구세요?</div>
        <div class="page-sub">내 이름을 찾아서 터치해요!</div>
      </div>
    </div>
    <div class="search-wrap">
      <i class="fas fa-magnifying-glass search-ic"></i>
      <input class="search-inp" id="searchInp" type="text" placeholder="이름 검색..."
             oninput="filterStudents(this.value)" autocomplete="off" spellcheck="false"/>
    </div>
    <div class="student-grid" id="studentGrid"></div>
  </div>
</div>

<!-- 메뉴 -->
<div class="screen" id="menu-screen">
  <div style="padding:clamp(12px,1.8vw,20px) clamp(14px,3vw,28px) 110px;">
    <div class="stu-banner">
      <div id="bannerAv"></div>
      <div class="stu-banner-info">
        <div class="stu-banner-name" id="bannerName"></div>
        <div class="stu-banner-stats" id="bannerStats"></div>
      </div>
      <button class="btn-change" onclick="goTo('student')"><i class="fas fa-exchange-alt" style="margin-right:3px"></i>변경</button>
    </div>
    <div class="tab-row" id="tabRow">
      <button class="tab-btn active-learn" onclick="switchTab('learn')" id="tab-learn"><div class="tab-dot"></div>학습 활동</button>
      <button class="tab-btn" onclick="switchTab('fine')" id="tab-fine"><div class="tab-dot"></div>벌금 항목</button>
      <button class="tab-btn" onclick="switchTab('shop')" id="tab-shop"><div class="tab-dot"></div>🛍️ 보상 상점</button>
    </div>
    <div class="menu-grid" id="menuGrid"></div>
  </div>
</div>

<!-- 완료 -->
<div id="done-screen">
  <div class="done-anim" id="doneEmoji">🎉</div>
  <div class="done-card">
    <div class="done-title" id="doneTitle">기록 완료!</div>
    <div class="done-sub" id="doneSub"></div>
    <div class="sess-sum" id="sessSum"></div>
    <div class="chips-row" id="doneChips"></div>
    <div class="done-btns">
      <button class="btn-cont" onclick="continueOrder()"><i class="fas fa-plus-circle"></i><span id="btnContLbl">계속 담기</span></button>
      <button class="btn-home" onclick="goTo('splash')"><i class="fas fa-house" style="margin-right:6px"></i>처음으로</button>
    </div>
  </div>
</div>

<!-- 장바구니 바 -->
<div class="cart-bar" id="cartBar">
  <div style="display:flex;align-items:center;gap:10px;">
    <div class="cart-ic">🛒<div class="cart-badge" id="cartBadge">0</div></div>
    <div>
      <div class="cart-cnt" id="cartCnt">0개 담음</div>
      <div class="cart-preview" id="cartPreview"></div>
    </div>
  </div>
  <div class="cart-btns">
    <button class="btn-cc" onclick="clearCart()"><i class="fas fa-trash"></i></button>
    <button class="btn-cs" onclick="openConfirm()"><i class="fas fa-paper-plane"></i>제출하기</button>
  </div>
</div>

<!-- 사진 인증 모달 -->
<div class="modal-ov" id="photo-modal">
  <div class="modal-box">
    <div class="modal-title">📸 사진으로 인증해요!</div>
    <div class="modal-sub" id="photoSub"></div>
    <div class="photo-zone" onclick="triggerPhoto()">
      <input type="file" id="photoInput" accept="image/*" capture="environment" onchange="onPhoto(event)"/>
      <img class="photo-prev" id="photoPrev" alt=""/>
      <div class="photo-ph" id="photoPh"><i class="fas fa-camera"></i><p>사진을 찍거나 갤러리에서 선택!</p><span>카메라 또는 앨범</span></div>
    </div>
    <div class="modal-btns">
      <button class="btn-mc" onclick="closePhotoModal()">취소</button>
      <button class="btn-mok" id="photoOk" onclick="confirmPhoto()" disabled><i class="fas fa-check"></i>인증 완료</button>
    </div>
  </div>
</div>

<!-- 확인 모달 -->
<div class="modal-ov" id="confirm-modal">
  <div class="modal-box">
    <div class="modal-title" style="margin-bottom:13px">📋 제출 확인</div>
    <div class="confirm-stu-row">
      <div id="confirmAv"></div>
      <div><div class="confirm-sn" id="confirmSn"></div><div style="font-size:11px;color:var(--g400)">학생</div></div>
    </div>
    <div class="order-list" id="orderList"></div>
    <div class="total-row"><div class="total-lbl">총 합계</div><div class="total-val" id="totalVal"></div></div>
    <div class="modal-btns">
      <button class="btn-mc" onclick="closeConfirm()"><i class="fas fa-xmark" style="margin-right:4px"></i>취소</button>
      <button class="btn-mok" id="confirmOk" onclick="doSubmit()"><i class="fas fa-paper-plane"></i><span id="confirmTxt">제출하기</span></button>
    </div>
  </div>
</div>

<script>
(function(){
const CFG_VER='2025-v3'
let CFG={currency:{unit:'포인트',symbol:'🏅',desc:''},menu:{learn:[],fine:[],shop:[]}}
let STUDENTS=[]
let ST={student:null,tab:'learn',cart:[],pendingItem:null,photoB64:null,submitting:false,sessionBalance:0,sessionOrders:[]}
let autoTimer=null

// 파티클
;(function(){
  const c=document.getElementById('bgP')
  const arr=['⭐','✨','📖','🌟','🍫','🏅']
  for(let i=0;i<16;i++){
    const el=document.createElement('div');el.className='particle'
    const sz=8+Math.random()*22
    if(Math.random()>.5){el.textContent=arr[Math.floor(Math.random()*arr.length)];el.style.cssText='position:absolute;font-size:'+sz+'px;left:'+Math.random()*100+'%;opacity:.2;animation:float-p '+(8+Math.random()*12)+'s linear '+(-(Math.random()*12))+'s infinite;'}
    else{el.style.cssText='position:absolute;width:'+sz+'px;height:'+sz+'px;left:'+Math.random()*100+'%;background:'+(Math.random()>.5?'#29ABE2':'#fbbf24')+';opacity:.1;border-radius:50%;animation:float-p '+(8+Math.random()*12)+'s linear '+(-(Math.random()*12))+'s infinite;'}
    c.appendChild(el)
  }
})()

// 시계
setInterval(()=>{const n=new Date();document.getElementById('clock').textContent=[n.getHours(),n.getMinutes(),n.getSeconds()].map(x=>String(x).padStart(2,'0')).join(':')},1000)

// 화면 전환
const SCRS=['splash','student-screen','menu-screen','done-screen']
function goTo(id){
  clearTimeout(autoTimer)
  SCRS.forEach(s=>document.getElementById(s).classList.remove('active'))
  const MAP={splash:'splash',student:'student-screen',menu:'menu-screen',done:'done-screen'}
  const el=document.getElementById(MAP[id]);if(!el)return
  el.classList.add('active','fade-up');setTimeout(()=>el.classList.remove('fade-up'),350)
  document.getElementById('cartBar').classList.toggle('visible',id==='menu')
  if(id==='student'){document.getElementById('searchInp').value='';filterStudents('')}
  if(id==='splash'){ST.cart=[];ST.student=null;ST.sessionBalance=0;ST.sessionOrders=[];updateCartBar()}
}
window.goTo=goTo

// 초기 로드
async function init(){
  try{
    const r=await fetch('/api/config');const d=await r.json()
    const sv=localStorage.getItem('kiosk_cfg_ver');const lc=localStorage.getItem('kiosk_config')
    if(lc&&sv===CFG_VER){try{CFG=JSON.parse(lc)}catch{CFG=d}}
    else{CFG=d;localStorage.removeItem('kiosk_config');localStorage.setItem('kiosk_cfg_ver',CFG_VER)}
  }catch{}
  applyCurrencyUI()
  await loadStudents()
  goTo('splash')
}

async function loadStudents(){
  try{
    const r=await fetch('/api/students');const d=await r.json()
    if(d.success){STUDENTS=d.students;renderStudents()}
  }catch{}
}

function applyCurrencyUI(){
  const c=CFG.currency
  document.getElementById('spSym').textContent=c.symbol
  document.getElementById('spDesc').textContent=c.desc||c.symbol+' '+c.unit+' 모으기!'
}

// 학생 그리드
function renderStudents(){
  const g=document.getElementById('studentGrid')
  g.innerHTML=STUDENTS.map(s=>{
    const photoEl=s.photo_url
      ?'<img class="stu-photo" src="'+escHtml(s.photo_url)+'" alt="'+escHtml(s.name)+'"/>'
      :'<div class="stu-av">'+escHtml(s.name[0])+'</div>'
    const fineBadge=s.fine_count>0
      ?'<div class="stu-fine-badge">⚠️ 미납 '+s.fine_count+'건</div>':''
    return '<button class="stu-btn" data-name="'+escHtml(s.name)+'" onclick="selectStudent('+s.id+')">'+
      photoEl+
      '<div class="stu-name">'+escHtml(s.name)+'</div>'+
      '<div class="stu-pts">🏅 '+s.points+'P</div>'+
      fineBadge+
    '</button>'
  }).join('')
}

function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

window.filterStudents=function(q){
  const kw=q.trim()
  document.querySelectorAll('#studentGrid .stu-btn').forEach(b=>{
    b.classList.toggle('hidden',!!kw&&!b.dataset.name.includes(kw))
  })
}

window.selectStudent=function(id){
  const s=STUDENTS.find(x=>x.id===id);if(!s)return
  ST.student=s;ST.cart=[];ST.sessionBalance=0;ST.sessionOrders=[]
  const av=document.getElementById('bannerAv')
  if(s.photo_url){av.outerHTML='<img class="stu-banner-photo" id="bannerAv" src="'+escHtml(s.photo_url)+'" alt="'+escHtml(s.name)+'"/>'}
  else{
    const newAv=document.createElement('div');newAv.id='bannerAv';newAv.className='stu-banner-av';newAv.textContent=s.name[0]
    av.replaceWith(newAv)
  }
  document.getElementById('bannerName').textContent=s.name
  updateBannerStats(s)
  const cav=document.getElementById('confirmAv')
  if(s.photo_url){
    cav.outerHTML='<img class="confirm-av" id="confirmAv" src="'+escHtml(s.photo_url)+'" alt="'+escHtml(s.name)+'"/>'
  } else {
    cav.outerHTML='<div class="confirm-av-txt" id="confirmAv">'+escHtml(s.name[0])+'</div>'
  }
  document.getElementById('confirmSn').textContent=s.name
  updateCartBar();switchTab('learn');goTo('menu')
}

function updateBannerStats(s){
  const c=CFG.currency
  const stats=document.getElementById('bannerStats')
  let html='<div class="stat-chip">'+c.symbol+' '+s.points+' '+c.unit+'</div>'
  if(s.fine_count>0) html+='<div class="stat-chip red-chip">⚠️ 미납 벌금 '+s.fine_count+'건</div>'
  if(s.unpaid_fines>0) html+='<div class="stat-chip red-chip">📋 미납 누적 '+s.unpaid_fines+'건</div>'
  stats.innerHTML=html
}

// 탭
window.switchTab=function(tab){
  ST.tab=tab
  document.querySelectorAll('.tab-btn').forEach(b=>b.className='tab-btn')
  document.getElementById('tab-'+tab).classList.add('tab-btn','active-'+tab)
  renderMenu()
}

// 메뉴 그리드
function renderMenu(){
  const items=CFG.menu[ST.tab]||[]
  const g=document.getElementById('menuGrid')
  const c=CFG.currency
  g.innerHTML=items.map(m=>{
    const ci=ST.cart.find(x=>x.id===m.id&&x.tab===ST.tab)
    const qty=ci?ci.qty:0
    const inCart=qty>0
    let costTxt=ST.tab==='learn'?(m.reward>0?'+'+m.reward+' '+c.symbol:'무료'):ST.tab==='fine'?'-'+m.cost+' '+c.unit:m.cost+' '+c.symbol
    const photoBadge=m.requirePhoto?'<div class="photo-badge-sm">📸</div>':''
    const qtyChip=qty>0?'<div class="qty-chip">'+qty+'</div>':''
    return '<button class="menu-btn type-'+ST.tab+(inCart?' in-cart':'')+'" onclick="addToCart(\''+m.id+'\',\''+ST.tab+'\')">'+
      photoBadge+
      '<div class="menu-ic-wrap">'+m.icon+qtyChip+'</div>'+
      '<div class="menu-lbl">'+escHtml(m.label)+'</div>'+
      '<div class="menu-cost-tag">'+costTxt+'</div>'+
    '</button>'
  }).join('')
}

// 장바구니
window.addToCart=function(id,tab){
  const item=(CFG.menu[tab]||[]).find(x=>x.id===id);if(!item)return
  if(item.requirePhoto){ST.pendingItem={item,tab};openPhotoModal(item.label);return}
  pushCart(item,tab,null)
}
function pushCart(item,tab,photo){
  const ex=ST.cart.find(x=>x.id===item.id&&x.tab===tab)
  if(ex){ex.qty++}else{ST.cart.push({id:item.id,tab,icon:item.icon,label:item.label,cost:item.cost,reward:item.reward||0,requirePhoto:item.requirePhoto,qty:1,photo})}
  updateCartBar();renderMenu()
  showFb(item.icon,item.label)
}
function showFb(icon,label){
  const fb=document.createElement('div');fb.className='fb-toast';fb.textContent=icon+' '+label+' 담았어요!'
  document.body.appendChild(fb);setTimeout(()=>fb.remove(),1500)
}
window.clearCart=function(){ST.cart=[];updateCartBar();renderMenu()}
function updateCartBar(){
  const tot=ST.cart.reduce((a,x)=>a+x.qty,0)
  document.getElementById('cartBadge').textContent=tot
  document.getElementById('cartCnt').textContent=tot+'개 담음'
  document.getElementById('cartPreview').textContent=ST.cart.map(x=>x.icon+x.label+(x.qty>1?' ×'+x.qty:'')).join(' · ')
  const isMenu=document.getElementById('menu-screen').classList.contains('active')
  document.getElementById('cartBar').classList.toggle('visible',isMenu)
}

// 사진 모달
function openPhotoModal(label){
  document.getElementById('photoSub').textContent='[ '+label+' ] 사진 인증이 필요해요 📸'
  document.getElementById('photoPrev').style.display='none'
  document.getElementById('photoPh').style.display='block'
  document.getElementById('photoOk').disabled=true
  ST.photoB64=null;document.getElementById('photo-modal').classList.add('open')
}
window.closePhotoModal=function(){document.getElementById('photo-modal').classList.remove('open');ST.pendingItem=null;ST.photoB64=null;document.getElementById('photoInput').value=''}
window.triggerPhoto=function(){document.getElementById('photoInput').click()}
window.onPhoto=function(e){
  const f=e.target.files[0];if(!f)return
  const reader=new FileReader()
  reader.onload=function(ev){
    ST.photoB64=ev.target.result
    const p=document.getElementById('photoPrev');p.src=ST.photoB64;p.style.display='block'
    document.getElementById('photoPh').style.display='none'
    document.getElementById('photoOk').disabled=false
  };reader.readAsDataURL(f)
}
window.confirmPhoto=function(){
  if(!ST.pendingItem||!ST.photoB64)return
  const{item,tab}=ST.pendingItem;pushCart(item,tab,ST.photoB64);closePhotoModal()
}

// 확인 모달
window.openConfirm=function(){
  if(ST.cart.length===0){showFb('🛒','먼저 항목을 담아보세요!');return}
  const c=CFG.currency
  document.getElementById('orderList').innerHTML=ST.cart.map(x=>{
    const tab=x.tab;let cs,cc
    if(tab==='learn'){cs=x.reward>0?'+'+x.reward*x.qty+' '+c.symbol:'무료';cc='green'}
    else if(tab==='fine'){cs='-'+x.cost*x.qty+' '+c.unit;cc='red'}
    else{cs=x.cost*x.qty+' '+c.symbol;cc='purple'}
    return '<div class="order-item"><div class="order-emoji">'+x.icon+'</div><div class="order-info"><div class="order-lbl">'+escHtml(x.label)+'</div><div class="order-qty">× '+x.qty+(x.requirePhoto?' 📸':'')+'</div></div><div class="order-cost '+cc+'">'+cs+'</div></div>'
  }).join('')
  const tc=calcTotal();const tv=document.getElementById('totalVal')
  if(tc===0){tv.textContent='무료 🎉';tv.style.color='var(--green)'}
  else if(tc>0){tv.textContent=tc+' '+c.unit+' 차감';tv.style.color='var(--red)'}
  else{tv.textContent=Math.abs(tc)+' '+c.symbol+' 획득!';tv.style.color='var(--green)'}
  const btn=document.getElementById('confirmOk');btn.disabled=false
  document.getElementById('confirmTxt').textContent='제출하기';btn.querySelector('.spinner')?.remove()
  document.getElementById('confirm-modal').classList.add('open')
}
window.closeConfirm=function(){document.getElementById('confirm-modal').classList.remove('open')}
function calcTotal(){return ST.cart.reduce((a,x)=>{if(x.tab==='learn')return a-(x.reward||0)*x.qty;return a+x.cost*x.qty},0)}

// 제출
window.doSubmit=async function(){
  if(ST.submitting)return;ST.submitting=true
  const btn=document.getElementById('confirmOk');btn.disabled=true
  document.getElementById('confirmTxt').textContent='전송 중...'
  const sp=document.createElement('div');sp.className='spinner';btn.insertBefore(sp,btn.firstChild)
  const ts=new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})
  const hasFine=ST.cart.some(x=>x.tab==='fine');const hasShop=ST.cart.some(x=>x.tab==='shop')
  const category=hasFine?'fine':hasShop?'shop':'learn'
  const tc=calcTotal();ST.sessionBalance+=tc
  ST.sessionOrders.push({items:[...ST.cart],totalCost:tc,ts,category})
  try{
    const res=await fetch('/api/submit',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:ST.student.name,items:ST.cart.map(x=>({icon:x.icon,label:x.label,qty:x.qty,tab:x.tab})),totalCost:tc,currency:CFG.currency.unit,category,photoBase64:ST.cart.find(x=>x.photo)?.photo||null,timestamp:ts})})
    const data=await res.json()
    if(ST.student){ST.student.points-=tc}
    await loadStudents()
    // 업데이트된 학생 정보 반영
    const updStu=STUDENTS.find(x=>x.id===ST.student.id)
    if(updStu) ST.student=updStu
    closeConfirm();renderDone(data.slack,data.notion,ts,tc)
  }catch{closeConfirm();renderDone(false,false,ts,tc)}
  finally{ST.submitting=false}
}

// 완료 화면
function renderDone(slackOk,notionOk,ts,tc){
  const c=CFG.currency
  const hasFine=ST.sessionOrders.at(-1)?.category==='fine'
  const hasShop=ST.sessionOrders.at(-1)?.category==='shop'
  document.getElementById('doneEmoji').textContent=hasFine?'😅':hasShop?'🛍️':'🎉'
  document.getElementById('doneTitle').textContent=hasFine?'기록 완료!':hasShop?'교환 완료! 🎊':'잘했어요! 🌟'
  const newPts=ST.student?ST.student.points:0
  document.getElementById('doneSub').innerHTML='<strong>'+escHtml(ST.student.name)+'</strong>님 기록 완료!<br/>'+(tc<0?'<span style="color:var(--green)">+'+Math.abs(tc)+' '+c.symbol+' 획득! 🎊</span>':tc>0?'<span style="color:var(--red)">-'+tc+' '+c.unit+' 차감</span>':'<span style="color:var(--green)">무료 활동 ✅</span>')
  const totalItems=ST.cart.reduce((a,x)=>a+x.qty,0)
  document.getElementById('sessSum').innerHTML=
    '<div class="ss-title">📊 이번 기록</div>'+
    ssRow('학생',escHtml(ST.student.name))+
    ssRow('항목',totalItems+'개')+
    ssRow('이번 합계',tc===0?'무료':Math.abs(tc)+' '+(tc<0?c.symbol+' 획득':c.unit+' 차감'))+
    ssRow('현재 포인트',newPts+' '+c.symbol)
  document.getElementById('doneChips').innerHTML=mkChip(slackOk,'fab fa-slack','슬랙')+mkChip(notionOk,'fas fa-database','노션')
  document.getElementById('btnContLbl').textContent=escHtml(ST.student.name)+'님으로 계속 담기 🛒'
  if(tc<=0&&!hasFine)launchConfetti()
  goTo('done');autoTimer=setTimeout(()=>goTo('splash'),28000)
}
window.continueOrder=function(){clearTimeout(autoTimer);ST.cart=[];updateCartBar();renderMenu();switchTab('learn');goTo('menu')}
function ssRow(l,v){return '<div class="ss-row"><span class="ss-lbl">'+l+'</span><span class="ss-val">'+v+'</span></div>'}
function mkChip(ok,ic,lb){return '<div class="chip '+(ok?'ok':'fail')+'"><i class="'+ic+'"></i> '+lb+' '+(ok?'✓':'✗')+'</div>'}
function launchConfetti(){
  const arr=['⭐','🌟','✨','💫','🎉','🎊','🏆','🍫','🍬']
  for(let i=0;i<14;i++){
    setTimeout(()=>{
      const el=document.createElement('div');el.className='confetti-p'
      el.textContent=arr[Math.floor(Math.random()*arr.length)]
      el.style.cssText='left:'+Math.random()*100+'%;bottom:10%;font-size:'+(18+Math.random()*16)+'px;animation-duration:'+(1.2+Math.random()*.8)+'s;animation-delay:'+Math.random()*.3+'s;'
      document.body.appendChild(el);setTimeout(()=>el.remove(),2500)
    },i*60)
  }
}
init()
})()
</script>
</body>
</html>`

// ══════════════════════════════════════════════════════════════════════════════
//  관리자 HTML
// ══════════════════════════════════════════════════════════════════════════════
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>관리자 - 바꿈수학</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚙️</text></svg>"/>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800&display=swap" rel="stylesheet"/>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/>
  <style>
    :root{--blue:#29ABE2;--blue-d:#1a90c4;--blue-s:#e8f6fd;--blue-m:#b3dff5;--white:#fff;--g50:#f8fafc;--g100:#f1f5f9;--g200:#e2e8f0;--g400:#94a3b8;--g600:#475569;--g800:#1e293b;--red:#ef4444;--red-s:#fef2f2;--green:#22c55e;--green-s:#f0fdf4;--yellow:#fbbf24;--yellow-s:#fffbeb;--purple:#a855f7;--purple-s:#faf5ff;--orange:#f97316;}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Noto Sans KR',sans-serif;background:var(--g50);color:var(--g800);min-height:100vh;}

    /* 로그인 오버레이 */
    #login-screen{position:fixed;inset:0;z-index:999;background:linear-gradient(160deg,#dff3fc,#f0f9ff);display:flex;align-items:center;justify-content:center;padding:20px;}
    #login-screen.hidden{display:none;}
    .login-box{background:var(--white);border-radius:24px;padding:40px 36px;width:min(400px,96vw);box-shadow:0 20px 60px rgba(41,171,226,.15);text-align:center;}
    .login-logo{height:50px;margin-bottom:20px;}
    .login-title{font-size:22px;font-weight:900;color:var(--g800);margin-bottom:6px;}
    .login-sub{font-size:14px;color:var(--g400);margin-bottom:24px;line-height:1.6;}
    .pw-wrap{position:relative;margin-bottom:14px;}
    .pw-inp{width:100%;background:var(--g50);border:2px solid var(--g200);border-radius:14px;padding:14px 46px 14px 16px;font-family:inherit;font-size:20px;font-weight:700;outline:none;transition:all .2s;text-align:center;letter-spacing:8px;}
    .pw-inp:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(41,171,226,.1);}
    .pw-eye{position:absolute;right:14px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--g400);font-size:16px;}
    .btn-login{width:100%;background:linear-gradient(135deg,var(--blue),var(--blue-d));color:white;border:none;border-radius:14px;font-family:inherit;font-size:16px;font-weight:800;padding:15px;cursor:pointer;transition:all .2s;box-shadow:0 4px 16px rgba(41,171,226,.35);}
    .btn-login:hover{transform:translateY(-1px);}
    .login-err{font-size:13px;color:var(--red);margin-top:10px;display:none;background:var(--red-s);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:8px 14px;}
    .login-err.show{display:block;}
    .login-hint{font-size:12px;color:var(--g400);margin-top:12px;}

    /* 메인 */
    #main-screen.hidden{display:none;}
    .hdr{background:var(--white);border-bottom:1.5px solid var(--g200);padding:0 clamp(14px,3vw,32px);height:64px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;box-shadow:0 1px 6px rgba(0,0,0,.05);}
    .hdr-l{display:flex;align-items:center;gap:12px;}
    .hdr-l img{height:34px;width:auto;}
    .hdr-ttl{font-size:15px;font-weight:800;color:var(--blue);}
    .hdr-r{display:flex;gap:8px;align-items:center;}
    .btn-kiosk{display:flex;align-items:center;gap:5px;background:var(--blue);color:white;text-decoration:none;font-size:13px;font-weight:700;padding:7px 14px;border-radius:100px;transition:all .2s;}
    .btn-kiosk:hover{background:var(--blue-d);}
    .btn-logout{display:flex;align-items:center;gap:5px;background:var(--g100);color:var(--g600);border:1.5px solid var(--g200);font-family:inherit;font-size:13px;font-weight:700;padding:7px 14px;border-radius:100px;cursor:pointer;transition:all .2s;}
    .btn-logout:hover{background:var(--red-s);color:var(--red);}

    /* 탭 네비 */
    .nav-tabs{display:flex;gap:0;border-bottom:2px solid var(--g200);background:var(--white);padding:0 clamp(14px,3vw,32px);overflow-x:auto;}
    .nav-tabs::-webkit-scrollbar{display:none;}
    .nav-tab{display:flex;align-items:center;gap:6px;font-family:inherit;font-size:14px;font-weight:700;color:var(--g400);padding:14px 20px;border:none;background:none;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px;transition:all .2s;white-space:nowrap;}
    .nav-tab.active{color:var(--blue);border-bottom-color:var(--blue);}
    .nav-tab:hover{color:var(--blue);}

    /* 공통 */
    .wrap{max-width:1000px;margin:0 auto;padding:clamp(16px,3vw,32px) clamp(14px,3vw,28px);display:flex;flex-direction:column;gap:20px;}
    .tab-panel{display:none;}.tab-panel.active{display:flex;flex-direction:column;gap:20px;}
    .card{background:var(--white);border:1.5px solid var(--g200);border-radius:20px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.04);}
    .card-hd{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid var(--g200);background:var(--g50);}
    .card-ttl{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:800;}
    .card-ic{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:14px;}
    .ic-blue{background:var(--blue-s);color:var(--blue);}.ic-green{background:var(--green-s);color:var(--green);}.ic-red{background:var(--red-s);color:var(--red);}.ic-purple{background:var(--purple-s);color:var(--purple);}.ic-yellow{background:var(--yellow-s);color:var(--yellow);}
    .card-bd{padding:18px 22px;}
    .inp{width:100%;background:var(--g50);border:1.5px solid var(--g200);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:14px;outline:none;transition:all .2s;color:var(--g800);}
    .inp:focus{border-color:var(--blue);}
    .lbl{display:block;font-size:12px;font-weight:700;color:var(--g400);margin-bottom:5px;}
    .add-row{display:flex;gap:8px;}
    .add-inp{flex:1;background:var(--g50);border:1.5px solid var(--g200);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:14px;outline:none;color:var(--g800);}
    .add-inp:focus{border-color:var(--blue);}
    .btn-add{background:var(--blue);color:white;border:none;border-radius:10px;font-family:inherit;font-size:13px;font-weight:700;padding:9px 15px;cursor:pointer;white-space:nowrap;transition:all .2s;}
    .btn-add:hover{background:var(--blue-d);}
    .btn-add.red{background:var(--red);}.btn-add.red:hover{background:#dc2626;}
    .btn-add.green{background:var(--green);}.btn-add.green:hover{background:#16a34a;}
    .btn-add.purple{background:var(--purple);}.btn-add.purple:hover{background:#9333ea;}
    .btn-del{width:28px;height:28px;border-radius:8px;background:var(--red-s);border:1px solid rgba(239,68,68,.2);color:var(--red);cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;font-size:11px;}
    .btn-del:hover{background:var(--red);color:white;}

    /* 학생 카드 */
    .stu-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;}
    .stu-card{background:var(--white);border:1.5px solid var(--g200);border-radius:18px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.05);transition:all .2s;}
    .stu-card:hover{border-color:var(--blue-m);box-shadow:0 6px 20px rgba(41,171,226,.12);}
    /* 카드 상단: 사진 + 이름 + 포인트 */
    .stu-card-top{display:flex;align-items:center;gap:14px;padding:16px 18px;background:linear-gradient(135deg,var(--blue-s),#f0f9ff);border-bottom:1px solid var(--g200);}
    .sc-photo-wrap{position:relative;flex-shrink:0;}
    .sc-photo{width:58px;height:58px;border-radius:50%;object-fit:cover;border:3px solid var(--blue-m);display:block;}
    .sc-av{width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,var(--blue-s),var(--blue-m));border:3px solid var(--blue-m);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:900;color:var(--blue-d);}
    .sc-photo-edit{position:absolute;bottom:-2px;right:-2px;width:22px;height:22px;background:var(--blue);color:white;border:2px solid white;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:10px;transition:all .2s;}
    .sc-photo-edit:hover{background:var(--blue-d);}
    .sc-photo-input{display:none;}
    .sc-info{flex:1;min-width:0;}
    .sc-name{font-size:18px;font-weight:800;margin-bottom:3px;}
    .sc-pts{font-size:14px;font-weight:700;color:var(--yellow-d);}
    .sc-fine-txt{font-size:12px;color:var(--red);margin-top:2px;}
    .sc-top-r{display:flex;flex-direction:column;align-items:flex-end;gap:6px;}
    /* 카드 본문: 포인트 조정 + 이력 */
    .sc-body{padding:14px 18px;display:flex;flex-direction:column;gap:10px;}
    .sc-sec-lbl{font-size:11px;font-weight:800;color:var(--g400);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
    .sc-row{display:flex;gap:6px;align-items:center;}
    .sc-adj-inp{background:var(--g50);border:1.5px solid var(--g200);border-radius:8px;padding:7px 10px;font-family:inherit;font-size:13px;outline:none;text-align:center;width:80px;flex-shrink:0;}
    .sc-adj-inp:focus{border-color:var(--blue);}
    .sc-rsn-inp{flex:1;background:var(--g50);border:1.5px solid var(--g200);border-radius:8px;padding:7px 10px;font-family:inherit;font-size:13px;outline:none;color:var(--g800);}
    .sc-rsn-inp:focus{border-color:var(--blue);}
    .btn-sm{font-family:inherit;font-size:12px;font-weight:700;padding:7px 14px;border-radius:8px;cursor:pointer;border:none;transition:all .2s;white-space:nowrap;}
    .btn-sm.blue{background:var(--blue-s);color:var(--blue-d);}.btn-sm.blue:hover{background:var(--blue);color:white;}
    .btn-sm.red{background:var(--red-s);color:var(--red);}.btn-sm.red:hover{background:var(--red);color:white;}
    .btn-sm.green{background:var(--green-s);color:var(--green);}.btn-sm.green:hover{background:var(--green);color:white;}
    .btn-sm.gray{background:var(--g100);color:var(--g600);}.btn-sm.gray:hover{background:var(--g200);}
    .btn-row{display:flex;gap:6px;flex-wrap:wrap;}

    /* 포인트 프리셋 버튼 */
    .preset-pts{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px;}
    .ppt-btn{font-family:inherit;font-size:12px;font-weight:700;padding:5px 10px;border-radius:6px;cursor:pointer;border:1.5px solid;transition:all .2s;}
    .ppt-btn.add{background:var(--green-s);color:var(--green);border-color:rgba(34,197,94,.3);}.ppt-btn.add:hover{background:var(--green);color:white;}
    .ppt-btn.sub{background:var(--red-s);color:var(--red);border-color:rgba(239,68,68,.3);}.ppt-btn.sub:hover{background:var(--red);color:white;}

    /* 벌금 목록 */
    .fine-list{display:flex;flex-direction:column;gap:8px;}
    .fine-item{display:flex;align-items:center;gap:10px;background:var(--g50);border:1px solid var(--g200);border-radius:12px;padding:10px 14px;transition:all .2s;}
    .fine-item.paid{opacity:.5;}
    .fine-stu{font-size:13px;font-weight:800;color:var(--g800);min-width:60px;}
    .fine-lbl{flex:1;font-size:13px;font-weight:600;}
    .fine-date{font-size:11px;color:var(--g400);white-space:nowrap;}
    .fine-badge{font-size:10px;font-weight:800;padding:2px 8px;border-radius:100px;}
    .fine-badge.unpaid{background:var(--red-s);color:var(--red);}
    .fine-badge.paid{background:var(--green-s);color:var(--green);}

    /* 메뉴 항목 설정 */
    .mi{display:grid;align-items:center;gap:7px;background:var(--g50);border:1px solid var(--g200);border-radius:12px;padding:9px 12px;margin-bottom:7px;}
    .mi-inp{background:var(--white);border:1.5px solid var(--g200);border-radius:8px;padding:7px 8px;font-family:inherit;font-size:13px;outline:none;width:100%;color:var(--g800);}
    .mi-inp:focus{border-color:var(--blue);}
    .cost-hint{font-size:10px;color:var(--g400);text-align:center;margin-top:2px;}
    .photo-chk{display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;cursor:pointer;color:var(--orange);}
    .photo-chk input{accent-color:var(--orange);}

    /* 화폐 프리셋 */
    .preset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:14px;}
    .preset-btn{background:var(--g50);border:2px solid var(--g200);border-radius:12px;padding:10px 8px;cursor:pointer;text-align:center;transition:all .2s;font-size:13px;font-weight:700;}
    .preset-btn:hover{border-color:var(--blue);background:var(--blue-s);}
    .preset-btn.sel{border-color:var(--blue);background:var(--blue-s);color:var(--blue);}
    .preset-emoji{font-size:22px;display:block;margin-bottom:3px;}
    .cur-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;}
    .span2{grid-column:1/-1;}

    /* 저장 바 */
    .save-bar{background:var(--white);border:1.5px solid var(--g200);border-radius:20px;padding:16px 22px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;}
    .save-hint{font-size:12px;color:var(--g400);}
    .save-btns{display:flex;gap:8px;}
    .btn-reset{background:var(--g100);color:var(--g600);border:1.5px solid var(--g200);border-radius:10px;font-family:inherit;font-size:13px;font-weight:600;padding:9px 15px;cursor:pointer;}
    .btn-save{background:linear-gradient(135deg,var(--blue),var(--blue-d));color:white;border:none;border-radius:10px;font-family:inherit;font-size:14px;font-weight:800;padding:11px 26px;cursor:pointer;display:flex;align-items:center;gap:6px;box-shadow:0 4px 14px rgba(41,171,226,.28);}

    /* 포인트 이력 */
    .hist-list{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto;}
    .hist-item{display:flex;align-items:center;gap:10px;background:var(--g50);border:1px solid var(--g200);border-radius:10px;padding:8px 12px;}
    .hist-delta{font-size:14px;font-weight:900;min-width:50px;text-align:right;}
    .hist-delta.pos{color:var(--green);}
    .hist-delta.neg{color:var(--red);}
    .hist-info{flex:1;}
    .hist-reason{font-size:13px;font-weight:600;}
    .hist-date{font-size:11px;color:var(--g400);}

    /* 모달 오버레이 */
    .modal-ov{position:fixed;inset:0;z-index:500;background:rgba(15,23,42,.5);display:none;align-items:center;justify-content:center;padding:16px;}
    .modal-ov.open{display:flex;}
    .modal-box{background:var(--white);border-radius:20px;padding:28px 24px;width:min(480px,96vw);max-height:85vh;display:flex;flex-direction:column;gap:14px;box-shadow:0 24px 80px rgba(0,0,0,.2);animation:mpop .35s cubic-bezier(.34,1.4,.64,1);}
    @keyframes mpop{from{opacity:0;transform:scale(.85);}to{opacity:1;transform:scale(1);}}
    .modal-ttl{font-size:18px;font-weight:900;display:flex;align-items:center;justify-content:space-between;}
    .modal-close{background:none;border:none;font-size:20px;cursor:pointer;color:var(--g400);line-height:1;}
    .modal-close:hover{color:var(--red);}
    .modal-scroll{overflow-y:auto;flex:1;}

    .toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) scale(.9);background:var(--g800);color:white;font-size:13px;font-weight:600;padding:10px 22px;border-radius:100px;box-shadow:0 8px 28px rgba(0,0,0,.16);z-index:9999;opacity:0;transition:all .3s;white-space:nowrap;}
    .toast.show{opacity:1;transform:translateX(-50%) scale(1);}
    .spinner-sm{width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:white;border-radius:50%;animation:spin .6s linear infinite;display:inline-block;}
    @keyframes spin{to{transform:rotate(360deg);}}
    @media(max-width:600px){.stu-cards{grid-template-columns:1fr;}}
  </style>
</head>
<body>

<!-- 로그인 -->
<div id="login-screen">
  <div class="login-box">
    <img class="login-logo" src="/static/logo_horizontal.png" alt="바꿈수학"/>
    <div class="login-title">🔒 관리자 전용</div>
    <div class="login-sub">
      이 페이지는 <strong>선생님 전용</strong>입니다<br/>
      학생들은 이 페이지에 접근할 수 없어요
    </div>
    <div class="pw-wrap">
      <input class="pw-inp" id="pwInp" type="password" placeholder="••••" maxlength="20"
             onkeydown="if(event.key==='Enter')doLogin()"/>
      <span class="pw-eye" onclick="togglePw()"><i class="fas fa-eye" id="eyeIc"></i></span>
    </div>
    <button class="btn-login" onclick="doLogin()"><i class="fas fa-unlock" style="margin-right:6px"></i>관리자 입장</button>
    <div class="login-err" id="loginErr">🙈 비밀번호가 틀렸어요. 다시 입력해주세요.</div>
    <div class="login-hint">기본 비밀번호: 1234</div>
  </div>
</div>

<!-- 메인 -->
<div id="main-screen" class="hidden">
  <header class="hdr">
    <div class="hdr-l">
      <img src="/static/logo_horizontal.png" alt="바꿈수학"/>
      <div class="hdr-ttl">⚙️ 관리자</div>
    </div>
    <div class="hdr-r">
      <a href="/" class="btn-kiosk"><i class="fas fa-display"></i> 키오스크</a>
      <button class="btn-logout" onclick="doLogout()"><i class="fas fa-sign-out-alt"></i> 로그아웃</button>
    </div>
  </header>

  <nav class="nav-tabs">
    <button class="nav-tab active" onclick="showTab('students')" id="ntab-students"><i class="fas fa-users"></i> 학생 관리</button>
    <button class="nav-tab" onclick="showTab('fines')" id="ntab-fines"><i class="fas fa-triangle-exclamation"></i> 벌금 관리</button>
    <button class="nav-tab" onclick="showTab('menu')" id="ntab-menu"><i class="fas fa-list"></i> 메뉴 설정</button>
    <button class="nav-tab" onclick="showTab('currency')" id="ntab-currency"><i class="fas fa-coins"></i> 화폐 설정</button>
  </nav>

  <div class="wrap">
    <!-- ① 학생 관리 탭 -->
    <div class="tab-panel active" id="tab-students">
      <div class="card">
        <div class="card-hd">
          <div class="card-ttl"><div class="card-ic ic-blue"><i class="fas fa-users"></i></div>학생 목록 &amp; 포인트 관리</div>
          <span style="font-size:12px;color:var(--g400)" id="stuCnt"></span>
        </div>
        <div class="card-bd">
          <div class="stu-cards" id="stuCards"></div>
          <div class="add-row" style="margin-top:16px;">
            <input class="add-inp" id="newStuInp" placeholder="새 학생 이름 입력..." maxlength="10" onkeydown="if(event.key==='Enter')addStudent()"/>
            <button class="btn-add" onclick="addStudent()"><i class="fas fa-user-plus" style="margin-right:4px"></i>학생 추가</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ② 벌금 관리 탭 -->
    <div class="tab-panel" id="tab-fines">
      <div class="card">
        <div class="card-hd">
          <div class="card-ttl"><div class="card-ic ic-red"><i class="fas fa-triangle-exclamation"></i></div>벌금 내역</div>
          <div style="display:flex;gap:6px;">
            <button class="btn-sm blue" onclick="loadFines('all')">전체</button>
            <button class="btn-sm red" onclick="loadFines('unpaid')">미납</button>
            <button class="btn-sm green" onclick="loadFines('paid')">완납</button>
          </div>
        </div>
        <div class="card-bd">
          <div class="fine-list" id="fineList"></div>
        </div>
      </div>
    </div>

    <!-- ③ 메뉴 설정 탭 -->
    <div class="tab-panel" id="tab-menu">
      <div class="card">
        <div class="card-hd">
          <div class="card-ttl"><div class="card-ic ic-green"><i class="fas fa-check-circle"></i></div>학습 활동</div>
          <span style="font-size:11px;color:var(--g400)">보상 = 획득 포인트</span>
        </div>
        <div class="card-bd">
          <div id="learnItems"></div>
          <div class="add-row" style="gap:6px;flex-wrap:wrap;margin-top:8px;">
            <input class="add-inp" id="nLIc" placeholder="📖" maxlength="4" style="width:60px;flex:none;text-align:center;"/>
            <input class="add-inp" id="nLLbl" placeholder="항목 이름" maxlength="20" style="flex:2;"/>
            <input class="add-inp" id="nLRew" type="number" placeholder="보상P" min="0" style="width:80px;flex:none;text-align:center;"/>
            <label class="photo-chk"><input type="checkbox" id="nLPhoto"/> 📸</label>
            <button class="btn-add" onclick="addItem('learn')"><i class="fas fa-plus"></i></button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-hd">
          <div class="card-ttl"><div class="card-ic ic-red"><i class="fas fa-triangle-exclamation"></i></div>벌금 항목</div>
        </div>
        <div class="card-bd">
          <div id="fineItems"></div>
          <div class="add-row" style="gap:6px;flex-wrap:wrap;margin-top:8px;">
            <input class="add-inp" id="nFIc" placeholder="🔔" maxlength="4" style="width:60px;flex:none;text-align:center;"/>
            <input class="add-inp" id="nFLbl" placeholder="항목 이름" maxlength="20" style="flex:2;"/>
            <input class="add-inp" id="nFCost" type="number" placeholder="차감P" min="0" style="width:80px;flex:none;text-align:center;"/>
            <button class="btn-add red" onclick="addItem('fine')"><i class="fas fa-plus"></i></button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-hd">
          <div class="card-ttl"><div class="card-ic ic-purple"><i class="fas fa-store"></i></div>🛍️ 보상 상점</div>
        </div>
        <div class="card-bd">
          <div id="shopItems"></div>
          <div class="add-row" style="gap:6px;flex-wrap:wrap;margin-top:8px;">
            <input class="add-inp" id="nSIc" placeholder="🎁" maxlength="4" style="width:60px;flex:none;text-align:center;"/>
            <input class="add-inp" id="nSLbl" placeholder="항목 이름" maxlength="20" style="flex:2;"/>
            <input class="add-inp" id="nSCost" type="number" placeholder="비용P" min="0" style="width:80px;flex:none;text-align:center;"/>
            <button class="btn-add purple" onclick="addItem('shop')"><i class="fas fa-plus"></i></button>
          </div>
        </div>
      </div>
      <div class="save-bar">
        <div class="save-hint">💾 변경사항은 저장 버튼을 눌러야 키오스크에 반영됩니다</div>
        <div class="save-btns">
          <button class="btn-reset" onclick="resetMenu()"><i class="fas fa-rotate-left" style="margin-right:4px"></i>기본값</button>
          <button class="btn-save" onclick="saveMenu()"><i class="fas fa-floppy-disk"></i>저장</button>
        </div>
      </div>
    </div>

    <!-- ④ 화폐 설정 탭 -->
    <div class="tab-panel" id="tab-currency">
      <div class="card">
        <div class="card-hd"><div class="card-ttl"><div class="card-ic ic-yellow"><i class="fas fa-coins"></i></div>화폐 / 보상 단위 설정</div></div>
        <div class="card-bd">
          <div class="preset-grid" id="presets"></div>
          <div class="cur-row">
            <div><label class="lbl">단위 이름</label><input class="inp" id="curUnit" placeholder="포인트" maxlength="10" oninput="updateCurPreview()"/></div>
            <div><label class="lbl">기호 이모지</label><input class="inp" id="curSymbol" placeholder="🏅" maxlength="4" oninput="updateCurPreview()"/></div>
            <div class="span2"><label class="lbl">스플래시 문구</label><input class="inp" id="curDesc" placeholder="포인트를 모아서 간식이랑 교환해요!" maxlength="50"/></div>
          </div>
          <div style="background:linear-gradient(135deg,var(--blue),var(--blue-d));color:white;border-radius:14px;padding:14px 18px;margin-top:14px;display:flex;align-items:center;gap:12px;">
            <div style="font-size:32px" id="pvSym">🏅</div>
            <div><div style="font-size:15px;font-weight:900" id="pvTitle">포인트 (🏅)</div><div style="font-size:12px;opacity:.8" id="pvSub">포인트를 모아서 간식이랑 교환해요!</div></div>
          </div>
        </div>
      </div>
      <div class="save-bar">
        <div class="save-hint">💾 저장 후 키오스크에 즉시 반영됩니다</div>
        <div class="save-btns">
          <button class="btn-save" onclick="saveCurrency()"><i class="fas fa-floppy-disk"></i>저장</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- 포인트 이력 모달 -->
<div class="modal-ov" id="hist-modal">
  <div class="modal-box">
    <div class="modal-ttl"><span id="histTitle">포인트 이력</span><button class="modal-close" onclick="closeHistModal()">✕</button></div>
    <div class="modal-scroll"><div class="hist-list" id="histList"></div></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(function(){
const PRESETS=[
  {unit:'포인트',symbol:'🏅',desc:'포인트를 모아서 간식이랑 교환해요!'},
  {unit:'별',symbol:'⭐',desc:'열심히 공부하면 별을 받아요!'},
  {unit:'코인',symbol:'🪙',desc:'코인을 모아서 보상을 받아요!'},
  {unit:'학습지',symbol:'📄',desc:'학습지로 교환할 수 있어요!'},
  {unit:'시간',symbol:'⏰',desc:'자유시간을 획득해요!'},
  {unit:'하트',symbol:'❤️',desc:'하트를 모아봐요!'},
  {unit:'스티커',symbol:'🌟',desc:'스티커를 모아봐요!'},
  {unit:'도장',symbol:'🔖',desc:'도장을 모아요!'},
]
const DEFAULT_MENU={
  learn:[
    {id:'study',icon:'📖',label:'자습 인증하기',cost:0,reward:2,requirePhoto:true},
    {id:'homework',icon:'✏️',label:'숙제 제출하기',cost:0,reward:1,requirePhoto:false},
    {id:'question',icon:'🙋',label:'질문하기',cost:0,reward:1,requirePhoto:false},
    {id:'record',icon:'📝',label:'모르는 문제 기록하기',cost:0,reward:2,requirePhoto:true},
    {id:'material',icon:'📄',label:'추가 학습지 요청',cost:0,reward:0,requirePhoto:false},
    {id:'makeup',icon:'📅',label:'보강 신청',cost:0,reward:0,requirePhoto:false},
    {id:'consult',icon:'💬',label:'상담 요청',cost:0,reward:0,requirePhoto:false},
  ],
  fine:[
    {id:'helpme',icon:'🆘',label:'지현쌤 Help me!',cost:3,reward:0,requirePhoto:false},
    {id:'lostwork',icon:'😰',label:'숙제 분실',cost:4,reward:0,requirePhoto:false},
    {id:'nohomework',icon:'🚫',label:'숙제 안함',cost:5,reward:0,requirePhoto:false},
  ],
  shop:[
    {id:'choco',icon:'🍫',label:'초콜릿(달달구리)',cost:3,reward:0,requirePhoto:false},
    {id:'jelly',icon:'🍬',label:'젤리',cost:2,reward:0,requirePhoto:false},
    {id:'candy',icon:'🍭',label:'사탕',cost:2,reward:0,requirePhoto:false},
    {id:'snack',icon:'🍿',label:'과자',cost:3,reward:0,requirePhoto:false},
    {id:'saekkomdal',icon:'🍋',label:'새콤달콤',cost:2,reward:0,requirePhoto:false},
    {id:'vitaminc',icon:'💊',label:'비타민C',cost:2,reward:0,requirePhoto:false},
  ],
}

let PW_TOKEN=''
let menuCfg=JSON.parse(JSON.stringify(DEFAULT_MENU))
let curCfg={unit:'포인트',symbol:'🏅',desc:'포인트를 모아서 간식이랑 교환해요!'}
let students=[]
let allFines=[]

/* ── 로그인 ── */
window.togglePw=function(){
  const inp=document.getElementById('pwInp');const ic=document.getElementById('eyeIc')
  if(inp.type==='password'){inp.type='text';ic.className='fas fa-eye-slash'}
  else{inp.type='password';ic.className='fas fa-eye'}
}
window.doLogin=async function(){
  const pw=document.getElementById('pwInp').value.trim()
  if(!pw){document.getElementById('loginErr').classList.add('show');return}
  // 서버에 인증 요청
  const r=await fetch('/api/admin/students',{headers:{'X-Admin-Password':pw}})
  if(r.ok||r.status!==401){
    PW_TOKEN=pw
    document.getElementById('login-screen').classList.add('hidden')
    document.getElementById('main-screen').classList.remove('hidden')
    document.getElementById('loginErr').classList.remove('show')
    loadAll()
  } else {
    document.getElementById('loginErr').classList.add('show')
    document.getElementById('pwInp').value=''
    document.getElementById('pwInp').focus()
  }
}
window.doLogout=function(){
  PW_TOKEN=''
  document.getElementById('main-screen').classList.add('hidden')
  document.getElementById('login-screen').classList.remove('hidden')
  document.getElementById('pwInp').value=''
}
function authHdr(){return{'X-Admin-Password':PW_TOKEN,'Content-Type':'application/json'}}

/* ── 탭 ── */
window.showTab=function(id){
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'))
  document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('active'))
  document.getElementById('tab-'+id).classList.add('active')
  document.getElementById('ntab-'+id).classList.add('active')
  if(id==='fines') loadFines('all')
}

/* ── 전체 로드 ── */
async function loadAll(){
  await loadStudentData()
  loadMenuCfg()
  loadCurrencyCfg()
  renderPresets()
  renderCurInputs()
}

async function loadStudentData(){
  const r=await fetch('/api/students');const d=await r.json()
  if(d.success){students=d.students;renderStudentCards()}
  document.getElementById('stuCnt').textContent=students.length+'명'
}

/* ── 학생 카드 ── */
function renderStudentCards(){
  const g=document.getElementById('stuCards')
  g.innerHTML=students.map(s=>{
    const photoEl=s.photo_url
      ?'<img class="sc-photo" src="'+escH(s.photo_url)+'" alt="'+escH(s.name)+'"/>'
      :'<div class="sc-av">'+escH(s.name[0])+'</div>'
    const fineHtml=s.fine_count>0
      ?'<div class="sc-fine-txt">⚠️ 미납 '+s.fine_count+'건</div>':''
    return '<div class="stu-card" id="scard-'+s.id+'">'+
      '<div class="stu-card-top">'+
        '<div class="sc-photo-wrap">'+
          photoEl+
          '<label class="sc-photo-edit" title="사진 변경"><i class="fas fa-camera"></i>'+
            '<input class="sc-photo-input" type="file" accept="image/*" onchange="uploadPhoto(event,'+s.id+')"/>'+
          '</label>'+
        '</div>'+
        '<div class="sc-info">'+
          '<div class="sc-name">'+escH(s.name)+'</div>'+
          '<div class="sc-pts" id="pts-'+s.id+'">🏅 '+s.points+' 포인트</div>'+
          fineHtml+
        '</div>'+
        '<div class="sc-top-r">'+
          '<button class="btn-del" onclick="delStudent('+s.id+',\''+escH(s.name)+'\')" title="학생 삭제"><i class="fas fa-trash-can"></i></button>'+
        '</div>'+
      '</div>'+
      '<div class="sc-body">'+
        // 빠른 포인트 조정
        '<div>'+
          '<div class="sc-sec-lbl">⚡ 빠른 포인트 조정</div>'+
          '<div class="preset-pts">'+
            '<button class="ppt-btn add" onclick="quickPt('+s.id+',1)">+1</button>'+
            '<button class="ppt-btn add" onclick="quickPt('+s.id+',2)">+2</button>'+
            '<button class="ppt-btn add" onclick="quickPt('+s.id+',5)">+5</button>'+
            '<button class="ppt-btn add" onclick="quickPt('+s.id+',10)">+10</button>'+
            '<button class="ppt-btn sub" onclick="quickPt('+s.id+',-1)">-1</button>'+
            '<button class="ppt-btn sub" onclick="quickPt('+s.id+',-2)">-2</button>'+
            '<button class="ppt-btn sub" onclick="quickPt('+s.id+',-5)">-5</button>'+
          '</div>'+
        '</div>'+
        // 직접 입력 조정
        '<div>'+
          '<div class="sc-sec-lbl">✏️ 직접 입력</div>'+
          '<div class="sc-row">'+
            '<input class="sc-adj-inp" id="adj-'+s.id+'" type="number" placeholder="±숫자"/>'+
            '<input class="sc-rsn-inp" id="adjr-'+s.id+'" placeholder="사유 (선택)"/>'+
          '</div>'+
          '<div class="btn-row" style="margin-top:5px;">'+
            '<button class="btn-sm green" style="flex:1" onclick="adjustPoints('+s.id+',1)"><i class="fas fa-plus"></i> 포인트 추가</button>'+
            '<button class="btn-sm red" style="flex:1" onclick="adjustPoints('+s.id+',-1)"><i class="fas fa-minus"></i> 포인트 차감</button>'+
          '</div>'+
        '</div>'+
        // 이력 보기
        '<button class="btn-sm gray" style="width:100%" onclick="showHistory('+s.id+',\''+escH(s.name)+'\')"><i class="fas fa-history" style="margin-right:4px"></i>포인트 이력 보기</button>'+
      '</div>'+
    '</div>'
  }).join('')
}

function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

/* ── 학생 추가/삭제 ── */
window.addStudent=async function(){
  const inp=document.getElementById('newStuInp');const name=inp.value.trim()
  if(!name){toast('이름을 입력하세요');return}
  const r=await fetch('/api/admin/students',{method:'POST',headers:authHdr(),body:JSON.stringify({name})})
  const d=await r.json()
  if(d.success){inp.value='';await loadStudentData();toast('✅ 학생 추가: '+name)}
  else toast('오류: '+d.error)
}
window.delStudent=async function(id,name){
  if(!confirm(name+' 학생을 삭제할까요?\n(포인트 이력도 모두 삭제됩니다)'))return
  await fetch('/api/admin/students/'+id,{method:'DELETE',headers:authHdr()})
  await loadStudentData();toast('🗑️ 삭제됨: '+name)
}

/* ── 사진 업로드 ── */
window.uploadPhoto=async function(e,id){
  const file=e.target.files[0];if(!file)return
  // 이미지 리사이즈 (최대 400px)
  const img=new Image()
  const url=URL.createObjectURL(file)
  img.onload=async function(){
    const MAX=400;let w=img.width,h=img.height
    if(w>MAX||h>MAX){const r=MAX/Math.max(w,h);w=Math.round(w*r);h=Math.round(h*r)}
    const cv=document.createElement('canvas');cv.width=w;cv.height=h
    cv.getContext('2d').drawImage(img,0,0,w,h)
    const b64=cv.toDataURL('image/jpeg',0.85)
    URL.revokeObjectURL(url)
    const r=await fetch('/api/admin/students/'+id+'/photo',{method:'POST',headers:authHdr(),body:JSON.stringify({photoBase64:b64})})
    if((await r.json()).success){await loadStudentData();toast('📸 사진 등록 완료!')}
  };img.src=url
}

/* ── 포인트 빠른 조정 ── */
window.quickPt=async function(id,delta){
  const r=await fetch('/api/admin/students/'+id+'/points',{method:'POST',headers:authHdr(),body:JSON.stringify({delta,reason:'관리자 빠른 조정'})})
  if((await r.json()).success){
    await loadStudentData()
    toast((delta>0?'+'  :'')+delta+' 포인트 조정 완료')
  }
}

/* ── 포인트 직접 입력 조정 ── */
window.adjustPoints=async function(id,sign){
  const adjInp=document.getElementById('adj-'+id);const rsnInp=document.getElementById('adjr-'+id)
  const val=parseInt(adjInp.value)||0
  if(val===0){toast('조정할 포인트 값을 입력하세요');return}
  const delta=Math.abs(val)*sign
  const reason=rsnInp.value.trim()||'관리자 조정'
  const r=await fetch('/api/admin/students/'+id+'/points',{method:'POST',headers:authHdr(),body:JSON.stringify({delta,reason})})
  if((await r.json()).success){
    adjInp.value='';rsnInp.value=''
    await loadStudentData()
    toast((delta>0?'+':'')+delta+' 포인트 조정 완료')
  }
}

/* ── 포인트 이력 모달 ── */
window.showHistory=async function(id,name){
  document.getElementById('histTitle').textContent='📊 '+name+' 포인트 이력'
  document.getElementById('histList').innerHTML='<div style="text-align:center;padding:20px;color:var(--g400)">불러오는 중...</div>'
  document.getElementById('hist-modal').classList.add('open')
  const r=await fetch('/api/students/'+id);const d=await r.json()
  if(!d.success){document.getElementById('histList').innerHTML='<div style="text-align:center;padding:20px;color:var(--red)">오류 발생</div>';return}
  const hist=d.history
  if(hist.length===0){document.getElementById('histList').innerHTML='<div style="text-align:center;padding:20px;color:var(--g400)">이력이 없어요 🌱</div>';return}
  document.getElementById('histList').innerHTML=hist.map(h=>{
    const pos=h.delta>0
    const cat={learn:'학습',fine:'벌금',shop:'보상',admin:'관리자'}[h.category]||h.category
    return '<div class="hist-item">'+
      '<div class="hist-delta '+(pos?'pos':'neg')+'">'+(pos?'+':'')+h.delta+'</div>'+
      '<div class="hist-info">'+
        '<div class="hist-reason">'+escH(h.reason)+'</div>'+
        '<div class="hist-date">'+cat+' · '+new Date(h.created_at).toLocaleString('ko-KR')+'</div>'+
      '</div>'+
    '</div>'
  }).join('')
}
window.closeHistModal=function(){document.getElementById('hist-modal').classList.remove('open')}

/* ── 벌금 목록 ── */
window.loadFines=async function(filter){
  const r=await fetch('/api/students');const d=await r.json()
  if(!d.success)return
  allFines=[]
  for(const s of d.students){
    if(s.fine_count>0||filter==='paid'||filter==='all'){
      const sr=await fetch('/api/students/'+s.id);const sd=await sr.json()
      if(sd.success){sd.fines.forEach(f=>{allFines.push({...f,studentName:s.name})})}
    }
  }
  // filter=all 면 위 루프에서 fine_count>0만 가져왔으므로, all이면 전체 재로드
  if(filter==='all'){
    allFines=[]
    for(const s of d.students){
      const sr=await fetch('/api/students/'+s.id);const sd=await sr.json()
      if(sd.success){sd.fines.forEach(f=>{allFines.push({...f,studentName:s.name})})}
    }
  }
  let filtered=allFines
  if(filter==='unpaid') filtered=allFines.filter(f=>!f.paid&&f.paid!==1)
  if(filter==='paid') filtered=allFines.filter(f=>f.paid===1||f.paid===true)
  renderFines(filtered)
}

function renderFines(fines){
  const el=document.getElementById('fineList')
  if(fines.length===0){el.innerHTML='<div style="text-align:center;color:var(--g400);padding:30px;font-size:14px;">벌금 내역이 없어요 🎉</div>';return}
  el.innerHTML=fines.map(f=>{
    const paid=f.paid===1||f.paid===true
    return '<div class="fine-item'+(paid?' paid':'')+'">'+
      '<div class="fine-stu">'+escH(f.studentName)+'</div>'+
      '<div class="fine-lbl">'+escH(f.label)+'</div>'+
      '<div class="fine-date">'+new Date(f.created_at).toLocaleDateString('ko-KR')+'</div>'+
      '<div class="fine-badge '+(paid?'paid':'unpaid')+'">'+(paid?'완납':'미납')+'</div>'+
      (!paid?'<button class="btn-sm green" onclick="payFine('+f.id+')">납부</button>':'')+
      '<button class="btn-sm red" onclick="delFine('+f.id+')"><i class="fas fa-trash-can"></i></button>'+
    '</div>'
  }).join('')
}
window.payFine=async function(id){
  await fetch('/api/admin/fines/'+id+'/pay',{method:'POST',headers:authHdr()})
  loadFines('all');toast('✅ 벌금 납부 처리 완료')
}
window.delFine=async function(id){
  if(!confirm('이 벌금 항목을 삭제할까요?'))return
  await fetch('/api/admin/fines/'+id,{method:'DELETE',headers:authHdr()})
  loadFines('all');toast('🗑️ 삭제 완료')
}

/* ── 메뉴 설정 ── */
function loadMenuCfg(){
  const sv=localStorage.getItem('kiosk_cfg_ver');const lc=localStorage.getItem('kiosk_config')
  if(lc&&sv==='2025-v3'){try{const p=JSON.parse(lc);if(p.menu)menuCfg=p.menu}catch{}}
  renderMenuItems('learn');renderMenuItems('fine');renderMenuItems('shop')
}
function renderMenuItems(type){
  const el=document.getElementById(type+'Items')
  const cols=type==='learn'?'42px 1fr 70px 70px 32px':'42px 1fr 80px 32px'
  el.innerHTML=menuCfg[type].map((m,i)=>{
    const costFld=type==='learn'
      ?'<div><input class="mi-inp" type="number" value="'+(m.reward||0)+'" min="0" onchange="updMenu(\''+type+'\','+i+',\'reward\',+this.value)" style="text-align:right"/><div class="cost-hint">획득P</div></div>'+
        '<label class="photo-chk" style="justify-content:center"><input type="checkbox" '+(m.requirePhoto?'checked':'')+' onchange="updMenu(\''+type+'\','+i+',\'requirePhoto\',this.checked)"/> 📸</label>'
      :'<input class="mi-inp" type="number" value="'+(m.cost||0)+'" min="0" onchange="updMenu(\''+type+'\','+i+',\'cost\',+this.value)" style="text-align:right"/>'
    return '<div class="mi" style="grid-template-columns:'+cols+'">'+
      '<input class="mi-inp" value="'+escH(m.icon)+'" maxlength="4" onchange="updMenu(\''+type+'\','+i+',\'icon\',this.value)" style="text-align:center"/>'+
      '<input class="mi-inp" value="'+escH(m.label)+'" maxlength="20" onchange="updMenu(\''+type+'\','+i+',\'label\',this.value)"/>'+
      costFld+
      '<button class="btn-del" onclick="delMenuItem(\''+type+'\','+i+')"><i class="fas fa-trash-can"></i></button>'+
    '</div>'
  }).join('')
}
window.updMenu=function(t,i,f,v){menuCfg[t][i][f]=v}
window.delMenuItem=function(t,i){if(!confirm(menuCfg[t][i].label+' 삭제?'))return;menuCfg[t].splice(i,1);renderMenuItems(t)}
window.addItem=function(type){
  const pfx={learn:'nL',fine:'nF',shop:'nS'}[type]
  const ic=(document.getElementById(pfx+'Ic')?.value||'').trim()||(type==='learn'?'📋':type==='fine'?'⚠️':'🎁')
  const lbl=document.getElementById(pfx+'Lbl')?.value.trim()
  if(!lbl){toast('항목 이름을 입력하세요');return}
  const cost=parseInt(document.getElementById(type==='learn'?'nLRew':type==='fine'?'nFCost':'nSCost')?.value||'0')||0
  const id=type+'_'+Date.now()
  if(type==='learn'){
    const photo=document.getElementById('nLPhoto')?.checked||false
    menuCfg.learn.push({id,icon:ic,label:lbl,cost:0,reward:cost,requirePhoto:photo})
  } else menuCfg[type].push({id,icon:ic,label:lbl,cost,reward:0,requirePhoto:false})
  ;['nLIc','nLLbl','nLRew','nFIc','nFLbl','nFCost','nSIc','nSLbl','nSCost'].forEach(x=>{const el=document.getElementById(x);if(el)el.value=''})
  renderMenuItems(type);toast('✅ 추가: '+lbl)
}
window.saveMenu=function(){
  const sv=localStorage.getItem('kiosk_cfg_ver');const lc=localStorage.getItem('kiosk_config')
  let cfg={currency:curCfg,menu:menuCfg}
  if(lc&&sv==='2025-v3'){try{const p=JSON.parse(lc);cfg={...p,menu:menuCfg}}catch{}}
  localStorage.setItem('kiosk_config',JSON.stringify(cfg));localStorage.setItem('kiosk_cfg_ver','2025-v3')
  toast('✅ 메뉴 저장 완료! 키오스크에 반영됩니다')
}
window.resetMenu=function(){if(!confirm('기본값으로 초기화할까요?'))return;menuCfg=JSON.parse(JSON.stringify(DEFAULT_MENU));renderMenuItems('learn');renderMenuItems('fine');renderMenuItems('shop');toast('기본값으로 초기화됨')}

/* ── 화폐 ── */
function loadCurrencyCfg(){
  const lc=localStorage.getItem('kiosk_config');if(lc){try{const p=JSON.parse(lc);if(p.currency)curCfg=p.currency}catch{}}
}
function renderPresets(){
  const g=document.getElementById('presets')
  g.innerHTML=PRESETS.map((p,i)=>{
    const s=curCfg.unit===p.unit&&curCfg.symbol===p.symbol
    return '<div class="preset-btn'+(s?' sel':'')+'" onclick="selPreset('+i+')"><span class="preset-emoji">'+p.symbol+'</span>'+p.unit+'</div>'
  }).join('')
}
function renderCurInputs(){
  document.getElementById('curUnit').value=curCfg.unit||'포인트'
  document.getElementById('curSymbol').value=curCfg.symbol||'🏅'
  document.getElementById('curDesc').value=curCfg.desc||''
  updateCurPreview()
}
window.selPreset=function(i){curCfg=Object.assign({},PRESETS[i]);renderPresets();renderCurInputs();toast('화폐: '+PRESETS[i].symbol+' '+PRESETS[i].unit)}
window.updateCurPreview=function(){
  const sym=document.getElementById('curSymbol')?.value||'🏅'
  const unit=document.getElementById('curUnit')?.value||'포인트'
  document.getElementById('pvSym').textContent=sym
  document.getElementById('pvTitle').textContent=unit+' ('+sym+')'
  document.getElementById('pvSub').textContent=document.getElementById('curDesc')?.value||''
}
window.saveCurrency=function(){
  curCfg.unit=document.getElementById('curUnit').value.trim()||'포인트'
  curCfg.symbol=document.getElementById('curSymbol').value.trim()||'🏅'
  curCfg.desc=document.getElementById('curDesc').value.trim()
  const lc=localStorage.getItem('kiosk_config');let cfg={currency:curCfg,menu:menuCfg}
  if(lc){try{const p=JSON.parse(lc);cfg={...p,currency:curCfg}}catch{}}
  localStorage.setItem('kiosk_config',JSON.stringify(cfg));localStorage.setItem('kiosk_cfg_ver','2025-v3')
  renderPresets();toast('✅ 화폐 설정 저장 완료!')
}

function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}
})()
</script>
</body>
</html>`

export default app
