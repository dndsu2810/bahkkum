
(function(){

var PW_TOKEN=''

var students=[]

var allFines=[]

var allQueues=[]

var allRequests=[]

var allOrders=[]

var menuCfg={learn:[],fine:[],shop:[]}

var curCfg={unit:'포인트',symbol:'P',desc:''}

// 빈 목록 HTML 생성 헬퍼 (큰따옴표 없이)
function emptyHtml(msg){
  var d=document.createElement('div')
  d.style.cssText='color:var(--g400);text-align:center;padding:20px;'
  d.textContent=msg
  return d.outerHTML
}
function emptyHtmlSm(msg){
  var d=document.createElement('div')
  d.style.cssText='color:var(--g400);font-size:13px;padding:8px 0;'
  d.textContent=msg
  return d.outerHTML
}

var curNoteReqId=null

var queueFilter='all'

var reqFilter='all'

var fineFilter='all'



var PRESETS=[

  {symbol:'P',unit:'포인트',desc:'포인트를 모아요!'},

  {symbol:'🏅',unit:'메달',desc:'메달을 모아요!'},

  {symbol:'🌟',unit:'별',desc:'별을 모아요!'},

  {symbol:'💎',unit:'보석',desc:'보석을 모아요!'},

  {symbol:'🪙',unit:'코인',desc:'코인을 모아요!'},

  {symbol:'🍀',unit:'클로버',desc:'클로버를 모아요!'},

  {symbol:'❤️',unit:'하트',desc:'하트를 모아요!'},

  {symbol:'🔥',unit:'불꽃',desc:'불꽃을 모아요!'},

]



var DEFAULT_MENU={

  learn:[

    {id:'study',icon:'📖',label:'자습 인증하기',cost:0,reward:2,unit:'P',requirePhoto:true},

    {id:'homework',icon:'✏️',label:'숙제 제출하기',cost:0,reward:1,unit:'P',requirePhoto:false},

    {id:'question',icon:'🙋',label:'질문하기',cost:0,reward:1,unit:'P',requirePhoto:false},

    {id:'record',icon:'📝',label:'모르는 문제 기록하기',cost:0,reward:2,unit:'P',requirePhoto:true},

    {id:'material',icon:'📄',label:'추가 학습지 요청',cost:0,reward:0,unit:'P',requirePhoto:false},

    {id:'makeup',icon:'📅',label:'보강 신청',cost:0,reward:0,unit:'P',requirePhoto:false},

    {id:'consult',icon:'💬',label:'상담 요청',cost:0,reward:0,unit:'P',requirePhoto:false},

  ],

  fine:[

    {id:'helpme',icon:'🆘',label:'지현쌤 Help me!',cost:3,reward:0,unit:'P',requirePhoto:false},

    {id:'lostwork',icon:'😰',label:'숙제 분실',cost:4,reward:0,unit:'P',requirePhoto:false},

    {id:'nohomework',icon:'🚫',label:'숙제 안함',cost:5,reward:0,unit:'P',requirePhoto:false},

  ],

  shop:[

    {id:'choco',icon:'🍫',label:'초콜릿(달달구리)',cost:3,reward:0,unit:'P',requirePhoto:false},

    {id:'jelly',icon:'🍬',label:'젤리',cost:2,reward:0,unit:'P',requirePhoto:false},

    {id:'candy',icon:'🍭',label:'사탕',cost:2,reward:0,unit:'P',requirePhoto:false},

    {id:'snack',icon:'🍿',label:'과자',cost:3,reward:0,unit:'P',requirePhoto:false},

    {id:'saekkomdal',icon:'🍋',label:'새콤달콤',cost:2,reward:0,unit:'P',requirePhoto:false},

    {id:'vitaminc',icon:'💊',label:'비타민C',cost:2,reward:0,unit:'P',requirePhoto:false},

  ]

}



// ── 로그인 ──

function doLogin(){

  var pw=document.getElementById('pwInp').value.trim()

  if(!pw)return

  fetch('/api/admin/auth',{headers:{'X-Admin-Password':pw}})

    .then(r=>r.json()).then(d=>{

      if(d.success){

        PW_TOKEN=pw

        document.getElementById('login-screen').classList.add('hidden')

        document.getElementById('main-screen').classList.remove('hidden')

        initAdmin()

      } else {

        document.getElementById('loginErr').classList.add('show')

      }

    }).catch(()=>{document.getElementById('loginErr').classList.add('show')})

}

window.doLogin=doLogin



function doLogout(){PW_TOKEN='';location.reload()}

window.doLogout=doLogout



function api(path,opts){

  opts=opts||{}

  opts.headers=Object.assign({'X-Admin-Password':PW_TOKEN,'Content-Type':'application/json'},opts.headers||{})

  return fetch(path,opts).then(r=>r.json())

}



// ── 탭 전환 ──

function switchMainTab(tab){

  document.querySelectorAll('.mtab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab))

  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id==='tab-'+tab))

  if(tab==='queue')loadQueue()

  else if(tab==='requests')loadRequests()

  else if(tab==='orders')loadOrders()

  else if(tab==='students')renderStudents()

  else if(tab==='fines')renderFines()

  else if(tab==='menu')renderMenuItems('learn'),renderMenuItems('fine'),renderMenuItems('shop')

  else if(tab==='currency')renderPresets(),updateCurPreview()

}

window.switchMainTab=switchMainTab



// ── 초기화 ──

function initAdmin(){

  // 오늘 날짜 세팅

  document.getElementById('queueDatePick').value=new Date().toISOString().slice(0,10)

  loadConfig()

  loadStudentsData()

  loadQueue()

  loadRequests()

  loadOrders()

}



function loadConfig(){

  // API에서 설정 불러오기 (DB 저장, 모든 기기 공유)
  fetch('/api/config').then(function(r){return r.json()}).then(function(cfg){

    menuCfg=cfg.menu||JSON.parse(JSON.stringify(DEFAULT_MENU))

    curCfg=cfg.currency||{unit:'포인트',symbol:'P',desc:''}

    // unit 필드 없는 항목 보완
    ;['learn','fine','shop'].forEach(function(t){

      (menuCfg[t]||[]).forEach(function(m){if(!m.unit)m.unit=curCfg.symbol||'P'})

    })

    // UI 반영
    renderMenuItems('learn');renderMenuItems('fine');renderMenuItems('shop')

    document.getElementById('curUnit').value=curCfg.unit||'포인트'

    document.getElementById('curSymbol').value=curCfg.symbol||'P'

    document.getElementById('curDesc').value=curCfg.desc||''

    updateCurPreview();renderPresets()

  }).catch(function(){

    menuCfg=JSON.parse(JSON.stringify(DEFAULT_MENU))

  })

}

// 설정을 API(DB)에 저장하는 공통 함수
function saveConfigToServer(callback){

  var cfg={currency:curCfg,menu:menuCfg}

  api('/api/admin/config',{method:'POST',body:JSON.stringify(cfg)}).then(function(d){

    if(d.success){

      if(callback)callback()

    } else {

      toast('저장 실패: '+(d.error||''))

    }

  }).catch(function(){ toast('저장 중 오류 발생') })

}



function loadStudentsData(){

  fetch('/api/students').then(r=>r.json()).then(d=>{

    if(d.success){

      students=d.students

      renderStudents()

      var unpaid=students.reduce(function(a,s){return a+(s.fine_count||0)},0)

      document.getElementById('badge-fines').textContent=unpaid>0?unpaid:''

    }

  })

  api('/api/admin/fines-all').then(d=>{

    if(d.success){

      allFines=d.fines

      // 벌금 탭이 활성화되어 있으면 재렌더링

      if(document.getElementById('tab-fines') && document.getElementById('tab-fines').classList.contains('active')){renderFines()}

    }

  }).catch(()=>{})

}



// ══ 번호표 ══

function loadQueue(){

  var date=document.getElementById('queueDatePick').value||new Date().toISOString().slice(0,10)

  api('/api/admin/queue?date='+date).then(function(d){

    if(!d.success)return

    allQueues=d.tickets

    var w=allQueues.filter(function(t){return t.status==='waiting'}).length

    var a=allQueues.filter(function(t){return t.status==='answering'}).length

    var dn=allQueues.filter(function(t){return t.status==='done'}).length

    document.getElementById('qs-waiting').textContent=w

    document.getElementById('qs-answering').textContent=a

    document.getElementById('qs-done').textContent=dn

    document.getElementById('qs-total').textContent=allQueues.length

    document.getElementById('badge-queue').textContent=(w+a)>0?(w+a):''

    renderQueueList()

  })

}

window.loadQueue=loadQueue



function renderQueueList(){

  var list=allQueues.filter(function(t){return queueFilter==='all'||t.status===queueFilter})

  var el=document.getElementById('queueList')

  if(list.length===0){el.innerHTML=emptyHtml('항목 없음');return}

  el.innerHTML=list.map(function(t){

    var sc=t.status==='done'?'done':t.status==='answering'?'answering':'waiting'

    var sl=t.status==='done'?'완료':t.status==='answering'?'답변중':'대기'

    var tm=t.created_at?t.created_at.slice(11,16):''

    return '<div class="ticket-item">'+

      '<div class="ticket-num '+sc+'">'+t.number+'</div>'+

      '<div class="ticket-info">'+

        '<div class="ticket-name">'+esc(t.student_name)+'</div>'+

        '<div class="ticket-time">'+tm+' 발급</div>'+

      '</div>'+

      '<span class="ticket-status-badge '+sc+'">'+sl+'</span>'+

      '<div class="ticket-actions">'+

        (t.status==='waiting'?'<button class="btn btn-sm" style="background:var(--yellow-s);color:#92400e;border:1.5px solid #fcd34d;" data-qid="'+t.id+'" data-qst="answering" data-qaction="status"><i class="fas fa-comment"></i> 답변중</button>':'')+

        (t.status==='answering'?'<button class="btn btn-green btn-sm" data-qid="'+t.id+'" data-qst="done" data-qaction="status"><i class="fas fa-check"></i> 완료</button>':'')+

        (t.status==='done'?'<span style="font-size:11px;color:var(--g400);">재발급 가능</span>':'')+

      '</div>'+

    '</div>'

  }).join('')

}



window.setQueueStatus=function(id,status){

  api('/api/admin/queue/'+id+'/status',{method:'POST',body:JSON.stringify({status:status})}).then(function(d){

    if(d.success){toast('상태 변경 완료');loadQueue()}

    else toast('오류: '+d.error)

  })

}



function filterQueue(f,el){

  queueFilter=f

  document.querySelectorAll('#tab-queue .filter-btn').forEach(function(b){b.classList.remove('active')})

  el.classList.add('active')

  renderQueueList()

}

window.filterQueue=filterQueue



// ══ 요청사항 ══

function loadRequests(){

  api('/api/admin/requests').then(function(d){

    if(!d.success)return

    allRequests=d.requests

    var pending=allRequests.filter(function(r){return r.status==='pending'}).length

    document.getElementById('badge-requests').textContent=pending>0?pending:''

    renderReqList()

  })

}

window.loadRequests=loadRequests



function renderReqList(){

  var list=allRequests.filter(function(r){return reqFilter==='all'||r.status===reqFilter})

  var el=document.getElementById('reqList')

  if(list.length===0){el.innerHTML=emptyHtml('항목 없음');return}

  el.innerHTML=list.map(function(r){

    var sl={pending:'미확인',in_progress:'처리중',done:'완료'}[r.status]||r.status

    var sc={pending:'pending',in_progress:'in_progress',done:'done'}[r.status]||'pending'

    var tm=r.created_at?r.created_at.slice(0,16).replace('T',' '):''

    return '<div class="req-item">'+

      '<div class="req-av">'+esc(r.student_name[0])+'</div>'+

      '<div class="req-body">'+

        '<div class="req-top">'+

          '<span class="req-name">'+esc(r.student_name)+'</span>'+

          '<span class="req-time">'+tm+'</span>'+

          (r.has_photo?'<span class="req-photo-badge"><i class="fas fa-image"></i> 사진</span>':'')+

          '<span class="status-badge '+sc+'">'+sl+'</span>'+

        '</div>'+

        '<div class="req-msg">'+esc(r.message)+'</div>'+

        (r.admin_note?'<div class="req-note"><i class="fas fa-pen-to-square"></i> '+esc(r.admin_note)+'</div>':'')+

      '</div>'+

      '<div class="req-actions">'+

        (r.has_photo?'<button class="btn btn-blue btn-sm" data-rid="'+r.id+'" data-rname="'+esc(r.student_name)+'" data-raction="photo" title="사진 보기"><i class="fas fa-image"></i></button>':'')+

        '<button class="btn btn-gray btn-sm" data-rid="'+r.id+'" data-rnote="'+esc(r.admin_note||'')+'" data-raction="note"><i class="fas fa-pen"></i></button>'+

        (r.status!=='done'?'<button class="btn btn-green btn-sm" data-rid="'+r.id+'" data-raction="done"><i class="fas fa-check"></i></button>':'')+

      '</div>'+

    '</div>'

  }).join('')

}



function filterReq(f,el){

  reqFilter=f

  document.querySelectorAll('#tab-requests .filter-btn').forEach(function(b){b.classList.remove('active')})

  el.classList.add('active')

  renderReqList()

}

window.filterReq=filterReq



window.openNote=function(id,note){

  curNoteReqId=id

  document.getElementById('noteInp').value=note||''

  document.getElementById('note-modal').classList.add('open')

}



window.saveNote=function(status){

  if(!curNoteReqId)return

  var note=document.getElementById('noteInp').value.trim()

  api('/api/admin/requests/'+curNoteReqId+'/status',{method:'POST',body:JSON.stringify({status:status,adminNote:note})}).then(function(d){

    if(d.success){toast('저장 완료');document.getElementById('note-modal').classList.remove('open');loadRequests()}

    else toast('오류')

  })

}



window.quickDoneReq=function(id){

  api('/api/admin/requests/'+id+'/status',{method:'POST',body:JSON.stringify({status:'done'})}).then(function(d){

    if(d.success){toast('완료 처리');loadRequests()}

  })

}



// ══ 주문현황 ══

function loadOrders(){

  var stu=document.getElementById('orderSearch').value.trim()

  var cat=document.getElementById('orderCatFilter').value

  var qs='?student='+encodeURIComponent(stu)+'&category='+cat

  api('/api/admin/orders'+qs).then(function(d){

    if(!d.success)return

    allOrders=d.orders

    renderOrderList()

  })

}

window.loadOrders=loadOrders



function renderOrderList(){

  var el=document.getElementById('orderList')

  if(allOrders.length===0){el.innerHTML=emptyHtml('항목 없음');return}

  var catEmoji={learn:'✅',fine:'🚨',shop:'🛍️'}

  el.innerHTML=allOrders.map(function(o){

    var items=[]

    try{items=JSON.parse(o.items_json)}catch(e){}

    var itemsTxt=items.map(function(x){return (x.icon||'')+' '+x.label+(x.qty>1?' x'+x.qty:'')}).join(' / ')

    var costVal=o.total_cost

    var cc=costVal===0?'free':costVal<0?'gain':'loss'

    var ct=costVal===0?'무료':costVal<0?'+'+Math.abs(costVal)+' '+o.currency+' 획득':'-'+costVal+' '+o.currency+' 차감'

    var tm=o.created_at?o.created_at.slice(0,16).replace('T',' '):''

    return '<div class="order-item">'+

      '<div class="order-cat '+o.category+'">'+(catEmoji[o.category]||'📋')+'</div>'+

      '<div class="order-body">'+

        '<div class="order-top">'+

          '<span class="order-stu">'+esc(o.student_name)+'</span>'+

          '<span class="order-time">'+tm+'</span>'+

          (o.has_photo?'<span style="font-size:10px;background:var(--orange);color:white;padding:2px 6px;border-radius:100px;font-weight:800;">사진</span>':'')+

        '</div>'+

        '<div class="order-items-txt">'+esc(itemsTxt)+'</div>'+

        (o.comment?'<div style="font-size:11px;color:var(--indigo);margin-top:2px;">💬 '+esc(o.comment)+'</div>':'')+

      '</div>'+

      '<div class="order-cost '+cc+'">'+ct+'</div>'+

    '</div>'

  }).join('')

}



// ══ 학생 관리 ══

function renderStudents(){

  var el=document.getElementById('stuList')

  if(students.length===0){el.innerHTML=emptyHtml('학생이 없습니다.');return}

  el.innerHTML=students.map(function(s){

    var av=s.photo_url

      ?'<img class="stu-av-sm" src="'+esc(s.photo_url)+'" alt=""/>'

      :'<div class="stu-av-txt">'+esc(s.name[0])+'</div>'

    var fineBadges=''

    if(s.fine_point>0)fineBadges+='<span style="font-size:10px;background:var(--red-s);color:var(--red);border:1px solid rgba(239,68,68,.25);border-radius:100px;padding:1px 5px;white-space:nowrap;">💸'+s.fine_point+'</span>'

    if(s.fine_time>0)fineBadges+='<span style="font-size:10px;background:#fff7ed;color:#c2410c;border:1px solid #fdba74;border-radius:100px;padding:1px 5px;white-space:nowrap;">⏰'+s.fine_time+'분</span>'

    if(s.fine_sheet>0)fineBadges+='<span style="font-size:10px;background:#fff7ed;color:#b45309;border:1px solid #fcd34d;border-radius:100px;padding:1px 5px;white-space:nowrap;">📄'+s.fine_sheet+'장</span>'

    return '<div class="stu-list-item" style="flex-wrap:wrap;">'+av+

      '<div class="stu-name-lbl">'+esc(s.name)+'</div>'+

      '<span class="stu-pts-lbl">'+curCfg.symbol+' '+s.points+'</span>'+

      fineBadges+

      '<div style="display:flex;gap:4px;margin-left:auto;">'+

      '<button class="btn btn-gray btn-sm btn-icon" data-sid="'+s.id+'" data-sname="'+esc(s.name)+'" data-saction="hist"><i class="fas fa-clock-rotate-left"></i></button>'+

      '<button class="btn btn-gray btn-sm btn-icon" data-sid="'+s.id+'" data-sname="'+esc(s.name)+'" data-saction="adj"><i class="fas fa-plus-minus"></i></button>'+

      '<button class="btn btn-gray btn-sm btn-icon" data-sid="'+s.id+'" data-saction="photo"><i class="fas fa-camera"></i></button>'+

      '<button class="btn btn-blue btn-sm btn-icon" title="수업 시간표" data-sid="'+s.id+'" data-sname="'+esc(s.name)+'" data-saction="schedule"><i class="fas fa-calendar-week"></i></button>'+

      '<button class="btn btn-red btn-sm btn-icon" data-sid="'+s.id+'" data-sname="'+esc(s.name)+'" data-saction="del"><i class="fas fa-trash"></i></button>'+

      '</div>'+

    '</div>'

  }).join('')

}



window.addStudent=function(){

  var name=document.getElementById('newStuName').value.trim()

  if(!name){toast('이름 입력');return}

  api('/api/admin/students',{method:'POST',body:JSON.stringify({name:name})}).then(function(d){

    if(d.success){document.getElementById('newStuName').value='';toast('추가: '+name);loadStudentsData()}

    else toast('오류: '+d.error)

  })

}



window.delStudent=function(id,name){

  if(!confirm(name+' 삭제?'))return

  api('/api/admin/students/'+id,{method:'DELETE'}).then(function(d){

    if(d.success){toast('삭제됨');loadStudentsData()}

  })

}



window.adjPoints=function(id,name){

  var v=prompt(name+'님 포인트 조정 (예: +5 또는 -3)','')

  if(!v)return

  var delta=parseInt(v)

  if(isNaN(delta)){toast('숫자로 입력하세요');return}

  api('/api/admin/students/'+id+'/points',{method:'POST',body:JSON.stringify({delta:delta,reason:'관리자 조정'})}).then(function(d){

    if(d.success){toast('조정 완료');loadStudentsData()}

  })

}



window.uploadPhoto=function(id){

  var inp=document.createElement('input');inp.type='file';inp.accept='image/*'

  inp.onchange=function(){

    var f=inp.files[0];if(!f)return

    var r=new FileReader()

    r.onload=function(ev){

      api('/api/admin/students/'+id+'/photo',{method:'POST',body:JSON.stringify({photoBase64:ev.target.result})}).then(function(d){

        if(d.success){toast('사진 업데이트');loadStudentsData()}

      })

    };r.readAsDataURL(f)

  };inp.click()

}



window.showHist=function(id,name){

  fetch('/api/students/'+id).then(r=>r.json()).then(d=>{

    if(!d.success)return

    document.getElementById('histTitle').textContent=name+' 포인트 이력'

    var hist=d.history||[]

    document.getElementById('histList').innerHTML=hist.length===0

      ?'<div style="color:var(--g400)">이력 없음</div>'

      :hist.map(function(h){

        var pos=h.delta>=0

        return '<div class="hist-item"><span>'+esc(h.reason||'')+'</span><span class="hist-delta '+(pos?'pos':'neg')+'">'+(pos?'+':'')+h.delta+'</span></div>'

      }).join('')

    document.getElementById('hist-modal').classList.add('open')

  })

}



// ══ 벌금 ══

function renderFines(){

  var el=document.getElementById('fineList')

  // allFines 데이터 사용 (API로 로드된 상세 목록)
  var displayFines=allFines.filter(function(f){

    if(fineFilter==='all')return !f.paid

    if(fineFilter==='point')return !f.paid&&f.fine_type==='point'

    if(fineFilter==='time')return !f.paid&&f.fine_type==='time'

    if(fineFilter==='sheet')return !f.paid&&f.fine_type==='sheet'

    return !f.paid

  })

  if(displayFines.length===0){el.innerHTML=emptyHtml('미납 벌금 없음 🎉');return}

  // 유형별 분류 색상
  function fineTypeStyle(t){

    if(t==='time')return 'background:#fff7ed;color:#c2410c;border:1px solid #fdba74;'

    if(t==='sheet')return 'background:#fff7ed;color:#b45309;border:1px solid #fcd34d;'

    return 'background:var(--red-s);color:var(--red);border:1px solid rgba(239,68,68,.25);'

  }

  function fineTypeLabel(f){

    var icon=f.fine_type==='time'?'⏰':f.fine_type==='sheet'?'📄':'💸'

    var unit=f.fine_type==='time'?'분':f.fine_type==='sheet'?'장':(f.unit||'포인트')

    return icon+' '+f.amount+' '+unit

  }

  el.innerHTML=displayFines.map(function(f){

    var typeLabel=fineTypeLabel(f)

    var typeSt=fineTypeStyle(f.fine_type)

    var isTS=(f.fine_type==='time'||f.fine_type==='sheet')

    var confirmTip=isTS?'확인하면 즉시 삭제됩니다':'확인하면 완납 처리됩니다'

    var dt=f.created_at?f.created_at.slice(0,10):''

    return '<div class="stu-list-item" style="flex-wrap:wrap;gap:6px;">'+

      '<div class="stu-av-txt" style="font-size:11px;width:30px;height:30px;flex-shrink:0;">'+esc((f.student_name||'?')[0])+'</div>'+

      '<div style="flex:1;min-width:80px;">'+

        '<div style="font-weight:800;font-size:13px;">'+esc(f.student_name||'')+'</div>'+

        '<div style="font-size:11px;color:var(--g400);">'+esc(f.label||'')+(dt?' · '+dt:'')+'</div>'+

      '</div>'+

      '<span style="font-size:12px;font-weight:700;border-radius:100px;padding:2px 8px;'+typeSt+'">'+typeLabel+'</span>'+

      '<button class="btn btn-sm" style="background:#f0fdf4;color:#16a34a;border:1px solid #86efac;font-size:11px;" title="'+confirmTip+'" data-fid="'+f.id+'" data-ftype="'+f.fine_type+'" data-faction="confirm">'+

        (isTS?'✅ 확인 후 삭제':'✅ 완납처리')+

      '</button>'+

      '<button class="btn btn-sm" style="background:var(--red-s);color:var(--red);border:1px solid rgba(239,68,68,.3);font-size:11px;" data-fid="'+f.id+'" data-faction="delfine">🗑 삭제</button>'+

    '</div>'

  }).join('')

}

window.filterFine=function(f,el){

  fineFilter=f

  document.querySelectorAll('#tab-fines .filter-btn').forEach(function(b){b.classList.remove('active')})

  el.classList.add('active')

  renderFines()

}



// ══ 메뉴 설정 ══

function renderMenuItems(type){

  var el=document.getElementById('menu'+type.charAt(0).toUpperCase()+type.slice(1)+'List')

  var items=menuCfg[type]||[]

  if(items.length===0){el.innerHTML=emptyHtmlSm('항목 없음');return}

  el.innerHTML=items.map(function(m,i){

    var isLearn=type==='learn'

    var isFine=type==='fine'

    var isShop=type==='shop'

    var valField=isLearn

      ?'<input class="item-cost-inp" type="number" value="'+(m.reward||0)+'" onchange="menuCfg.'+type+'['+i+'].reward=+this.value" placeholder="보상"/>'

      :'<input class="item-cost-inp" type="number" value="'+(m.cost||0)+'" onchange="menuCfg.'+type+'['+i+'].cost=+this.value" placeholder="비용"/>'

    // fine 항목: 화폐유형 셀렉트 + 단위
    var fineTypeField=isFine

      ?'<select class="item-unit-sel" onchange="menuCfg.fine['+i+'].fineType=this.value;menuCfg.fine['+i+'].unit=(this.value===\'time\'?\'분\':this.value===\'sheet\'?\'장\':curCfg.unit);renderMenuItems(\'fine\')" style="width:70px;font-size:12px;">'+

        '<option value="point"'+(((m.fineType||'point')==='point')?' selected':'')+'>💸 포인트</option>'+

        '<option value="time"'+((m.fineType==='time')?' selected':'')+'>⏰ 시간(분)</option>'+

        '<option value="sheet"'+((m.fineType==='sheet')?' selected':'')+'>📄 학습지(장)</option>'+

      '</select>'

      :''

    // shop 품절 토글
    var soldOutField=isShop

      ?'<label style="font-size:11px;font-weight:700;white-space:nowrap;display:flex;align-items:center;gap:3px;"><input type="checkbox" '+(m.soldOut?'checked':'')+' onchange="menuCfg.shop['+i+'].soldOut=this.checked;renderMenuItems(\'shop\')"/> 품절</label>'

      :''

    return '<div class="menu-item-row">'+

      '<div class="item-icon-box">'+m.icon+(m.soldOut?'<span style="font-size:8px;background:#dc2626;color:white;border-radius:4px;padding:1px 3px;position:absolute;top:0;right:0;">품절</span>':'')+

      '</div>'+

      '<div class="item-label">'+esc(m.label)+'</div>'+

      valField+

      (isFine?fineTypeField:'<input class="item-unit-sel" value="'+(m.unit||curCfg.symbol||'P')+'" onchange="menuCfg.'+type+'['+i+'].unit=this.value" placeholder="단위" style="width:60px;"/>')+

      (isLearn?'<label style="font-size:11px;font-weight:700;white-space:nowrap;display:flex;align-items:center;gap:3px;"><input type="checkbox" '+(m.requirePhoto?'checked':'')+' onchange="menuCfg.'+type+'['+i+'].requirePhoto=this.checked"/> 사진</label>':'')+

      soldOutField+

      '<button class="item-del-btn" data-mtype="'+type+'" data-midx="'+i+'" data-maction="del"><i class="fas fa-trash"></i></button>'+

    '</div>'

  }).join('')

}



window.delMenuItem=function(type,i){

  menuCfg[type].splice(i,1)

  renderMenuItems(type)

}



function addMenuItem(type){

  var pfx={learn:'nL',fine:'nF',shop:'nS'}[type]

  var ic=(document.getElementById(pfx+'Ic').value||'').trim()||'[항목]'

  var lbl=document.getElementById(pfx+'Lbl').value.trim()

  if(!lbl){toast('항목 이름 입력');return}

  var costEl=document.getElementById(type==='learn'?'nLRew':type==='fine'?'nFCost':'nSCost')

  var unitEl=document.getElementById(pfx+'Unit')

  var cost=parseInt(costEl.value||'0')||0

  var unit=(unitEl&&unitEl.value.trim())||curCfg.symbol||'P'

  var newId=type+'_'+Date.now()

  if(type==='learn'){

    var photo=document.getElementById('nLPhoto').checked||false

    menuCfg.learn.push({id:newId,icon:ic,label:lbl,cost:0,reward:cost,unit:unit,requirePhoto:photo})

  } else if(type==='fine'){

    var ftEl=document.getElementById('nFType')

    var ft=(ftEl?ftEl.value:'point')

    var fineUnit=ft==='time'?'분':ft==='sheet'?'장':curCfg.unit

    menuCfg.fine.push({id:newId,icon:ic,label:lbl,cost:cost,reward:0,unit:fineUnit,fineType:ft,requirePhoto:false})

  } else {

    menuCfg[type].push({id:newId,icon:ic,label:lbl,cost:cost,reward:0,unit:unit,requirePhoto:false,soldOut:false})

  }

  document.getElementById(pfx+'Ic').value=''

  document.getElementById(pfx+'Lbl').value=''

  costEl.value=''

  if(unitEl)unitEl.value=''

  renderMenuItems(type);toast('추가: '+lbl)

}



document.getElementById('addLearnBtn').addEventListener('click',function(){addMenuItem('learn')})

document.getElementById('addFineBtn').addEventListener('click',function(){addMenuItem('fine')})

document.getElementById('addShopBtn').addEventListener('click',function(){addMenuItem('shop')})



document.getElementById('savemenuBtn').addEventListener('click',function(){

  // DOM에서 현재 입력값을 직접 수집해 menuCfg에 반영 (onchange 누락 방지)
  ;['learn','fine','shop'].forEach(function(t){

    var el=document.getElementById('menu'+t.charAt(0).toUpperCase()+t.slice(1)+'List')

    if(!el)return

    var rows=el.querySelectorAll('.menu-item-row')

    rows.forEach(function(row,i){

      if(!menuCfg[t][i])return

      // 비용/보상 숫자 입력값
      var costInp=row.querySelector('.item-cost-inp')

      if(costInp){

        if(t==='learn') menuCfg[t][i].reward=+(costInp.value)||0

        else menuCfg[t][i].cost=+(costInp.value)||0

      }

      // 단위 입력값 (learn/shop)
      var unitInp=row.querySelector('.item-unit-sel')

      if(unitInp && t!=='fine') menuCfg[t][i].unit=unitInp.value||curCfg.symbol||'P'

      // fine 타입 셀렉트
      if(t==='fine'){

        var ftSel=row.querySelector('select')

        if(ftSel){

          menuCfg[t][i].fineType=ftSel.value

          menuCfg[t][i].unit=ftSel.value==='time'?'분':ftSel.value==='sheet'?'장':curCfg.unit

        }

      }

      // shop 품절 체크박스
      if(t==='shop'){

        var cb=row.querySelector('input[type="checkbox"]')

        if(cb) menuCfg[t][i].soldOut=cb.checked

      }

      // learn 사진 체크박스
      if(t==='learn'){

        var pcb=row.querySelector('input[type="checkbox"]')

        if(pcb) menuCfg[t][i].requirePhoto=pcb.checked

      }

    })

  })

  saveConfigToServer(function(){ toast('✅ 메뉴 저장 완료! 키오스크에 즉시 반영됩니다.') })

})



document.getElementById('resetmenuBtn').addEventListener('click',function(){

  if(!confirm('기본값으로 초기화? 저장된 설정이 모두 삭제됩니다.'))return

  menuCfg=JSON.parse(JSON.stringify(DEFAULT_MENU))

  renderMenuItems('learn');renderMenuItems('fine');renderMenuItems('shop')

  saveConfigToServer(function(){ toast('기본값으로 초기화됨') })

})



// ══ 화폐 설정 ══

function renderPresets(){

  document.getElementById('presetGrid').innerHTML=PRESETS.map(function(p,i){

    return '<button class="preset-btn" onclick="applyPreset('+i+')"><span class="pi">'+p.symbol+'</span>'+p.unit+'</button>'

  }).join('')

}

window.applyPreset=function(i){

  var p=PRESETS[i];curCfg.unit=p.unit;curCfg.symbol=p.symbol;curCfg.desc=p.desc

  document.getElementById('curUnit').value=p.unit

  document.getElementById('curSymbol').value=p.symbol

  document.getElementById('curDesc').value=p.desc

  updateCurPreview()

}

function updateCurPreview(){

  document.getElementById('curPrevSymbol').textContent=document.getElementById('curSymbol').value||'P'

  document.getElementById('curPrevUnit').textContent=document.getElementById('curUnit').value||'포인트'

  document.getElementById('curPrevDesc').textContent=document.getElementById('curDesc').value||'설명이 여기 표시됩니다'

}

document.getElementById('curUnit').addEventListener('input',updateCurPreview)

document.getElementById('curSymbol').addEventListener('input',updateCurPreview)

document.getElementById('savecurBtn').addEventListener('click',function(){

  curCfg.unit=document.getElementById('curUnit').value.trim()||'포인트'

  curCfg.symbol=document.getElementById('curSymbol').value.trim()||'P'

  curCfg.desc=document.getElementById('curDesc').value.trim()

  saveConfigToServer(function(){ renderPresets();toast('✅ 화폐 설정 저장! 키오스크에 즉시 반영됩니다.') })

})



// ── 요청사항 사진 보기 모달 ──
function openReqPhotoModal(rid, rname){

  var modal=document.getElementById('req-photo-modal')

  var title=document.getElementById('reqPhotoModalTitle')

  var content=document.getElementById('reqPhotoModalContent')

  if(!modal)return

  title.textContent='📸 '+rname+' 님의 첨부 사진'

  content.innerHTML='<div style="color:var(--g400);padding:20px;">로딩 중...</div>'

  modal.classList.add('open')

  api('/api/admin/requests/'+rid+'/photo').then(function(d){

    if(d.success && d.photo){

      content.innerHTML='<img src="'+d.photo+'" style="max-width:100%;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.15);"/>'

    } else {

      content.innerHTML='<div style="color:var(--g400);padding:20px;">사진을 불러올 수 없습니다.</div>'

    }

  }).catch(function(){

    content.innerHTML='<div style="color:var(--red);padding:20px;">오류가 발생했습니다.</div>'

  })

}



window.closeReqPhotoModal=function(){

  var modal=document.getElementById('req-photo-modal')

  if(modal) modal.classList.remove('open')

}



// ── 유틸 ──

function esc(s){var r=String(s);r=r.split('&').join('&amp;');r=r.split('<').join('&lt;');r=r.split('>').join('&gt;');r=r.split(String.fromCharCode(34)).join('&#34;');return r}

function toast(msg){var t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.remove()},2200)}



