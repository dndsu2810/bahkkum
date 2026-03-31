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

app.get('/api/config', (c) => c.json(DEFAULT_CONFIG))

app.post('/api/submit', async (c) => {
  try {
    const body = await c.req.json()
    const { name, items, totalCost, currency, category, timestamp } = body
    if (!name || !items) return c.json({ success: false, error: '필수 값 누락' }, 400)
    const [slackR, notionR] = await Promise.allSettled([
      sendSlack(c.env, { name, items, totalCost, currency, category, timestamp }),
      saveNotion(c.env, { name, items, totalCost, currency, category, timestamp }),
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

async function sendSlack(env: Bindings, d: any) {
  if (!env.SLACK_WEBHOOK_URL) return false
  const catEmoji: Record<string, string> = { learn:'✅', fine:'🚨', shop:'🛍️' }
  const catLabel: Record<string, string> = { learn:'학습 활동', fine:'벌금', shop:'보상 교환' }
  const itemList = d.items.map((x: any) => `• ${x.icon} ${x.label} × ${x.qty}`).join('\n')
  const payload = {
    blocks: [
      { type:'header', text:{ type:'plain_text', text:`바꿈수학 키오스크 ${catEmoji[d.category]||'📋'}`, emoji:true } },
      { type:'section', text:{ type:'mrkdwn', text:`*${catLabel[d.category]||d.category}* 기록\n\n*👤 학생:* ${d.name}\n*📋 항목:*\n${itemList}\n*💰 합계:* ${d.totalCost !== 0 ? Math.abs(d.totalCost) + ' ' + d.currency : '무료'}` } },
      { type:'context', elements:[{ type:'mrkdwn', text:`⏰ ${d.timestamp}` }] },
      { type:'divider' },
    ],
  }
  const res = await fetch(env.SLACK_WEBHOOK_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
  if (!res.ok) throw new Error(`Slack ${res.status}`)
  return true
}

async function saveNotion(env: Bindings, d: any) {
  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) return false
  const catLabel: Record<string, string> = { learn:'학습 활동', fine:'벌금', shop:'보상 교환' }
  const itemList = d.items.map((x: any) => `${x.icon} ${x.label} × ${x.qty}`).join(', ')
  const payload = {
    parent: { database_id: env.NOTION_DATABASE_ID },
    properties: {
      '학생 이름': { title: [{ text:{ content: d.name } }] },
      '항목':      { rich_text: [{ text:{ content: itemList } }] },
      '금액':      { number: Math.abs(d.totalCost) },
      '구분':      { select:{ name: catLabel[d.category] || d.category } },
      '접수 일시': { date:{ start: new Date().toISOString() } },
      '상태':      { select:{ name: '접수 완료' } },
    },
  }
  const res = await fetch('https://api.notion.com/v1/pages', {
    method:'POST',
    headers:{ Authorization:`Bearer ${env.NOTION_API_KEY}`, 'Content-Type':'application/json', 'Notion-Version':'2022-06-28' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Notion ${res.status}`)
  return true
}

app.get('/api/health', (c) => c.json({ status:'ok', slack:!!c.env.SLACK_WEBHOOK_URL, notion:!!(c.env.NOTION_API_KEY && c.env.NOTION_DATABASE_ID), ts: new Date().toISOString() }))

app.get('/',      (c) => c.html(MAIN_HTML))
app.get('/admin', (c) => c.html(ADMIN_HTML))

// ── 기본 설정 ──────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  currency: { unit: '별', symbol: '⭐', desc: '열심히 공부하면 별을 받아요!' },
  students: ['김민준','이서연','박지우','최하은','정도윤','강서현','윤민서','장준혁','임지원','한소율','오현우','신예린','류재원','노은지','문성훈'],
  menu: {
    learn: [
      { id:'study',    icon:'📖', label:'자습 인증하기',    cost:0, reward:2, requirePhoto:false },
      { id:'homework', icon:'✏️', label:'숙제 제출 완료',   cost:0, reward:1, requirePhoto:false },
      { id:'question', icon:'🙋', label:'질문하기',         cost:0, reward:1, requirePhoto:false },
      { id:'record',   icon:'📝', label:'모르는 문제 기록', cost:0, reward:2, requirePhoto:true  },
      { id:'material', icon:'📄', label:'추가 학습지 요청', cost:0, reward:0, requirePhoto:false },
    ],
    fine: [
      { id:'callteacher', icon:'🔔', label:'선생님 호출', cost:3, reward:0, requirePhoto:false },
      { id:'lostwork',    icon:'😰', label:'숙제 분실',   cost:4, reward:0, requirePhoto:false },
      { id:'nohomework',  icon:'🚫', label:'숙제 안함',   cost:5, reward:0, requirePhoto:false },
    ],
    shop: [
      { id:'snack',     icon:'🍬', label:'간식 교환권',    cost:5,  reward:0, requirePhoto:false },
      { id:'sticker',   icon:'🌟', label:'스티커 1장',     cost:2,  reward:0, requirePhoto:false },
      { id:'pencil',    icon:'✏️', label:'연필 1자루',     cost:3,  reward:0, requirePhoto:false },
      { id:'eraser',    icon:'🧹', label:'지우개',         cost:4,  reward:0, requirePhoto:false },
      { id:'freetime',  icon:'⏱️', label:'자유시간 10분',  cost:10, reward:0, requirePhoto:false },
      { id:'worksheet', icon:'📋', label:'학습지 2장',     cost:3,  reward:0, requirePhoto:false },
    ],
  },
}

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
      --blue:#29ABE2; --blue-d:#1a90c4; --blue-dd:#0f6a96; --blue-soft:#e8f6fd; --blue-mid:#a8d8f0; --blue-light:#f0f9ff;
      --white:#fff; --sky:#f0f9ff;
      --g50:#f8fafc; --g100:#f1f5f9; --g200:#e2e8f0; --g300:#cbd5e1; --g400:#94a3b8; --g600:#475569; --g800:#1e293b;
      --yellow:#fbbf24; --yellow-d:#f59e0b; --yellow-s:#fffbeb;
      --green:#22c55e; --green-d:#16a34a; --green-s:#f0fdf4;
      --red:#ef4444; --red-d:#dc2626; --red-s:#fef2f2;
      --purple:#a855f7; --purple-d:#9333ea; --purple-s:#faf5ff;
      --orange:#f97316; --orange-s:#fff7ed;
      --pink:#ec4899; --pink-s:#fdf2f8;
      --r-xl:24px; --r-lg:16px; --r-md:12px; --r-sm:8px;
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html{font-size:16px; scroll-behavior:smooth;}
    body{
      font-family:'Noto Sans KR',sans-serif;
      background:linear-gradient(160deg,#dff3fc 0%,#f0f9ff 40%,#fafcff 100%);
      background-attachment:fixed;
      color:var(--g800); min-height:100vh; overflow-x:hidden;
      -webkit-tap-highlight-color:transparent; user-select:none;
    }

    /* ─── 파티클 배경 ─── */
    .bg-particles{
      position:fixed; top:0; left:0; right:0; bottom:0;
      pointer-events:none; z-index:0; overflow:hidden;
    }
    .particle{
      position:absolute; border-radius:50%; opacity:.12;
      animation:float-particle linear infinite;
    }
    @keyframes float-particle{
      0%{transform:translateY(100vh) scale(0);opacity:0;}
      10%{opacity:.15;}
      90%{opacity:.1;}
      100%{transform:translateY(-100px) scale(1);opacity:0;}
    }

    /* ─── 헤더 ─── */
    .header{
      position:relative; z-index:20;
      background:rgba(255,255,255,.95);
      backdrop-filter:blur(16px);
      border-bottom:1.5px solid rgba(41,171,226,.12);
      box-shadow:0 2px 16px rgba(41,171,226,.08);
      padding:0 clamp(14px,3vw,32px);
      height:clamp(58px,7.5vw,70px);
      display:flex; align-items:center; justify-content:space-between;
    }
    .header-logo img{height:clamp(30px,4.5vw,42px);width:auto;}
    .header-right{display:flex;align-items:center;gap:8px;}
    .clock-badge{
      font-size:clamp(11px,1.6vw,15px); font-weight:800; color:var(--blue);
      background:var(--blue-soft); border:1.5px solid var(--blue-mid);
      padding:5px 12px; border-radius:100px; font-variant-numeric:tabular-nums;
      white-space:nowrap;
    }
    .btn-admin-link{
      display:flex; align-items:center; gap:5px;
      font-size:12px; font-weight:700; color:var(--g400);
      text-decoration:none; padding:6px 12px;
      border-radius:100px; border:1.5px solid var(--g200);
      background:var(--white); transition:all .2s;
    }
    .btn-admin-link:hover{color:var(--blue);border-color:var(--blue-mid);background:var(--blue-soft);}

    /* ─── 화면 전환 ─── */
    .screen{display:none;position:relative;z-index:5;}
    .screen.active{display:block;}

    /* ══════════════════════════
       스플래시
    ══════════════════════════ */
    #splash{
      min-height:calc(100vh - clamp(58px,7.5vw,70px));
      display:none; flex-direction:column;
      align-items:center; justify-content:center;
      padding:clamp(20px,4vw,48px) 20px; gap:clamp(12px,2.5vw,20px);
      cursor:pointer; text-align:center;
    }
    #splash.active{display:flex;}

    .splash-logo-img{
      width:clamp(100px,18vw,180px); height:auto;
      animation:logo-bob 3s ease-in-out infinite;
      filter:drop-shadow(0 10px 30px rgba(41,171,226,.3));
    }
    @keyframes logo-bob{
      0%,100%{transform:translateY(0) scale(1);}
      50%{transform:translateY(-14px) scale(1.03);}
    }

    .splash-badge{
      display:inline-flex; align-items:center; gap:8px;
      background:linear-gradient(135deg,var(--yellow),var(--yellow-d));
      color:white; font-size:clamp(12px,1.8vw,15px); font-weight:900;
      padding:8px 22px; border-radius:100px;
      box-shadow:0 4px 18px rgba(251,191,36,.45);
      animation:bounce-badge .7s ease-in-out infinite alternate;
    }
    @keyframes bounce-badge{from{transform:scale(1) translateY(0);}to{transform:scale(1.05) translateY(-3px);}}

    .splash-title{
      font-family:'Nunito',sans-serif;
      font-size:clamp(24px,5vw,50px); font-weight:900;
      color:var(--blue-dd); letter-spacing:-1px; line-height:1.1;
    }
    .splash-title .hi{
      background:linear-gradient(135deg,var(--blue) 0%,#0ea5e9 100%);
      -webkit-background-clip:text; -webkit-text-fill-color:transparent;
    }
    .splash-desc{font-size:clamp(13px,1.8vw,17px);color:var(--g400);}

    .floating-icons{display:flex;gap:clamp(10px,2vw,18px);flex-wrap:wrap;justify-content:center;margin:4px 0;}
    .fi{
      font-size:clamp(22px,4vw,34px);
      animation:fi-float 2.5s ease-in-out infinite;
      display:inline-block;
    }
    .fi:nth-child(1){animation-delay:0s;}
    .fi:nth-child(2){animation-delay:.3s;}
    .fi:nth-child(3){animation-delay:.6s;}
    .fi:nth-child(4){animation-delay:.9s;}
    .fi:nth-child(5){animation-delay:1.2s;}
    .fi:nth-child(6){animation-delay:1.5s;}
    @keyframes fi-float{0%,100%{transform:translateY(0) rotate(-5deg) scale(1);}50%{transform:translateY(-10px) rotate(5deg) scale(1.1);}}

    .tap-pulse-btn{
      background:linear-gradient(135deg,var(--blue),var(--blue-d));
      color:white; font-size:clamp(14px,2.2vw,20px); font-weight:900;
      padding:clamp(14px,2vw,20px) clamp(28px,5vw,52px);
      border-radius:100px; border:none; cursor:pointer;
      box-shadow:0 8px 30px rgba(41,171,226,.45);
      animation:pulse-glow 2s ease-in-out infinite;
      display:flex; align-items:center; gap:10px; font-family:inherit;
    }
    @keyframes pulse-glow{
      0%,100%{box-shadow:0 8px 30px rgba(41,171,226,.4);transform:scale(1);}
      50%{box-shadow:0 14px 40px rgba(41,171,226,.65);transform:scale(1.04);}
    }
    .tap-pulse-btn i{animation:hand-tap 2s ease-in-out infinite;}
    @keyframes hand-tap{0%,100%{transform:scale(1) rotate(0);}40%{transform:scale(1.3) rotate(-15deg);}70%{transform:scale(.9) rotate(10deg);}}

    .splash-footer{font-size:11px;color:var(--g300);margin-top:4px;}

    /* ══════════════════════════
       학생 선택
    ══════════════════════════ */
    #student-screen{
      min-height:calc(100vh - clamp(58px,7.5vw,70px));
      padding:clamp(14px,2vw,24px) clamp(14px,3vw,28px);
    }
    .page-top{display:flex;align-items:center;gap:12px;margin-bottom:clamp(10px,1.8vw,18px);}
    .back-btn{
      width:40px; height:40px; border-radius:50%;
      background:var(--white); border:1.5px solid var(--g200);
      display:flex; align-items:center; justify-content:center;
      cursor:pointer; font-size:14px; color:var(--g600);
      transition:all .2s; flex-shrink:0;
      box-shadow:0 1px 4px rgba(0,0,0,.06);
    }
    .back-btn:hover{border-color:var(--blue);color:var(--blue);background:var(--blue-soft);}
    .page-title{font-family:'Nunito',sans-serif;font-size:clamp(17px,2.8vw,24px);font-weight:900;color:var(--g800);}
    .page-sub{font-size:clamp(11px,1.5vw,13px);color:var(--g400);margin-top:2px;}

    .search-wrap{position:relative;margin-bottom:clamp(10px,1.8vw,16px);}
    .search-inp{
      width:100%; background:var(--white);
      border:2px solid var(--g200); border-radius:var(--r-lg);
      padding:clamp(10px,1.5vw,13px) 13px clamp(10px,1.5vw,13px) 42px;
      font-family:inherit; font-size:clamp(14px,1.8vw,16px); font-weight:500;
      color:var(--g800); outline:none; transition:all .2s;
      box-shadow:0 1px 6px rgba(0,0,0,.04);
    }
    .search-inp:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(41,171,226,.1);}
    .search-inp::placeholder{color:var(--g400);font-weight:400;}
    .search-ic{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--g400);font-size:14px;}

    .student-grid{
      display:grid;
      grid-template-columns:repeat(auto-fill,minmax(clamp(85px,14vw,120px),1fr));
      gap:clamp(8px,1.4vw,12px);
    }
    .stu-btn{
      background:var(--white); border:2.5px solid var(--g200);
      border-radius:var(--r-xl); padding:clamp(12px,2vw,18px) 6px;
      cursor:pointer; display:flex; flex-direction:column;
      align-items:center; gap:7px; transition:all .18s;
      box-shadow:0 1px 6px rgba(0,0,0,.04);
    }
    .stu-btn:hover{border-color:var(--blue);background:var(--blue-soft);transform:translateY(-4px);box-shadow:0 8px 24px rgba(41,171,226,.18);}
    .stu-btn:active{transform:scale(.94);}
    .stu-av{
      width:clamp(42px,6.5vw,56px); height:clamp(42px,6.5vw,56px);
      border-radius:50%;
      background:linear-gradient(135deg,var(--blue-soft),#cde9f8);
      border:2.5px solid var(--blue-mid);
      display:flex; align-items:center; justify-content:center;
      font-size:clamp(15px,2.4vw,22px); font-weight:900; color:var(--blue-d);
    }
    .stu-name{font-size:clamp(11px,1.5vw,14px);font-weight:800;color:var(--g800);text-align:center;line-height:1.3;}
    .stu-btn.hidden{display:none;}

    /* ══════════════════════════
       메뉴 화면
    ══════════════════════════ */
    #menu-screen{
      min-height:calc(100vh - clamp(58px,7.5vw,70px));
      padding:clamp(12px,1.8vw,20px) clamp(14px,3vw,28px) clamp(90px,13vw,110px);
    }

    /* 학생 배너 */
    .stu-banner{
      display:flex; align-items:center; gap:12px;
      background:linear-gradient(135deg,var(--blue),var(--blue-d) 60%,#1680b0);
      color:white; border-radius:var(--r-xl);
      padding:clamp(11px,1.8vw,16px) clamp(14px,2.2vw,20px);
      margin-bottom:clamp(10px,1.6vw,16px);
      box-shadow:0 6px 22px rgba(41,171,226,.3);
      position:relative; overflow:hidden;
    }
    .stu-banner::before{
      content:''; position:absolute; right:-20px; top:-20px;
      width:120px; height:120px; border-radius:50%;
      background:rgba(255,255,255,.06);
    }
    .stu-banner-av{
      width:clamp(38px,5.5vw,50px); height:clamp(38px,5.5vw,50px);
      border-radius:50%; background:rgba(255,255,255,.25);
      display:flex; align-items:center; justify-content:center;
      font-size:clamp(14px,2vw,20px); font-weight:900;
      border:2px solid rgba(255,255,255,.4); flex-shrink:0;
    }
    .stu-banner-info{flex:1;min-width:0;}
    .stu-banner-name{font-size:clamp(14px,2vw,19px);font-weight:900;}
    .stu-banner-sub{font-size:clamp(10px,1.3vw,12px);opacity:.75;margin-top:1px;}

    /* 별 잔고 */
    .star-balance{
      display:flex; align-items:center; gap:5px;
      background:rgba(255,255,255,.18); border:1.5px solid rgba(255,255,255,.3);
      border-radius:100px; padding:5px 12px;
      font-size:clamp(12px,1.6vw,15px); font-weight:900;
      flex-shrink:0; white-space:nowrap;
    }
    .star-balance .sb-val{font-size:clamp(14px,2vw,18px);}
    .btn-change{
      background:rgba(255,255,255,.18); border:1.5px solid rgba(255,255,255,.35);
      color:white; font-family:inherit; font-size:clamp(10px,1.3vw,12px); font-weight:700;
      padding:6px 12px; border-radius:100px; cursor:pointer; transition:all .2s;
      white-space:nowrap; flex-shrink:0;
    }
    .btn-change:hover{background:rgba(255,255,255,.3);}

    /* 탭 */
    .tab-row{display:flex;gap:6px;margin-bottom:clamp(10px,1.6vw,16px);overflow-x:auto;padding-bottom:2px;}
    .tab-row::-webkit-scrollbar{display:none;}
    .tab-btn{
      display:flex; align-items:center; gap:5px;
      font-family:inherit; font-size:clamp(11px,1.5vw,13px); font-weight:800;
      padding:clamp(7px,1.1vw,11px) clamp(11px,1.8vw,17px);
      border-radius:100px; cursor:pointer; transition:all .2s;
      white-space:nowrap; border:2px solid transparent;
      background:var(--white); color:var(--g400);
      box-shadow:0 1px 4px rgba(0,0,0,.05);
    }
    .tab-dot{width:6px;height:6px;border-radius:50%;background:currentColor;}
    .tab-btn.active-learn{background:var(--green-s);color:var(--green);border-color:rgba(34,197,94,.3);}
    .tab-btn.active-fine{background:var(--red-s);color:var(--red);border-color:rgba(239,68,68,.3);}
    .tab-btn.active-shop{background:var(--purple-s);color:var(--purple);border-color:rgba(168,85,247,.3);}
    .tab-badge{
      background:currentColor; color:white;
      min-width:18px; height:18px; border-radius:9px;
      font-size:10px; font-weight:900;
      display:flex; align-items:center; justify-content:center; padding:0 4px;
    }
    .tab-badge span{filter:invert(1);}

    /* 메뉴 그리드 */
    .menu-grid{
      display:grid;
      grid-template-columns:repeat(auto-fill,minmax(clamp(110px,16vw,160px),1fr));
      gap:clamp(8px,1.4vw,12px);
    }
    .menu-btn{
      background:var(--white); border:2.5px solid var(--g200);
      border-radius:var(--r-xl); padding:clamp(13px,2vw,20px) clamp(9px,1.4vw,13px);
      cursor:pointer; display:flex; flex-direction:column;
      align-items:center; gap:clamp(5px,.9vw,9px);
      transition:all .22s; text-align:center;
      box-shadow:0 2px 8px rgba(0,0,0,.04);
      position:relative; overflow:hidden;
    }
    .menu-btn:active{transform:scale(.94) !important;}

    .menu-btn.type-learn:hover{border-color:var(--green);background:var(--green-s);transform:translateY(-5px);box-shadow:0 10px 28px rgba(34,197,94,.15);}
    .menu-btn.type-fine:hover{border-color:var(--red);background:var(--red-s);transform:translateY(-5px);box-shadow:0 10px 28px rgba(239,68,68,.12);}
    .menu-btn.type-shop:hover{border-color:var(--purple);background:var(--purple-s);transform:translateY(-5px);box-shadow:0 10px 28px rgba(168,85,247,.15);}

    /* 장바구니에 담긴 항목 표시 */
    .menu-btn.in-cart{
      border-width:3px;
    }
    .menu-btn.in-cart.type-learn{border-color:var(--green);}
    .menu-btn.in-cart.type-fine{border-color:var(--red);}
    .menu-btn.in-cart.type-shop{border-color:var(--purple);}

    .menu-ic-wrap{
      width:clamp(50px,7.5vw,68px); height:clamp(50px,7.5vw,68px);
      border-radius:clamp(12px,1.8vw,18px);
      display:flex; align-items:center; justify-content:center;
      font-size:clamp(22px,3.5vw,32px); position:relative;
    }
    .type-learn .menu-ic-wrap{background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1.5px solid rgba(34,197,94,.2);}
    .type-fine  .menu-ic-wrap{background:var(--red-s);border:1.5px solid rgba(239,68,68,.18);}
    .type-shop  .menu-ic-wrap{background:var(--purple-s);border:1.5px solid rgba(168,85,247,.2);}

    .menu-lbl{font-size:clamp(11px,1.5vw,14px);font-weight:800;color:var(--g800);line-height:1.25;}
    .menu-cost-tag{
      font-size:clamp(10px,1.3vw,12px); font-weight:800;
      padding:3px 9px; border-radius:100px;
    }
    .type-learn .menu-cost-tag{background:var(--green-s);color:var(--green);border:1px solid rgba(34,197,94,.2);}
    .type-fine  .menu-cost-tag{background:var(--red-s);color:var(--red);border:1px solid rgba(239,68,68,.2);}
    .type-shop  .menu-cost-tag{background:var(--purple-s);color:var(--purple);border:1px solid rgba(168,85,247,.2);}

    .photo-badge-small{
      position:absolute; top:-2px; right:-2px;
      background:var(--orange); color:white;
      font-size:9px; font-weight:900;
      padding:2px 6px; border-radius:100px;
    }

    /* 수량 표시 배지 */
    .qty-chip{
      position:absolute; top:-6px; right:-6px;
      background:var(--blue); color:white;
      font-size:11px; font-weight:900;
      width:22px; height:22px; border-radius:50%;
      display:flex; align-items:center; justify-content:center;
      border:2px solid white; box-shadow:0 2px 6px rgba(41,171,226,.4);
    }
    .type-learn .qty-chip{background:var(--green);}
    .type-fine  .qty-chip{background:var(--red);}
    .type-shop  .qty-chip{background:var(--purple);}

    /* ── 장바구니 하단바 ── */
    .cart-bar{
      position:fixed; bottom:0; left:0; right:0; z-index:50;
      background:rgba(255,255,255,.97); backdrop-filter:blur(14px);
      border-top:1.5px solid var(--g200);
      box-shadow:0 -4px 24px rgba(0,0,0,.08);
      padding:clamp(9px,1.6vw,13px) clamp(14px,3vw,28px);
      display:none; align-items:center; justify-content:space-between; gap:10px;
      transition:transform .3s cubic-bezier(.34,1.4,.64,1);
    }
    .cart-bar.visible{display:flex;}
    .cart-bar.pop{animation:cart-pop .35s cubic-bezier(.34,1.4,.64,1);}
    @keyframes cart-pop{0%{transform:translateY(4px);}50%{transform:translateY(-5px);}100%{transform:translateY(0);}}
    .cart-info{display:flex;align-items:center;gap:10px;min-width:0;}
    .cart-ic-wrap{
      width:44px; height:44px; border-radius:var(--r-md);
      background:var(--blue-soft); border:1.5px solid var(--blue-mid);
      display:flex; align-items:center; justify-content:center;
      font-size:20px; flex-shrink:0; position:relative;
    }
    .cart-badge{
      position:absolute; top:-7px; right:-7px;
      background:var(--red); color:white;
      font-size:10px; font-weight:900;
      min-width:20px; height:20px; border-radius:10px;
      display:flex; align-items:center; justify-content:center;
      border:2px solid white; padding:0 3px;
    }
    .cart-cnt{font-size:clamp(11px,1.4vw,13px);font-weight:700;color:var(--g600);}
    .cart-preview{
      font-size:clamp(10px,1.3vw,12px);color:var(--g400);
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      max-width:clamp(110px,18vw,220px);
    }
    .cart-btns{display:flex;gap:7px;flex-shrink:0;}
    .btn-cc{
      background:var(--g100); border:1.5px solid var(--g200);
      color:var(--g600); font-family:inherit; font-size:clamp(11px,1.4vw,13px); font-weight:600;
      padding:clamp(9px,1.4vw,12px) clamp(11px,1.8vw,16px); border-radius:var(--r-md);
      cursor:pointer; transition:all .2s;
    }
    .btn-cc:hover{background:var(--red-s);color:var(--red);border-color:rgba(239,68,68,.3);}
    .btn-cs{
      background:linear-gradient(135deg,var(--blue),var(--blue-d));
      border:none; color:white; font-family:inherit;
      font-size:clamp(12px,1.6vw,15px); font-weight:800;
      padding:clamp(9px,1.4vw,12px) clamp(14px,2.2vw,22px);
      border-radius:var(--r-md); cursor:pointer; transition:all .2s;
      box-shadow:0 4px 14px rgba(41,171,226,.35);
      display:flex; align-items:center; gap:6px;
    }
    .btn-cs:hover{transform:translateY(-1px);box-shadow:0 6px 22px rgba(41,171,226,.5);}

    /* ══════════════════════════
       사진 인증 모달
    ══════════════════════════ */
    .modal-ov{
      position:fixed;inset:0;z-index:200;
      background:rgba(15,23,42,.45); backdrop-filter:blur(8px);
      display:none; align-items:center; justify-content:center; padding:16px;
    }
    .modal-ov.open{display:flex;}
    .modal-box{
      background:var(--white); border-radius:var(--r-xl);
      padding:clamp(22px,3.5vw,34px) clamp(18px,3.5vw,30px);
      width:min(490px,96vw);
      box-shadow:0 28px 80px rgba(0,0,0,.18);
      animation:modal-pop .4s cubic-bezier(.34,1.4,.64,1);
    }
    @keyframes modal-pop{from{opacity:0;transform:scale(.82) translateY(20px);}to{opacity:1;transform:scale(1) translateY(0);}}
    .modal-title{font-size:clamp(17px,2.4vw,22px);font-weight:900;color:var(--g800);margin-bottom:5px;}
    .modal-sub{font-size:14px;color:var(--g400);margin-bottom:0;}

    .photo-zone{
      border:2.5px dashed var(--blue-mid); border-radius:var(--r-lg);
      background:var(--blue-soft);
      padding:clamp(20px,3.5vw,34px) 20px;
      text-align:center; cursor:pointer; transition:all .2s;
      position:relative; overflow:hidden; margin:14px 0;
    }
    .photo-zone:hover{border-color:var(--blue);background:#d8eef9;}
    .photo-zone input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;}
    .photo-prev{max-width:100%;max-height:200px;border-radius:var(--r-md);object-fit:cover;display:none;margin:0 auto;}
    .photo-ph{pointer-events:none;}
    .photo-ph i{font-size:42px;color:var(--blue);margin-bottom:8px;display:block;}
    .photo-ph p{font-size:15px;font-weight:700;color:var(--blue-d);}
    .photo-ph span{font-size:12px;color:var(--g400);}

    .modal-btns{display:flex;gap:10px;margin-top:14px;}
    .btn-mc{flex:1;background:var(--g100);border:1.5px solid var(--g200);color:var(--g600);font-family:inherit;font-size:14px;font-weight:700;padding:13px;border-radius:var(--r-lg);cursor:pointer;transition:all .2s;}
    .btn-mc:hover{background:var(--g200);}
    .btn-mok{
      flex:2; background:linear-gradient(135deg,var(--blue),var(--blue-d));
      border:none; color:white; font-family:inherit; font-size:14px; font-weight:800;
      padding:13px; border-radius:var(--r-lg); cursor:pointer;
      box-shadow:0 4px 14px rgba(41,171,226,.35);
      display:flex; align-items:center; justify-content:center; gap:8px; transition:all .2s;
    }
    .btn-mok:disabled{opacity:.4;cursor:not-allowed;}
    .btn-mok:not(:disabled):hover{transform:translateY(-1px);box-shadow:0 6px 22px rgba(41,171,226,.5);}

    /* ══════════════════════════
       확인 모달
    ══════════════════════════ */
    #confirm-modal .modal-box{max-width:530px;}
    .confirm-stu-row{
      display:flex;align-items:center;gap:10px;
      background:var(--blue-soft);border:1.5px solid var(--blue-mid);
      border-radius:var(--r-lg);padding:12px 16px;margin-bottom:14px;
    }
    .confirm-av{width:38px;height:38px;border-radius:50%;background:var(--blue-mid);border:2px solid var(--blue);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:900;color:var(--blue-d);}
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

    .total-row{
      display:flex;align-items:center;justify-content:space-between;
      background:var(--g50);border:1.5px solid var(--g200);
      border-radius:var(--r-lg);padding:13px 16px;margin-bottom:15px;
    }
    .total-lbl{font-size:13px;font-weight:700;color:var(--g600);}
    .total-val{font-size:20px;font-weight:900;}

    .spinner{width:17px;height:17px;border:2.5px solid rgba(255,255,255,.3);border-top-color:white;border-radius:50%;animation:spin .65s linear infinite;}
    @keyframes spin{to{transform:rotate(360deg);}}

    /* ══════════════════════════
       완료 화면
    ══════════════════════════ */
    #done-screen{
      min-height:calc(100vh - clamp(58px,7.5vw,70px));
      display:none; flex-direction:column;
      align-items:center; justify-content:center;
      padding:clamp(20px,3.5vw,44px) 16px; gap:clamp(12px,2.2vw,18px);
    }
    #done-screen.active{display:flex;}

    .done-anim{font-size:clamp(44px,7vw,72px);animation:done-pop 1s cubic-bezier(.34,1.4,.64,1);}
    @keyframes done-pop{from{transform:scale(0) rotate(-30deg);opacity:0;}60%{transform:scale(1.2) rotate(10deg);}to{transform:scale(1) rotate(0);opacity:1;}}

    .done-card{
      background:var(--white); border-radius:var(--r-xl);
      padding:clamp(24px,3.5vw,38px) clamp(20px,3.5vw,34px);
      width:min(500px,96vw);
      box-shadow:0 14px 56px rgba(41,171,226,.12);
      text-align:center; border:1.5px solid var(--g200);
      animation:modal-pop .5s cubic-bezier(.34,1.4,.64,1);
    }
    .done-title{font-family:'Nunito',sans-serif;font-size:clamp(20px,3.5vw,32px);font-weight:900;color:var(--g800);margin-bottom:5px;}
    .done-sub{font-size:clamp(13px,1.7vw,16px);color:var(--g400);line-height:1.65;margin-bottom:clamp(14px,2.2vw,22px);}

    /* 연속 주문 요약 */
    .session-summary{
      background:linear-gradient(135deg,var(--blue-soft),#e0f4fc);
      border:1.5px solid var(--blue-mid); border-radius:var(--r-lg);
      padding:clamp(12px,2vw,18px); margin-bottom:clamp(12px,2vw,18px);
      text-align:left;
    }
    .ss-title{font-size:12px;font-weight:700;color:var(--blue-d);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;}
    .ss-row{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(41,171,226,.12);}
    .ss-row:last-child{border-bottom:none;}
    .ss-lbl{font-size:12px;color:var(--g600);}
    .ss-val{font-size:13px;font-weight:800;}

    .chips-row{display:flex;gap:7px;justify-content:center;margin-bottom:clamp(14px,2.2vw,20px);flex-wrap:wrap;}
    .chip{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:700;padding:6px 14px;border-radius:100px;}
    .chip.ok{background:var(--green-s);color:var(--green);border:1px solid rgba(34,197,94,.25);}
    .chip.fail{background:var(--red-s);color:var(--red);border:1px solid rgba(239,68,68,.25);}

    /* 행동 버튼 */
    .done-btns{display:flex;flex-direction:column;gap:9px;width:100%;}
    .btn-continue{
      width:100%; background:linear-gradient(135deg,var(--blue),var(--blue-d));
      border:none; color:white; font-family:inherit;
      font-size:clamp(14px,1.9vw,17px); font-weight:900;
      padding:clamp(13px,2vw,17px); border-radius:var(--r-lg);
      cursor:pointer; transition:all .2s;
      box-shadow:0 4px 18px rgba(41,171,226,.3);
      display:flex; align-items:center; justify-content:center; gap:8px;
    }
    .btn-continue:hover{transform:translateY(-1px);box-shadow:0 7px 26px rgba(41,171,226,.45);}
    .btn-home{
      width:100%; background:var(--g100); border:1.5px solid var(--g200);
      color:var(--g600); font-family:inherit;
      font-size:clamp(13px,1.7vw,15px); font-weight:700;
      padding:clamp(11px,1.7vw,15px); border-radius:var(--r-lg);
      cursor:pointer; transition:all .2s;
    }
    .btn-home:hover{background:var(--g200);}

    /* ── 피드백 토스트 ── */
    .fb-toast{
      position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
      background:var(--g800);color:white;
      padding:9px 22px;border-radius:100px;
      font-size:14px;font-weight:700;z-index:9999;
      animation:fb-in .3s ease; pointer-events:none;
      white-space:nowrap;
    }
    @keyframes fb-in{from{opacity:0;transform:translateX(-50%) translateY(10px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}

    /* ── 보상 폭죽 ── */
    .confetti-piece{
      position:fixed;z-index:9998;pointer-events:none;
      font-size:clamp(18px,3vw,28px);
      animation:confetti-fly linear forwards;
    }
    @keyframes confetti-fly{
      0%{transform:translateY(0) rotate(0) scale(1);opacity:1;}
      100%{transform:translateY(-60vh) rotate(720deg) scale(0);opacity:0;}
    }

    /* ── 유틸 ── */
    .fade-up{animation:fadeUp .3s ease;}
    @keyframes fadeUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
    ::-webkit-scrollbar{width:4px;height:4px;}
    ::-webkit-scrollbar-thumb{background:var(--blue-mid);border-radius:2px;}

    @media(max-width:480px){
      .student-grid{grid-template-columns:repeat(3,1fr);}
      .menu-grid{grid-template-columns:repeat(2,1fr);}
      .star-balance{display:none;}
    }
    @media(min-width:481px) and (max-width:768px){
      .student-grid{grid-template-columns:repeat(4,1fr);}
      .menu-grid{grid-template-columns:repeat(3,1fr);}
    }
    @media(min-width:769px){
      .student-grid{grid-template-columns:repeat(6,1fr);}
      .menu-grid{grid-template-columns:repeat(4,1fr);}
    }
    @media(min-width:1200px){
      .menu-grid{grid-template-columns:repeat(5,1fr);}
    }
  </style>
</head>
<body>

<!-- 배경 파티클 -->
<div class="bg-particles" id="bgParticles"></div>

<!-- 헤더 -->
<header class="header">
  <div class="header-logo">
    <img src="/static/logo_horizontal.png" alt="바꿈수학"/>
  </div>
  <div class="header-right">
    <div class="clock-badge" id="clock">--:--:--</div>
    <a href="/admin" class="btn-admin-link">
      <i class="fas fa-sliders"></i><span>관리</span>
    </a>
  </div>
</header>

<!-- ══ 스플래시 ══ -->
<div id="splash" onclick="goTo('student')">
  <img class="splash-logo-img" src="/static/logo_square.png" alt="바꿈"/>
  <div class="splash-badge" id="splashBadge">
    <span id="splashSymbol">⭐</span>
    <span id="splashDesc">열심히 공부하면 별을 받아요!</span>
  </div>
  <div class="splash-title">
    바꿈수학<br/><span class="hi">학습 키오스크</span>
  </div>
  <div class="splash-desc">초등수학 전용 · Made by 이지현 선생님</div>
  <div class="floating-icons" id="floatingIcons">
    <span class="fi">📖</span>
    <span class="fi">✏️</span>
    <span class="fi">🌟</span>
    <span class="fi">🏆</span>
    <span class="fi">🎯</span>
    <span class="fi">🎉</span>
  </div>
  <button class="tap-pulse-btn">
    <i class="fas fa-hand-pointer"></i>
    화면을 터치해서 시작!
  </button>
  <div class="splash-footer">Made with ❤️ by 이지현 | 바꿈수학 초등 전용</div>
</div>

<!-- ══ 학생 선택 ══ -->
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

<!-- ══ 메뉴 ══ -->
<div class="screen" id="menu-screen">
  <div style="padding:clamp(12px,1.8vw,20px) clamp(14px,3vw,28px) clamp(90px,13vw,110px);">
    <!-- 학생 배너 -->
    <div class="stu-banner">
      <div class="stu-banner-av" id="bannerAv"></div>
      <div class="stu-banner-info">
        <div class="stu-banner-name" id="bannerName"></div>
        <div class="stu-banner-sub">항목을 골라 장바구니에 담아요 🛒</div>
      </div>
      <div class="star-balance" id="starBalance">
        <span id="starSymbol">⭐</span>
        <span class="sb-val" id="starVal">0</span>
        <span id="starUnit">별</span>
      </div>
      <button class="btn-change" onclick="goTo('student')">
        <i class="fas fa-exchange-alt" style="margin-right:3px"></i>변경
      </button>
    </div>

    <!-- 탭 -->
    <div class="tab-row" id="tabRow">
      <button class="tab-btn active-learn" onclick="switchTab('learn')" id="tab-learn">
        <div class="tab-dot"></div>학습 활동
      </button>
      <button class="tab-btn" onclick="switchTab('fine')" id="tab-fine">
        <div class="tab-dot"></div>벌금 항목
      </button>
      <button class="tab-btn" onclick="switchTab('shop')" id="tab-shop">
        <div class="tab-dot"></div>🛍️ 보상 상점
      </button>
    </div>

    <div class="menu-grid" id="menuGrid"></div>
  </div>
</div>

<!-- ══ 완료 화면 ══ -->
<div id="done-screen">
  <div class="done-anim" id="doneEmoji">🎉</div>
  <div class="done-card">
    <div class="done-title" id="doneTitle">기록 완료!</div>
    <div class="done-sub" id="doneSub"></div>
    <div class="session-summary" id="sessionSummary"></div>
    <div class="chips-row" id="doneChips"></div>
    <div class="done-btns">
      <button class="btn-continue" id="btnContinue" onclick="continueOrder()">
        <i class="fas fa-plus-circle"></i>
        <span id="btnContinueLbl">같은 학생으로 계속 담기</span>
      </button>
      <button class="btn-home" onclick="goToSplash()">
        <i class="fas fa-house" style="margin-right:6px"></i>처음으로 돌아가기
      </button>
    </div>
  </div>
</div>

<!-- ══ 장바구니 하단바 ══ -->
<div class="cart-bar" id="cartBar">
  <div class="cart-info">
    <div class="cart-ic-wrap">
      🛒
      <div class="cart-badge" id="cartBadge">0</div>
    </div>
    <div>
      <div class="cart-cnt" id="cartCnt">0개 담음</div>
      <div class="cart-preview" id="cartPreview"></div>
    </div>
  </div>
  <div class="cart-btns">
    <button class="btn-cc" onclick="clearCart()" title="비우기">
      <i class="fas fa-trash"></i>
    </button>
    <button class="btn-cs" onclick="openConfirm()">
      <i class="fas fa-paper-plane"></i>제출하기
    </button>
  </div>
</div>

<!-- ══ 사진 인증 모달 ══ -->
<div class="modal-ov" id="photo-modal">
  <div class="modal-box">
    <div class="modal-title">📸 사진으로 인증해요!</div>
    <div class="modal-sub" id="photoSub">이 항목은 사진 인증이 필요해요</div>
    <div class="photo-zone" id="photoZone" onclick="triggerPhoto()">
      <input type="file" id="photoInput" accept="image/*" capture="environment" onchange="onPhoto(event)"/>
      <img class="photo-prev" id="photoPrev" alt=""/>
      <div class="photo-ph" id="photoPh">
        <i class="fas fa-camera"></i>
        <p>사진을 찍거나 갤러리에서 선택!</p>
        <span>카메라 또는 앨범</span>
      </div>
    </div>
    <div class="modal-btns">
      <button class="btn-mc" onclick="closePhotoModal()">취소</button>
      <button class="btn-mok" id="photoOk" onclick="confirmPhoto()" disabled>
        <i class="fas fa-check"></i>인증 완료
      </button>
    </div>
  </div>
</div>

<!-- ══ 확인 모달 ══ -->
<div class="modal-ov" id="confirm-modal">
  <div class="modal-box">
    <div class="modal-title" style="margin-bottom:13px">📋 제출 확인</div>
    <div class="confirm-stu-row">
      <div class="confirm-av" id="confirmAv"></div>
      <div>
        <div class="confirm-sn" id="confirmSn"></div>
        <div style="font-size:11px;color:var(--g400)">학생</div>
      </div>
    </div>
    <div class="order-list" id="orderList"></div>
    <div class="total-row">
      <div class="total-lbl" id="totalLbl">총 합계</div>
      <div class="total-val" id="totalVal"></div>
    </div>
    <div class="modal-btns">
      <button class="btn-mc" onclick="closeConfirm()">
        <i class="fas fa-xmark" style="margin-right:4px"></i>취소
      </button>
      <button class="btn-mok" id="confirmOk" onclick="doSubmit()">
        <i class="fas fa-paper-plane"></i>
        <span id="confirmTxt">제출하기</span>
      </button>
    </div>
  </div>
</div>

<script>
(function(){
/* ─── 상태 ─── */
let CFG = { currency:{unit:'별',symbol:'⭐',desc:''}, students:[], menu:{learn:[],fine:[],shop:[]} }
let ST = {
  student: null,
  tab: 'learn',
  cart: [],
  pendingItem: null,
  photoB64: null,
  submitting: false,
  sessionBalance: 0,   // 이번 세션 획득/차감 별
  sessionOrders: [],   // 이번 세션 제출 기록
}
let autoTimer = null

/* ─── 파티클 배경 ─── */
(function initParticles(){
  const c = document.getElementById('bgParticles')
  const emojis = ['⭐','✨','📖','🌟','🎯','💫','🔵','⚪']
  for(let i=0;i<18;i++){
    const el = document.createElement('div')
    el.className='particle'
    const size = 8 + Math.random()*24
    el.style.cssText = [
      'width:'+size+'px','height:'+size+'px',
      'left:'+Math.random()*100+'%',
      'background:'+(Math.random()>.5?'#29ABE2':'#fbbf24'),
      'animation-duration:'+(8+Math.random()*14)+'s',
      'animation-delay:'+(-Math.random()*14)+'s',
    ].join(';')
    if(Math.random()>.5){ el.textContent=emojis[Math.floor(Math.random()*emojis.length)]; el.style.background='none'; el.style.fontSize=size+'px'; el.style.borderRadius='0'; el.style.opacity='.25'; }
    c.appendChild(el)
  }
})()

/* ─── 시계 ─── */
setInterval(()=>{
  const n=new Date()
  document.getElementById('clock').textContent =
    [n.getHours(),n.getMinutes(),n.getSeconds()].map(x=>String(x).padStart(2,'0')).join(':')
},1000)

/* ─── 화면 전환 ─── */
const SCREENS = ['splash','student-screen','menu-screen','done-screen']
function goTo(id){
  clearTimeout(autoTimer)
  SCREENS.forEach(s=>document.getElementById(s).classList.remove('active'))
  const MAP = {splash:'splash',student:'student-screen',menu:'menu-screen',done:'done-screen'}
  const el = document.getElementById(MAP[id])
  if(!el) return
  el.classList.add('active')
  el.classList.add('fade-up')
  setTimeout(()=>el.classList.remove('fade-up'),350)
  const isMenu = id==='menu'
  const cb = document.getElementById('cartBar')
  cb.classList.toggle('visible', isMenu)
  if(id==='student'){ document.getElementById('searchInp').value=''; filterStudents('') }
  if(id==='splash'){ ST.cart=[]; ST.student=null; ST.sessionBalance=0; ST.sessionOrders=[]; updateCartBar(); }
  if(id==='menu'){ updateStarBalance(); }
}
window.goTo = goTo

function goToSplash(){ goTo('splash') }
window.goToSplash = goToSplash

/* ─── 설정 로드 ─── */
async function loadCfg(){
  try{
    const r=await fetch('/api/config')
    const d=await r.json()
    const local=localStorage.getItem('kiosk_config')
    if(local){ try{ CFG=JSON.parse(local) }catch{ CFG=d } }
    else CFG=d
  }catch{}
  applyCurrencyUI()
  renderStudents()
  goTo('splash')
}

function applyCurrencyUI(){
  const c=CFG.currency
  document.getElementById('splashSymbol').textContent = c.symbol
  document.getElementById('splashDesc').textContent   = c.desc || c.symbol+' '+c.unit+' 모으기!'
  document.getElementById('starSymbol').textContent   = c.symbol
  document.getElementById('starUnit').textContent     = c.unit
  // 스플래시 플로팅 아이콘에 심볼 반영
  const fi = document.getElementById('floatingIcons')
  if(fi){ const f=fi.children; if(f[2]) f[2].textContent=c.symbol; if(f[4]) f[4].textContent=c.symbol; }
}

function updateStarBalance(){
  document.getElementById('starVal').textContent = Math.max(0, -ST.sessionBalance)
}

/* ─── 학생 그리드 ─── */
function renderStudents(){
  const g=document.getElementById('studentGrid')
  g.innerHTML = CFG.students.map(n=>{
    const s=n.trim()
    return '<button class="stu-btn" data-name="'+s+'" onclick="selectStudent(\''+encodeURIComponent(s)+'\')">' +
      '<div class="stu-av">'+s[0]+'</div>' +
      '<div class="stu-name">'+s+'</div>' +
    '</button>'
  }).join('')
}

window.filterStudents = function(q){
  const kw=q.trim()
  document.querySelectorAll('#studentGrid .stu-btn').forEach(b=>{
    b.classList.toggle('hidden', !!kw && !b.dataset.name.includes(kw))
  })
}

window.selectStudent = function(enc){
  const name=decodeURIComponent(enc)
  ST.student=name; ST.cart=[]; ST.sessionBalance=0; ST.sessionOrders=[]
  document.getElementById('bannerName').textContent=name
  document.getElementById('bannerAv').textContent=name[0]
  document.getElementById('confirmAv').textContent=name[0]
  document.getElementById('confirmSn').textContent=name
  updateCartBar(); switchTab('learn'); goTo('menu')
}

/* ─── 탭 ─── */
window.switchTab = function(tab){
  ST.tab=tab
  document.querySelectorAll('.tab-btn').forEach(b=>b.className='tab-btn')
  document.getElementById('tab-'+tab).classList.add('tab-btn','active-'+tab)
  renderMenu()
}

/* ─── 메뉴 그리드 ─── */
function renderMenu(){
  const items=CFG.menu[ST.tab]||[]
  const g=document.getElementById('menuGrid')
  g.innerHTML=items.map(m=>{
    const costTxt=costText(m,ST.tab)
    const cartItem=ST.cart.find(x=>x.id===m.id && x.tab===ST.tab)
    const qty=cartItem?cartItem.qty:0
    const inCart=qty>0
    const photoBadge=m.requirePhoto?'<div class="photo-badge-small">📸</div>':''
    const qtyChip=qty>0?'<div class="qty-chip">'+qty+'</div>':''
    return '<button class="menu-btn type-'+ST.tab+(inCart?' in-cart':'')+'" onclick="addToCart(\''+m.id+'\',\''+ST.tab+'\')">'+
      photoBadge+
      '<div class="menu-ic-wrap">'+m.icon+qtyChip+'</div>'+
      '<div class="menu-lbl">'+m.label+'</div>'+
      '<div class="menu-cost-tag">'+costTxt+'</div>'+
    '</button>'
  }).join('')
}

function costText(m,tab){
  const c=CFG.currency
  if(tab==='learn') return m.reward>0?'+'+m.reward+' '+c.symbol:'무료'
  if(tab==='fine')  return '-'+m.cost+' '+c.unit
  return m.cost+' '+c.symbol
}

/* ─── 장바구니 ─── */
window.addToCart = function(id,tab){
  const item=(CFG.menu[tab]||[]).find(x=>x.id===id)
  if(!item) return
  if(item.requirePhoto){
    ST.pendingItem={item,tab}
    openPhotoModal(item.label)
    return
  }
  pushCart(item,tab,null)
}

function pushCart(item,tab,photo){
  const ex=ST.cart.find(x=>x.id===item.id && x.tab===tab)
  if(ex){ ex.qty++ }
  else{ ST.cart.push({id:item.id,tab,icon:item.icon,label:item.label,cost:item.cost,reward:item.reward||0,requirePhoto:item.requirePhoto,qty:1,photo}) }
  updateCartBar()
  renderMenu() // 수량 배지 갱신
  showFeedback(item.icon, item.label)
  // 애니메이션: 카트바 팝
  const cb=document.getElementById('cartBar')
  cb.classList.remove('pop')
  void cb.offsetWidth
  cb.classList.add('pop')
}

function showFeedback(icon, label){
  const fb=document.createElement('div')
  fb.className='fb-toast'
  fb.textContent=icon+' '+label+' 담았어요!'
  document.body.appendChild(fb)
  setTimeout(()=>fb.remove(),1500)
}

window.clearCart = function(){ ST.cart=[]; updateCartBar(); renderMenu() }

function updateCartBar(){
  const total=ST.cart.reduce((a,x)=>a+x.qty,0)
  document.getElementById('cartBadge').textContent=total
  document.getElementById('cartCnt').textContent=total+'개 담음'
  document.getElementById('cartPreview').textContent=ST.cart.map(x=>x.icon+x.label+(x.qty>1?' ×'+x.qty:'')).join(' · ')
  const isMenu=document.getElementById('menu-screen').classList.contains('active')
  document.getElementById('cartBar').classList.toggle('visible',isMenu)
}

/* ─── 사진 모달 ─── */
function openPhotoModal(label){
  document.getElementById('photoSub').textContent='[ '+label+' ] 항목은 사진 인증이 필요해요 📸'
  document.getElementById('photoPrev').style.display='none'
  document.getElementById('photoPh').style.display='block'
  document.getElementById('photoOk').disabled=true
  ST.photoB64=null
  document.getElementById('photo-modal').classList.add('open')
}
window.closePhotoModal=function(){
  document.getElementById('photo-modal').classList.remove('open')
  ST.pendingItem=null; ST.photoB64=null
  document.getElementById('photoInput').value=''
}
window.triggerPhoto=function(){ document.getElementById('photoInput').click() }
window.onPhoto=function(e){
  const f=e.target.files[0]; if(!f) return
  const reader=new FileReader()
  reader.onload=function(ev){
    ST.photoB64=ev.target.result
    const p=document.getElementById('photoPrev')
    p.src=ST.photoB64; p.style.display='block'
    document.getElementById('photoPh').style.display='none'
    document.getElementById('photoOk').disabled=false
  }
  reader.readAsDataURL(f)
}
window.confirmPhoto=function(){
  if(!ST.pendingItem||!ST.photoB64) return
  const{item,tab}=ST.pendingItem
  pushCart(item,tab,ST.photoB64)
  closePhotoModal()
}

/* ─── 확인 모달 ─── */
window.openConfirm=function(){
  if(ST.cart.length===0){ showFeedback('🛒','먼저 항목을 담아보세요!'); return }
  const c=CFG.currency
  const ol=document.getElementById('orderList')
  ol.innerHTML=ST.cart.map(x=>{
    const tab=x.tab; let cs,cc
    if(tab==='learn'){ cs=x.reward>0?'+'+x.reward*x.qty+' '+c.symbol:'무료'; cc='green' }
    else if(tab==='fine'){ cs='-'+x.cost*x.qty+' '+c.unit; cc='red' }
    else{ cs=x.cost*x.qty+' '+c.symbol; cc='purple' }
    return '<div class="order-item">'+
      '<div class="order-emoji">'+x.icon+'</div>'+
      '<div class="order-info">'+
        '<div class="order-lbl">'+x.label+'</div>'+
        '<div class="order-qty">× '+x.qty+(x.requirePhoto?' 📸':'')+'</div>'+
      '</div>'+
      '<div class="order-cost '+cc+'">'+cs+'</div>'+
    '</div>'
  }).join('')
  const tc=calcTotal()
  const tv=document.getElementById('totalVal')
  if(tc===0){ tv.textContent='무료 🎉'; tv.style.color='var(--green)' }
  else if(tc>0){ tv.textContent=tc+' '+c.unit+' 소모'; tv.style.color='var(--red)' }
  else{ tv.textContent=Math.abs(tc)+' '+c.symbol+' 획득!'; tv.style.color='var(--green)' }
  const btn=document.getElementById('confirmOk')
  btn.disabled=false; document.getElementById('confirmTxt').textContent='제출하기'
  btn.querySelector('.spinner')?.remove()
  document.getElementById('confirm-modal').classList.add('open')
}
window.closeConfirm=function(){ document.getElementById('confirm-modal').classList.remove('open') }

function calcTotal(){
  return ST.cart.reduce((a,x)=>{
    if(x.tab==='learn') return a-(x.reward||0)*x.qty
    return a+x.cost*x.qty
  },0)
}

/* ─── 제출 ─── */
window.doSubmit=async function(){
  if(ST.submitting) return
  ST.submitting=true
  const btn=document.getElementById('confirmOk')
  btn.disabled=true; document.getElementById('confirmTxt').textContent='전송 중...'
  const sp=document.createElement('div'); sp.className='spinner'; btn.insertBefore(sp,btn.firstChild)

  const ts=new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})
  const hasFine=ST.cart.some(x=>x.tab==='fine')
  const hasShop=ST.cart.some(x=>x.tab==='shop')
  const category=hasFine?'fine':hasShop?'shop':'learn'
  const tc=calcTotal()
  ST.sessionBalance+=tc
  ST.sessionOrders.push({ items:[...ST.cart], totalCost:tc, ts, category })

  try{
    const res=await fetch('/api/submit',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        name:ST.student, items:ST.cart.map(x=>({icon:x.icon,label:x.label,qty:x.qty,tab:x.tab})),
        totalCost:tc, currency:CFG.currency.unit, category,
        photoBase64:ST.cart.find(x=>x.photo)?.photo||null, timestamp:ts,
      }),
    })
    const data=await res.json()
    closeConfirm(); renderDone(data.slack,data.notion,ts,tc)
  }catch{
    closeConfirm(); renderDone(false,false,ts,tc)
  }finally{ ST.submitting=false }
}

/* ─── 완료 화면 ─── */
function renderDone(slackOk,notionOk,ts,tc){
  const c=CFG.currency
  const hasFine=ST.sessionOrders.at(-1)?.category==='fine'
  const hasShop=ST.sessionOrders.at(-1)?.category==='shop'
  const emoji=hasFine?'😅':hasShop?'🛍️':'🎉'
  document.getElementById('doneEmoji').textContent=emoji
  document.getElementById('doneTitle').textContent=hasFine?'기록 완료!':hasShop?'교환 완료! 🎊':'잘했어요! 🌟'
  document.getElementById('doneSub').innerHTML=
    '<strong>'+ST.student+'</strong>님의 항목이 기록되었어요!<br/>'+
    (tc<0?'<span style="color:var(--green)">'+Math.abs(tc)+' '+c.symbol+' 획득! 🎊</span>':
     tc>0?'<span style="color:var(--red)">'+tc+' '+c.unit+' 차감</span>':
     '<span style="color:var(--green)">무료 활동 ✅</span>')

  // 세션 요약
  const totalItems=ST.cart.reduce((a,x)=>a+x.qty,0)
  const balance=ST.sessionBalance
  const ss=document.getElementById('sessionSummary')
  ss.innerHTML=
    '<div class="ss-title">📊 이번 기록 요약</div>'+
    ssRow('학생',ST.student)+
    ssRow('담은 항목',totalItems+'개')+
    ssRow('이번 합계',tc===0?'무료':Math.abs(tc)+' '+(tc<0?c.symbol+' 획득':c.unit+' 차감'))+
    (ST.sessionOrders.length>1?ssRow('세션 누계',Math.abs(balance)+' '+(balance<=0?c.symbol+' 획득':c.unit+' 차감')):'')

  document.getElementById('doneChips').innerHTML=
    mkChip(slackOk,'fab fa-slack','슬랙')+mkChip(notionOk,'fas fa-database','노션')

  document.getElementById('btnContinueLbl').textContent=ST.student+'님으로 계속 담기 🛒'

  // 보상 획득시 폭죽
  if(tc<=0 && !hasFine) launchConfetti()

  goTo('done')
  autoTimer=setTimeout(()=>goTo('splash'), 28000)
}

window.continueOrder=function(){
  clearTimeout(autoTimer)
  ST.cart=[]; updateCartBar(); renderMenu(); switchTab('learn'); goTo('menu')
}

function ssRow(l,v){ return '<div class="ss-row"><span class="ss-lbl">'+l+'</span><span class="ss-val">'+v+'</span></div>' }
function mkChip(ok,ic,lb){ return '<div class="chip '+(ok?'ok':'fail')+'"><i class="'+ic+'"></i> '+lb+' '+(ok?'✓':'✗')+'</div>' }

/* ─── 폭죽 애니메이션 ─── */
function launchConfetti(){
  const emojis=['⭐','🌟','✨','💫','🎉','🎊','🏆','🌈']
  for(let i=0;i<14;i++){
    setTimeout(()=>{
      const el=document.createElement('div')
      el.className='confetti-piece'
      el.textContent=emojis[Math.floor(Math.random()*emojis.length)]
      el.style.cssText='left:'+Math.random()*100+'%;bottom:10%;animation-duration:'+(1.2+Math.random()*.8)+'s;animation-delay:'+Math.random()*.3+'s;'
      document.body.appendChild(el)
      setTimeout(()=>el.remove(),2500)
    }, i*60)
  }
}

/* ─── 초기화 ─── */
loadCfg()
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
    :root{
      --blue:#29ABE2;--blue-d:#1a90c4;--blue-s:#e8f6fd;--blue-m:#b3dff5;
      --white:#fff;--g50:#f8fafc;--g100:#f1f5f9;--g200:#e2e8f0;
      --g400:#94a3b8;--g600:#475569;--g800:#1e293b;
      --red:#ef4444;--red-s:#fef2f2;
      --green:#22c55e;--green-s:#f0fdf4;
      --yellow:#fbbf24;--yellow-s:#fffbeb;
      --purple:#a855f7;--purple-s:#faf5ff;
      --orange:#f97316;--orange-s:#fff7ed;
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Noto Sans KR',sans-serif;background:var(--g50);color:var(--g800);min-height:100vh;}
    .hdr{background:var(--white);border-bottom:1.5px solid var(--g200);padding:0 clamp(14px,3vw,32px);height:64px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;box-shadow:0 1px 6px rgba(0,0,0,.05);}
    .hdr-l{display:flex;align-items:center;gap:12px;}
    .hdr-l img{height:36px;width:auto;}
    .hdr-ttl{font-size:16px;font-weight:800;color:var(--blue);}
    .btn-kiosk{display:flex;align-items:center;gap:5px;background:var(--blue);color:white;text-decoration:none;font-size:13px;font-weight:700;padding:8px 16px;border-radius:100px;transition:all .2s;box-shadow:0 2px 8px rgba(41,171,226,.25);}
    .btn-kiosk:hover{background:var(--blue-d);}
    .wrap{max-width:1000px;margin:0 auto;padding:clamp(16px,3vw,36px) clamp(14px,3vw,28px);display:flex;flex-direction:column;gap:20px;}
    .card{background:var(--white);border:1.5px solid var(--g200);border-radius:20px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.04);}
    .card-hd{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid var(--g200);background:var(--g50);}
    .card-ttl{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:800;}
    .card-ic{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:14px;}
    .ic-blue{background:var(--blue-s);color:var(--blue);}
    .ic-green{background:var(--green-s);color:var(--green);}
    .ic-red{background:var(--red-s);color:var(--red);}
    .ic-purple{background:var(--purple-s);color:var(--purple);}
    .ic-yellow{background:var(--yellow-s);color:var(--yellow);}
    .card-bd{padding:18px 22px;}

    /* 화폐 */
    .preset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:14px;}
    .preset-btn{background:var(--g50);border:2px solid var(--g200);border-radius:12px;padding:12px 8px;cursor:pointer;text-align:center;transition:all .2s;font-size:13px;font-weight:700;}
    .preset-btn:hover{border-color:var(--blue);background:var(--blue-s);}
    .preset-btn.sel{border-color:var(--blue);background:var(--blue-s);color:var(--blue);}
    .preset-emoji{font-size:24px;display:block;margin-bottom:3px;}
    .cur-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;}
    .lbl{display:block;font-size:12px;font-weight:700;color:var(--g400);margin-bottom:5px;}
    .inp{width:100%;background:var(--g50);border:1.5px solid var(--g200);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:14px;outline:none;transition:all .2s;color:var(--g800);}
    .inp:focus{border-color:var(--blue);box-shadow:0 0 0 2px rgba(41,171,226,.1);}
    .span2{grid-column:1/-1;}

    /* 학생 */
    .stu-list{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto;margin-bottom:12px;}
    .stu-item{display:flex;align-items:center;justify-content:space-between;background:var(--g50);border:1px solid var(--g200);border-radius:12px;padding:9px 14px;transition:all .2s;}
    .stu-item:hover{border-color:var(--blue-m);background:var(--blue-s);}
    .stu-l{display:flex;align-items:center;gap:9px;}
    .s-av{width:28px;height:28px;border-radius:50%;background:var(--blue-s);border:1.5px solid var(--blue-m);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;color:var(--blue-d);}
    .s-nm{font-size:14px;font-weight:700;}
    .add-row{display:flex;gap:8px;}
    .add-inp{flex:1;background:var(--g50);border:1.5px solid var(--g200);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:14px;outline:none;transition:all .2s;color:var(--g800);}
    .add-inp:focus{border-color:var(--blue);}
    .btn-add{background:var(--blue);color:white;border:none;border-radius:10px;font-family:inherit;font-size:13px;font-weight:700;padding:9px 15px;cursor:pointer;white-space:nowrap;transition:all .2s;}
    .btn-add:hover{background:var(--blue-d);}
    .btn-add.red{background:var(--red);}
    .btn-add.red:hover{background:#dc2626;}
    .btn-add.purple{background:var(--purple);}
    .btn-add.purple:hover{background:#9333ea;}
    .btn-del{width:28px;height:28px;border-radius:8px;background:var(--red-s);border:1px solid rgba(239,68,68,.2);color:var(--red);cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;font-size:11px;}
    .btn-del:hover{background:var(--red);color:white;}

    /* 메뉴 항목 */
    .mi{display:grid;align-items:center;gap:7px;background:var(--g50);border:1px solid var(--g200);border-radius:12px;padding:9px 12px;margin-bottom:7px;transition:all .2s;}
    .mi:hover{border-color:var(--blue-m);}
    .mi-l4{grid-template-columns:42px 1fr 88px 32px;}
    .mi-l5{grid-template-columns:42px 1fr 70px 70px 32px;}
    .mi-inp{background:var(--white);border:1.5px solid var(--g200);border-radius:8px;padding:7px 8px;font-family:inherit;font-size:13px;outline:none;transition:all .2s;width:100%;color:var(--g800);}
    .mi-inp:focus{border-color:var(--blue);}
    .mi-ic{text-align:center;font-size:18px;}
    .photo-chk{display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;cursor:pointer;color:var(--orange);white-space:nowrap;}
    .photo-chk input{accent-color:var(--orange);}
    .cost-hint{font-size:10px;color:var(--g400);text-align:center;margin-top:2px;}
    .add-mi-row{display:grid;align-items:center;gap:7px;margin-top:10px;}

    /* 저장 */
    .save-bar{background:var(--white);border:1.5px solid var(--g200);border-radius:20px;padding:16px 22px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;box-shadow:0 1px 4px rgba(0,0,0,.04);}
    .save-hint{font-size:12px;color:var(--g400);}
    .save-btns{display:flex;gap:8px;}
    .btn-reset{background:var(--g100);color:var(--g600);border:1.5px solid var(--g200);border-radius:10px;font-family:inherit;font-size:13px;font-weight:600;padding:9px 15px;cursor:pointer;transition:all .2s;}
    .btn-reset:hover{background:var(--g200);}
    .btn-save{background:linear-gradient(135deg,var(--blue),var(--blue-d));color:white;border:none;border-radius:10px;font-family:inherit;font-size:14px;font-weight:800;padding:11px 26px;cursor:pointer;transition:all .2s;box-shadow:0 4px 14px rgba(41,171,226,.28);display:flex;align-items:center;gap:6px;}
    .btn-save:hover{transform:translateY(-1px);box-shadow:0 6px 22px rgba(41,171,226,.42);}
    .toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) scale(.9);background:var(--g800);color:white;font-size:13px;font-weight:600;padding:10px 22px;border-radius:100px;box-shadow:0 8px 28px rgba(0,0,0,.16);z-index:999;opacity:0;transition:all .3s;white-space:nowrap;}
    .toast.show{opacity:1;transform:translateX(-50%) scale(1);}

    /* 화폐 단위 미리보기 */
    .cur-preview{
      background:linear-gradient(135deg,var(--blue),var(--blue-d));
      color:white; border-radius:14px; padding:14px 18px;
      margin-top:14px; display:flex; align-items:center; gap:12px;
    }
    .cur-preview-sym{font-size:32px;}
    .cur-preview-info{flex:1;}
    .cur-preview-title{font-size:15px;font-weight:900;}
    .cur-preview-sub{font-size:12px;opacity:.8;margin-top:2px;}

    @media(max-width:560px){
      .mi-l4,.mi-l5{grid-template-columns:38px 1fr 80px 28px;}
    }
  </style>
</head>
<body>
<header class="hdr">
  <div class="hdr-l">
    <img src="/static/logo_horizontal.png" alt="바꿈수학"/>
    <div class="hdr-ttl">⚙️ 관리자</div>
  </div>
  <a href="/" class="btn-kiosk"><i class="fas fa-display"></i> 키오스크로</a>
</header>
<div class="wrap">

  <!-- 화폐/보상 단위 -->
  <div class="card">
    <div class="card-hd">
      <div class="card-ttl">
        <div class="card-ic ic-yellow"><i class="fas fa-coins"></i></div>
        화폐 / 보상 단위 설정
      </div>
    </div>
    <div class="card-bd">
      <div style="font-size:12px;color:var(--g400);margin-bottom:10px;">🚀 빠른 선택</div>
      <div class="preset-grid" id="presets"></div>
      <div class="cur-row">
        <div><label class="lbl">단위 이름</label><input class="inp" id="curUnit" placeholder="별" maxlength="10" oninput="updatePreview()"/></div>
        <div><label class="lbl">기호 (이모지)</label><input class="inp" id="curSymbol" placeholder="⭐" maxlength="4" oninput="updatePreview()"/></div>
        <div class="span2"><label class="lbl">스플래시 화면 안내 문구</label><input class="inp" id="curDesc" placeholder="열심히 공부하면 별을 받아요!" maxlength="50"/></div>
      </div>
      <div class="cur-preview" id="curPreview">
        <div class="cur-preview-sym" id="pvSym">⭐</div>
        <div class="cur-preview-info">
          <div class="cur-preview-title" id="pvTitle">별 (⭐)</div>
          <div class="cur-preview-sub" id="pvSub">열심히 공부하면 별을 받아요!</div>
        </div>
      </div>
    </div>
  </div>

  <!-- 학생 목록 -->
  <div class="card">
    <div class="card-hd">
      <div class="card-ttl"><div class="card-ic ic-blue"><i class="fas fa-users"></i></div>학생 목록</div>
      <span style="font-size:12px;color:var(--g400)" id="stuCnt"></span>
    </div>
    <div class="card-bd">
      <div class="stu-list" id="stuList"></div>
      <div class="add-row">
        <input class="add-inp" id="newStu" placeholder="학생 이름 추가..." maxlength="10" onkeydown="if(event.key==='Enter')addStu()"/>
        <button class="btn-add" onclick="addStu()"><i class="fas fa-plus" style="margin-right:4px"></i>추가</button>
      </div>
    </div>
  </div>

  <!-- 학습 활동 -->
  <div class="card">
    <div class="card-hd">
      <div class="card-ttl"><div class="card-ic ic-green"><i class="fas fa-check-circle"></i></div>학습 활동 항목</div>
      <span style="font-size:11px;color:var(--g400)">보상 = 획득 <span id="hintLearn">별</span> 수</span>
    </div>
    <div class="card-bd">
      <div id="learnItems"></div>
      <div class="add-mi-row mi-l5" style="grid-template-columns:42px 1fr 70px 1fr 32px;">
        <input class="mi-inp mi-ic" id="nLIc" placeholder="📖" maxlength="4"/>
        <input class="mi-inp" id="nLLbl" placeholder="항목 이름" maxlength="20" onkeydown="if(event.key==='Enter')addItem('learn')"/>
        <div>
          <input class="mi-inp" id="nLRew" type="number" placeholder="보상" min="0" step="1" style="text-align:right"/>
          <div class="cost-hint">획득</div>
        </div>
        <label class="photo-chk" style="justify-content:center"><input type="checkbox" id="nLPhoto"/> 📸 사진</label>
        <button class="btn-add" style="padding:8px 0;width:100%" onclick="addItem('learn')"><i class="fas fa-plus"></i></button>
      </div>
    </div>
  </div>

  <!-- 벌금 -->
  <div class="card">
    <div class="card-hd">
      <div class="card-ttl"><div class="card-ic ic-red"><i class="fas fa-triangle-exclamation"></i></div>벌금 항목</div>
      <span style="font-size:11px;color:var(--g400)">차감할 <span id="hintFine">별</span> 수</span>
    </div>
    <div class="card-bd">
      <div id="fineItems"></div>
      <div class="add-mi-row mi-l4" style="grid-template-columns:42px 1fr 88px 32px;">
        <input class="mi-inp mi-ic" id="nFIc" placeholder="🔔" maxlength="4"/>
        <input class="mi-inp" id="nFLbl" placeholder="항목 이름" maxlength="20" onkeydown="if(event.key==='Enter')addItem('fine')"/>
        <input class="mi-inp" id="nFCost" type="number" placeholder="차감" min="0" step="1" style="text-align:right"/>
        <button class="btn-add red" style="padding:8px 0;width:100%" onclick="addItem('fine')"><i class="fas fa-plus"></i></button>
      </div>
    </div>
  </div>

  <!-- 보상 상점 -->
  <div class="card">
    <div class="card-hd">
      <div class="card-ttl"><div class="card-ic ic-purple"><i class="fas fa-store"></i></div>🛍️ 보상 상점</div>
      <span style="font-size:11px;color:var(--g400)">구매에 필요한 <span id="hintShop">별</span> 수</span>
    </div>
    <div class="card-bd">
      <div id="shopItems"></div>
      <div class="add-mi-row mi-l4" style="grid-template-columns:42px 1fr 88px 32px;">
        <input class="mi-inp mi-ic" id="nSIc" placeholder="🎁" maxlength="4"/>
        <input class="mi-inp" id="nSLbl" placeholder="항목 이름 (예: 자유시간 10분)" maxlength="20" onkeydown="if(event.key==='Enter')addItem('shop')"/>
        <input class="mi-inp" id="nSCost" type="number" placeholder="비용" min="0" step="1" style="text-align:right"/>
        <button class="btn-add purple" style="padding:8px 0;width:100%" onclick="addItem('shop')"><i class="fas fa-plus"></i></button>
      </div>
    </div>
  </div>

  <!-- 저장 -->
  <div class="save-bar">
    <div class="save-hint">💾 변경사항은 이 기기의 브라우저에 저장됩니다</div>
    <div class="save-btns">
      <button class="btn-reset" onclick="resetAll()"><i class="fas fa-rotate-left" style="margin-right:4px"></i>기본값</button>
      <button class="btn-save" onclick="saveCfg()"><i class="fas fa-floppy-disk"></i>저장하기</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
(function(){
const PRESETS=[
  {unit:'별',    symbol:'⭐',desc:'열심히 공부하면 별을 받아요!'},
  {unit:'코인',  symbol:'🪙',desc:'코인을 모아서 보상을 받아요!'},
  {unit:'포인트',symbol:'💎',desc:'포인트를 쌓아보세요!'},
  {unit:'학습지',symbol:'📄',desc:'학습지로 교환할 수 있어요!'},
  {unit:'시간',  symbol:'⏰',desc:'자유시간을 획득해요!'},
  {unit:'하트',  symbol:'❤️',desc:'하트를 모아봐요!'},
  {unit:'스티커',symbol:'🌟',desc:'스티커를 모아봐요!'},
  {unit:'도장',  symbol:'🔖',desc:'도장을 모아요!'},
]
const DEFAULT={
  currency:{unit:'별',symbol:'⭐',desc:'열심히 공부하면 별을 받아요!'},
  students:['김민준','이서연','박지우','최하은','정도윤','강서현','윤민서','장준혁','임지원','한소율'],
  menu:{
    learn:[
      {id:'study',   icon:'📖',label:'자습 인증하기',   cost:0,reward:2,requirePhoto:false},
      {id:'homework',icon:'✏️',label:'숙제 제출 완료',  cost:0,reward:1,requirePhoto:false},
      {id:'question',icon:'🙋',label:'질문하기',        cost:0,reward:1,requirePhoto:false},
      {id:'record',  icon:'📝',label:'모르는 문제 기록',cost:0,reward:2,requirePhoto:true},
      {id:'material',icon:'📄',label:'추가 학습지 요청',cost:0,reward:0,requirePhoto:false},
    ],
    fine:[
      {id:'callteacher',icon:'🔔',label:'선생님 호출',cost:3,reward:0,requirePhoto:false},
      {id:'lostwork',   icon:'😰',label:'숙제 분실',  cost:4,reward:0,requirePhoto:false},
      {id:'nohomework', icon:'🚫',label:'숙제 안함',  cost:5,reward:0,requirePhoto:false},
    ],
    shop:[
      {id:'snack',    icon:'🍬',label:'간식 교환권',   cost:5, reward:0,requirePhoto:false},
      {id:'sticker',  icon:'🌟',label:'스티커 1장',    cost:2, reward:0,requirePhoto:false},
      {id:'pencil',   icon:'✏️',label:'연필 1자루',    cost:3, reward:0,requirePhoto:false},
      {id:'freetime', icon:'⏱️',label:'자유시간 10분', cost:10,reward:0,requirePhoto:false},
      {id:'worksheet',icon:'📋',label:'학습지 2장',    cost:3, reward:0,requirePhoto:false},
    ],
  },
}
let cfg=JSON.parse(JSON.stringify(DEFAULT))

function load(){
  const s=localStorage.getItem('kiosk_config')
  if(s){ try{ cfg=JSON.parse(s) }catch{ cfg=JSON.parse(JSON.stringify(DEFAULT)) } }
  renderAll()
}
function renderAll(){
  renderPresets()
  renderCurInputs()
  updatePreview()
  renderStudents()
  renderItems('learn'); renderItems('fine'); renderItems('shop')
  updateHints()
}
function updateHints(){
  const u=cfg.currency.unit||'별'
  ;['hintLearn','hintFine','hintShop'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.textContent=u
  })
}

/* 화폐 */
function renderPresets(){
  const g=document.getElementById('presets')
  g.innerHTML=PRESETS.map((p,i)=>{
    const s=cfg.currency.unit===p.unit && cfg.currency.symbol===p.symbol
    return '<div class="preset-btn'+(s?' sel':'')+'" onclick="selPreset('+i+')">'+
      '<span class="preset-emoji">'+p.symbol+'</span>'+p.unit+
    '</div>'
  }).join('')
}
function renderCurInputs(){
  document.getElementById('curUnit').value  =cfg.currency.unit  ||''
  document.getElementById('curSymbol').value=cfg.currency.symbol||''
  document.getElementById('curDesc').value  =cfg.currency.desc  ||''
}
window.selPreset=function(i){
  const p=PRESETS[i]; cfg.currency={unit:p.unit,symbol:p.symbol,desc:p.desc}
  renderPresets(); renderCurInputs(); updatePreview()
  toast('화폐: '+p.symbol+' '+p.unit+' 선택됨')
}
window.updatePreview=function(){
  const sym=document.getElementById('curSymbol').value||'⭐'
  const unit=document.getElementById('curUnit').value||'별'
  const desc=document.getElementById('curDesc').value||'열심히 공부하면 '+unit+'을 받아요!'
  document.getElementById('pvSym').textContent=sym
  document.getElementById('pvTitle').textContent=unit+' ('+sym+')'
  document.getElementById('pvSub').textContent=desc
}

/* 학생 */
function renderStudents(){
  const l=document.getElementById('stuList')
  l.innerHTML=cfg.students.map((n,i)=>
    '<div class="stu-item">'+
      '<div class="stu-l"><div class="s-av">'+n[0]+'</div><div class="s-nm">'+n+'</div></div>'+
      '<button class="btn-del" onclick="delStu('+i+')" title="삭제"><i class="fas fa-trash-can"></i></button>'+
    '</div>'
  ).join('')
  document.getElementById('stuCnt').textContent=cfg.students.length+'명'
}
window.addStu=function(){
  const inp=document.getElementById('newStu'); const n=inp.value.trim()
  if(!n){toast('이름을 입력하세요');return}
  if(cfg.students.includes(n)){toast('이미 있는 학생입니다');return}
  cfg.students.push(n); inp.value=''; renderStudents(); toast('학생 추가: '+n)
}
window.delStu=function(i){
  if(!confirm(cfg.students[i]+' 학생을 삭제할까요?')) return
  cfg.students.splice(i,1); renderStudents()
}

/* 메뉴 항목 */
function renderItems(type){
  const el=document.getElementById(type+'Items')
  const unitLbl=cfg.currency.unit||'별'
  el.innerHTML=cfg.menu[type].map((m,i)=>{
    const photoCb=type==='learn'
      ?'<label class="photo-chk"><input type="checkbox" '+(m.requirePhoto?'checked':'')+' onchange="upd(\''+type+'\','+i+',\'requirePhoto\',this.checked)"/> 📸</label>':''
    const costFld=type==='learn'
      ?'<div><input class="mi-inp" type="number" value="'+(m.reward||0)+'" min="0" step="1" style="text-align:right" onchange="upd(\''+type+'\','+i+',\'reward\',parseInt(this.value)||0)"/><div class="cost-hint">'+unitLbl+' 획득</div></div>'
      :'<input class="mi-inp" type="number" value="'+(m.cost||0)+'" min="0" step="1" style="text-align:right" onchange="upd(\''+type+'\','+i+',\'cost\',parseInt(this.value)||0)"/>'
    const cols=type==='learn'?'42px 1fr 70px 1fr 32px':'42px 1fr 88px 32px'
    return '<div class="mi" style="grid-template-columns:'+cols+'">'+
      '<input class="mi-inp mi-ic" value="'+m.icon+'" maxlength="4" onchange="upd(\''+type+'\','+i+',\'icon\',this.value)"/>'+
      '<input class="mi-inp" value="'+m.label+'" maxlength="20" onchange="upd(\''+type+'\','+i+',\'label\',this.value)"/>'+
      costFld+
      (type==='learn'?photoCb:'')+
      '<button class="btn-del" onclick="delItem(\''+type+'\','+i+')"><i class="fas fa-trash-can"></i></button>'+
    '</div>'
  }).join('')
}
window.upd=function(t,i,f,v){ cfg.menu[t][i][f]=v }
window.delItem=function(t,i){
  if(!confirm(cfg.menu[t][i].label+' 삭제?')) return
  cfg.menu[t].splice(i,1); renderItems(t)
}
window.addItem=function(type){
  const ic=document.getElementById('n'+{learn:'L',fine:'F',shop:'S'}[type]+'Ic')?.value.trim()||''
  const lblEl=document.getElementById('n'+{learn:'L',fine:'F',shop:'S'}[type]+'Lbl')
  const costEl=document.getElementById('n'+{learn:'L',fine:'F',shop:'S'}[type]+(type==='learn'?'Rew':'Cost'))
  const label=lblEl.value.trim()
  if(!label){toast('항목 이름을 입력하세요');return}
  const icon=ic||(type==='learn'?'📋':type==='fine'?'⚠️':'🎁')
  const cost=parseInt(costEl?.value||'0')||0
  const id=type+'_'+Date.now()
  if(type==='learn'){
    const photo=document.getElementById('nLPhoto')?.checked||false
    cfg.menu.learn.push({id,icon,label,cost:0,reward:cost,requirePhoto:photo})
  } else {
    cfg.menu[type].push({id,icon,label,cost,reward:0,requirePhoto:false})
  }
  if(lblEl) lblEl.value=''; if(costEl) costEl.value=''; if(ic) ic.value=''
  ;[document.getElementById('n'+{learn:'L',fine:'F',shop:'S'}[type]+'Ic')].forEach(el=>{ if(el) el.value='' })
  renderItems(type); toast('항목 추가: '+label)
}

/* 저장 */
window.saveCfg=function(){
  cfg.currency.unit  =document.getElementById('curUnit').value.trim()||'별'
  cfg.currency.symbol=document.getElementById('curSymbol').value.trim()||'⭐'
  cfg.currency.desc  =document.getElementById('curDesc').value.trim()
  localStorage.setItem('kiosk_config',JSON.stringify(cfg))
  renderAll(); toast('✅ 저장 완료! 키오스크에 즉시 반영됩니다')
}
window.resetAll=function(){
  if(!confirm('기본값으로 초기화할까요?')) return
  cfg=JSON.parse(JSON.stringify(DEFAULT))
  localStorage.removeItem('kiosk_config')
  renderAll(); toast('기본값으로 초기화됨')
}

function toast(msg){
  const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show')
  setTimeout(()=>t.classList.remove('show'),2500)
}

load()
})()
</script>
</body>
</html>`

export default app
