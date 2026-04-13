import { Hono } from 'hono'

import { cors } from 'hono/cors'

import { serveStatic } from 'hono/cloudflare-workers'



type Bindings = {

  DB: D1Database

  SLACK_WEBHOOK_URL: string

  SLACK_BOT_TOKEN: string

  SLACK_CHANNEL_ID: string

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



// 키오스크 설정 조회 (DB 우선, 없으면 DEFAULT_CONFIG)
app.get('/api/config', async (c) => {

  try {

    const row = await c.env.DB.prepare(

      "SELECT value FROM app_config WHERE key='kiosk_config'"

    ).first() as any

    if (row?.value) {

      return c.json(JSON.parse(row.value))

    }

  } catch (_) {}

  return c.json(DEFAULT_CONFIG)

})



// 관리자 설정 저장 (DB에 저장 → 모든 기기에서 즉시 반영)
app.post('/api/admin/config', async (c) => {

  try {

    const body = await c.req.json()

    await c.env.DB.prepare(

      "INSERT INTO app_config (key, value, updated_at) VALUES ('kiosk_config', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"

    ).bind(JSON.stringify(body)).run()

    return c.json({ success: true })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 상점 잠금 상태 조회 (키오스크용) ──────────────────────────────────────────
// 시간 범위 체크 헬퍼
function checkSlots(slots: any[], dayName: string, hhmm: number): boolean {
  for (const slot of slots) {
    if ((slot.day || '') !== dayName) continue
    const [sh, sm] = (slot.start || '00:00').split(':').map(Number)
    const [eh, em] = (slot.end || '00:00').split(':').map(Number)
    if (hhmm >= sh * 100 + sm && hhmm < eh * 100 + em) return true
  }
  return false
}

function parseSlots(value: string): any[] {
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed.schedule)) return parsed.schedule
    if (Array.isArray(parsed.slots)) return parsed.slots
  } catch (_) {}
  return []
}

app.get('/api/shop/status', async (c) => {

  try {
    // student_id 쿼리 파라미터 (있으면 학생별 스케줄 우선, 없으면 전체 스케줄)
    const studentId = c.req.query('student_id')

    const DAYS_KO = ['일','월','화','수','목','금','토']
    const now = new Date(Date.now() + 9 * 3600 * 1000)
    const dayName = DAYS_KO[now.getUTCDay()]
    const hhmm = now.getUTCHours() * 100 + now.getUTCMinutes()

    let isClassTime = false

    if (studentId) {
      // 1순위: 학생 개인 시간표
      const stuSched = await c.env.DB.prepare(
        'SELECT schedule_json FROM student_schedules WHERE student_id=?'
      ).bind(studentId).first() as any

      if (stuSched?.schedule_json) {
        const slots = parseSlots(stuSched.schedule_json)
        if (slots.length > 0) {
          isClassTime = checkSlots(slots, dayName, hhmm)
        } else {
          // 개인 시간표가 비어있으면 전체 시간표 fallback
          const globalSched = await c.env.DB.prepare(
            "SELECT value FROM app_config WHERE key='class_schedule'"
          ).first() as any
          if (globalSched?.value) isClassTime = checkSlots(parseSlots(globalSched.value), dayName, hhmm)
        }
      } else {
        // 개인 시간표 없으면 전체 시간표
        const globalSched = await c.env.DB.prepare(
          "SELECT value FROM app_config WHERE key='class_schedule'"
        ).first() as any
        if (globalSched?.value) isClassTime = checkSlots(parseSlots(globalSched.value), dayName, hhmm)
      }
    } else {
      // student_id 없으면 전체 시간표
      const schedRow = await c.env.DB.prepare(
        "SELECT value FROM app_config WHERE key='class_schedule'"
      ).first() as any
      if (schedRow?.value) isClassTime = checkSlots(parseSlots(schedRow.value), dayName, hhmm)
    }

    // 잠금해제 요청: student_id가 있으면 해당 학생 것만 확인
    let unlockQuery = "SELECT * FROM shop_unlock_requests WHERE status='approved' AND expires_at > datetime('now')"
    let unlockRow: any
    if (studentId) {
      unlockRow = await c.env.DB.prepare(unlockQuery + ' AND student_id=? ORDER BY expires_at DESC LIMIT 1')
        .bind(studentId).first() as any
      // 학생 id 매칭 안 되면 전체 승인도 확인
      if (!unlockRow) {
        unlockRow = await c.env.DB.prepare(unlockQuery + ' AND student_id IS NULL ORDER BY expires_at DESC LIMIT 1')
          .first() as any
      }
    } else {
      unlockRow = await c.env.DB.prepare(unlockQuery + ' ORDER BY expires_at DESC LIMIT 1').first() as any
    }

    const unlocked = !!unlockRow
    const expiresAt = unlockRow?.expires_at || null

    // 강제 잠금 상태 확인
    const forceLockRow = await c.env.DB.prepare(
      "SELECT value FROM app_config WHERE key='force_lock'"
    ).first() as any
    const forceLocked = forceLockRow?.value === '1'

    // 완전 오픈 상태 확인 (관리자가 시간 제한 없이 열어둔 경우)
    const forceOpenRow = await c.env.DB.prepare(
      "SELECT value FROM app_config WHERE key='force_open'"
    ).first() as any
    const forceOpen = forceOpenRow?.value === '1'

    // 잠금 여부 계산
    // force_open이면 무조건 열림
    // forceLocked 또는 수업시간이면 잠김 (단, unlocked 승인이 있으면 열림)
    const locked = !forceOpen && (forceLocked || isClassTime) && !unlocked

    return c.json({ success: true, isClassTime, forceLocked, forceOpen, locked, unlocked, expiresAt })

  } catch (e: any) {

    return c.json({ success: true, isClassTime: false, locked: false, unlocked: false, expiresAt: null })

  }

})



// ── 상점 잠금해제 요청 (키오스크) ─────────────────────────────────────────────
app.post('/api/shop/request-unlock', async (c) => {

  try {

    const { studentName, studentId } = await c.req.json()

    if (!studentName) return c.json({ success: false, error: '학생 이름 필요' }, 400)

    const existing = await c.env.DB.prepare(
      "SELECT id FROM shop_unlock_requests WHERE status='pending' AND student_name=? AND requested_at > datetime('now','-5 minutes')"
    ).bind(studentName).first() as any

    if (existing) return c.json({ success: true, requestId: existing.id, alreadyPending: true })

    const result = await c.env.DB.prepare(
      "INSERT INTO shop_unlock_requests (student_name, student_id, status) VALUES (?, ?, 'pending')"
    ).bind(studentName, studentId || null).run() as any

    try { await sendShopUnlockSlack(c.env, studentName) } catch (_) {}

    return c.json({ success: true, requestId: result.meta?.last_row_id })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 관리자: 잠금해제 승인 ─────────────────────────────────────────────────────
app.post('/api/admin/shop/unlock', async (c) => {

  try {

    const { requestId, minutes } = await c.req.json()

    const mins = minutes || 10

    await c.env.DB.prepare(
      `UPDATE shop_unlock_requests SET status='approved', unlocked_at=datetime('now'), expires_at=datetime('now','+${mins} minutes') WHERE id=?`
    ).bind(requestId).run()

    return c.json({ success: true, minutes: mins })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 관리자: 상점 즉시 잠금 ────────────────────────────────────────────────────
// ── 관리자: 상점 직접 열기 (승인 요청 없이) ───────────────────────────────────
app.post('/api/admin/shop/direct-unlock', async (c) => {
  try {
    const { minutes = 10, mode = 'timed' } = await c.req.json()
    // force_lock 해제
    await c.env.DB.prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES ('force_lock', '0', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=CURRENT_TIMESTAMP"
    ).run()
    // 기존 승인된 것 만료 처리
    await c.env.DB.prepare(
      "UPDATE shop_unlock_requests SET status='expired' WHERE status='approved'"
    ).run()
if (mode === 'schedule') {
      // 시간표 모드: 강제 잠금/오픈 모두 해제 → 시간표가 자동 운영
      await c.env.DB.prepare(
        "INSERT INTO app_config (key, value, updated_at) VALUES ('force_lock', '0', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=CURRENT_TIMESTAMP"
      ).run()
      await c.env.DB.prepare(
        "INSERT INTO app_config (key, value, updated_at) VALUES ('force_open', '0', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=CURRENT_TIMESTAMP"
      ).run()
      await c.env.DB.prepare(
        "UPDATE shop_unlock_requests SET status='expired' WHERE status='approved'"
      ).run()
      return c.json({ success: true, mode: 'schedule' })
    }
    if (mode === 'permanent') {
      // 완전 오픈: force_open=1 저장 (시간 제한 없음)
      await c.env.DB.prepare(
        "INSERT INTO app_config (key, value, updated_at) VALUES ('force_open', '1', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='1', updated_at=CURRENT_TIMESTAMP"
      ).run()
    } else {
      // 시간 제한 열기
      const mins = Math.max(1, Math.min(480, parseInt(minutes) || 10))
      await c.env.DB.prepare(
        "INSERT INTO app_config (key, value, updated_at) VALUES ('force_open', '0', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=CURRENT_TIMESTAMP"
      ).run()
      await c.env.DB.prepare(
        `INSERT INTO shop_unlock_requests (student_name, student_id, status, unlocked_at, expires_at) VALUES ('관리자 직접 열기', NULL, 'approved', datetime('now'), datetime('now','+${mins} minutes'))`
      ).run()
    }
    return c.json({ success: true, mode })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

app.post('/api/admin/shop/lock', async (c) => {
  try {
    // 강제 잠금 ON + force_open OFF
    await c.env.DB.prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES ('force_lock', '1', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='1', updated_at=CURRENT_TIMESTAMP"
    ).run()
    await c.env.DB.prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES ('force_open', '0', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value='0', updated_at=CURRENT_TIMESTAMP"
    ).run()
    // 열려있는 잠금해제 요청도 모두 만료
    await c.env.DB.prepare(
      "UPDATE shop_unlock_requests SET status='expired' WHERE status='approved'"
    ).run()
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})



// ── 관리자: 잠금해제 요청 목록 ────────────────────────────────────────────────
app.get('/api/admin/shop/requests', async (c) => {

  try {

    const rows = await c.env.DB.prepare(
      "SELECT * FROM shop_unlock_requests ORDER BY requested_at DESC LIMIT 50"
    ).all()

    return c.json({ success: true, requests: rows.results })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 관리자: 수업 시간표 저장 ──────────────────────────────────────────────────
// ── 수업 시간표 조회 ──────────────────────────────────────────────────────────
app.get('/api/admin/shop/schedule', async (c) => {
  try {
    const row = await c.env.DB.prepare(
      "SELECT value FROM app_config WHERE key='class_schedule'"
    ).first<{ value: string }>()
    if (!row) return c.json({ success: true, schedule: [] })
    const parsed = JSON.parse(row.value)
    // body가 {schedule:[...]} 형태이거나 그냥 배열인 경우 모두 처리
    const schedule = Array.isArray(parsed) ? parsed : (parsed.schedule || [])
    return c.json({ success: true, schedule })
  } catch (e: any) {
    return c.json({ success: false, schedule: [], error: e.message })
  }
})

app.post('/api/admin/shop/schedule', async (c) => {

  try {

    const body = await c.req.json()

    await c.env.DB.prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES ('class_schedule', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP"
    ).bind(JSON.stringify(body)).run()

    return c.json({ success: true })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 상점 잠금해제 Slack 알림 ──────────────────────────────────────────────────
async function sendShopUnlockSlack(env: Bindings, studentName: string) {
// 상점 남은 재고 조회 (키오스크용)
app.get('/api/shop/stock', async (c) => {
  try {
    const today = getKSTDate()
    const monthKey = today.slice(0, 7)
    const rows = await c.env.DB.prepare(
      "SELECT item_id, remaining_stock, initial_stock FROM shop_stock WHERE month_key=?"
    ).bind(monthKey).all()
    const stock: Record<string, { remaining: number; initial: number }> = {}
    for (const row of (rows.results as any[])) {
      stock[row.item_id] = { remaining: Number(row.remaining_stock), initial: Number(row.initial_stock) }
    }
    return c.json({ success: true, stock, monthKey })
  } catch (e: any) {
    return c.json({ success: false, stock: {}, error: e.message })
  }
})
 
// 이번 달 재고 채우기 (관리자용)
app.post('/api/admin/shop/restock', async (c) => {
  try {
    const today = getKSTDate()
    const monthKey = today.slice(0, 7)
    const configRow = await c.env.DB.prepare(
      "SELECT value FROM app_config WHERE key='kiosk_config'"
    ).first() as any
    if (!configRow?.value) return c.json({ success: false, error: '설정 없음' }, 400)
    const config = JSON.parse(configRow.value)
    const shopItems: any[] = config.menu?.shop || []
    let count = 0
    for (const item of shopItems) {
      if ((item.monthlyStock || 0) > 0) {
        await c.env.DB.prepare(
          `INSERT INTO shop_stock (item_id, month_key, initial_stock, remaining_stock, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(item_id, month_key) DO UPDATE SET
           initial_stock = excluded.initial_stock,
           remaining_stock = excluded.remaining_stock,
           updated_at = CURRENT_TIMESTAMP`
        ).bind(item.id, monthKey, item.monthlyStock, item.monthlyStock).run()
        count++
      }
    }
    return c.json({ success: true, monthKey, itemsRestocked: count })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})
 

  if (!env.SLACK_WEBHOOK_URL) return

  const now = new Date(Date.now() + 9 * 3600 * 1000)
  const timeStr = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`

  await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🛍️ 상점 주문 승인 요청', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `*👤 학생:* ${studentName}\n*⏰ 요청 시각:* ${timeStr}\n\n관리자 페이지에서 승인하면 10분간 주문 가능합니다.` } },
        { type: 'divider' },
      ]
    })
  })

}



// 학생 목록 (포인트 + 벌금 유형별 집계 포함)

app.get('/api/students', async (c) => {

  try {

    const rows = await c.env.DB.prepare(`

      SELECT s.id, s.name, s.photo_url, s.points,

        COALESCE(SUM(CASE WHEN f.paid=0 THEN f.amount ELSE 0 END),0) AS unpaid_fines,

        COUNT(CASE WHEN f.paid=0 THEN 1 END) AS fine_count,

        COALESCE(SUM(CASE WHEN f.paid=0 AND f.fine_type='time' THEN f.amount ELSE 0 END),0) AS fine_time,

        COALESCE(SUM(CASE WHEN f.paid=0 AND f.fine_type='sheet' THEN f.amount ELSE 0 END),0) AS fine_sheet,

        COALESCE(SUM(CASE WHEN f.paid=0 AND f.fine_type='point' THEN f.amount ELSE 0 END),0) AS fine_point

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

    // 벌금 유형별 미납 합계

    const fineStats = await c.env.DB.prepare(`

      SELECT

        COALESCE(SUM(CASE WHEN fine_type='time' AND paid=0 THEN amount ELSE 0 END),0) AS fine_time,

        COALESCE(SUM(CASE WHEN fine_type='sheet' AND paid=0 THEN amount ELSE 0 END),0) AS fine_sheet,

        COALESCE(SUM(CASE WHEN fine_type='point' AND paid=0 THEN amount ELSE 0 END),0) AS fine_point

      FROM fines WHERE student_id=?

    `).bind(id).first()

    return c.json({ success: true, student: stu, history: history.results, fines: fines.results, fineStats })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// 키오스크 제출 (포인트 자동 반영)

app.post('/api/submit', async (c) => {

  try {

    const body = await c.req.json()

    const { name, items, totalCost, currency, category, timestamp, photoBase64, comment } = body

    if (!name || !items) return c.json({ success: false, error: '필수 값 누락' }, 400)



    // D1: 학생 찾기

    // 상점 구매 시 한도/재고 체크
    if (category === 'shop') {
      const today = getKSTDate()
      const monthKey = today.slice(0, 7)
      try {
        const configRow = await c.env.DB.prepare(
          "SELECT value FROM app_config WHERE key='kiosk_config'"
        ).first() as any
        if (configRow?.value) {
          const config = JSON.parse(configRow.value)
          const shopItems: any[] = config.menu?.shop || []
          for (const item of items) {
            const menuItem = shopItems.find((s: any) => s.id === item.id)
            if (!menuItem) continue
            if ((menuItem.dailyLimit || 0) > 0) {
              const logRow = await c.env.DB.prepare(
                "SELECT COALESCE(SUM(qty),0) as total FROM shop_purchase_log WHERE item_id=? AND purchase_date=? AND student_name=?"
              ).bind(item.id, today, name).first() as any
              const used = Number(logRow?.total || 0)
              if (used + item.qty > menuItem.dailyLimit) {
                return c.json({ success: false, error: `${item.label}: 오늘 구매 한도(하루 ${menuItem.dailyLimit}개)를 초과했어요` }, 400)
              }
            }
            if ((menuItem.monthlyStock || 0) > 0) {
              const stockRow = await c.env.DB.prepare(
                "SELECT remaining_stock FROM shop_stock WHERE item_id=? AND month_key=?"
              ).bind(item.id, monthKey).first() as any
              if (stockRow !== null && stockRow !== undefined) {
                if (Number(stockRow.remaining_stock) < item.qty) {
                  return c.json({ success: false, error: `${item.label}: 이번 달 재고가 부족해요 (남은 수량: ${stockRow.remaining_stock}개)` }, 400)
                }
              }
            }
          }
        }
      } catch (_) {}
    }
    const stu = await c.env.DB.prepare('SELECT * FROM students WHERE name=?').bind(name).first() as any

    if (stu) {

      const delta = -(totalCost) // totalCost가 음수면 획득, 양수면 차감

      await c.env.DB.prepare('UPDATE students SET points = points + ? WHERE id=?').bind(delta, stu.id).run()

      const reason = items.map((x) => `${x.icon}${x.label}×${x.qty}`).join(', ')

      await c.env.DB.prepare(

        'INSERT INTO point_history (student_id, delta, reason, category) VALUES (?,?,?,?)'

      ).bind(stu.id, delta, reason, category).run()

      if (category === 'fine') {

        for (const item of items) {

          // item.fineType: 'point'|'time'|'sheet' (항목별 화폐 유형)
          const fineType = item.fineType || 'point'
          const unitLabel = item.unit || currency

          await c.env.DB.prepare(

            'INSERT INTO fines (student_id, label, amount, unit, fine_type) VALUES (?,?,?,?,?)'

          ).bind(stu.id, `${item.icon} ${item.label}`, item.qty, unitLabel, fineType).run()

        }

      }

    }
 // 상점 구매 로그 기록 (한도 체크 & 재고 차감)
      if (category === 'shop') {
        const today = getKSTDate()
        const monthKey = today.slice(0, 7)
        for (const item of items) {
          try {
            await c.env.DB.prepare(
              "INSERT INTO shop_purchase_log (item_id, student_id, student_name, qty, purchase_date) VALUES (?,?,?,?,?)"
            ).bind(item.id || item.label, stu.id, name, item.qty, today).run()
            await c.env.DB.prepare(
              "UPDATE shop_stock SET remaining_stock = MAX(0, remaining_stock - ?), updated_at = CURRENT_TIMESTAMP WHERE item_id=? AND month_key=?"
            ).bind(item.qty, item.id || item.label, monthKey).run()
          } catch (_) {}
        }
      }


    const [slackR, notionR] = await Promise.allSettled([

      sendSlack(c.env, { name, items, totalCost, currency, category, timestamp, photoBase64, comment }),

      saveNotion(c.env, { name, items, totalCost, currency, category, timestamp, photoBase64, comment }),

    ])

    const slackOk = slackR.status === 'fulfilled' && slackR.value

    const notionOk = notionR.status === 'fulfilled' && notionR.value



    // orders 테이블 저장

    try {

      await c.env.DB.prepare(

        'INSERT INTO orders (student_name,items_json,total_cost,currency,category,comment,has_photo,slack_ok,notion_ok) VALUES (?,?,?,?,?,?,?,?,?)'

      ).bind(name, JSON.stringify(items), totalCost, currency, category, comment||null, photoBase64?1:0, slackOk?1:0, notionOk?1:0).run()

    } catch(_) {}



    return c.json({ success: true, slack: slackOk, notion: notionOk })

  } catch (err: any) {

    return c.json({ success: false, error: err.message }, 500)

  }

})



// 학생 요청사항 제출

app.post('/api/request', async (c) => {

  try {

    const body = await c.req.json()

    const { name, message, photoBase64, timestamp } = body

    if (!name || !message) return c.json({ success: false, error: '이름과 메시지 필요' }, 400)



    // requests 테이블 저장

    try {

      await c.env.DB.prepare(

        "INSERT INTO requests (student_name,message,photo_base64,status) VALUES (?,?,?,'pending')"

      ).bind(name, message, photoBase64||null).run()

    } catch(_) {}



    const [slackR, notionR] = await Promise.allSettled([

      sendSlackRequest(c.env, { name, message, photoBase64, timestamp }),

      saveNotionRequest(c.env, { name, message, photoBase64, timestamp }),

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





// ══════════════════════════════════════════════════════════════════════════════

//  API: 번호표

// ══════════════════════════════════════════════════════════════════════════════



// KST 오늘 날짜 (YYYY-MM-DD)

function getKSTDate() {

  const now = new Date()

  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)

  return kst.toISOString().slice(0, 10)

}



// 번호표 발급

app.post('/api/queue/draw', async (c) => {

  try {

    const { studentName } = await c.req.json()

    if (!studentName) return c.json({ success: false, error: '이름 필요' }, 400)

    const today = getKSTDate()



    // 오늘 이미 번호표 뽑았는지 (완료 상태면 재발급 허용)

    const existing = await c.env.DB.prepare(

      "SELECT * FROM queue WHERE student_name=? AND date=? ORDER BY created_at DESC LIMIT 1"

    ).bind(studentName, today).first() as any



    if (existing && existing.status !== 'done') {

      return c.json({ success: false, error: 'already_drawn', message: '오늘 이미 번호표를 뽑았어요 선생님이 완료 처리 후 재발급 가능해요.' })

    }



    // 직전 번호표 발급자 체크 (연속 발급 방지, 완료된 경우 제외)

    const lastTicket = await c.env.DB.prepare(

      "SELECT * FROM queue WHERE date=? AND status != 'done' ORDER BY created_at DESC LIMIT 1"

    ).bind(today).first() as any



    if (lastTicket && lastTicket.student_name === studentName) {

      return c.json({ success: false, error: 'consecutive', message: '방금 전에도 내가 뽑았어요 친구에게 양보해요 😊' })

    }



    // 오늘 마지막 번호 조회

    const maxRow = await c.env.DB.prepare(

      'SELECT MAX(number) as maxNum FROM queue WHERE date=?'

    ).bind(today).first() as any

    const nextNum = (maxRow?.maxNum || 0) + 1



    // 번호표 발급

    await c.env.DB.prepare(

      "INSERT INTO queue (number, student_name, date, status) VALUES (?,?,?,'waiting')"

    ).bind(nextNum, studentName, today).run()



    // 대기 인원 (내 앞, waiting/answering 상태만)

    const waitingRow = await c.env.DB.prepare(

      "SELECT COUNT(*) as cnt FROM queue WHERE date=? AND number < ? AND status IN ('waiting','answering')"

    ).bind(today, nextNum).first() as any

    const waiting = waitingRow?.cnt || 0



    // 슬랙 알림

    const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })

    await sendSlackQueue(c.env, { studentName, number: nextNum, waiting, date: today, ts })



    return c.json({ success: true, number: nextNum, waiting, date: today })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// 번호표 현황 조회

app.get('/api/queue/status', async (c) => {

  try {

    const today = getKSTDate()

    const rows = await c.env.DB.prepare(

      'SELECT * FROM queue WHERE date=? ORDER BY number ASC'

    ).bind(today).all()

    const tickets = rows.results as any[]

    const waiting = tickets.filter((r) => r.status === 'waiting').length

    const answering = tickets.filter((r) => r.status === 'answering').length

    const done = tickets.filter((r) => r.status === 'done').length

    return c.json({ success: true, total: tickets.length, waiting, answering, done, tickets })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// 번호표 상태 변경 (관리자) - waiting→answering→done

app.post('/api/admin/queue/:id/status', async (c) => {

  try {

    const id = c.req.param('id')

    const { status } = await c.req.json()

    if (!['waiting','answering','done'].includes(status))

      return c.json({ success: false, error: '잘못된 상태값' }, 400)

    await c.env.DB.prepare('UPDATE queue SET status=?, called=? WHERE id=?')

      .bind(status, status === 'done' ? 2 : status === 'answering' ? 1 : 0, id).run()

    return c.json({ success: true })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// 번호표 전체 목록 (관리자, 날짜 파라미터 가능)

app.get('/api/admin/queue', async (c) => {

  try {

    const date = c.req.query('date') || getKSTDate()

    const rows = await c.env.DB.prepare(

      'SELECT * FROM queue WHERE date=? ORDER BY number ASC'

    ).bind(date).all()

    return c.json({ success: true, tickets: rows.results, date })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 요청사항 관리자 API ─────────────────────────────────────────────────────



// 요청사항 목록 (관리자)

app.get('/api/admin/requests', async (c) => {

  try {

    const status = c.req.query('status') || ''

    let sql = 'SELECT id,student_name,message,status,admin_note,created_at,CASE WHEN photo_base64 IS NOT NULL AND photo_base64 != \'\' THEN 1 ELSE 0 END as has_photo FROM requests'

    if (status) sql += ' WHERE status=?'

    sql += ' ORDER BY created_at DESC LIMIT 100'

    const rows = status

      ? await c.env.DB.prepare(sql).bind(status).all()

      : await c.env.DB.prepare(sql).all()

    return c.json({ success: true, requests: rows.results })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// 요청사항 사진 조회 (관리자)

app.get('/api/admin/requests/:id/photo', async (c) => {

  try {

    const id = c.req.param('id')

    const row = await c.env.DB.prepare(

      'SELECT photo_base64 FROM requests WHERE id=?'

    ).bind(id).first() as any

    if (!row) return c.json({ success: false, error: '없음' }, 404)

    return c.json({ success: true, photo: row.photo_base64 || null })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// 요청사항 상태 변경 (관리자)

app.post('/api/admin/requests/:id/status', async (c) => {

  try {

    const id = c.req.param('id')

    const { status, adminNote } = await c.req.json()

    await c.env.DB.prepare(

      'UPDATE requests SET status=?, admin_note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'

    ).bind(status, adminNote || null, id).run()

    return c.json({ success: true })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 주문현황 관리자 API ─────────────────────────────────────────────────────



// 주문 목록 (관리자)

app.get('/api/admin/orders', async (c) => {

  try {

    const student = c.req.query('student') || ''

    const category = c.req.query('category') || ''

    let sql = 'SELECT * FROM orders'

    const params: any[] = []

    const wheres: string[] = []

    if (student) { wheres.push('student_name LIKE ?'); params.push('%'+student+'%') }

    if (category) { wheres.push('category=?'); params.push(category) }

    if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ')

    sql += ' ORDER BY created_at DESC LIMIT 200'

    const stmt = c.env.DB.prepare(sql)

    const rows = params.length ? await stmt.bind(...params).all() : await stmt.all()

    return c.json({ success: true, orders: rows.results })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

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



// 관리자 인증 확인용 엔드포인트 (로그인 검증)

app.get('/api/admin/auth', (c) => c.json({ success: true, message: '인증 성공' }))



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



// ── 학생별 시간표 조회/저장 ─────────────────────────────────────────────────
app.get('/api/admin/students/:id/schedule', async (c) => {
  const id = c.req.param('id')
  try {
    const row = await c.env.DB.prepare(
      'SELECT schedule_json FROM student_schedules WHERE student_id=?'
    ).bind(id).first() as any
    const schedule = row?.schedule_json ? parseSlots(row.schedule_json) : []
    return c.json({ success: true, schedule })
  } catch (e: any) {
    return c.json({ success: false, schedule: [], error: e.message })
  }
})

app.post('/api/admin/students/:id/schedule', async (c) => {
  const id = c.req.param('id')
  try {
    const { schedule } = await c.req.json()
    const json = JSON.stringify(Array.isArray(schedule) ? schedule : [])
    await c.env.DB.prepare(
      'INSERT INTO student_schedules (student_id, schedule_json, updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(student_id) DO UPDATE SET schedule_json=excluded.schedule_json, updated_at=CURRENT_TIMESTAMP'
    ).bind(id, json).run()
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
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



// 전체 벌금 목록 (관리자용) - fine_type 필터 지원

app.get('/api/admin/fines-all', async (c) => {

  try {

    const fineType = c.req.query('type') || 'all'

    let sql = `SELECT f.*, s.name as student_name FROM fines f LEFT JOIN students s ON s.id = f.student_id`

    if (fineType !== 'all') sql += ` WHERE f.fine_type='${fineType}'`

    sql += ` ORDER BY f.created_at DESC LIMIT 500`

    const rows = await c.env.DB.prepare(sql).all()

    return c.json({ success: true, fines: rows.results })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})

// 벌금 확인(time/sheet는 확인 즉시 삭제, point는 paid 처리)

app.post('/api/admin/fines/:id/confirm', async (c) => {

  const id = c.req.param('id')

  try {

    const fine = await c.env.DB.prepare('SELECT * FROM fines WHERE id=?').bind(id).first() as any

    if (!fine) return c.json({ success: false, error: '없음' }, 404)

    if (fine.fine_type === 'time' || fine.fine_type === 'sheet') {

      // 시간/장수 벌금: 확인하면 삭제

      await c.env.DB.prepare('DELETE FROM fines WHERE id=?').bind(id).run()

    } else {

      // 포인트 벌금: paid 처리

      await c.env.DB.prepare('UPDATE fines SET paid=1 WHERE id=?').bind(id).run()

    }

    return c.json({ success: true })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})

// 학생 벌금 현황 공개 조회 (키오스크에서 학생이 확인)

app.get('/api/my-fines/:studentId', async (c) => {

  const id = c.req.param('studentId')

  try {

    const stu = await c.env.DB.prepare('SELECT id, name, photo_url, points FROM students WHERE id=?').bind(id).first()

    if (!stu) return c.json({ success: false, error: '학생 없음' }, 404)

    const fines = await c.env.DB.prepare(

      `SELECT id, label, amount, unit, fine_type, created_at FROM fines WHERE student_id=? AND paid=0 ORDER BY created_at DESC`

    ).bind(id).all()

    return c.json({ success: true, student: stu, fines: fines.results })

  } catch (e: any) {

    return c.json({ success: false, error: e.message }, 500)

  }

})



// ── 번호표 Slack 알림 ──────────────────────────────────────────────────────────

async function sendSlackQueue(env: Bindings, d: any) {

  if (!env.SLACK_WEBHOOK_URL) return false

  const waitText = d.waiting === 0 ? '없음 (즉시 가능)' : `${d.waiting}명 대기 중`

  const payload = {

    blocks: [

      { type: 'header', text: { type: 'plain_text', text: '[바꿈수학] 번호표 발급 알림 🎫', emoji: true } },

      { type: 'section', fields: [

        { type: 'mrkdwn', text: `*학생:*\n${d.studentName}` },

        { type: 'mrkdwn', text: `*발급 번호:*\n*${d.number}번*` },

        { type: 'mrkdwn', text: `*앞 대기:*\n${waitText}` },

        { type: 'mrkdwn', text: `*날짜:*\n${d.date}` },

      ]},

      { type: 'context', elements: [{ type: 'mrkdwn', text: `⏰ ${d.ts} | 관리자 페이지에서 상태 변경 가능` }] },

      { type: 'divider' },

    ],

  }

  const res = await fetch(env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })

  if (!res.ok) throw new Error(`Slack ${res.status}`)

  return true

}



// ── Slack ──────────────────────────────────────────────────────────────────────

async function sendSlack(env: Bindings, d: any) {

  if (!env.SLACK_WEBHOOK_URL) return false

  const catEmoji: Record<string, string> = { learn: '✅', fine: '🚨', shop: '🛍️' }

  const catLabel: Record<string, string> = { learn: '학습 활동', fine: '벌금', shop: '보상 교환' }

  const itemList = d.items.map((x) => `• ${x.icon} ${x.label} × ${x.qty}`).join('\n')

  const costText = d.totalCost === 0 ? '무료' : d.totalCost < 0

    ? `+${Math.abs(d.totalCost)} ${d.currency} 획득`

    : `-${d.totalCost} ${d.currency} 차감`

  const payload = {

    blocks: [

      { type: 'header', text: { type: 'plain_text', text: `바꿈수학 키오스크 ${catEmoji[d.category] || '📋'}`, emoji: true } },

      { type: 'section', text: { type: 'mrkdwn', text: `*${catLabel[d.category] || d.category}* 기록\n\n*👤 학생:* ${d.name}\n*📋 항목:*\n${itemList}\n*🏅 합계:* ${costText}${d.comment ? '\n*💬 코멘트:* '+d.comment : ''}${d.photoBase64 ? '\n*📸 인증사진:* 첨부됨 (노션 확인)' : ''}` } },

      { type: 'context', elements: [{ type: 'mrkdwn', text: `⏰ ${d.timestamp}` }] },

      { type: 'divider' },

    ],

  }

  const res = await fetch(env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })

  if (!res.ok) throw new Error(`Slack ${res.status}`)

  // Bot Token이 있으면 인증사진도 Slack에 업로드
  if (d.photoBase64 && env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID) {

    try {

      const imgData = d.photoBase64.replace(/^data:image\/\w+;base64,/, '')

      const mimeMatch = d.photoBase64.match(/^data:(image\/\w+);base64,/)

      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg'

      const ext = mime.split('/')[1] || 'jpg'

      const binStr = atob(imgData)

      const binArr = new Uint8Array(binStr.length)

      for (let i = 0; i < binStr.length; i++) binArr[i] = binStr.charCodeAt(i)

      const form = new FormData()

      form.append('channels', env.SLACK_CHANNEL_ID)

      form.append('filename', `cert_${d.name}_${Date.now()}.${ext}`)

      form.append('initial_comment', `📸 ${d.name} 학생의 인증 사진`)

      form.append('file', new Blob([binArr], { type: mime }), `photo.${ext}`)

      await fetch('https://slack.com/api/files.upload', {

        method: 'POST',

        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },

        body: form,

      })

    } catch (_) {}

  }

  return true

}



// ── Notion ─────────────────────────────────────────────────────────────────────

async function saveNotion(env: Bindings, d: any) {

  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) return false

  const catLabel: Record<string, string> = { learn: '학습 활동', fine: '벌금', shop: '보상 교환' }

  const itemList = d.items.map((x) => `${x.icon} ${x.label} × ${x.qty}${x.comment ? ' ('+x.comment+')' : ''}`).join(', ')

  const costText = d.totalCost === 0 ? '무료' : d.totalCost < 0

    ? `+${Math.abs(d.totalCost)} ${d.currency}`

    : `-${d.totalCost} ${d.currency}`



  // 페이지 본문 블록: 코멘트 + 이미지

  const children: any[] = []

  if (d.comment) {

    children.push({

      object: 'block', type: 'callout',

      callout: {

        rich_text: [{ type: 'text', text: { content: `💬 ${d.comment}` } }],

        icon: { emoji: '💬' }, color: 'blue_background'

      }

    })

  }

  if (d.photoBase64) {

    // base64 이미지는 Notion external URL로 직접 삽입 불가 → 단락에 텍스트로 안내

    // 실제 이미지: file_upload API 또는 외부 URL 필요

    // → base64 자체를 data URI로 파일 블록에 넣으면 Notion이 거부하므로

    //   대신 이미지가 첨부됐다는 안내 + items 각각의 comment에서 사진 정보 표시

    children.push({

      object: 'block', type: 'callout',

      callout: {

        rich_text: [{ type: 'text', text: { content: '📸 인증 사진이 첨부되었습니다 (키오스크 제출)' } }],

        icon: { emoji: '📸' }, color: 'yellow_background'

      }

    })

    // Notion File Upload API로 실제 이미지 업로드 시도

    try {

      const imgData = d.photoBase64.replace(/^data:image\/\w+;base64,/, '')

      const mimeMatch = d.photoBase64.match(/^data:(image\/\w+);base64,/)

      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg'

      const ext = mime.split('/')[1] || 'jpg'

      // Step1: 업로드 URL 발급

      const uploadRes = await fetch('https://api.notion.com/v1/file_uploads', {

        method: 'POST',

        headers: { Authorization: `Bearer ${env.NOTION_API_KEY}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },

        body: JSON.stringify({ name: `photo.${ext}`, content_type: mime })

      })

      if (uploadRes.ok) {

        const uploadData = await uploadRes.json() as any

        const uploadUrl = uploadData.upload_url

        const fileId = uploadData.id

        // Step2: 이미지 바이너리 업로드

        const binStr = atob(imgData)

        const binArr = new Uint8Array(binStr.length)

        for (let i = 0; i < binStr.length; i++) binArr[i] = binStr.charCodeAt(i)

        const uploadBinRes = await fetch(uploadUrl, {

          method: 'PUT',

          headers: { 'Content-Type': mime },

          body: binArr

        })

        if (uploadBinRes.ok) {

          // Step3: 업로드된 파일 ID로 이미지 블록 추가

          children.push({

            object: 'block', type: 'image',

            image: { type: 'file_upload', file_upload: { id: fileId } }

          })

          // 안내 블록은 제거 (이미지 성공)

          children.splice(children.findIndex((b) => b.callout?.icon?.emoji === '📸'), 1)

        }

      }

    } catch (_) { /* 실패시 안내 텍스트만 남김 */ }

  }



  const payload: any = {

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

  if (children.length > 0) payload.children = children



  const res = await fetch('https://api.notion.com/v1/pages', {

    method: 'POST',

    headers: { Authorization: `Bearer ${env.NOTION_API_KEY}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },

    body: JSON.stringify(payload),

  })

  if (!res.ok) { const t = await res.text(); throw new Error(`Notion ${res.status}: ${t}`) }

  return true

}



// ── 요청사항 Slack ─────────────────────────────────────────────────────────────

async function sendSlackRequest(env: Bindings, d: any) {

  if (!env.SLACK_WEBHOOK_URL) return false

  const photoNote = d.photoBase64 ? '\n📎 *사진 첨부됨* → 관리자 페이지에서 확인 가능' : ''

  const blocks: any[] = [

    { type: 'header', text: { type: 'plain_text', text: '📬 바꿈수학 - 선생님께 요청사항', emoji: true } },

    { type: 'section', text: { type: 'mrkdwn', text: `*👤 학생:* ${d.name}\n*💬 메시지:*\n${d.message}${photoNote}` } },

    { type: 'context', elements: [{ type: 'mrkdwn', text: `⏰ ${d.timestamp}` }] },

    { type: 'divider' },

  ]

  const res = await fetch(env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blocks }) })

  if (!res.ok) throw new Error(`Slack ${res.status}`)

  // Bot Token이 있으면 이미지도 Slack에 별도 업로드
  if (d.photoBase64 && env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID) {

    try {

      const imgData = d.photoBase64.replace(/^data:image\/\w+;base64,/, '')

      const mimeMatch = d.photoBase64.match(/^data:(image\/\w+);base64,/)

      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg'

      const ext = mime.split('/')[1] || 'jpg'

      const binStr = atob(imgData)

      const binArr = new Uint8Array(binStr.length)

      for (let i = 0; i < binStr.length; i++) binArr[i] = binStr.charCodeAt(i)

      const form = new FormData()

      form.append('channels', env.SLACK_CHANNEL_ID)

      form.append('filename', `request_${d.name}_${Date.now()}.${ext}`)

      form.append('initial_comment', `📸 ${d.name} 학생의 요청사항 첨부 사진`)

      form.append('file', new Blob([binArr], { type: mime }), `photo.${ext}`)

      await fetch('https://slack.com/api/files.upload', {

        method: 'POST',

        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },

        body: form,

      })

    } catch (_) {}

  }

  return true

}



// ── 요청사항 Notion ────────────────────────────────────────────────────────────

async function saveNotionRequest(env: Bindings, d: any) {

  if (!env.NOTION_API_KEY || !env.NOTION_DATABASE_ID) return false

  const children: any[] = [

    { object: 'block', type: 'callout',

      callout: { rich_text: [{ type: 'text', text: { content: d.message } }], icon: { emoji: '💬' }, color: 'blue_background' } },

  ]

  if (d.photoBase64) {

    // Notion File Upload API로 실제 이미지 업로드

    let imgUploaded = false

    try {

      const imgData = d.photoBase64.replace(/^data:image\/\w+;base64,/, '')

      const mimeMatch = d.photoBase64.match(/^data:(image\/\w+);base64,/)

      const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg'

      const ext = mime.split('/')[1] || 'jpg'

      const uploadRes = await fetch('https://api.notion.com/v1/file_uploads', {

        method: 'POST',

        headers: { Authorization: `Bearer ${env.NOTION_API_KEY}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },

        body: JSON.stringify({ name: `request_photo.${ext}`, content_type: mime })

      })

      if (uploadRes.ok) {

        const uploadData = await uploadRes.json() as any

        const binStr = atob(imgData)

        const binArr = new Uint8Array(binStr.length)

        for (let i = 0; i < binStr.length; i++) binArr[i] = binStr.charCodeAt(i)

        const uploadBinRes = await fetch(uploadData.upload_url, {

          method: 'PUT', headers: { 'Content-Type': mime }, body: binArr

        })

        if (uploadBinRes.ok) {

          children.push({

            object: 'block', type: 'image',

            image: { type: 'file_upload', file_upload: { id: uploadData.id } }

          })

          imgUploaded = true

        }

      }

    } catch (_) {}

    if (!imgUploaded) {

      children.push({

        object: 'block', type: 'callout',

        callout: { rich_text: [{ type: 'text', text: { content: '📸 사진 첨부됨 (업로드 실패 - 키오스크에서 직접 확인)' } }], icon: { emoji: '📸' }, color: 'yellow_background' }

      })

    }

  }

  const payload = {

    parent: { database_id: env.NOTION_DATABASE_ID },

    properties: {

      '학생 이름': { title: [{ text: { content: d.name } }] },

      '항목': { rich_text: [{ text: { content: d.message.slice(0, 100) } }] },

      '금액': { rich_text: [{ text: { content: '요청사항' } }] },

      '구분': { multi_select: [{ name: '요청사항' }] },

      '접수 일시': { date: { start: new Date().toISOString() } },

      '상태': { select: { name: '검토 중' } },

    },

    children,

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

      { id: 'helpme',     icon: '🆘', label: '지현쌤 Help me!', cost: 3, reward: 0, requirePhoto: false, fineType: 'point', unit: '포인트' },

      { id: 'lostwork',   icon: '😰', label: '숙제 분실',        cost: 4, reward: 0, requirePhoto: false, fineType: 'point', unit: '포인트' },

      { id: 'nohomework', icon: '🚫', label: '숙제 안함',        cost: 5, reward: 0, requirePhoto: false, fineType: 'point', unit: '포인트' },

    ],

    shop: [

      { id: 'choco',      icon: '🍫', label: '초콜릿(달달구리)', cost: 3, reward: 0, requirePhoto: false, soldOut: false },

      { id: 'jelly',      icon: '🍬', label: '젤리',             cost: 2, reward: 0, requirePhoto: false, soldOut: false },

      { id: 'candy',      icon: '🍭', label: '사탕',             cost: 2, reward: 0, requirePhoto: false, soldOut: false },

      { id: 'snack',      icon: '🍿', label: '과자',             cost: 3, reward: 0, requirePhoto: false, soldOut: false },

      { id: 'saekkomdal', icon: '🍋', label: '새콤달콤',         cost: 2, reward: 0, requirePhoto: false, soldOut: false },

      { id: 'vitaminc',   icon: '💊', label: '비타민C',          cost: 2, reward: 0, requirePhoto: false, soldOut: false },

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

    .home-btn{display:flex;align-items:center;gap:5px;background:var(--g100);border:1.5px solid var(--g200);color:var(--g600);font-family:inherit;font-size:clamp(11px,1.4vw,13px);font-weight:700;padding:6px 14px;border-radius:100px;cursor:pointer;transition:all .2s;}

    .home-btn:hover{background:var(--blue-soft);border-color:var(--blue-mid);color:var(--blue);}



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

    .stat-chip.orange-chip{background:rgba(249,115,22,.25);border-color:rgba(249,115,22,.4);color:#c2410c;}

    .stat-chip.status-chip{cursor:pointer;transition:all .2s;}

    .stat-chip.status-chip:hover{transform:scale(1.05);}

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

    .menu-btn.sold-out{opacity:.55;cursor:not-allowed;filter:grayscale(.4);}
    #shop-unlock-badge{display:none;}
    #shopUnlockReqBtn:hover{opacity:.9;transform:translateY(-2px);}
    #shopUnlockReqBtn:active{transform:translateY(0);}

    .menu-btn.sold-out:hover{transform:none;box-shadow:none;}

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

    .qty-ctrl{display:flex;align-items:center;border-radius:100px;overflow:hidden;border:2px solid var(--blue-d);background:var(--white);margin-top:4px;}

    .type-learn .qty-ctrl{border-color:var(--green);}

    .type-fine  .qty-ctrl{border-color:var(--red);}

    .type-shop  .qty-ctrl{border-color:var(--purple);}

    .qty-minus,.qty-plus{width:30px;height:30px;border:none;cursor:pointer;font-size:17px;font-weight:900;display:flex;align-items:center;justify-content:center;background:transparent;line-height:1;}

    .qty-minus{color:var(--red);} .qty-plus{color:var(--green);}

    .qty-num{font-size:14px;font-weight:900;min-width:24px;text-align:center;color:var(--g800);}

    .menu-btn{cursor:pointer;}



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





    /* ── 번호표 화면 ── */

    #queue-screen{min-height:calc(100vh - clamp(56px,7vw,68px));display:none;flex-direction:column;align-items:center;justify-content:flex-start;padding:clamp(20px,3.5vw,44px) clamp(14px,3vw,28px);gap:clamp(14px,2.5vw,22px);}

    #queue-screen.active{display:flex;}

    .queue-hero{width:100%;max-width:500px;background:linear-gradient(135deg,#1e40af,#2563eb,#3b82f6);border-radius:var(--r-xl);padding:clamp(24px,4vw,40px) clamp(20px,3.5vw,36px);text-align:center;color:white;box-shadow:0 16px 48px rgba(37,99,235,.35);position:relative;overflow:hidden;}

    .queue-hero::before{content:'';position:absolute;right:-30px;top:-30px;width:200px;height:200px;border-radius:50%;background:rgba(255,255,255,.06);}

    .queue-hero::after{content:'';position:absolute;left:-20px;bottom:-20px;width:140px;height:140px;border-radius:50%;background:rgba(255,255,255,.04);}

    .queue-label{font-size:clamp(12px,1.8vw,15px);font-weight:800;letter-spacing:2px;text-transform:uppercase;opacity:.8;margin-bottom:8px;}

    .queue-number{font-family:'Nunito',sans-serif;font-size:clamp(72px,14vw,120px);font-weight:900;line-height:1;text-shadow:0 6px 24px rgba(0,0,0,.2);animation:numPop .5s cubic-bezier(.34,1.4,.64,1);}

    @keyframes numPop{from{transform:scale(0) rotate(-15deg);opacity:0;}60%{transform:scale(1.15) rotate(5deg);}to{transform:scale(1) rotate(0);opacity:1;}}

    .queue-sub{font-size:clamp(13px,1.8vw,16px);opacity:.85;margin-top:8px;}

    .queue-date{font-size:clamp(11px,1.4vw,13px);opacity:.6;margin-top:6px;}

    .waiting-card{width:100%;max-width:500px;background:var(--white);border-radius:var(--r-xl);padding:clamp(16px,2.5vw,24px);box-shadow:0 4px 20px rgba(0,0,0,.07);border:1.5px solid var(--g200);}

    .waiting-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--g100);}

    .waiting-row:last-child{border-bottom:none;}

    .waiting-lbl{font-size:clamp(13px,1.7vw,15px);font-weight:700;color:var(--g600);}

    .waiting-val{font-size:clamp(16px,2.2vw,20px);font-weight:900;}

    .waiting-val.big{font-size:clamp(22px,3.5vw,32px);color:#2563eb;}

    .queue-msg-box{width:100%;max-width:500px;border-radius:var(--r-lg);padding:clamp(14px,2.2vw,20px) clamp(16px,2.5vw,22px);display:flex;align-items:center;gap:12px;font-size:clamp(13px,1.7vw,15px);font-weight:700;}

    .queue-msg-box.warn{background:#fef3c7;border:1.5px solid #fcd34d;color:#92400e;}

    .queue-msg-box.ok{background:var(--green-s);border:1.5px solid rgba(34,197,94,.3);color:#166534;}

    .queue-msg-box.info{background:var(--blue-soft);border:1.5px solid var(--blue-mid);color:var(--blue-dd);}

    .queue-msg-icon{font-size:clamp(20px,3vw,26px);flex-shrink:0;}

    .btn-queue-draw{width:100%;max-width:500px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:white;border:none;border-radius:var(--r-xl);padding:clamp(16px,2.5vw,22px);font-family:inherit;font-size:clamp(15px,2.2vw,19px);font-weight:900;cursor:pointer;box-shadow:0 8px 28px rgba(37,99,235,.4);display:flex;align-items:center;justify-content:center;gap:10px;transition:all .2s;}

    .btn-queue-draw:hover{transform:translateY(-2px);box-shadow:0 12px 36px rgba(37,99,235,.55);}

    .btn-queue-draw:disabled{opacity:.45;cursor:not-allowed;transform:none;}

    .queue-ticket-list{width:100%;max-width:500px;}

    .qtl-title{font-size:13px;font-weight:800;color:var(--g400);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;}

    .qtl-items{display:flex;flex-wrap:wrap;gap:6px;}

    .qtl-chip{padding:5px 12px;border-radius:100px;font-size:12px;font-weight:800;}

    .qtl-chip.waiting{background:var(--blue-soft);color:#2563eb;border:1.5px solid var(--blue-mid);}

    .qtl-chip.called{background:var(--g100);color:var(--g400);border:1.5px solid var(--g200);text-decoration:line-through;}

    .qtl-chip.mine{background:linear-gradient(135deg,#2563eb,#1d4ed8);color:white;border:none;box-shadow:0 2px 8px rgba(37,99,235,.35);}



    /* 스플래시 번호표 버튼 */

    .queue-entry-btn{display:flex;align-items:center;gap:8px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:white;font-size:clamp(13px,1.8vw,15px);font-weight:800;padding:clamp(10px,1.5vw,14px) clamp(20px,3vw,28px);border-radius:100px;border:none;cursor:pointer;box-shadow:0 4px 18px rgba(37,99,235,.4);transition:all .2s;font-family:inherit;}

    .queue-entry-btn:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(37,99,235,.55);}

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

    <button id="homeBtn" class="home-btn" onclick="goTo('splash')" style="display:none"><i class="fas fa-house"></i> 홈</button>

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

  <button class="queue-entry-btn" onclick="event.stopPropagation();goToQueue()" id="queueEntryBtn"><i class="fas fa-ticket"></i>번호표 뽑기</button>

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

      <div style="display:flex;gap:6px;flex-shrink:0;">

        <button class="btn-change" onclick="openReqModal()" style="background:rgba(168,85,247,.25);border-color:rgba(168,85,247,.4);" title="요청하기"><i class="fas fa-comment-dots"></i></button>

        <button class="btn-change" onclick="goTo('student')"><i class="fas fa-exchange-alt" style="margin-right:3px"></i>변경</button>

      </div>

    </div>

    <div class="tab-row" id="tabRow">

      <button class="tab-btn active-learn" onclick="switchTab('learn')" id="tab-learn"><div class="tab-dot"></div>학습 활동</button>

      <button class="tab-btn" onclick="switchTab('fine')" id="tab-fine"><div class="tab-dot"></div>벌금 항목</button>

      <button class="tab-btn" onclick="switchTab('shop')" id="tab-shop"><div class="tab-dot"></div>🛍️ 보상 상점</button>

    </div>

    <!-- 상점 잠금해제 배지 (해제 중 남은 시간) -->
    <div id="shop-unlock-badge" style="display:none;text-align:center;font-size:13px;font-weight:700;color:#16a34a;background:#f0fdf4;border:1.5px solid #86efac;border-radius:100px;padding:4px 14px;margin-bottom:8px;"></div>

    <div style="position:relative;">

      <div class="menu-grid" id="menuGrid"></div>

      <!-- 상점 잠금 오버레이 -->
      <div id="shop-lock-overlay" style="display:none;position:absolute;inset:0;z-index:20;background:rgba(15,23,42,.72);backdrop-filter:blur(6px);border-radius:16px;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px;">
        <div style="font-size:52px;">🔒</div>
        <div style="color:white;font-size:18px;font-weight:900;text-align:center;">지금은 상점을 이용할 수 없어요</div>
        <div id="shopLockMsg" style="color:rgba(255,255,255,.75);font-size:14px;font-weight:700;text-align:center;">수업 중입니다</div>
        <div style="color:rgba(255,255,255,.6);font-size:12px;text-align:center;">선생님께 승인 요청을 보내면<br/>잠시 주문이 가능해요!</div>
        <button id="shopUnlockReqBtn" onclick="requestShopUnlock()" style="margin-top:8px;padding:14px 28px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:white;border:none;border-radius:14px;font-size:15px;font-weight:800;cursor:pointer;box-shadow:0 4px 16px rgba(99,102,241,.4);">
          🙋 선생님께 상점 열기 요청
        </button>
        <div id="shopUnlockReqStatus" style="color:rgba(255,255,255,.8);font-size:13px;min-height:20px;text-align:center;"></div>
      </div>

    </div>

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



<!-- 번호표 화면 -->

<div class="screen" id="queue-screen">

  <!-- 학생 선택 단계 -->

  <div id="queue-step-select" style="width:100%;max-width:500px;display:none;">

    <div style="text-align:center;margin-bottom:clamp(16px,2.5vw,24px);">

      <div style="font-family:Nunito,sans-serif;font-size:clamp(20px,3.5vw,28px);font-weight:900;color:#1e40af;">번호표 뽑기</div>

      <div style="font-size:clamp(13px,1.7vw,15px);color:var(--g400);margin-top:6px;">이름을 선택하면 번호가 발급돼요!</div>

    </div>

    <div class="search-wrap">

      <i class="fas fa-magnifying-glass search-ic"></i>

      <input class="search-inp" id="queueSearchInp" type="text" placeholder="이름 검색..."

             oninput="filterQueueStudents(this.value)" autocomplete="off" spellcheck="false"/>

    </div>

    <div class="student-grid" id="queueStudentGrid"></div>

    <div style="margin-top:16px;text-align:center;">

      <button class="home-btn" onclick="goTo('splash')" style="margin:0 auto;"><i class="fas fa-chevron-left" style="margin-right:4px"></i>돌아가기</button>

    </div>

  </div>



  <!-- 번호표 결과 단계 -->

  <div id="queue-step-result" style="width:100%;display:flex;flex-direction:column;align-items:center;gap:clamp(14px,2.2vw,20px);display:none;">

    <!-- 번호 카드 -->

    <div class="queue-hero">

      <div class="queue-label">내 번호표</div>

      <div class="queue-number" id="queueNumber">--</div>

      <div class="queue-sub" id="queueStuName"></div>

      <div class="queue-date" id="queueDate"></div>

    </div>



    <!-- 대기 현황 -->

    <div class="waiting-card">

      <div class="waiting-row">

        <div class="waiting-lbl"><i class="fas fa-clock" style="margin-right:6px;color:#2563eb"></i>내 앞 대기</div>

        <div class="waiting-val big" id="queueWaiting">--</div>

      </div>

      <div class="waiting-row">

        <div class="waiting-lbl"><i class="fas fa-users" style="margin-right:6px;color:var(--g400)"></i>오늘 총 발급</div>

        <div class="waiting-val" id="queueTotal">--</div>

      </div>

    </div>



    <!-- 메시지 박스 -->

    <div class="queue-msg-box info" id="queueMsgBox">

      <div class="queue-msg-icon">🎫</div>

      <div id="queueMsgText">번호를 기억해두세요!</div>

    </div>



    <!-- 오늘의 번호표 목록 -->

    <div class="queue-ticket-list" id="queueTicketList"></div>



    <!-- 버튼 -->

    <div style="display:flex;flex-direction:column;gap:9px;width:100%;max-width:500px;">

      <button class="btn-cont" onclick="goTo('student')" style="background:linear-gradient(135deg,var(--blue),var(--blue-d));"><i class="fas fa-check"></i>키오스크 이용하기</button>

      <button class="btn-home" onclick="goTo('splash')"><i class="fas fa-house" style="margin-right:6px"></i>처음으로</button>

    </div>

  </div>

</div>



<!-- 내 상태 모달 -->

<div class="modal-ov" id="my-status-modal">

  <div class="modal-box" style="max-width:400px;">

    <div class="modal-title">📊 내 현재 상태</div>

    <div id="myStatusContent" style="margin:12px 0;"></div>

    <div class="modal-btns">

      <button class="btn-mok" style="flex:1;" onclick="closeMyStatus()"><i class="fas fa-check"></i>확인</button>

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

    <button class="btn-cc" onclick="openReqModal()" style="background:var(--purple-s);border-color:rgba(168,85,247,.3);color:var(--purple);" title="선생님께 요청하기"><i class="fas fa-comment-dots"></i></button>

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

    <textarea id="photoComment" placeholder="선생님께 한마디 남겨도 좋아요 (선택)" style="width:100%;min-height:70px;border:2px solid var(--g200);border-radius:var(--r-md);padding:10px 12px;font-family:inherit;font-size:14px;outline:none;resize:none;margin-bottom:4px;transition:border-color .2s;" onfocus="this.style.borderColor='var(--blue)'" onblur="this.style.borderColor='var(--g200)'"></textarea>

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



<!-- 요청사항 모달 -->

<div class="modal-ov" id="req-modal">

  <div class="modal-box">

    <div class="modal-title">💬 선생님께 요청해요</div>

    <div class="modal-sub" style="margin-bottom:12px">이미지나 문자로 요청사항을 남겨드려요!</div>

    <textarea id="reqMsg" placeholder="선생님께 하고 싶은 말을 써주세요..." style="width:100%;min-height:90px;border:2px solid var(--g200);border-radius:var(--r-md);padding:10px 12px;font-family:inherit;font-size:14px;outline:none;resize:vertical;transition:all .2s;" onfocus="this.style.borderColor='var(--blue)'" onblur="this.style.borderColor='var(--g200)'"></textarea>

    <div id="reqPhotoWrap" style="margin:10px 0;">

      <img class="photo-prev" id="reqPrev" alt="" style="display:none;max-width:100%;max-height:180px;border-radius:var(--r-md);margin:0 auto 10px;"/>

      <div style="display:flex;gap:8px;">

        <button type="button" onclick="triggerReqPhoto('camera')" style="flex:1;padding:12px 8px;border:2px dashed var(--blue-mid);border-radius:var(--r-md);background:var(--blue-soft);color:var(--blue);font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;"><i class="fas fa-camera" style="font-size:20px;"></i>카메라 촬영</button>

        <button type="button" onclick="triggerReqPhoto('gallery')" style="flex:1;padding:12px 8px;border:2px dashed var(--g300);border-radius:var(--r-md);background:var(--g100);color:var(--g600);font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:6px;"><i class="fas fa-image" style="font-size:20px;"></i>갤러리 선택</button>

      </div>

      <input type="file" id="reqPhotoCamera" accept="image/*" capture="environment" style="display:none" onchange="onReqPhoto(event)"/>

      <input type="file" id="reqPhotoGallery" accept="image/*" style="display:none" onchange="onReqPhoto(event)"/>

      <div id="reqPhotoInfo" style="display:none;text-align:center;margin-top:6px;font-size:12px;color:var(--g500);"><i class="fas fa-check-circle" style="color:var(--green);"></i> 사진 첨부됨 · <span style="color:var(--red);cursor:pointer;" onclick="clearReqPhoto()">삭제</span></div>

    </div>

    <div class="modal-btns">

      <button class="btn-mc" onclick="closeReqModal()">취소</button>

      <button class="btn-mok" id="reqOk" onclick="doRequest()"><i class="fas fa-paper-plane"></i><span id="reqTxt">전송하기</span></button>

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

const SCRS=['splash','student-screen','menu-screen','done-screen','queue-screen']

function goTo(id){

  clearTimeout(autoTimer)

  SCRS.forEach(s=>document.getElementById(s).classList.remove('active'))

  const MAP={splash:'splash',student:'student-screen',menu:'menu-screen',done:'done-screen',queue:'queue-screen'}

  const el=document.getElementById(MAP[id]);if(!el)return

  el.classList.add('active','fade-up');setTimeout(()=>el.classList.remove('fade-up'),350)

  document.getElementById('cartBar').classList.toggle('visible',id==='menu')

  // 홈버튼: splash 제외 모든 화면에서 표시

  const homeBtn=document.getElementById('homeBtn')

  if(homeBtn) homeBtn.style.display=(id==='splash')?'none':'flex'

  if(id==='student'){document.getElementById('searchInp').value='';filterStudents('')}

  if(id==='splash'){ST.cart=[];ST.student=null;ST.sessionBalance=0;ST.sessionOrders=[];updateCartBar()}

}

window.goTo=goTo



// 내 상태 모달

window.openMyStatus=function(){

  const s=ST.student;if(!s){toast('학생을 먼저 선택해주세요');return}

  const c=CFG.currency

  let html='<div style="display:flex;flex-direction:column;gap:12px;">'

  // 포인트

  html+='<div style="background:linear-gradient(135deg,#eff6ff,#dbeafe);border:2px solid #93c5fd;border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:12px;">'

  html+='<div style="font-size:32px;">'+c.symbol+'</div>'

  html+='<div><div style="font-size:12px;color:#3b82f6;font-weight:700;">내 포인트</div>'

  html+='<div style="font-size:24px;font-weight:900;color:#1e40af;">'+s.points+' <span style="font-size:14px;">'+c.unit+'</span></div></div>'

  html+='</div>'

  // 벌금 포인트

  if(s.fine_point>0){

    html+='<div style="background:#fff5f5;border:2px solid #fca5a5;border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:12px;">'

    html+='<div style="font-size:32px;">💸</div>'

    html+='<div><div style="font-size:12px;color:#dc2626;font-weight:700;">미납 벌금 포인트</div>'

    html+='<div style="font-size:24px;font-weight:900;color:#dc2626;">'+s.fine_point+' <span style="font-size:14px;">'+c.unit+'</span></div></div>'

    html+='</div>'

  }

  // 벌금 시간

  if(s.fine_time>0){

    html+='<div style="background:#fff7ed;border:2px solid #fdba74;border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:12px;">'

    html+='<div style="font-size:32px;">⏰</div>'

    html+='<div><div style="font-size:12px;color:#ea580c;font-weight:700;">벌금 시간 (선생님 확인 후 삭제)</div>'

    html+='<div style="font-size:24px;font-weight:900;color:#ea580c;">'+s.fine_time+' <span style="font-size:14px;">분</span></div></div>'

    html+='</div>'

  }

  // 벌금 학습지

  if(s.fine_sheet>0){

    html+='<div style="background:#fff7ed;border:2px solid #fdba74;border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:12px;">'

    html+='<div style="font-size:32px;">📄</div>'

    html+='<div><div style="font-size:12px;color:#ea580c;font-weight:700;">벌금 학습지 (선생님 확인 후 삭제)</div>'

    html+='<div style="font-size:24px;font-weight:900;color:#ea580c;">'+s.fine_sheet+' <span style="font-size:14px;">장</span></div></div>'

    html+='</div>'

  }

  if(s.fine_point===0&&s.fine_time===0&&s.fine_sheet===0){

    html+='<div style="text-align:center;padding:16px;color:#22c55e;font-weight:700;font-size:16px;">🎉 벌금이 없어요!</div>'

  }

  html+='</div>'

  document.getElementById('myStatusContent').innerHTML=html

  document.getElementById('my-status-modal').classList.add('open')

}

window.closeMyStatus=function(){

  document.getElementById('my-status-modal').classList.remove('open')

}



// 초기 로드

async function init(){

  try{

    // 항상 서버(DB)에서 최신 설정 불러오기 (관리자 변경 즉시 반영)
    const r=await fetch('/api/config');const d=await r.json()

    CFG=d

    // localStorage는 더 이상 사용하지 않음 (삭제하여 혼동 방지)
    localStorage.removeItem('kiosk_config');localStorage.removeItem('kiosk_cfg_ver')

  }catch(e){}

  applyCurrencyUI()

  await loadStudents()

  goTo('splash')

}



async function loadStudents(){

  try{

    const r=await fetch('/api/students');const d=await r.json()

    if(d.success){STUDENTS=d.students;renderStudents()}

  }catch(e){}

}



function applyCurrencyUI(){

  const c=CFG.currency || {unit:'포인트', symbol:'\uD83C\uDFC5', desc:''}

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

      ?'<div class="stu-fine-badge">\u26A0 미납 '+s.fine_count+'건</div>':''

    return '<button class="stu-btn" data-name="'+escHtml(s.name)+'" onclick="selectStudent('+s.id+')">'+

      photoEl+

      '<div class="stu-name">'+escHtml(s.name)+'</div>'+

      '<div class="stu-pts">🏅 '+s.points+'P</div>'+

      fineBadge+

    '</button>'

  }).join('')

}



function escHtml(s){var r=String(s);r=r.split('&').join('&amp;');r=r.split('<').join('&lt;');r=r.split('>').join('&gt;');r=r.split(String.fromCharCode(34)).join('&#34;');return r}



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

  if(s.fine_point>0) html+='<div class="stat-chip red-chip">💸 벌금 '+s.fine_point+' '+c.unit+'</div>'

  if(s.fine_time>0) html+='<div class="stat-chip orange-chip">⏰ 벌금 '+s.fine_time+'분</div>'

  if(s.fine_sheet>0) html+='<div class="stat-chip orange-chip">📄 벌금 학습지 '+s.fine_sheet+'장</div>'

  // 내 상태 확인 버튼 (벌금 있을 때만 강조)
  html+='<div class="stat-chip status-chip" onclick="openMyStatus()" style="cursor:pointer;background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.3);color:#2563eb;">📊 내 상태</div>'

  stats.innerHTML=html

}



// ── 상점 잠금 상태 ──
let SHOP_STATUS = { locked: false, forceLocked: false, unlocked: false, expiresAt: null }
let shopUnlockTimer = null
let shopPollTimer = null

async function checkShopStatus() {
  try {
    const sid = ST.student?.id
    const url = sid ? '/api/shop/status?student_id=' + sid : '/api/shop/status'
    const r = await fetch(url)
    const d = await r.json()
    SHOP_STATUS = d
    renderShopLockOverlay()
  } catch(_) {}
}

function renderShopLockOverlay() {
  const overlay = document.getElementById('shop-lock-overlay')
  if (!overlay) return

  // 상점 탭이 아닐 때는 오버레이/배지 항상 숨김
  if (ST.tab !== 'shop') {
    overlay.style.display = 'none'
    const b = document.getElementById('shop-unlock-badge')
    if (b) b.style.display = 'none'
    return
  }

  if (SHOP_STATUS.unlocked && !SHOP_STATUS.locked) {
    const exp = SHOP_STATUS.expiresAt ? new Date(SHOP_STATUS.expiresAt + 'Z') : null
    const remain = exp ? Math.max(0, Math.floor((exp.getTime() - Date.now()) / 1000)) : 0
    if (remain <= 0) {
      SHOP_STATUS.unlocked = false
      overlay.style.display = 'none'
      const b = document.getElementById('shop-unlock-badge')
      if (b) b.style.display = 'none'
      return
    }
    const mm = Math.floor(remain / 60), ss = remain % 60
    overlay.style.display = 'none'
    const badge = document.getElementById('shop-unlock-badge')
    if (badge) { badge.style.display = 'block'; badge.textContent = '\uD83D\uDD13 ' + mm + ':' + String(ss).padStart(2,'0') + ' \uB0A8\uC74C' }
    return
  }

  if (SHOP_STATUS.locked) {
    overlay.style.display = 'flex'
    const lockMsg = document.getElementById('shopLockMsg')
    if (lockMsg) lockMsg.textContent = SHOP_STATUS.forceLocked ? '\uAD00\uB9AC\uc790\uAC00 \uC7A0\uAD38\uC2B5\uB2C8\uB2E4' : '\uC218\uC5C5 \uC911\uC785\uB2C8\uB2E4'
    const badge = document.getElementById('shop-unlock-badge')
    if (badge) { badge.style.display = 'none'; badge.textContent = '' }
    return
  }

  overlay.style.display = 'none'
  const badge = document.getElementById('shop-unlock-badge')
  if (badge) { badge.style.display = 'none'; badge.textContent = '' }
}




// 탭

window.switchTab=async function(tab){

  // 탭 변경 전 상점 polling 정지 (상점 탭 벗어날 때)
  if (tab !== 'shop' && shopPollTimer) {
    clearInterval(shopPollTimer); shopPollTimer = null
  }

  // 상점 탭이 아니면 오버레이/배지 반드시 숨김 (ST.tab 업데이트 전에 먼저 숨김)
  if (tab !== 'shop') {
    const ov = document.getElementById('shop-lock-overlay')
    if (ov) ov.style.display = 'none'
    const badge = document.getElementById('shop-unlock-badge')
    if (badge) badge.style.display = 'none'
  }

  // ST.tab 먼저 업데이트 (renderShopLockOverlay가 ST.tab 확인하므로)
  ST.tab = tab
  document.querySelectorAll('.tab-btn').forEach(b=>b.className='tab-btn')
  document.getElementById('tab-'+tab).classList.add('tab-btn','active-'+tab)

  // 상점 탭 클릭 시 잠금 확인
  if (tab === 'shop') {
    await checkShopStatus()
  }

  renderMenu()

  // 상점 탭이면 잠금 오버레이 처리
  if (tab === 'shop') renderShopLockOverlay()

}



// 메뉴 그리드

function renderMenu(){

  const items=CFG.menu[ST.tab]||[]

  const g=document.getElementById('menuGrid')

  const c=CFG.currency

  g.innerHTML=items.map(m=>{

    // 보강신청은 외부 링크

    if(m.id==='makeup'||m.externalUrl){

      const url=m.externalUrl||'https://forms.gle/XwZk3PdQk9HVPVfW6'

      return '<div class="menu-btn type-'+ST.tab+' btn-menu-ext" data-url="'+url+'">'+

        '<div class="menu-ic-wrap">'+m.icon+'</div>'+

        '<div class="menu-lbl">'+escHtml(m.label)+'</div>'+

        '<div class="menu-cost-tag" style="background:var(--blue-soft);color:var(--blue);border-color:var(--blue-mid)">외부링크</div>'+

      '</div>'

    }

    const ci=ST.cart.find(x=>x.id===m.id&&x.tab===ST.tab)

    const qty=ci?ci.qty:0

    const inCart=qty>0

    let costTxt

    if(ST.tab==='learn'){

      const netPts=(m.reward||0)-(m.cost||0)

      costTxt=netPts>0?'+'+netPts+' '+c.symbol:netPts<0?netPts+' '+c.unit:'무료'

    } else if(ST.tab==='fine'){

      // 항목별 화폐 단위 표시
      const fineUnit=m.unit||(m.fineType==='time'?'분':m.fineType==='sheet'?'장':c.unit)
      const fineIcon=m.fineType==='time'?'⏰':m.fineType==='sheet'?'📄':'💸'
      costTxt=fineIcon+' '+m.cost+' '+fineUnit

    } else {

      // shop: soldOut 체크
      if(m.soldOut){
        costTxt='품절'
      } else {
        costTxt=m.cost+' '+c.symbol
      }

    }

    const photoBadge=m.requirePhoto?'<div class="photo-badge-sm">cam</div>':''

    // shop 품절 처리
    const isSoldOut=(ST.tab==='shop'&&m.soldOut)

    let bottomHtml

    if(isSoldOut){

      bottomHtml='<div class="menu-cost-tag" style="background:#fee2e2;color:#dc2626;border-color:#fca5a5;">🚫 품절</div>'

    } else if(qty>0){

      bottomHtml='<div class="qty-ctrl" data-id="'+m.id+'" data-tab="'+ST.tab+'">'+

        '<button class="qty-minus">-</button>'+

        '<span class="qty-num">'+qty+'</span>'+

        '<button class="qty-plus">+</button>'+

      '</div>'

    } else {

      bottomHtml='<div class="menu-cost-tag">'+costTxt+'</div>'

    }

    return '<div class="menu-btn type-'+ST.tab+(inCart?' in-cart':'')+(isSoldOut?' sold-out':'')+' btn-menu-item" data-id="'+m.id+'" data-tab="'+ST.tab+'" data-soldout="'+isSoldOut+'">'+

      photoBadge+

      '<div class="menu-ic-wrap">'+m.icon+'</div>'+

      '<div class="menu-lbl">'+escHtml(m.label)+'</div>'+

      bottomHtml+

    '</div>'

  }).join('')

}



// 메뉴 그리드 이벤트 위임

document.addEventListener('click',function(e){

  // 외부링크 버튼

  const extBtn=e.target.closest('.btn-menu-ext')

  if(extBtn){window.open(extBtn.dataset.url,'_blank');return}

  // 수량 + 버튼

  if(e.target.closest('.qty-plus')){

    const ctrl=e.target.closest('.qty-ctrl')

    if(ctrl){

      const ex=ST.cart.find(x=>x.id===ctrl.dataset.id&&x.tab===ctrl.dataset.tab)

      if(ex){ex.qty++;updateCartBar();renderMenu()}

    }

    return

  }

  // 수량 - 버튼

  if(e.target.closest('.qty-minus')){

    const ctrl=e.target.closest('.qty-ctrl')

    if(ctrl){

      const ex=ST.cart.find(x=>x.id===ctrl.dataset.id&&x.tab===ctrl.dataset.tab)

      if(ex){

        ex.qty--

        if(ex.qty<=0)ST.cart.splice(ST.cart.indexOf(ex),1)

        updateCartBar();renderMenu()

      }

    }

    return

  }

  // 메뉴 카드 클릭 (수량 컨트롤 영역 제외, 품절 제외)

  const btn=e.target.closest('.btn-menu-item')

  if(btn&&!e.target.closest('.qty-ctrl')&&btn.dataset.soldout!=='true'){window.addToCart(btn.dataset.id,btn.dataset.tab)}

})



// 장바구니

window.addToCart=function(id,tab){

  const item=(CFG.menu[tab]||[]).find(x=>x.id===id);if(!item)return

  // 품절 처리
  if(item.soldOut){toast('😢 품절된 상품이에요!');return}

  if(item.requirePhoto){ST.pendingItem={item,tab};openPhotoModal(item.label);return}

  pushCart(item,tab,null)

}

function pushCart(item,tab,photo,comment){

  const ex=ST.cart.find(x=>x.id===item.id&&x.tab===tab)

  if(ex){ex.qty++}else{ST.cart.push({id:item.id,tab,icon:item.icon,label:item.label,cost:item.cost,reward:item.reward||0,requirePhoto:item.requirePhoto,qty:1,photo,comment:comment||'',fineType:item.fineType||'point',unit:item.unit||''})}

  updateCartBar();renderMenu()

  showFb(item.icon,item.label)

}

function showFb(icon,label){

  const fb=document.createElement('div');fb.className='fb-toast';fb.textContent=icon+' '+label+' 담았어요!'

  document.body.appendChild(fb);setTimeout(()=>fb.remove(),1500)

}

window.clearCart=function(){ST.cart=[];updateCartBar();renderMenu()}



// ── 상점 잠금해제 요청 ──────────────────────────────────────────────────────

window.requestShopUnlock = async function() {

  if (!ST.student) return

  const btn = document.getElementById('shopUnlockReqBtn')

  const status = document.getElementById('shopUnlockReqStatus')

  btn.disabled = true; btn.textContent = '⏳ 요청 중...'

  try {

    const res = await fetch('/api/shop/request-unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentName: ST.student.name, studentId: ST.student.id })
    })

    const d = await res.json()

    if (d.success) {

      btn.textContent = '✅ 요청 완료!'

      status.textContent = d.alreadyPending
        ? '이미 요청을 보냈어요. 선생님 승인을 기다려주세요 🙏'
        : '선생님께 알림을 보냈어요 승인되면 자동으로 열립니다 🙏'

      // 10초마다 승인 여부 폴링
      if (shopPollTimer) clearInterval(shopPollTimer)

      shopPollTimer = setInterval(async () => {

        await checkShopStatus()

        if (!SHOP_STATUS.locked) {

          clearInterval(shopPollTimer); shopPollTimer = null

          showFb('🛍️','상점이 열렸어요 빠르게 주문하세요!')

          renderShopLockOverlay()

          renderMenu()

          // 배지 표시
          const badge = document.getElementById('shop-unlock-badge')

          badge.style.display = 'block'

          // 1분마다 남은 시간 갱신
          const badgeTimer = setInterval(() => {

            if (!SHOP_STATUS.unlocked) { clearInterval(badgeTimer); badge.style.display='none'; return }

            const exp = SHOP_STATUS.expiresAt ? new Date(SHOP_STATUS.expiresAt + 'Z') : null

            const remain = exp ? Math.max(0, Math.floor((exp.getTime() - Date.now()) / 1000)) : 0

            if (remain <= 0) { clearInterval(badgeTimer); badge.style.display='none'; checkShopStatus(); return }

            const mm = Math.floor(remain/60), ss = remain%60

            badge.textContent = '\uD83D\uDD13 \uC0C1\uC810 \uC624\uD508 \uC911 \u00B7 ' + mm + ':' + String(ss).padStart(2,'0') + ' \uB0A8\uC74C'

          }, 1000)

        }

      }, 10000)

    } else {

      status.textContent = '요청 실패. 다시 시도해주세요.'

      btn.disabled = false; btn.textContent = '🙋 선생님께 상점 열기 요청'

    }

  } catch(_) {

    status.textContent = '오류가 발생했어요.'

    btn.disabled = false; btn.textContent = '🙋 선생님께 상점 열기 요청'

  }

}

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

window.closePhotoModal=function(){document.getElementById('photo-modal').classList.remove('open');ST.pendingItem=null;ST.photoB64=null;document.getElementById('photoInput').value='';document.getElementById('photoComment').value=''}

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

  const{item,tab}=ST.pendingItem

  const comment=document.getElementById('photoComment').value.trim()

  pushCart(item,tab,ST.photoB64,comment)

  closePhotoModal()

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

function calcTotal(){

  return ST.cart.reduce((a,x)=>{

    if(x.tab==='learn'){

      // learn: reward 있으면 획득(음수), cost 있으면 차감(양수)

      return a - (x.reward||0)*x.qty + (x.cost||0)*x.qty

    }

    if(x.tab==='fine'){

      // fine: cost 차감 - reward 획득 (벌점이지만 일부 보상 가능)

      return a + (x.cost||0)*x.qty - (x.reward||0)*x.qty

    }

    // shop: cost 차감

    return a + (x.cost||0)*x.qty

  },0)

}



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

      body:JSON.stringify({

        name:ST.student.name,

        items:ST.cart.map(x=>({icon:x.icon,label:x.label,qty:x.qty,tab:x.tab,comment:x.comment||'',fineType:x.fineType||'point',unit:x.unit||''})),

        totalCost:tc,

        currency:CFG.currency.unit,

        category,

        photoBase64:ST.cart.find(x=>x.photo)?.photo||null,

        comment:ST.cart.filter(x=>x.comment).map(x=>x.icon+x.label+': '+x.comment).join(' / ')||null,

        timestamp:ts

      })})

    const data=await res.json()

    if(ST.student){ST.student.points-=tc}

    await loadStudents()

    // 업데이트된 학생 정보 반영

    const updStu=STUDENTS.find(x=>x.id===ST.student.id)

    if(updStu) ST.student=updStu

    closeConfirm();renderDone(data.slack,data.notion,ts,tc)

  }catch(err){closeConfirm();renderDone(false,false,ts,tc)}

  finally{ST.submitting=false}

}



// 완료 화면

function renderDone(slackOk,notionOk,ts,tc){

  const c=CFG.currency

  const lastOrder=ST.sessionOrders[ST.sessionOrders.length-1]

  const hasFine=lastOrder&&lastOrder.category==='fine'

  const hasShop=lastOrder&&lastOrder.category==='shop'

  document.getElementById('doneEmoji').textContent=hasFine?'\uD83D\uDE05':hasShop?'\uD83D\uDECD':'\uD83C\uDF89'

  document.getElementById('doneTitle').textContent=hasFine?'기록 완료!':hasShop?'교환 완료 🎊':'잘했어요 🌟'

  const newPts=ST.student?ST.student.points:0

  document.getElementById('doneSub').innerHTML='<strong>'+escHtml(ST.student.name)+'</strong>님 기록 완료!<br/>'+(tc<0?'<span style="color:var(--green)">+'+Math.abs(tc)+' '+c.symbol+' 획득 🎊</span>':tc>0?'<span style="color:var(--red)">-'+tc+' '+c.unit+' 차감</span>':'<span style="color:var(--green)">무료 활동 ✅</span>')

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

// 요청사항 모달

let REQ_B64=null

window.openReqModal=function(){

  if(!ST.student){showFb('💬','먼저 학생을 선택해주세요!');return}

  document.getElementById('reqMsg').value=''

  document.getElementById('reqPrev').style.display='none'

  const pc=document.getElementById('reqPhotoCamera');if(pc)pc.value=''

  const pg=document.getElementById('reqPhotoGallery');if(pg)pg.value=''

  const pi=document.getElementById('reqPhotoInfo');if(pi)pi.style.display='none'

  REQ_B64=null

  document.getElementById('req-modal').classList.add('open')

}

window.closeReqModal=function(){

  document.getElementById('req-modal').classList.remove('open')

}

window.triggerReqPhoto=function(mode){

  if(mode==='camera'){

    document.getElementById('reqPhotoCamera').click()

  } else {

    document.getElementById('reqPhotoGallery').click()

  }

}

window.clearReqPhoto=function(){

  REQ_B64=null

  const p=document.getElementById('reqPrev');p.src='';p.style.display='none'

  const pc=document.getElementById('reqPhotoCamera');if(pc)pc.value=''

  const pg=document.getElementById('reqPhotoGallery');if(pg)pg.value=''

  const pi=document.getElementById('reqPhotoInfo');if(pi)pi.style.display='none'

}

window.onReqPhoto=function(e){

  const f=e.target.files[0];if(!f)return

  const reader=new FileReader()

  reader.onload=function(ev){

    REQ_B64=ev.target.result

    const p=document.getElementById('reqPrev');p.src=REQ_B64;p.style.display='block'

    const pi=document.getElementById('reqPhotoInfo');if(pi)pi.style.display='block'

  };reader.readAsDataURL(f)

}

window.doRequest=async function(){

  const msg=document.getElementById('reqMsg').value.trim()

  if(!msg&&!REQ_B64){showFb('💬','내용을 입력하거나 사진을 첨부해주세요!');return}

  const btn=document.getElementById('reqOk')

  btn.disabled=true;document.getElementById('reqTxt').textContent='전송 중...'

  const ts=new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})

  try{

    const res=await fetch('/api/request',{method:'POST',headers:{'Content-Type':'application/json'},

      body:JSON.stringify({name:ST.student.name,message:msg||'(사진만 첨부)',photoBase64:REQ_B64,timestamp:ts})})

    const d=await res.json()

    closeReqModal()

    showFb('💬','요청사항 전송 완료!')

  }catch(err){showFb('💬','전송 실패. 다시 시도해주세요.')}

  finally{btn.disabled=false;document.getElementById('reqTxt').textContent='전송하기'}

}





// ──────────────────────────────────────────────────────────

//  번호표 시스템

// ──────────────────────────────────────────────────────────

let QUEUE_STUDENT = null  // 번호표 뽑을 학생



// 번호표 화면으로 이동 (학생 선택 단계)

window.goToQueue = function() {

  goTo('queue')

  // queue-screen 내 sub-step 제어

  document.getElementById('queue-step-select').style.display = 'block'

  document.getElementById('queue-step-result').style.display = 'none'

  document.getElementById('queueSearchInp').value = ''

  renderQueueStudents()

}



// 번호표 학생 그리드 렌더

function renderQueueStudents() {

  const g = document.getElementById('queueStudentGrid')

  g.innerHTML = STUDENTS.map(s => {

    const photoEl = s.photo_url

      ? '<img class="stu-photo" src="'+escHtml(s.photo_url)+'" alt="'+escHtml(s.name)+'"/>'

      : '<div class="stu-av">'+escHtml(s.name[0])+'</div>'

    return '<button class="stu-btn" data-name="'+escHtml(s.name)+'" onclick="selectQueueStudent('+s.id+')">'+

      photoEl+'<div class="stu-name">'+escHtml(s.name)+'</div></button>'

  }).join('')

}



window.filterQueueStudents = function(q) {

  const kw = q.trim()

  document.querySelectorAll('#queueStudentGrid .stu-btn').forEach(b => {

    b.classList.toggle('hidden', !!kw && !b.dataset.name.includes(kw))

  })

}



// 학생 선택 후 번호표 발급

window.selectQueueStudent = async function(id) {

  const s = STUDENTS.find(x => x.id === id); if (!s) return

  QUEUE_STUDENT = s



  // 단계 전환 (결과 화면으로)

  document.getElementById('queue-step-select').style.display = 'none'

  document.getElementById('queue-step-result').style.display = 'flex'



  // 임시 로딩 표시

  document.getElementById('queueNumber').textContent = '...'

  document.getElementById('queueStuName').textContent = s.name

  document.getElementById('queueWaiting').textContent = '-'

  document.getElementById('queueTotal').textContent = '-'



  try {

    const res = await fetch('/api/queue/draw', {

      method: 'POST',

      headers: {'Content-Type':'application/json'},

      body: JSON.stringify({ studentName: s.name })

    })

    const data = await res.json()



    if (!data.success) {

      // 오류 처리

      const msgBox = document.getElementById('queueMsgBox')

      const msgText = document.getElementById('queueMsgText')

      msgBox.className = 'queue-msg-box warn'

      document.querySelector('#queueMsgBox .queue-msg-icon').textContent = data.error === 'consecutive' ? '🙋' : '⚠️'

      msgText.textContent = data.message || '번호표를 발급할 수 없어요.'

      document.getElementById('queueNumber').textContent = '!'

      // 현황 불러오기

      await loadQueueStatus(null)

      return

    }



    // 성공

    document.getElementById('queueNumber').textContent = data.number

    document.getElementById('queueDate').textContent = data.date + ' 발급'



    const msgBox = document.getElementById('queueMsgBox')

    const msgText = document.getElementById('queueMsgText')



    if (data.waiting === 0) {

      msgBox.className = 'queue-msg-box ok'

      document.querySelector('#queueMsgBox .queue-msg-icon').textContent = '🎉'

      msgText.textContent = '첫 번째 바로 이용할 수 있어요!'

    } else if (data.waiting <= 2) {

      msgBox.className = 'queue-msg-box info'

      document.querySelector('#queueMsgBox .queue-msg-icon').textContent = '⏳'

      msgText.textContent = '앞에 ' + data.waiting + '명 있어요. 거의 다 왔어요!'

    } else {

      msgBox.className = 'queue-msg-box info'

      document.querySelector('#queueMsgBox .queue-msg-icon').textContent = '🎫'

      msgText.textContent = '앞에 ' + data.waiting + '명이 기다리고 있어요!'

    }



    await loadQueueStatus(data.number)



  } catch (err) {

    document.getElementById('queueNumber').textContent = '!'

    document.getElementById('queueMsgText').textContent = '네트워크 오류가 발생했어요.'

  }

}



// 현황 조회 및 목록 표시

async function loadQueueStatus(myNumber) {

  try {

    const res = await fetch('/api/queue/status')

    const data = await res.json()

    if (!data.success) return



    document.getElementById('queueWaiting').textContent = myNumber

      ? (data.tickets.filter(t => !t.called && t.number < myNumber).length) + '명'

      : (data.waiting + '명')

    document.getElementById('queueTotal').textContent = data.total + '장'



    // 번호표 목록 렌더

    const listEl = document.getElementById('queueTicketList')

    if (data.tickets.length > 0) {

      const chips = data.tickets.map(t => {

        const isMine = myNumber && t.number === myNumber

        const cls = isMine ? 'mine' : (t.called ? 'called' : 'waiting')

        return '<div class="qtl-chip ' + cls + '">' + t.number + '번 ' + escHtml(t.student_name) + (isMine ? ' (나)' : '') + '</div>'

      }).join('')

      listEl.innerHTML = '<div class="qtl-title">오늘의 번호표 현황</div><div class="qtl-items">' + chips + '</div>'

    } else {

      listEl.innerHTML = ''

    }

  } catch (e) {}

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

  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x2699;</text></svg>"/>

  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;800&display=swap" rel="stylesheet"/>

  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet"/>

  <style>

    :root{--blue:#29ABE2;--blue-d:#1a90c4;--blue-s:#e8f6fd;--blue-m:#b3dff5;--white:#fff;--g50:#f8fafc;--g100:#f1f5f9;--g200:#e2e8f0;--g400:#94a3b8;--g600:#475569;--g800:#1e293b;--red:#ef4444;--red-s:#fef2f2;--green:#22c55e;--green-s:#f0fdf4;--yellow:#fbbf24;--yellow-s:#fffbeb;--purple:#a855f7;--purple-s:#faf5ff;--orange:#f97316;--indigo:#6366f1;--indigo-s:#eef2ff;}

    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}

    body{font-family:'Noto Sans KR',sans-serif;background:var(--g50);color:var(--g800);min-height:100vh;}



    /* 로그인 */

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



    /* 헤더 */

    #main-screen.hidden{display:none;}

    .hdr{background:var(--white);border-bottom:1.5px solid var(--g200);padding:0 clamp(14px,3vw,32px);height:64px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;box-shadow:0 1px 6px rgba(0,0,0,.05);}

    .hdr-l{display:flex;align-items:center;gap:12px;}

    .hdr-l img{height:34px;width:auto;}

    .hdr-ttl{font-size:15px;font-weight:800;color:var(--blue);}

    .hdr-r{display:flex;gap:8px;align-items:center;}

    .btn-kiosk{display:flex;align-items:center;gap:5px;background:var(--blue);color:white;text-decoration:none;font-size:13px;font-weight:700;padding:7px 14px;border-radius:100px;transition:all .2s;}

    .btn-kiosk:hover{background:var(--blue-d);}

    .btn-logout{background:var(--g100);border:1.5px solid var(--g200);color:var(--g600);font-family:inherit;font-size:13px;font-weight:700;padding:7px 14px;border-radius:100px;cursor:pointer;transition:all .2s;}

    .btn-logout:hover{background:var(--red-s);color:var(--red);border-color:rgba(239,68,68,.3);}



    /* 탭 네비 */

    .main-tabs{display:flex;gap:4px;padding:14px clamp(14px,3vw,32px) 0;background:var(--white);border-bottom:1.5px solid var(--g200);overflow-x:auto;}

    .main-tabs::-webkit-scrollbar{display:none;}

    .mtab{display:flex;align-items:center;gap:6px;font-family:inherit;font-size:13px;font-weight:700;padding:10px 16px;border-radius:10px 10px 0 0;cursor:pointer;border:none;background:transparent;color:var(--g400);transition:all .2s;white-space:nowrap;border-bottom:2.5px solid transparent;margin-bottom:-1.5px;}

    .mtab:hover{color:var(--g800);background:var(--g50);}

    .mtab.active{color:var(--blue);border-bottom-color:var(--blue);background:var(--blue-s);}

    .mtab .badge{min-width:18px;height:18px;border-radius:9px;font-size:10px;font-weight:900;display:inline-flex;align-items:center;justify-content:center;padding:0 5px;}

    .mtab .badge.red{background:var(--red);color:white;}

    .mtab .badge.yellow{background:var(--yellow);color:#78350f;}

    .mtab .badge.blue{background:var(--blue);color:white;}



    /* 콘텐츠 영역 */

    .content{padding:clamp(14px,2.5vw,28px) clamp(14px,3vw,32px);max-width:1200px;margin:0 auto;}

    .tab-panel{display:none;}

    .tab-panel.active{display:block;}



    /* 카드 */

    .card{background:var(--white);border-radius:16px;border:1.5px solid var(--g200);box-shadow:0 2px 10px rgba(0,0,0,.04);margin-bottom:16px;overflow:hidden;}

    .card-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1.5px solid var(--g100);gap:10px;flex-wrap:wrap;}

    .card-title{font-size:15px;font-weight:800;color:var(--g800);display:flex;align-items:center;gap:7px;}

    .card-body{padding:16px 20px;}



    /* 필터 버튼 */

    .filter-row{display:flex;gap:6px;flex-wrap:wrap;}

    .filter-btn{font-family:inherit;font-size:12px;font-weight:700;padding:6px 14px;border-radius:100px;border:1.5px solid var(--g200);background:var(--white);color:var(--g600);cursor:pointer;transition:all .15s;}

    .filter-btn:hover{border-color:var(--blue);color:var(--blue);}

    .filter-btn.active{background:var(--blue);border-color:var(--blue);color:white;}



    /* 번호표 아이템 */

    .ticket-item{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--g100);}

    .ticket-item:last-child{border-bottom:none;}

    .ticket-num{width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-family:'Nunito',sans-serif;font-size:20px;font-weight:900;flex-shrink:0;}

    .ticket-num.waiting{background:#dbeafe;color:#1d4ed8;}

    .ticket-num.answering{background:var(--yellow-s);color:#92400e;}

    .ticket-num.done{background:var(--green-s);color:#166534;}

    .ticket-info{flex:1;min-width:0;}

    .ticket-name{font-size:14px;font-weight:800;}

    .ticket-time{font-size:11px;color:var(--g400);margin-top:2px;}

    .ticket-actions{display:flex;gap:6px;flex-shrink:0;}

    .ticket-status-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:800;padding:4px 10px;border-radius:100px;}

    .ticket-status-badge.waiting{background:#dbeafe;color:#1d4ed8;}

    .ticket-status-badge.answering{background:var(--yellow-s);color:#92400e;}

    .ticket-status-badge.done{background:var(--green-s);color:#166534;}

    .stat-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:16px;}

    .stat-card{background:var(--white);border:1.5px solid var(--g200);border-radius:14px;padding:14px 16px;text-align:center;}

    .stat-card .num{font-family:'Nunito',sans-serif;font-size:28px;font-weight:900;line-height:1;}

    .stat-card .lbl{font-size:11px;font-weight:700;color:var(--g400);margin-top:4px;}

    .stat-card.blue .num{color:#1d4ed8;}

    .stat-card.yellow .num{color:#92400e;}

    .stat-card.green .num{color:#166534;}

    .stat-card.gray .num{color:var(--g600);}



    /* 요청사항 */

    .req-item{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--g100);}

    .req-item:last-child{border-bottom:none;}

    .req-av{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--blue-s),#cde9f8);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:var(--blue-d);flex-shrink:0;border:2px solid var(--blue-m);}

    .req-body{flex:1;min-width:0;}

    .req-top{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;}

    .req-name{font-size:13px;font-weight:800;}

    .req-time{font-size:11px;color:var(--g400);}

    .req-msg{font-size:13px;color:var(--g600);line-height:1.5;word-break:break-all;}

    .req-note{font-size:12px;color:var(--indigo);background:var(--indigo-s);border-radius:8px;padding:6px 10px;margin-top:6px;}

    .req-photo-badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:800;background:var(--orange);color:white;padding:2px 7px;border-radius:100px;}

    .req-actions{display:flex;gap:5px;flex-shrink:0;flex-direction:column;align-items:flex-end;}

    .status-badge{display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:800;padding:4px 10px;border-radius:100px;white-space:nowrap;}

    .status-badge.pending{background:#fef3c7;color:#92400e;}

    .status-badge.in_progress{background:var(--blue-s);color:var(--blue-d);}

    .status-badge.done{background:var(--green-s);color:#166534;}



    /* 주문 현황 */

    .order-item{display:flex;gap:10px;padding:12px 0;border-bottom:1px solid var(--g100);align-items:flex-start;}

    .order-item:last-child{border-bottom:none;}

    .order-cat{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}

    .order-cat.learn{background:var(--green-s);}

    .order-cat.fine{background:var(--red-s);}

    .order-cat.shop{background:var(--purple-s);}

    .order-body{flex:1;min-width:0;}

    .order-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;}

    .order-stu{font-size:13px;font-weight:800;}

    .order-time{font-size:11px;color:var(--g400);}

    .order-items-txt{font-size:12px;color:var(--g600);}

    .order-cost{font-size:13px;font-weight:900;white-space:nowrap;flex-shrink:0;}

    .order-cost.gain{color:var(--green);}

    .order-cost.loss{color:var(--red);}

    .order-cost.free{color:var(--g400);}



    /* 학생 관리 */

    .stu-list-item{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--g100);}

    .stu-list-item:last-child{border-bottom:none;}

    .stu-av-sm{width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid var(--blue-m);flex-shrink:0;}

    .stu-av-txt{width:36px;height:36px;border-radius:50%;background:var(--blue-s);border:2px solid var(--blue-m);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;color:var(--blue-d);flex-shrink:0;}

    .stu-name-lbl{font-size:14px;font-weight:800;flex:1;}

    .stu-pts-lbl{font-size:12px;font-weight:700;background:var(--yellow-s);color:#92400e;border:1px solid rgba(251,191,36,.3);border-radius:100px;padding:2px 8px;}



    /* 메뉴 항목 / 화폐 설정 */

    .menu-item-row{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px dashed var(--g100);flex-wrap:wrap;}

    .menu-item-row:last-child{border-bottom:none;}

    .item-icon-box{width:38px;height:38px;border-radius:10px;background:var(--g50);border:1.5px solid var(--g200);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;}

    .item-label{font-size:13px;font-weight:700;flex:1;min-width:80px;}

    .item-cost-inp{width:72px;border:1.5px solid var(--g200);border-radius:8px;padding:5px 8px;font-family:inherit;font-size:12px;font-weight:700;text-align:center;outline:none;}

    .item-cost-inp:focus{border-color:var(--blue);}

    .item-unit-sel{border:1.5px solid var(--g200);border-radius:8px;padding:5px 6px;font-family:inherit;font-size:12px;font-weight:700;outline:none;background:var(--white);}

    .item-unit-sel:focus{border-color:var(--blue);}

    .item-del-btn{width:28px;height:28px;border-radius:8px;border:1.5px solid rgba(239,68,68,.25);background:var(--red-s);color:var(--red);font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}



    /* 입력 컨트롤 */

    .inp{width:100%;border:1.5px solid var(--g200);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:14px;font-weight:500;outline:none;transition:all .2s;background:var(--white);}

    .inp:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(41,171,226,.08);}

    .sel{border:1.5px solid var(--g200);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:14px;font-weight:500;outline:none;background:var(--white);cursor:pointer;}

    .btn{font-family:inherit;font-size:13px;font-weight:700;padding:8px 16px;border-radius:10px;cursor:pointer;border:none;transition:all .2s;}

    .btn-blue{background:var(--blue);color:white;}

    .btn-blue:hover{background:var(--blue-d);}

    .btn-green{background:var(--green);color:white;}

    .btn-green:hover{background:#16a34a;}

    .btn-red{background:var(--red);color:white;}

    .btn-red:hover{background:#dc2626;}

    .btn-gray{background:var(--g100);color:var(--g600);border:1.5px solid var(--g200);}

    .btn-gray:hover{background:var(--g200);}

    .btn-sm{padding:5px 11px;font-size:12px;border-radius:8px;}

    .btn-xs{padding:3px 8px;font-size:11px;border-radius:6px;}

    .btn-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;}



    /* 히스토리 모달 */

    .modal-ov{position:fixed;inset:0;z-index:300;background:rgba(15,23,42,.45);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;padding:16px;}

    .modal-ov.open{display:flex;}

    .modal-box{background:var(--white);border-radius:20px;padding:28px 24px;width:min(520px,96vw);max-height:80vh;overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.16);}

    .modal-title{font-size:18px;font-weight:900;margin-bottom:16px;}

    .hist-item{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--g100);font-size:13px;}

    .hist-item:last-child{border-bottom:none;}

    .hist-delta{font-weight:900;}

    .hist-delta.pos{color:var(--green);}

    .hist-delta.neg{color:var(--red);}



    /* 저장 바 */

    .save-bar{position:sticky;bottom:0;background:rgba(255,255,255,.95);backdrop-filter:blur(10px);border-top:1.5px solid var(--g200);padding:12px 20px;display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 -20px -16px;}



    /* 프리셋 */

    .preset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:8px;margin-bottom:16px;}

    .preset-btn{background:var(--g50);border:1.5px solid var(--g200);border-radius:12px;padding:10px 8px;cursor:pointer;text-align:center;font-family:inherit;font-size:12px;font-weight:700;transition:all .15s;}

    .preset-btn:hover{border-color:var(--blue);background:var(--blue-s);}

    .preset-btn .pi{font-size:20px;display:block;margin-bottom:4px;}



    /* 토스트 */

    .toast{position:fixed;bottom:24px;right:24px;background:var(--g800);color:white;padding:10px 20px;border-radius:100px;font-size:13px;font-weight:700;z-index:9999;animation:tst-in .3s ease;pointer-events:none;}

    @keyframes tst-in{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}



    /* 반응형 */

    @media(max-width:640px){

      .ticket-actions,.req-actions{flex-direction:row;}

      .order-item{flex-wrap:wrap;}

    }

  </style>

</head>

<body>



<!-- 로그인 -->

<div id="login-screen">

  <div class="login-box">

    <img class="login-logo" src="/static/logo_horizontal.png" alt="바꿈수학"/>

    <div class="login-title">관리자 로그인</div>

    <div class="login-sub">바꿈수학 키오스크 관리자 페이지입니다.</div>

    <div class="pw-wrap">

      <input class="pw-inp" type="password" id="pwInp" placeholder="비밀번호" onkeydown="if(event.key==='Enter')doLogin()"/>

      <i class="fas fa-eye pw-eye" onclick="var i=document.getElementById('pwInp');i.type=i.type==='password'?'text':'password'"></i>

    </div>

    <button class="btn-login" onclick="doLogin()">로그인</button>

    <div class="login-err" id="loginErr">비밀번호가 틀렸습니다.</div>

  </div>

</div>



<!-- 메인 -->

<div id="main-screen" class="hidden">

  <header class="hdr">

    <div class="hdr-l">

      <img src="/static/logo_horizontal.png" alt="바꿈수학"/>

      <span class="hdr-ttl">관리자</span>

    </div>

    <div class="hdr-r">

      <a href="/" class="btn-kiosk" target="_blank"><i class="fas fa-desktop"></i> 키오스크</a>

      <button class="btn-logout" onclick="doLogout()"><i class="fas fa-sign-out-alt"></i> 로그아웃</button>

    </div>

  </header>



  <!-- 탭 네비 -->

  <nav class="main-tabs" id="mainTabs">

    <button class="mtab active" data-tab="queue" onclick="switchMainTab('queue')">

      <i class="fas fa-ticket"></i> 번호표

      <span class="badge blue" id="badge-queue">0</span>

    </button>

    <button class="mtab" data-tab="requests" onclick="switchMainTab('requests')">

      <i class="fas fa-comment-dots"></i> 요청사항

      <span class="badge red" id="badge-requests">0</span>

    </button>

    <button class="mtab" data-tab="orders" onclick="switchMainTab('orders')">

      <i class="fas fa-list-check"></i> 주문현황

    </button>

    <button class="mtab" data-tab="students" onclick="switchMainTab('students')">

      <i class="fas fa-users"></i> 학생관리

    </button>

    <button class="mtab" data-tab="fines" onclick="switchMainTab('fines')">

      <i class="fas fa-exclamation-triangle"></i> 벌금

      <span class="badge red" id="badge-fines">0</span>

    </button>

    <button class="mtab" data-tab="menu" onclick="switchMainTab('menu')">

      <i class="fas fa-utensils"></i> 메뉴설정

    </button>

    <button class="mtab" data-tab="currency" onclick="switchMainTab('currency')">

      <i class="fas fa-coins"></i> 화폐설정

    </button>

    <button class="mtab" data-tab="shoplock" onclick="switchMainTab('shoplock')">

      <i class="fas fa-store"></i> 상점잠금

    </button>

  </nav>



  <div class="content">



    <!-- ══ 번호표 탭 ══ -->

    <div class="tab-panel active" id="tab-queue">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-ticket"></i> 오늘 번호표 현황</div>

          <div style="display:flex;gap:8px;align-items:center;">

            <input type="date" id="queueDatePick" class="inp" style="width:160px;" onchange="loadQueue()"/>

            <button class="btn btn-blue btn-sm" onclick="loadQueue()"><i class="fas fa-rotate"></i> 새로고침</button>

          </div>

        </div>

        <div class="card-body">

          <div class="stat-cards" id="queueStats">

            <div class="stat-card blue"><div class="num" id="qs-waiting">-</div><div class="lbl">대기중</div></div>

            <div class="stat-card yellow"><div class="num" id="qs-answering">-</div><div class="lbl">답변중</div></div>

            <div class="stat-card green"><div class="num" id="qs-done">-</div><div class="lbl">완료</div></div>

            <div class="stat-card gray"><div class="num" id="qs-total">-</div><div class="lbl">총 발급</div></div>

          </div>

          <div class="filter-row" style="margin-bottom:12px;">

            <button class="filter-btn active" onclick="filterQueue('all',this)">전체</button>

            <button class="filter-btn" onclick="filterQueue('waiting',this)">대기중</button>

            <button class="filter-btn" onclick="filterQueue('answering',this)">답변중</button>

            <button class="filter-btn" onclick="filterQueue('done',this)">완료</button>

          </div>

          <div id="queueList"><div style="color:var(--g400);text-align:center;padding:20px;">로딩 중...</div></div>

        </div>

      </div>

    </div>



    <!-- ══ 요청사항 탭 ══ -->

    <div class="tab-panel" id="tab-requests">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-comment-dots"></i> 학생 요청사항</div>

          <div style="display:flex;gap:8px;">

            <button class="btn btn-blue btn-sm" onclick="loadRequests()"><i class="fas fa-rotate"></i> 새로고침</button>

          </div>

        </div>

        <div class="card-body">

          <div class="filter-row" style="margin-bottom:12px;">

            <button class="filter-btn active" onclick="filterReq('all',this)">전체</button>

            <button class="filter-btn" onclick="filterReq('pending',this)">미확인</button>

            <button class="filter-btn" onclick="filterReq('in_progress',this)">처리중</button>

            <button class="filter-btn" onclick="filterReq('done',this)">완료</button>

          </div>

          <div id="reqList"><div style="color:var(--g400);text-align:center;padding:20px;">로딩 중...</div></div>

        </div>

      </div>

    </div>



    <!-- ══ 주문현황 탭 ══ -->

    <div class="tab-panel" id="tab-orders">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-list-check"></i> 제출 내역</div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">

            <input class="inp" id="orderSearch" placeholder="학생 이름 검색..." style="width:160px;" oninput="loadOrders()"/>

            <select class="sel" id="orderCatFilter" onchange="loadOrders()" style="padding:8px 10px;font-size:13px;">

              <option value="">전체 분류</option>

              <option value="learn">학습활동</option>

              <option value="fine">벌금</option>

              <option value="shop">보상교환</option>

            </select>

            <button class="btn btn-blue btn-sm" onclick="loadOrders()"><i class="fas fa-rotate"></i> 새로고침</button>

          </div>

        </div>

        <div class="card-body">

          <div id="orderList"><div style="color:var(--g400);text-align:center;padding:20px;">로딩 중...</div></div>

        </div>

      </div>

    </div>



    <!-- ══ 학생 관리 탭 ══ -->

    <div class="tab-panel" id="tab-students">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-users"></i> 학생 목록</div>

          <div style="display:flex;gap:8px;">

            <input class="inp" id="newStuName" placeholder="새 학생 이름" style="width:160px;" onkeydown="if(event.key==='Enter')addStudent()"/>

            <button class="btn btn-green btn-sm" onclick="addStudent()"><i class="fas fa-plus"></i> 추가</button>

          </div>

        </div>

        <div class="card-body">

          <div id="stuList">로딩 중...</div>

        </div>

      </div>

    </div>



    <!-- ══ 벌금 탭 ══ -->

    <div class="tab-panel" id="tab-fines">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-exclamation-triangle"></i> 벌금 관리</div>

          <div class="filter-row">

            <button class="filter-btn active" onclick="filterFine('all',this)">전체</button>

            <button class="filter-btn" onclick="filterFine('point',this)">💸 포인트</button>

            <button class="filter-btn" onclick="filterFine('time',this)">⏰ 시간</button>

            <button class="filter-btn" onclick="filterFine('sheet',this)">📄 학습지</button>

            <button class="btn btn-sm btn-green" onclick="loadStudentsData()" style="margin-left:6px;"><i class="fas fa-refresh"></i></button>

          </div>

        </div>

        <div class="card-body">

          <div id="fineList">로딩 중...</div>

        </div>

      </div>

    </div>



    <!-- ══ 메뉴 설정 탭 ══ -->

    <div class="tab-panel" id="tab-menu">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-book"></i> 학습 활동</div>

          <span style="font-size:12px;color:var(--g400)">보상 = 포인트 획득 / 비용 = 포인트 차감</span>

        </div>

        <div class="card-body">

          <div id="menuLearnList"></div>

          <div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;">

            <input class="inp" id="nLIc" placeholder="아이콘" style="width:64px;"/>

            <input class="inp" id="nLLbl" placeholder="항목명" style="flex:1;min-width:100px;"/>

            <input class="inp" id="nLRew" placeholder="보상 P" type="number" style="width:80px;"/>

            <input class="inp" id="nLUnit" placeholder="화폐단위" style="width:80px;"/>

            <label style="display:flex;align-items:center;gap:4px;font-size:13px;white-space:nowrap;"><input type="checkbox" id="nLPhoto"/> 사진</label>

            <button class="btn btn-blue btn-sm" id="addLearnBtn">추가</button>

          </div>

        </div>

      </div>

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-exclamation-circle"></i> 벌금 항목</div>

        </div>

        <div class="card-body">

          <div id="menuFineList"></div>

          <div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;align-items:center;">

            <input class="inp" id="nFIc" placeholder="아이콘" style="width:64px;"/>

            <input class="inp" id="nFLbl" placeholder="항목명" style="flex:1;min-width:100px;"/>

            <input class="inp" id="nFCost" placeholder="수량" type="number" style="width:70px;"/>

            <select class="inp" id="nFType" style="width:110px;padding:6px 8px;font-size:12px;">

              <option value="point">💸 포인트</option>

              <option value="time">⏰ 시간(분)</option>

              <option value="sheet">📄 학습지(장)</option>

            </select>

            <button class="btn btn-red btn-sm" id="addFineBtn">추가</button>

          </div>

        </div>

      </div>

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-shopping-bag"></i> 보상 상점</div>

        </div>

        <div class="card-body">

          <div id="menuShopList"></div>

          <div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;align-items:flex-end;">
            <input class="inp" id="nSIc" placeholder="아이콘" style="width:64px;"/>
            <input class="inp" id="nSLbl" placeholder="항목명" style="flex:1;min-width:100px;"/>
            <input class="inp" id="nSCost" placeholder="비용" type="number" style="width:70px;"/>
            <input class="inp" id="nSUnit" placeholder="화폐단위" style="width:70px;"/>
            <div style="display:flex;flex-direction:column;gap:2px;">
              <input class="inp" id="nSDailyLimit" placeholder="0" type="number" min="0" style="width:60px;" title="하루 구매 한도 (0=무제한)"/>
              <span style="font-size:10px;color:var(--g400);text-align:center;">일한도</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:2px;">
              <input class="inp" id="nSMonthlyStock" placeholder="0" type="number" min="0" style="width:60px;" title="월 재고 (0=무제한)"/>
              <span style="font-size:10px;color:var(--g400);text-align:center;">월재고</span>
            </div>
            <button class="btn btn-blue btn-sm" id="addShopBtn">추가</button>
          </div>

        </div>

      </div>

      <div style="position:sticky;bottom:0;background:rgba(255,255,255,.95);backdrop-filter:blur(10px);border-top:1.5px solid var(--g200);padding:12px 0;display:flex;gap:8px;justify-content:flex-end;">

        <button class="btn btn-gray btn-sm" id="resetmenuBtn"><i class="fas fa-rotate-left"></i> 기본값</button>

        <button class="btn btn-blue" id="savemenuBtn"><i class="fas fa-floppy-disk"></i> 메뉴 저장</button>

      </div>

    </div>



    <!-- ══ 화폐 설정 탭 ══ -->

    <div class="tab-panel" id="tab-currency">

      <div class="card">

        <div class="card-head">

          <div class="card-title"><i class="fas fa-coins"></i> 기본 화폐 단위</div>

        </div>

        <div class="card-body">

          <div class="preset-grid" id="presetGrid"></div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">

            <div>

              <label style="font-size:12px;font-weight:700;color:var(--g600);display:block;margin-bottom:4px;">화폐 이름</label>

              <input class="inp" id="curUnit" placeholder="포인트"/>

            </div>

            <div>

              <label style="font-size:12px;font-weight:700;color:var(--g600);display:block;margin-bottom:4px;">기호/이모지</label>

              <input class="inp" id="curSymbol" placeholder="P"/>

            </div>

          </div>

          <div style="margin-bottom:14px;">

            <label style="font-size:12px;font-weight:700;color:var(--g600);display:block;margin-bottom:4px;">설명 (스플래시 표시)</label>

            <input class="inp" id="curDesc" placeholder="포인트를 모아서 간식이랑 교환해요!"/>

          </div>

          <div style="background:var(--g50);border:1.5px solid var(--g200);border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:8px;">

            <span style="font-size:22px;" id="curPrevSymbol">P</span>

            <div>

              <div style="font-size:14px;font-weight:800;" id="curPrevUnit">포인트</div>

              <div style="font-size:12px;color:var(--g400);" id="curPrevDesc">설명이 여기 표시됩니다</div>

            </div>

          </div>

          <button class="btn btn-blue" style="width:100%;margin-top:12px;" id="savecurBtn"><i class="fas fa-floppy-disk"></i> 저장</button>

        </div>

      </div>

    </div>

  <!-- ══ 상점 잠금 탭 ══ -->
    <div class="tab-panel" id="tab-shoplock">
 
      <!-- 승인 요청 목록 -->
      <div class="card">
        <div class="card-head">
          <div class="card-title"><i class="fas fa-bell"></i> 상점 열기 요청</div>
          <button class="btn btn-sm btn-green" onclick="loadShopRequests()"><i class="fas fa-refresh"></i></button>
        </div>
        <div class="card-body">
          <div id="shopRequestList"><div style="color:var(--g400);text-align:center;padding:16px;">로딩 중...</div></div>
        </div>
      </div>
 
      <!-- 현재 상태 -->
      <div class="card">
        <div class="card-head">
          <div class="card-title"><i class="fas fa-store"></i> 상점 현재 상태</div>
        </div>
        <div class="card-body">
          <div id="shopStatusBadge" style="margin-bottom:12px;padding:10px 14px;border-radius:10px;font-weight:700;font-size:14px;">확인 중...</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <button class="btn btn-green btn-sm" id="adminUnlockBtn" onclick="adminUnlockShop()"><i class="fas fa-unlock"></i> 열기</button>
            <button class="btn btn-red btn-sm" id="adminLockBtn" onclick="adminLockShop()"><i class="fas fa-lock"></i> 즉시 잠금</button>
          </div>
        </div>
      </div>
 
      <!-- 수업 시간표 설정 -->
      <div class="card">
        <div class="card-head">
          <div class="card-title"><i class="fas fa-calendar-week"></i> 수업 시간표 설정</div>
        </div>
        <div class="card-body">
          <div style="font-size:12px;color:var(--g500);margin-bottom:10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:8px 10px;">
            <i class="fas fa-info-circle" style="color:#0ea5e9;margin-right:4px;"></i>
            수업 시간 중에는 상점이 자동으로 잠깁니다.<br>
            <b>📅 시간표 모드</b>에서만 적용돼요. 강제 잠금/오픈 상태에서는 시간표가 무시됩니다.
          </div>
          <div id="scheduleSlots"></div>
          <button class="btn btn-blue btn-sm" style="margin-top:8px;" onclick="addScheduleSlot()"><i class="fas fa-plus"></i> 시간대 추가</button>
          <div style="margin-top:14px;display:flex;gap:8px;">
            <button class="btn btn-green" onclick="saveSchedule()"><i class="fas fa-floppy-disk"></i> 시간표 저장</button>
          </div>
        </div>
      </div>
 
      <!-- 이번 달 재고 관리 -->
      <div class="card">
        <div class="card-head">
          <div class="card-title"><i class="fas fa-box"></i> 이번 달 재고 관리</div>
          <button class="btn btn-sm btn-green" onclick="doRestock()"><i class="fas fa-rotate"></i> 이번 달 재고 채우기</button>
        </div>
        <div class="card-body">
          <div style="font-size:12px;color:var(--g500);margin-bottom:12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:8px 10px;">
            <i class="fas fa-info-circle" style="color:#f97316;margin-right:4px;"></i>
            메뉴설정 → 보상 상점에서 <b>월 재고</b>를 설정한 후,<br>
            매달 초에 <b>이번 달 재고 채우기</b> 버튼을 눌러주세요.<br>
            학생들이 구매할 때마다 재고가 자동으로 줄어들어요.
          </div>
          <div id="shopStockInfo">
            <div style="color:var(--g400);font-size:13px;">로딩 중...</div>
          </div>
        </div>
      </div>
 
    </div>

   

</div><!-- /main-screen -->



<!-- 포인트 이력 모달 -->

<div class="modal-ov" id="hist-modal">

  <div class="modal-box">

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">

      <div class="modal-title" id="histTitle">포인트 이력</div>

      <button class="btn btn-gray btn-sm" id="closeHistBtn"><i class="fas fa-xmark"></i></button>

    </div>

    <div id="histList"></div>

  </div>

</div>



<!-- 요청 메모 모달 -->

<div class="modal-ov" id="note-modal">

  <div class="modal-box">

    <div class="modal-title">메모 / 처리 내용</div>

    <textarea id="noteInp" style="width:100%;min-height:80px;border:1.5px solid var(--g200);border-radius:10px;padding:10px 12px;font-family:inherit;font-size:14px;outline:none;resize:vertical;margin-bottom:12px;"></textarea>

    <div style="display:flex;gap:8px;flex-wrap:wrap;">

      <button class="btn btn-blue btn-sm" onclick="saveNote('in_progress')"><i class="fas fa-spinner"></i> 처리중</button>

      <button class="btn btn-green btn-sm" onclick="saveNote('done')"><i class="fas fa-check"></i> 완료</button>

      <button class="btn btn-gray btn-sm" onclick="document.getElementById('note-modal').classList.remove('open')">취소</button>

    </div>

  </div>

</div>




<!-- 사진 보기 모달 -->
<div class="modal-ov" id="req-photo-modal" onclick="if(event.target===this)closeReqPhotoModal()">
  <div class="modal-box" style="max-width:480px;width:95%;">
    <div class="modal-head">
      <span class="modal-title" id="reqPhotoModalTitle">📸 첨부 사진</span>
      <button class="btn btn-gray btn-sm" onclick="closeReqPhotoModal()">✕</button>
    </div>
    <div class="modal-body" style="text-align:center;">
      <div id="reqPhotoModalContent" style="min-height:80px;display:flex;align-items:center;justify-content:center;">
        <div style="color:var(--g400);">로딩 중...</div>
      </div>
    </div>
  </div>
</div>

<!-- 학생 시간표 설정 모달 -->
<div class="modal-ov" id="stu-sched-modal" onclick="if(event.target===this)closeStuSchedModal()">
  <div class="modal-box" style="max-width:460px;width:95%;">
    <div class="modal-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <span class="modal-title" id="stuSchedTitle">수업 시간표</span>
      <button class="btn btn-gray btn-sm" onclick="closeStuSchedModal()">✕</button>
    </div>
    <div style="font-size:12px;color:var(--g500);margin-bottom:10px;background:#f0f9ff;border-radius:8px;padding:8px 10px;border:1px solid #bae6fd;">
      <i class="fas fa-info-circle" style="color:#0ea5e9;margin-right:4px;"></i>
      수업 시간 중에는 이 학생의 상점이 자동으로 잠깁니다.<br>
      비워두면 전체 공통 시간표가 적용됩니다.
    </div>
    <div id="stuSchedSlots" style="margin-bottom:12px;"></div>
    <button class="btn btn-gray btn-sm" onclick="addStuSchedSlot()" style="margin-bottom:14px;">
      <i class="fas fa-plus"></i> 시간대 추가
    </button>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-green" onclick="saveStuSchedule()" style="flex:1;">
        <i class="fas fa-floppy-disk"></i> 저장
      </button>
      <button class="btn btn-gray" onclick="closeStuSchedModal()">취소</button>
    </div>
  </div>
</div>

<script src="/static/admin.js"></script>
</body>

</html>`

export default app