document.getElementById('closeHistBtn').addEventListener('click',function(){document.getElementById('hist-modal').classList.remove('open')})



// ── 이벤트 위임: 동적으로 생성된 버튼들 처리 ──
document.addEventListener('click',function(e){
  var btn=e.target.closest('[data-qaction]')
  if(btn){
    var id=btn.dataset.qid, st=btn.dataset.qst
    if(btn.dataset.qaction==='status') setQueueStatus(id,st)
    return
  }
  btn=e.target.closest('[data-raction]')
  if(btn){
    var rid=btn.dataset.rid
    if(btn.dataset.raction==='note') openNote(rid, btn.dataset.rnote||'')
    else if(btn.dataset.raction==='done') quickDoneReq(rid)
    else if(btn.dataset.raction==='photo') openReqPhotoModal(rid, btn.dataset.rname||'')
    return
  }
  btn=e.target.closest('[data-saction]')
  if(btn){
    var sid=btn.dataset.sid, sname=btn.dataset.sname||''
    if(btn.dataset.saction==='hist') showHist(sid,sname)
    else if(btn.dataset.saction==='adj') adjPoints(sid,sname)
    else if(btn.dataset.saction==='photo') uploadPhoto(sid)
    else if(btn.dataset.saction==='schedule') openStudentSchedule(sid,sname)
    else if(btn.dataset.saction==='del') delStudent(sid,sname)
    return
  }
  btn=e.target.closest('[data-faction]')
  if(btn){
    var fid=btn.dataset.fid, fname=btn.dataset.fname||''
    if(btn.dataset.faction==='hist') showHist(fid,fname)
    else if(btn.dataset.faction==='confirm'){
      var ftype=btn.dataset.ftype||'point'
      var tipMsg=ftype==='time'||ftype==='sheet'?'벌금을 확인하고 삭제할까요?':'완납 처리할까요?'
      if(confirm(tipMsg)){
        api('/api/admin/fines/'+fid+'/confirm',{method:'POST'}).then(function(d){
          if(d.success){toast('처리 완료');loadStudentsData()}
          else toast('오류: '+(d.error||''))
        })
      }
    }
    else if(btn.dataset.faction==='delfine'){
      if(confirm('이 벌금을 삭제할까요?')){
        api('/api/admin/fines/'+fid,{method:'DELETE'}).then(function(d){
          if(d.success){toast('삭제됨');loadStudentsData()}
          else toast('오류')
        })
      }
    }
    return
  }
  btn=e.target.closest('[data-maction]')
  if(btn){
    if(btn.dataset.maction==='del') delMenuItem(btn.dataset.mtype, parseInt(btn.dataset.midx))
    return
  }
  // 상점 잠금해제 승인 버튼
  btn=e.target.closest('[data-unlock-id]')
  if(btn){
    var reqId=btn.dataset.unlockId, reqName=btn.dataset.unlockName||''
    var mins=parseInt(prompt('몇 분간 열어줄까요? (기본 10분)','10')||'10')
    if(isNaN(mins)||mins<=0)return
    api('/api/admin/shop/unlock',{method:'POST',body:JSON.stringify({requestId:reqId,minutes:mins})}).then(function(d){
      if(d.success){toast('✅ '+reqName+' 요청 승인! '+mins+'분간 상점 열립니다.');loadShopRequests();loadShopStatus()}
      else toast('오류: '+(d.error||''))
    })
    return
  }
})

