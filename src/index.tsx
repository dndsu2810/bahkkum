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

// ─── API: 폼 제출 처리 ───────────────────────────────────────────────────────
app.post('/api/submit', async (c) => {
  try {
    const body = await c.req.json()
    const { name, phone, course, level, message, timestamp } = body

    // 필수 필드 검증
    if (!name || !phone || !course) {
      return c.json({ success: false, error: '이름, 연락처, 수강 과목은 필수입니다.' }, 400)
    }

    const results = await Promise.allSettled([
      sendSlackNotification(c.env, { name, phone, course, level, message, timestamp }),
      saveToNotion(c.env, { name, phone, course, level, message, timestamp }),
    ])

    const slackResult = results[0]
    const notionResult = results[1]

    const slackOk = slackResult.status === 'fulfilled' && slackResult.value
    const notionOk = notionResult.status === 'fulfilled' && notionResult.value

    return c.json({
      success: true,
      slack: slackOk,
      notion: notionOk,
      slackError: slackResult.status === 'rejected' ? slackResult.reason?.message : null,
      notionError: notionResult.status === 'rejected' ? notionResult.reason?.message : null,
    })
  } catch (err: any) {
    console.error('Submit error:', err)
    return c.json({ success: false, error: err.message }, 500)
  }
})

// ─── Slack 알림 전송 ──────────────────────────────────────────────────────────
async function sendSlackNotification(
  env: Bindings,
  data: { name: string; phone: string; course: string; level: string; message: string; timestamp: string }
): Promise<boolean> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.warn('SLACK_WEBHOOK_URL not configured')
    return false
  }

  const levelLabel: Record<string, string> = {
    beginner: '🟢 입문',
    intermediate: '🟡 중급',
    advanced: '🔴 고급',
  }

  const courseLabel: Record<string, string> = {
    coding: '💻 코딩/프로그래밍',
    math: '📐 수학/과학',
    english: '🔤 영어/어학',
    art: '🎨 예술/디자인',
    business: '📊 비즈니스/경영',
    other: '📚 기타',
  }

  const slackPayload = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🎓 새로운 학습 신청이 접수되었습니다!',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*👤 이름*\n${data.name}` },
          { type: 'mrkdwn', text: `*📞 연락처*\n${data.phone}` },
          { type: 'mrkdwn', text: `*📚 수강 과목*\n${courseLabel[data.course] || data.course}` },
          { type: 'mrkdwn', text: `*📊 학습 수준*\n${levelLabel[data.level] || data.level || '미선택'}` },
        ],
      },
      ...(data.message
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*💬 추가 메시지*\n${data.message}`,
              },
            },
          ]
        : []),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `⏰ 접수 시각: ${data.timestamp || new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
          },
        ],
      },
      {
        type: 'divider',
      },
    ],
  }

  const response = await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slackPayload),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Slack API error: ${response.status} - ${text}`)
  }
  return true
}

// ─── Notion DB 저장 ───────────────────────────────────────────────────────────
async function saveToNotion(
  env: Bindings,
  data: { name: string; phone: string; course: string; level: string; message: string; timestamp: string }
): Promise<boolean> {
  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) {
    console.warn('Notion credentials not configured')
    return false
  }

  const courseLabel: Record<string, string> = {
    coding: '코딩/프로그래밍',
    math: '수학/과학',
    english: '영어/어학',
    art: '예술/디자인',
    business: '비즈니스/경영',
    other: '기타',
  }

  const levelLabel: Record<string, string> = {
    beginner: '입문',
    intermediate: '중급',
    advanced: '고급',
  }

  const notionPayload = {
    parent: { database_id: env.NOTION_DATABASE_ID },
    properties: {
      이름: {
        title: [{ text: { content: data.name } }],
      },
      연락처: {
        rich_text: [{ text: { content: data.phone } }],
      },
      '수강 과목': {
        select: { name: courseLabel[data.course] || data.course },
      },
      '학습 수준': {
        select: { name: levelLabel[data.level] || data.level || '미선택' },
      },
      '추가 메시지': {
        rich_text: [{ text: { content: data.message || '' } }],
      },
      '접수 일시': {
        date: { start: new Date().toISOString() },
      },
      상태: {
        select: { name: '신청 완료' },
      },
    },
  }

  const response = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify(notionPayload),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Notion API error: ${response.status} - ${text}`)
  }
  return true
}

