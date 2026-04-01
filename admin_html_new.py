NEW_ADMIN = r"""const ADMIN_HTML = `<!DOCTYPE html>
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
            <button class="filter-btn" onclick="filterFine('unpaid',this)">미납</button>
            <button class="filter-btn" onclick="filterFine('paid',this)">납부</button>
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
          <div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;">
            <input class="inp" id="nFIc" placeholder="아이콘" style="width:64px;"/>
            <input class="inp" id="nFLbl" placeholder="항목명" style="flex:1;min-width:100px;"/>
            <input class="inp" id="nFCost" placeholder="비용" type="number" style="width:80px;"/>
            <input class="inp" id="nFUnit" placeholder="화폐단위" style="width:80px;"/>
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
          <div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;">
            <input class="inp" id="nSIc" placeholder="아이콘" style="width:64px;"/>
            <input class="inp" id="nSLbl" placeholder="항목명" style="flex:1;min-width:100px;"/>
            <input class="inp" id="nSCost" placeholder="비용" type="number" style="width:80px;"/>
            <input class="inp" id="nSUnit" placeholder="화폐단위" style="width:80px;"/>
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

  </div><!-- /content -->
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

<script>
(function(){
var PW_TOKEN=''
var students=[]
var allFines=[]
var allQueues=[]
var allRequests=[]
var allOrders=[]
var menuCfg={learn:[],fine:[],shop:[]}
var curCfg={unit:'포인트',symbol:'P',desc:''}
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
  var lc=localStorage.getItem('kiosk_config')
  if(lc){try{var cfg=JSON.parse(lc);menuCfg=cfg.menu||DEFAULT_MENU;curCfg=cfg.currency||{unit:'포인트',symbol:'P',desc:''}}catch(e){menuCfg=JSON.parse(JSON.stringify(DEFAULT_MENU))}}
  else{menuCfg=JSON.parse(JSON.stringify(DEFAULT_MENU))}
  // unit 필드 없는 항목 보완
  ;['learn','fine','shop'].forEach(function(t){
    (menuCfg[t]||[]).forEach(function(m){if(!m.unit)m.unit=curCfg.symbol||'P'})
  })
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
  api('/api/admin/fines-all').then(d=>{if(d.success)allFines=d.fines}).catch(()=>{
    // fallback: 학생별로 모음
  })
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
  if(list.length===0){el.innerHTML='<div style="color:var(--g400);text-align:center;padding:20px;">항목 없음</div>';return}
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
        (t.status==='waiting'?'<button class="btn btn-sm" style="background:var(--yellow-s);color:#92400e;border:1.5px solid #fcd34d;" onclick="setQueueStatus('+t.id+',\'answering\')"><i class="fas fa-comment"></i> 답변중</button>':'')+
        (t.status==='answering'?'<button class="btn btn-green btn-sm" onclick="setQueueStatus('+t.id+',\'done\')"><i class="fas fa-check"></i> 완료</button>':'')+
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
  if(list.length===0){el.innerHTML='<div style="color:var(--g400);text-align:center;padding:20px;">항목 없음</div>';return}
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
        '<button class="btn btn-gray btn-sm" onclick="openNote('+r.id+',\''+esc(r.admin_note||'')+'\')"><i class="fas fa-pen"></i></button>'+
        (r.status!=='done'?'<button class="btn btn-green btn-sm" onclick="quickDoneReq('+r.id+')"><i class="fas fa-check"></i></button>':'')+
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
  if(allOrders.length===0){el.innerHTML='<div style="color:var(--g400);text-align:center;padding:20px;">항목 없음</div>';return}
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
  if(students.length===0){el.innerHTML='<div style="color:var(--g400)">학생이 없습니다.</div>';return}
  el.innerHTML=students.map(function(s){
    var av=s.photo_url
      ?'<img class="stu-av-sm" src="'+esc(s.photo_url)+'" alt=""/>'
      :'<div class="stu-av-txt">'+esc(s.name[0])+'</div>'
    return '<div class="stu-list-item">'+av+
      '<div class="stu-name-lbl">'+esc(s.name)+'</div>'+
      '<span class="stu-pts-lbl">'+curCfg.symbol+' '+s.points+'</span>'+
      '<button class="btn btn-gray btn-sm btn-icon" onclick="showHist('+s.id+',\''+esc(s.name)+'\')"><i class="fas fa-clock-rotate-left"></i></button>'+
      '<button class="btn btn-gray btn-sm btn-icon" onclick="adjPoints('+s.id+',\''+esc(s.name)+'\')"><i class="fas fa-plus-minus"></i></button>'+
      '<button class="btn btn-gray btn-sm btn-icon" onclick="uploadPhoto('+s.id+')"><i class="fas fa-camera"></i></button>'+
      '<button class="btn btn-red btn-sm btn-icon" onclick="delStudent('+s.id+',\''+esc(s.name)+'\')"><i class="fas fa-trash"></i></button>'+
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
  // 학생 전체에서 벌금 합산
  var allF=[]
  students.forEach(function(s){
    if(s.fine_count>0||s.unpaid_fines>0){
      allF.push({student:s.name,unpaid:s.unpaid_fines,count:s.fine_count,id:s.id})
    }
  })
  var el=document.getElementById('fineList')
  if(allF.length===0){el.innerHTML='<div style="color:var(--g400);text-align:center;padding:20px;">미납 벌금 없음</div>';return}
  el.innerHTML='<div style="color:var(--g400);font-size:12px;padding:8px 0;">상세 내역은 학생 상세에서 확인 가능합니다.</div>'+
  allF.map(function(f){
    return '<div class="stu-list-item">'+
      '<div class="stu-av-txt">'+esc(f.student[0])+'</div>'+
      '<div class="stu-name-lbl">'+esc(f.student)+'</div>'+
      '<span style="font-size:12px;font-weight:700;background:var(--red-s);color:var(--red);border:1px solid rgba(239,68,68,.25);border-radius:100px;padding:2px 8px;">미납 '+f.count+'건</span>'+
      '<button class="btn btn-blue btn-sm" onclick="showHist('+f.id+',\''+esc(f.student)+'\')">내역</button>'+
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
  if(items.length===0){el.innerHTML='<div style="color:var(--g400);font-size:13px;padding:8px 0;">항목 없음</div>';return}
  el.innerHTML=items.map(function(m,i){
    var isLearn=type==='learn'
    var valField=isLearn
      ?'<input class="item-cost-inp" type="number" value="'+(m.reward||0)+'" onchange="menuCfg.'+type+'['+i+'].reward=+this.value" placeholder="보상"/>'
      :'<input class="item-cost-inp" type="number" value="'+(m.cost||0)+'" onchange="menuCfg.'+type+'['+i+'].cost=+this.value" placeholder="비용"/>'
    return '<div class="menu-item-row">'+
      '<div class="item-icon-box">'+m.icon+'</div>'+
      '<div class="item-label">'+esc(m.label)+'</div>'+
      valField+
      '<input class="item-unit-sel" value="'+(m.unit||curCfg.symbol||'P')+'" onchange="menuCfg.'+type+'['+i+'].unit=this.value" placeholder="단위" style="width:60px;"/>'+
      (isLearn?'<label style="font-size:11px;font-weight:700;white-space:nowrap;display:flex;align-items:center;gap:3px;"><input type="checkbox" '+(m.requirePhoto?'checked':'')+' onchange="menuCfg.'+type+'['+i+'].requirePhoto=this.checked"/> 사진</label>':'')+
      '<button class="item-del-btn" onclick="delMenuItem(\''+type+'\','+i+')"><i class="fas fa-trash"></i></button>'+
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
  } else {
    menuCfg[type].push({id:newId,icon:ic,label:lbl,cost:cost,reward:0,unit:unit,requirePhoto:false})
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
  var lc=localStorage.getItem('kiosk_config'),cfg={currency:curCfg,menu:menuCfg}
  if(lc){try{cfg=Object.assign({},JSON.parse(lc),{menu:menuCfg})}catch(e){}}
  localStorage.setItem('kiosk_config',JSON.stringify(cfg));localStorage.setItem('kiosk_cfg_ver','2025-v3')
  toast('메뉴 저장 완료!')
})

document.getElementById('resetmenuBtn').addEventListener('click',function(){
  if(!confirm('기본값으로 초기화?'))return
  menuCfg=JSON.parse(JSON.stringify(DEFAULT_MENU))
  renderMenuItems('learn');renderMenuItems('fine');renderMenuItems('shop');toast('초기화됨')
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
  var lc=localStorage.getItem('kiosk_config'),cfg={currency:curCfg,menu:menuCfg}
  if(lc){try{cfg=Object.assign({},JSON.parse(lc),{currency:curCfg})}catch(e){}}
  localStorage.setItem('kiosk_config',JSON.stringify(cfg));localStorage.setItem('kiosk_cfg_ver','2025-v3')
  renderPresets();toast('화폐 설정 저장!')
})

// ── 유틸 ──
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function toast(msg){var t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.remove()},2200)}

document.getElementById('closeHistBtn').addEventListener('click',function(){document.getElementById('hist-modal').classList.remove('open')})

})()
</script>
</body>
</html>`"""

# 파일에 쓰기
with open('/home/user/webapp/admin_html_new.py', 'w') as f:
    f.write(NEW_ADMIN)
print("파일 저장 완료")