// ── 학생별 시간표 모달 ────────────────────────────────────────────────────────────

var stuSchedId=null, stuSchedSlots=[]
var DAYS=['월','화','수','목','금','토','일']

function openStudentSchedule(sid, sname){
  stuSchedId=sid
  stuSchedSlots=[]
  var modal=document.getElementById('stu-sched-modal')
  if(!modal)return
  document.getElementById('stuSchedTitle').textContent=esc(sname)+' 수업 시간표'
  document.getElementById('stuSchedSlots').innerHTML='<div style="color:var(--g400);text-align:center;padding:12px;">로딩 중...</div>'
  modal.classList.add('open')
  api('/api/admin/students/'+sid+'/schedule').then(function(d){
    stuSchedSlots=d.success&&Array.isArray(d.schedule)?d.schedule:[]
    renderStuSchedSlots()
  }).catch(function(){stuSchedSlots=[];renderStuSchedSlots()})
}

function renderStuSchedSlots(){
  var el=document.getElementById('stuSchedSlots')
  if(!el)return
  if(stuSchedSlots.length===0){
    el.innerHTML='<div style="color:var(--g400);font-size:13px;padding:8px 0;">추가된 시간대가 없습니다.<br><span style="font-size:11px;color:var(--g300);">비워두면 전체 시간표가 적용됩니다.</span></div>'
    return
  }
  var html=''
  stuSchedSlots.forEach(function(sl,i){
    html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;">'
    html+='<select class="ss-day" data-idx="'+i+'" style="padding:5px 7px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    DAYS.forEach(function(d){html+='<option value="'+d+'"'+(sl.day===d?' selected':'')+'>'+d+'</option>'})
    html+='</select>'
    html+='<input type="time" class="ss-start" data-idx="'+i+'" value="'+(sl.start||'')+'" style="padding:5px 7px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    html+='<span style="color:var(--g400);">~</span>'
    html+='<input type="time" class="ss-end" data-idx="'+i+'" value="'+(sl.end||'')+'" style="padding:5px 7px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    html+='<button class="btn btn-red btn-sm" onclick="removeStuSchedSlot('+i+')"><i class="fas fa-trash"></i></button>'
    html+='</div>'
  })
  el.innerHTML=html
}