// ─── 헬스 체크 ────────────────────────────────────────────────────────────────
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    slack: !!c.env.SLACK_WEBHOOK_URL,
    notion: !!(c.env.NOTION_API_KEY && c.env.NOTION_DATABASE_ID),
    timestamp: new Date().toISOString(),
  })
})

// ─── 메인 HTML 페이지 ──────────────────────────────────────────────────────────
app.get('/', (c) => {
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>학습 키오스크</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet" />
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap');

    * { font-family: 'Noto Sans KR', sans-serif; }

    body {
      background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%);
      min-height: 100vh;
    }

    .kiosk-card {
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 24px;
    }

    .step-dot {
      width: 14px; height: 14px;
      border-radius: 50%;
      background: rgba(255,255,255,0.2);
      transition: all 0.4s ease;
    }
    .step-dot.active {
      background: #6366f1;
      box-shadow: 0 0 12px #6366f1;
      transform: scale(1.3);
    }
    .step-dot.done {
      background: #22c55e;
      box-shadow: 0 0 10px #22c55e;
    }

    .course-btn {
      background: rgba(255,255,255,0.07);
      border: 2px solid rgba(255,255,255,0.15);
      border-radius: 20px;
      padding: 28px 20px;
      cursor: pointer;
      transition: all 0.25s ease;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }
    .course-btn:hover {
      background: rgba(99,102,241,0.25);
      border-color: #6366f1;
      transform: translateY(-4px);
      box-shadow: 0 12px 30px rgba(99,102,241,0.3);
    }
    .course-btn.selected {
      background: rgba(99,102,241,0.35);
      border-color: #818cf8;
      box-shadow: 0 0 0 3px rgba(99,102,241,0.3), 0 12px 30px rgba(99,102,241,0.4);
      transform: translateY(-4px);
    }

    .level-btn {
      background: rgba(255,255,255,0.07);
      border: 2px solid rgba(255,255,255,0.15);
      border-radius: 16px;
      padding: 24px 16px;
      cursor: pointer;
      transition: all 0.25s ease;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .level-btn:hover { transform: translateY(-4px); }
    .level-btn.beginner.selected {
      background: rgba(34,197,94,0.25);
      border-color: #22c55e;
      box-shadow: 0 0 0 3px rgba(34,197,94,0.3);
      transform: translateY(-4px);
    }
    .level-btn.intermediate.selected {
      background: rgba(234,179,8,0.25);
      border-color: #eab308;
      box-shadow: 0 0 0 3px rgba(234,179,8,0.3);
      transform: translateY(-4px);
    }
    .level-btn.advanced.selected {
      background: rgba(239,68,68,0.25);
      border-color: #ef4444;
      box-shadow: 0 0 0 3px rgba(239,68,68,0.3);
      transform: translateY(-4px);
    }

    .kiosk-input {
      background: rgba(255,255,255,0.07);
      border: 2px solid rgba(255,255,255,0.15);
      border-radius: 14px;
      color: white;
      font-size: 20px;
      padding: 18px 20px;
      width: 100%;
      transition: all 0.25s ease;
      outline: none;
    }
    .kiosk-input:focus {
      border-color: #6366f1;
      background: rgba(99,102,241,0.1);
      box-shadow: 0 0 0 3px rgba(99,102,241,0.2);
    }
    .kiosk-input::placeholder { color: rgba(255,255,255,0.3); }

    .kiosk-input-phone {
      background: rgba(255,255,255,0.07);
      border: 2px solid rgba(255,255,255,0.15);
      border-radius: 14px;
      color: white;
      font-size: 28px;
      font-weight: 700;
      letter-spacing: 4px;
      padding: 20px 24px;
      width: 100%;
      transition: all 0.25s ease;
      outline: none;
      text-align: center;
    }
    .kiosk-input-phone:focus {
      border-color: #6366f1;
      background: rgba(99,102,241,0.1);
      box-shadow: 0 0 0 3px rgba(99,102,241,0.2);
    }
    .kiosk-input-phone::placeholder { color: rgba(255,255,255,0.3); font-size: 18px; letter-spacing: 1px; }

    .numpad-btn {
      background: rgba(255,255,255,0.08);
      border: 2px solid rgba(255,255,255,0.12);
      border-radius: 14px;
      color: white;
      font-size: 28px;
      font-weight: 700;
      padding: 20px;
      cursor: pointer;
      transition: all 0.15s ease;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    .numpad-btn:hover {
      background: rgba(99,102,241,0.3);
      border-color: #6366f1;
      transform: scale(1.05);
    }
    .numpad-btn:active { transform: scale(0.95); }
    .numpad-btn.del {
      background: rgba(239,68,68,0.15);
      border-color: rgba(239,68,68,0.3);
      font-size: 20px;
    }
    .numpad-btn.del:hover { background: rgba(239,68,68,0.3); border-color: #ef4444; }
    .numpad-btn.clear {
      background: rgba(234,179,8,0.15);
      border-color: rgba(234,179,8,0.3);
      font-size: 16px;
    }
    .numpad-btn.clear:hover { background: rgba(234,179,8,0.3); border-color: #eab308; }

    .btn-primary {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-radius: 16px;
      color: white;
      font-size: 22px;
      font-weight: 700;
      padding: 22px 40px;
      cursor: pointer;
      transition: all 0.25s ease;
      border: none;
      box-shadow: 0 8px 24px rgba(99,102,241,0.4);
    }
    .btn-primary:hover:not(:disabled) {
      transform: translateY(-3px);
      box-shadow: 0 14px 32px rgba(99,102,241,0.5);
    }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

    .btn-secondary {
      background: rgba(255,255,255,0.08);
      border: 2px solid rgba(255,255,255,0.2);
      border-radius: 16px;
      color: rgba(255,255,255,0.7);
      font-size: 20px;
      font-weight: 600;
      padding: 20px 36px;
      cursor: pointer;
      transition: all 0.25s ease;
    }
    .btn-secondary:hover {
      background: rgba(255,255,255,0.15);
      color: white;
    }

    .slide-in { animation: slideIn 0.4s cubic-bezier(0.34,1.56,0.64,1) both; }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(30px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    .pulse-ring {
      animation: pulseRing 2s infinite;
    }
    @keyframes pulseRing {
      0%, 100% { box-shadow: 0 0 0 0 rgba(99,102,241,0.5); }
      50% { box-shadow: 0 0 0 18px rgba(99,102,241,0); }
    }

    .success-animation {
      animation: successPop 0.6s cubic-bezier(0.34,1.56,0.64,1) both;
    }
    @keyframes successPop {
      from { opacity: 0; transform: scale(0.5); }
      to   { opacity: 1; transform: scale(1); }
    }

    .loading-spinner {
      border: 4px solid rgba(255,255,255,0.2);
      border-top: 4px solid white;
      border-radius: 50%;
      width: 32px; height: 32px;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .tag-badge {
      background: rgba(99,102,241,0.2);
      border: 1px solid rgba(99,102,241,0.4);
      border-radius: 9999px;
      padding: 6px 16px;
      font-size: 14px;
      color: #a5b4fc;
    }
  </style>
</head>
<body class="flex items-center justify-center min-h-screen p-4">

  <div id="app" class="w-full max-w-2xl">
    <!-- 동적으로 렌더링됨 -->
  </div>

  <script>
  (function() {
    // ── 상태 관리 ──────────────────────────────────────────────────────────
    const state = {
      step: 0,         // 0:시작, 1:이름, 2:전화번호, 3:과목, 4:수준, 5:메시지, 6:확인, 7:완료
      name: '',
      phone: '',
      course: '',
      level: '',
      message: '',
      submitting: false,
    }

    const totalSteps = 6  // 1~6단계 (진행 표시용)

    const courseOptions = [
      { value: 'coding',   icon: 'fa-laptop-code',   label: '코딩 / 프로그래밍', color: '#6366f1' },
      { value: 'math',     icon: 'fa-square-root-variable', label: '수학 / 과학',  color: '#06b6d4' },
      { value: 'english',  icon: 'fa-language',      label: '영어 / 어학',       color: '#f59e0b' },
      { value: 'art',      icon: 'fa-palette',       label: '예술 / 디자인',     color: '#ec4899' },
      { value: 'business', icon: 'fa-chart-line',    label: '비즈니스 / 경영',   color: '#22c55e' },
      { value: 'other',    icon: 'fa-book-open',     label: '기타',              color: '#8b5cf6' },
    ]

    const levelOptions = [
      { value: 'beginner',     icon: 'fa-seedling',  label: '입문',  sub: '처음 시작해요',    color: '#22c55e', cls: 'beginner' },
      { value: 'intermediate', icon: 'fa-fire',      label: '중급',  sub: '기초는 알아요',    color: '#eab308', cls: 'intermediate' },
      { value: 'advanced',     icon: 'fa-bolt',      label: '고급',  sub: '심화 학습 원해요', color: '#ef4444', cls: 'advanced' },
    ]

    // ── 렌더 헬퍼 ─────────────────────────────────────────────────────────
    function render(html) {
      const app = document.getElementById('app')
      app.innerHTML = html
      app.querySelectorAll('[data-animate]').forEach(el => el.classList.add('slide-in'))
    }

    function progressBar() {
      if (state.step === 0 || state.step === 7) return ''
      const pct = Math.round(((state.step - 1) / totalSteps) * 100)
      const dots = Array.from({length: totalSteps}, (_, i) => {
        const cls = i < state.step - 1 ? 'done' : (i === state.step - 1 ? 'active' : '')
        return \`<div class="step-dot \${cls}"></div>\`
      }).join('')
      return \`
        <div class="mb-8">
          <div class="flex items-center justify-between mb-3">
            <span class="text-white/50 text-sm font-medium">단계 \${state.step} / \${totalSteps}</span>
            <span class="text-white/50 text-sm font-medium">\${pct}%</span>
          </div>
          <div class="w-full bg-white/10 rounded-full h-2 mb-4 overflow-hidden">
            <div class="bg-gradient-to-r from-indigo-500 to-purple-500 h-2 rounded-full transition-all duration-500"
                 style="width:\${pct}%"></div>
          </div>
          <div class="flex items-center gap-2 justify-center">\${dots}</div>
        </div>
      \`
    }

    // ── 단계별 화면 ────────────────────────────────────────────────────────

    // 0단계: 시작 화면
    function renderStart() {
      render(\`
        <div class="kiosk-card p-10 text-center" data-animate>
          <div class="mb-8">
            <div class="inline-flex items-center justify-center w-28 h-28 rounded-full
                        bg-gradient-to-br from-indigo-500 to-purple-600
                        shadow-2xl pulse-ring mb-6">
              <i class="fas fa-graduation-cap text-5xl text-white"></i>
            </div>
            <h1 class="text-5xl font-black text-white mb-3">학습 키오스크</h1>
            <p class="text-white/60 text-xl">원하는 학습 과정을 신청해 보세요</p>
          </div>

          <div class="grid grid-cols-3 gap-4 mb-10">
            <div class="kiosk-card p-5 text-center">
              <i class="fas fa-bolt text-yellow-400 text-2xl mb-2"></i>
              <div class="text-white font-bold">빠른 신청</div>
              <div class="text-white/50 text-sm">2분 내 완료</div>
            </div>
            <div class="kiosk-card p-5 text-center">
              <i class="fas fa-bell text-indigo-400 text-2xl mb-2"></i>
              <div class="text-white font-bold">즉시 알림</div>
              <div class="text-white/50 text-sm">실시간 접수</div>
            </div>
            <div class="kiosk-card p-5 text-center">
              <i class="fas fa-shield-halved text-green-400 text-2xl mb-2"></i>
              <div class="text-white font-bold">안전 보관</div>
              <div class="text-white/50 text-sm">데이터 저장</div>
            </div>
          </div>

          <button class="btn-primary w-full text-2xl py-6" onclick="nextStep()">
            <i class="fas fa-play mr-3"></i>신청 시작하기
          </button>
        </div>
      \`)
    }

    // 1단계: 이름 입력
    function renderName() {
      render(\`
        <div class="kiosk-card p-10" data-animate>
          \${progressBar()}
          <div class="text-center mb-8">
            <div class="inline-flex items-center justify-center w-20 h-20 rounded-full
                        bg-gradient-to-br from-indigo-500 to-purple-600 mb-5 shadow-xl">
              <i class="fas fa-user text-3xl text-white"></i>
            </div>
            <h2 class="text-4xl font-black text-white mb-2">이름을 입력하세요</h2>
            <p class="text-white/50 text-lg">실명을 입력해 주세요</p>
          </div>
          <div class="mb-8">
            <input id="nameInput" type="text" class="kiosk-input text-center text-2xl"
                   placeholder="홍길동" value="\${state.name}"
                   maxlength="20" autocomplete="off" spellcheck="false"
                   oninput="state.name=this.value.trim(); updateNameBtn()"
                   onkeydown="if(event.key==='Enter' && this.value.trim()) nextStep()" />
            <div class="text-center mt-3 text-white/40 text-sm">최대 20자</div>
          </div>
          <div class="flex gap-4">
            <button class="btn-secondary flex-1" onclick="prevStep()">
              <i class="fas fa-chevron-left mr-2"></i>이전
            </button>
            <button id="nameNextBtn" class="btn-primary flex-1"
                    onclick="nextStep()" \${state.name ? '' : 'disabled'}>
              다음 <i class="fas fa-chevron-right ml-2"></i>
            </button>
          </div>
        </div>
      \`)
      const inp = document.getElementById('nameInput')
      if (inp) {
        inp.focus()
        inp.setSelectionRange(inp.value.length, inp.value.length)
      }
    }

    function updateNameBtn() {
      const btn = document.getElementById('nameNextBtn')
      if (btn) btn.disabled = !state.name
    }

    // 2단계: 전화번호 (넘패드)
    function renderPhone() {
      render(\`
        <div class="kiosk-card p-8" data-animate>
          \${progressBar()}
          <div class="text-center mb-6">
            <div class="inline-flex items-center justify-center w-20 h-20 rounded-full
                        bg-gradient-to-br from-cyan-500 to-blue-600 mb-5 shadow-xl">
              <i class="fas fa-phone text-3xl text-white"></i>
            </div>
            <h2 class="text-4xl font-black text-white mb-2">전화번호 입력</h2>
            <p class="text-white/50 text-lg">숫자만 입력해 주세요</p>
          </div>

          <div class="mb-6">
            <input id="phoneDisplay" type="text" class="kiosk-input-phone"
                   placeholder="010 - 0000 - 0000"
                   value="\${formatPhone(state.phone)}"
                   readonly />
          </div>

          <div class="grid grid-cols-3 gap-3 mb-6">
            \${['1','2','3','4','5','6','7','8','9'].map(n =>
              \`<button class="numpad-btn" onclick="phoneInput('\${n}')">\${n}</button>\`
            ).join('')}
            <button class="numpad-btn clear" onclick="phoneClear()">
              <i class="fas fa-rotate-left"></i><br/><span style="font-size:13px">전체삭제</span>
            </button>
            <button class="numpad-btn" onclick="phoneInput('0')">0</button>
            <button class="numpad-btn del" onclick="phoneDel()">
              <i class="fas fa-delete-left"></i>
            </button>
          </div>

          <div class="flex gap-4">
            <button class="btn-secondary flex-1" onclick="prevStep()">
              <i class="fas fa-chevron-left mr-2"></i>이전
            </button>
            <button id="phoneNextBtn" class="btn-primary flex-1"
                    onclick="nextStep()" \${state.phone.length >= 10 ? '' : 'disabled'}>
              다음 <i class="fas fa-chevron-right ml-2"></i>
            </button>
          </div>
        </div>
      \`)
    }

    function formatPhone(raw) {
      const d = raw.replace(/\\D/g,'')
      if (d.length <= 3) return d
      if (d.length <= 7) return d.slice(0,3) + ' - ' + d.slice(3)
      return d.slice(0,3) + ' - ' + d.slice(3,7) + ' - ' + d.slice(7,11)
    }

    function phoneInput(digit) {
      if (state.phone.length >= 11) return
      state.phone += digit
      const el = document.getElementById('phoneDisplay')
      if (el) el.value = formatPhone(state.phone)
      const btn = document.getElementById('phoneNextBtn')
      if (btn) btn.disabled = state.phone.length < 10
    }

    function phoneDel() {
      state.phone = state.phone.slice(0,-1)
      const el = document.getElementById('phoneDisplay')
      if (el) el.value = formatPhone(state.phone)
      const btn = document.getElementById('phoneNextBtn')
      if (btn) btn.disabled = state.phone.length < 10
    }

    function phoneClear() {
      state.phone = ''
      const el = document.getElementById('phoneDisplay')
      if (el) el.value = ''
      const btn = document.getElementById('phoneNextBtn')
      if (btn) btn.disabled = true
    }

    // 3단계: 과목 선택
    function renderCourse() {
      const btns = courseOptions.map(c => \`
        <button class="course-btn \${state.course===c.value?'selected':''}"
                onclick="selectCourse('\${c.value}')">
          <i class="fas \${c.icon} text-4xl" style="color:\${c.color}"></i>
          <span class="text-white font-bold text-lg leading-tight text-center">\${c.label}</span>
          \${state.course===c.value ? '<i class="fas fa-check-circle text-indigo-400 text-xl"></i>' : ''}
        </button>
      \`).join('')

      render(\`
        <div class="kiosk-card p-8" data-animate>
          \${progressBar()}
          <div class="text-center mb-6">
            <div class="inline-flex items-center justify-center w-20 h-20 rounded-full
                        bg-gradient-to-br from-purple-500 to-pink-600 mb-5 shadow-xl">
              <i class="fas fa-book text-3xl text-white"></i>
            </div>
            <h2 class="text-4xl font-black text-white mb-2">수강 과목 선택</h2>
            <p class="text-white/50 text-lg">배우고 싶은 분야를 선택하세요</p>
          </div>
          <div class="grid grid-cols-3 gap-4 mb-8">\${btns}</div>
          <div class="flex gap-4">
            <button class="btn-secondary flex-1" onclick="prevStep()">
              <i class="fas fa-chevron-left mr-2"></i>이전
            </button>
            <button id="courseNextBtn" class="btn-primary flex-1"
                    onclick="nextStep()" \${state.course ? '' : 'disabled'}>
              다음 <i class="fas fa-chevron-right ml-2"></i>
            </button>
          </div>
        </div>
      \`)
    }

    function selectCourse(val) {
      state.course = val
      renderCourse()
    }

    // 4단계: 수준 선택
    function renderLevel() {
      const btns = levelOptions.map(l => \`
        <button class="level-btn \${l.cls} \${state.level===l.value?'selected':''}"
                onclick="selectLevel('\${l.value}')">
          <div class="flex items-center justify-center w-16 h-16 rounded-full mb-2"
               style="background:rgba(\${l.value==='beginner'?'34,197,94':l.value==='intermediate'?'234,179,8':'239,68,68'},0.2);border:2px solid \${l.color}">
            <i class="fas \${l.icon} text-2xl" style="color:\${l.color}"></i>
          </div>
          <span class="text-white font-black text-2xl">\${l.label}</span>
          <span class="text-white/60 text-sm">\${l.sub}</span>
          \${state.level===l.value ? \`<i class="fas fa-check-circle text-xl" style="color:\${l.color}"></i>\` : ''}
        </button>
      \`).join('')

      render(\`
        <div class="kiosk-card p-8" data-animate>
          \${progressBar()}
          <div class="text-center mb-6">
            <div class="inline-flex items-center justify-center w-20 h-20 rounded-full
                        bg-gradient-to-br from-orange-500 to-red-600 mb-5 shadow-xl">
              <i class="fas fa-signal text-3xl text-white"></i>
            </div>
            <h2 class="text-4xl font-black text-white mb-2">현재 학습 수준</h2>
            <p class="text-white/50 text-lg">지금 나의 실력은 어느 정도인가요?</p>
          </div>
          <div class="grid grid-cols-3 gap-4 mb-8">\${btns}</div>
          <div class="flex gap-4">
            <button class="btn-secondary flex-1" onclick="prevStep()">
              <i class="fas fa-chevron-left mr-2"></i>이전
            </button>
            <button id="levelNextBtn" class="btn-primary flex-1"
                    onclick="nextStep()" \${state.level ? '' : 'disabled'}>
              다음 <i class="fas fa-chevron-right ml-2"></i>
            </button>
          </div>
        </div>
      \`)
    }

    function selectLevel(val) {
      state.level = val
      renderLevel()
    }

    // 5단계: 추가 메시지
    function renderMessage() {
      render(\`
        <div class="kiosk-card p-10" data-animate>
          \${progressBar()}
          <div class="text-center mb-8">
            <div class="inline-flex items-center justify-center w-20 h-20 rounded-full
                        bg-gradient-to-br from-emerald-500 to-teal-600 mb-5 shadow-xl">
              <i class="fas fa-comment-dots text-3xl text-white"></i>
            </div>
            <h2 class="text-4xl font-black text-white mb-2">추가 메시지</h2>
            <p class="text-white/50 text-lg">궁금한 점이나 요청 사항을 입력하세요 (선택)</p>
          </div>
          <div class="mb-8">
            <textarea id="msgInput" class="kiosk-input text-lg"
                      style="min-height:140px;resize:none;line-height:1.7"
                      placeholder="예) 주말 오전 수업 원합니다 / 개인 레슨 문의 / 기타 궁금한 점..."
                      maxlength="300"
                      oninput="state.message=this.value">\${state.message}</textarea>
            <div class="flex justify-between mt-2 text-white/30 text-sm">
              <span>선택 사항입니다</span>
              <span id="msgCount">\${state.message.length}/300</span>
            </div>
          </div>
          <div class="flex gap-4">
            <button class="btn-secondary flex-1" onclick="prevStep()">
              <i class="fas fa-chevron-left mr-2"></i>이전
            </button>
            <button class="btn-primary flex-1" onclick="nextStep()">
              다음 <i class="fas fa-chevron-right ml-2"></i>
            </button>
          </div>
        </div>
      \`)
      const ta = document.getElementById('msgInput')
      if (ta) {
        ta.addEventListener('input', () => {
          const c = document.getElementById('msgCount')
          if (c) c.textContent = ta.value.length + '/300'
        })
      }
    }

    // 6단계: 최종 확인
    function renderConfirm() {
      const cLabel = { coding:'💻 코딩/프로그래밍', math:'📐 수학/과학', english:'🔤 영어/어학', art:'🎨 예술/디자인', business:'📊 비즈니스/경영', other:'📚 기타' }
      const lLabel = { beginner:'🟢 입문', intermediate:'🟡 중급', advanced:'🔴 고급' }

      render(\`
        <div class="kiosk-card p-10" data-animate>
          \${progressBar()}
          <div class="text-center mb-8">
            <div class="inline-flex items-center justify-center w-20 h-20 rounded-full
                        bg-gradient-to-br from-violet-500 to-indigo-600 mb-5 shadow-xl">
              <i class="fas fa-clipboard-check text-3xl text-white"></i>
            </div>
            <h2 class="text-4xl font-black text-white mb-2">신청 내용 확인</h2>
            <p class="text-white/50 text-lg">입력하신 내용을 확인해 주세요</p>
          </div>

          <div class="space-y-4 mb-8">
            <div class="flex items-center justify-between p-5 rounded-2xl"
                 style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1)">
              <span class="text-white/60 text-lg flex items-center gap-2">
                <i class="fas fa-user w-6 text-center text-indigo-400"></i>이름
              </span>
              <span class="text-white font-bold text-xl">\${state.name}</span>
            </div>
            <div class="flex items-center justify-between p-5 rounded-2xl"
                 style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1)">
              <span class="text-white/60 text-lg flex items-center gap-2">
                <i class="fas fa-phone w-6 text-center text-cyan-400"></i>연락처
              </span>
              <span class="text-white font-bold text-xl">\${formatPhone(state.phone)}</span>
            </div>
            <div class="flex items-center justify-between p-5 rounded-2xl"
                 style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1)">
              <span class="text-white/60 text-lg flex items-center gap-2">
                <i class="fas fa-book w-6 text-center text-purple-400"></i>수강 과목
              </span>
              <span class="text-white font-bold text-xl">\${cLabel[state.course]||state.course}</span>
            </div>
            <div class="flex items-center justify-between p-5 rounded-2xl"
                 style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1)">
              <span class="text-white/60 text-lg flex items-center gap-2">
                <i class="fas fa-signal w-6 text-center text-orange-400"></i>학습 수준
              </span>
              <span class="text-white font-bold text-xl">\${lLabel[state.level]||state.level||'미선택'}</span>
            </div>
            \${state.message ? \`
            <div class="p-5 rounded-2xl"
                 style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1)">
              <div class="text-white/60 text-lg flex items-center gap-2 mb-2">
                <i class="fas fa-comment-dots w-6 text-center text-emerald-400"></i>추가 메시지
              </div>
              <div class="text-white text-lg leading-relaxed">\${state.message}</div>
            </div>
            \` : ''}
          </div>

          <div class="flex gap-4">
            <button class="btn-secondary flex-1" onclick="prevStep()" \${state.submitting?'disabled':''}>
              <i class="fas fa-chevron-left mr-2"></i>수정하기
            </button>
            <button id="submitBtn" class="btn-primary flex-1" onclick="submitForm()" \${state.submitting?'disabled':''}>
              \${state.submitting
                ? '<div class="loading-spinner mx-auto"></div>'
                : '<i class="fas fa-paper-plane mr-2"></i>신청 완료'}
            </button>
          </div>
        </div>
      \`)
    }

    // 7단계: 완료
    function renderDone(slackOk, notionOk) {
      render(\`
        <div class="kiosk-card p-10 text-center" data-animate>
          <div class="mb-8">
            <div class="inline-flex items-center justify-center w-32 h-32 rounded-full
                        bg-gradient-to-br from-green-400 to-emerald-600
                        shadow-2xl success-animation mb-6">
              <i class="fas fa-check text-6xl text-white"></i>
            </div>
            <h2 class="text-5xl font-black text-white mb-3">신청 완료!</h2>
            <p class="text-white/60 text-xl">학습 신청이 성공적으로 접수되었습니다</p>
          </div>

          <div class="grid grid-cols-2 gap-4 mb-8">
            <div class="p-5 rounded-2xl \${slackOk
                ? 'bg-green-500/10 border border-green-500/30'
                : 'bg-red-500/10 border border-red-500/30'}">
              <i class="fab fa-slack text-3xl mb-2 block \${slackOk?'text-green-400':'text-red-400'}"></i>
              <div class="text-white font-bold">슬랙 알림</div>
              <div class="\${slackOk?'text-green-400':'text-red-400'} text-sm mt-1">
                \${slackOk ? '✅ 전송 완료' : '❌ 전송 실패'}
              </div>
            </div>
            <div class="p-5 rounded-2xl \${notionOk
                ? 'bg-green-500/10 border border-green-500/30'
                : 'bg-red-500/10 border border-red-500/30'}">
              <i class="fas fa-database text-3xl mb-2 block \${notionOk?'text-green-400':'text-red-400'}"></i>
              <div class="text-white font-bold">노션 저장</div>
              <div class="\${notionOk?'text-green-400':'text-red-400'} text-sm mt-1">
                \${notionOk ? '✅ 저장 완료' : '❌ 저장 실패'}
              </div>
            </div>
          </div>

          <div class="kiosk-card p-6 mb-8 text-left space-y-3">
            <div class="text-white/50 text-sm font-semibold uppercase tracking-wider mb-3">접수 요약</div>
            <div class="flex justify-between items-center">
              <span class="text-white/60">이름</span>
              <span class="text-white font-bold">\${state.name}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-white/60">연락처</span>
              <span class="text-white font-bold">\${formatPhone(state.phone)}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-white/60">과목</span>
              <span class="text-white font-bold">\${{ coding:'코딩/프로그래밍', math:'수학/과학', english:'영어/어학', art:'예술/디자인', business:'비즈니스/경영', other:'기타' }[state.course]||state.course}</span>
            </div>
          </div>

          <button class="btn-primary w-full text-xl py-6" onclick="resetForm()">
            <i class="fas fa-rotate-left mr-3"></i>새로운 신청 시작
          </button>
        </div>
      \`)
    }

    // ── 네비게이션 ─────────────────────────────────────────────────────────
    function nextStep() { state.step++; renderStep() }
    function prevStep() { state.step--; renderStep() }

    function renderStep() {
      switch(state.step) {
        case 0: renderStart();   break
        case 1: renderName();    break
        case 2: renderPhone();   break
        case 3: renderCourse();  break
        case 4: renderLevel();   break
        case 5: renderMessage(); break
        case 6: renderConfirm(); break
        default: renderStart();
      }
    }

    // ── 폼 제출 ────────────────────────────────────────────────────────────
    async function submitForm() {
      if (state.submitting) return
      state.submitting = true
      renderConfirm()

      const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })

      try {
        const res = await fetch('/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: state.name,
            phone: state.phone,
            course: state.course,
            level: state.level,
            message: state.message,
            timestamp,
          }),
        })
        const data = await res.json()
        state.step = 7
        renderDone(data.slack, data.notion)
      } catch (err) {
        state.submitting = false
        alert('오류가 발생했습니다. 다시 시도해 주세요.')
        renderConfirm()
      }
    }

    function resetForm() {
      state.step = 0
      state.name = ''
      state.phone = ''
      state.course = ''
      state.level = ''
      state.message = ''
      state.submitting = false
      renderStep()
    }

    // 전역 바인딩
    window.nextStep    = nextStep
    window.prevStep    = prevStep
    window.selectCourse = selectCourse
    window.selectLevel  = selectLevel
    window.phoneInput   = phoneInput
    window.phoneDel     = phoneDel
    window.phoneClear   = phoneClear
    window.submitForm   = submitForm
    window.resetForm    = resetForm
    window.state        = state
    window.formatPhone  = formatPhone
    window.updateNameBtn = updateNameBtn

    // 시작
    renderStep()
  })()
  </script>
</body>
</html>`
  return c.html(html)
})

export default app