window.addStuSchedSlot=function(){
  stuSchedSlots.push({day:'월',start:'14:00',end:'16:00'})
  renderStuSchedSlots()
}

window.removeStuSchedSlot=function(i){
  stuSchedSlots.splice(i,1)
  renderStuSchedSlots()
}

window.saveStuSchedule=function(){
  if(!stuSchedId)return
  // DOM에서 현재 값 수집
  var dayEls=document.querySelectorAll('.ss-day')
  var startEls=document.querySelectorAll('.ss-start')
  var endEls=document.querySelectorAll('.ss-end')
  var arr=[]
  dayEls.forEach(function(el,i){arr.push({day:el.value,start:startEls[i].value,end:endEls[i].value})})
  stuSchedSlots=arr
  api('/api/admin/students/'+stuSchedId+'/schedule',{method:'POST',body:JSON.stringify({schedule:stuSchedSlots})}).then(function(d){
    if(d.success){
      toast('✅ 시간표 저장됨!')
      document.getElementById('stu-sched-modal').classList.remove('open')
    } else {
      toast('저장 실패: '+(d.error||''))
    }
  })
}

window.closeStuSchedModal=function(){
  document.getElementById('stu-sched-modal').classList.remove('open')
}

// ── 상점 잠금 관련 ──────────────────────────────────────────────────────────────

var shopSchedule=[]

function loadShopRequests(){
  var el=document.getElementById('shopRequestList')
  if(!el)return
  el.innerHTML='<div style="color:var(--g400);text-align:center;padding:16px;">로딩 중...</div>'
  api('/api/admin/shop/requests').then(function(d){
    if(!d.success||!d.requests||d.requests.length===0){
      el.innerHTML='<div style="color:var(--g400);text-align:center;padding:16px;">승인 요청이 없습니다.</div>'
      return
    }
    var html=''
    d.requests.forEach(function(r){
      var statusLabel={pending:'⏳ 대기',approved:'✅ 승인',expired:'만료',rejected:'거절'}[r.status]||r.status
      var statusColor={pending:'#f59e0b',approved:'#22c55e',expired:'#94a3b8',rejected:'#ef4444'}[r.status]||'#94a3b8'
      var dt=r.requested_at?r.requested_at.replace('T',' ').substring(0,16):''
      html+='<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--g100);">'
      html+='<div style="flex:1;">'
      html+='<div style="font-weight:700;font-size:14px;">'+esc(r.student_name)+'</div>'
      html+='<div style="font-size:12px;color:var(--g400);">'+esc(dt)+'</div>'
      html+='</div>'
      html+='<span style="font-size:12px;font-weight:700;color:'+statusColor+';">'+statusLabel+'</span>'
      if(r.status==='pending'){
        html+='<button class="btn btn-green btn-sm" data-unlock-id="'+r.id+'" data-unlock-name="'+esc(r.student_name)+'"><i class="fas fa-unlock"></i> 열기</button>'
      }
      html+='</div>'
    })
    el.innerHTML=html
  }).catch(function(){
    el.innerHTML='<div style="color:#ef4444;text-align:center;padding:16px;">불러오기 실패</div>'
  })
}

function loadShopStatus(){
  var el=document.getElementById('shopStatusBadge')
  if(!el)return
  api('/api/shop/status').then(function(d){
    if(!d.success)return
    if(d.locked){
      el.style.background='#fee2e2';el.style.color='#dc2626';el.style.border='1.5px solid #fca5a5'
      el.textContent='🔒 수업 중 – 상점 잠김'
    } else if(d.unlocked){
      var exp=d.expiresAt?new Date(d.expiresAt+'Z'):null
      var remain=exp?Math.max(0,Math.ceil((exp-Date.now())/60000)):0
      el.style.background='#f0fdf4';el.style.color='#16a34a';el.style.border='1.5px solid #86efac'
      el.textContent='🔓 임시 오픈 중 (약 '+remain+'분 남음)'
    } else {
      el.style.background='#f0fdf4';el.style.color='#16a34a';el.style.border='1.5px solid #86efac'
      el.textContent='✅ 상점 열림 (수업 시간 아님)'
    }
  })
}

window.adminLockShop=function(){
  if(!confirm('상점을 즉시 잠글까요?'))return
  api('/api/admin/shop/lock',{method:'POST'}).then(function(d){
    if(d.success){toast('🔒 상점 잠금됨');loadShopStatus()}
    else toast('오류: '+(d.error||''))
  })
}

// 시간표 슬롯 렌더링
var DAYS=['월','화','수','목','금','토','일']
function renderScheduleSlots(){
  var el=document.getElementById('scheduleSlots')
  if(!el)return
  if(shopSchedule.length===0){
    el.innerHTML='<div style="color:var(--g400);font-size:13px;padding:8px 0;">추가된 시간대가 없습니다.</div>'
    return
  }
  var html=''
  shopSchedule.forEach(function(sl,i){
    html+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">'
    html+='<select class="sched-day" data-idx="'+i+'" style="padding:6px 8px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    DAYS.forEach(function(d){
      html+='<option value="'+d+'"'+(sl.day===d?' selected':'')+'>'+d+'</option>'
    })
    html+='</select>'
    html+='<input type="time" class="sched-start" data-idx="'+i+'" value="'+(sl.start||'')+'" style="padding:6px 8px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    html+='<span style="color:var(--g400);">~</span>'
    html+='<input type="time" class="sched-end" data-idx="'+i+'" value="'+(sl.end||'')+'" style="padding:6px 8px;border:1.5px solid var(--g200);border-radius:8px;font-size:13px;">'
    html+='<button class="btn btn-red btn-sm" onclick="removeScheduleSlot('+i+')"><i class="fas fa-trash"></i></button>'
    html+='</div>'
  })
  el.innerHTML=html
}

window.addScheduleSlot=function(){
  shopSchedule.push({day:'월',start:'14:00',end:'16:00'})
  renderScheduleSlots()
}

window.removeScheduleSlot=function(i){
  shopSchedule.splice(i,1)
  renderScheduleSlots()
}

function collectScheduleFromDOM(){
  var dayEls=document.querySelectorAll('.sched-day')
  var startEls=document.querySelectorAll('.sched-start')
  var endEls=document.querySelectorAll('.sched-end')
  var arr=[]
  dayEls.forEach(function(el,i){
    arr.push({day:el.value,start:startEls[i].value,end:endEls[i].value})
  })
  shopSchedule=arr
}

window.saveSchedule=function(){
  collectScheduleFromDOM()
  api('/api/admin/shop/schedule',{method:'POST',body:JSON.stringify({schedule:shopSchedule})}).then(function(d){
    if(d.success)toast('✅ 시간표 저장! 즉시 반영됩니다.')
    else toast('오류: '+(d.error||''))
  })
}

function loadScheduleFromServer(){
  api('/api/admin/shop/schedule').then(function(d){
    if(d.success&&Array.isArray(d.schedule)){
      shopSchedule=d.schedule
    } else {
      shopSchedule=[]
    }
    renderScheduleSlots()
  }).catch(function(){renderScheduleSlots()})
}

// shoplock 탭 활성화 시 데이터 로드
var _origSwitchMainTab=window.switchMainTab
window.switchMainTab=function(tab){
  _origSwitchMainTab(tab)
  if(tab==='shoplock'){
    loadShopRequests()
    loadShopStatus()
    loadScheduleFromServer()
  }
}



})()

