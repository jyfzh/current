import { initAppearance, normalizeAppearance } from "./admin-appearance.js";

// Served by the Worker itself: no CDN, framework, or third-party scripts.
export const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Current · 订阅管理</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/admin/style.css"><script src="/admin/app.js" defer></script></head>
<body>
<section id="login" class="login-shell">
  <div class="login-brand"><span class="brand-mark">c.</span><span>current<span class="brand-dot"> / </span>让信息流动</span></div>
  <form id="login-form" class="login-card"><div class="eyebrow">YOUR PERSONAL INFORMATION STREAM</div><h1>欢迎回来。</h1><p class="muted">登录以管理你的订阅，让好内容持续发生。</p><label>账号<input name="email" autocomplete="username" placeholder="邮箱，或默认账号 admin" required maxlength="2048"></label><label>密码<input name="password" type="password" autocomplete="current-password" placeholder="Fever 登录密码" required maxlength="2048"></label><p id="login-error" role="alert" class="error"></p><button class="primary" type="submit">登录管理面板 <span>→</span></button><p class="login-note">使用现有 Fever 账号登录 · 凭据仅保留在当前页面内存</p></form>
  <div class="login-footer">CURRENT / 一个安静、有序的信息入口。</div>
</section>
<div id="dashboard" class="app" hidden>
  <aside class="sidebar"><a class="brand" href="/admin"><span class="brand-mark">c.</span>current<span class="version">管理台</span></a><div class="workspace"><span class="workspace-icon">C</span><div>我的阅读空间<small>Personal workspace</small></div><span class="workspace-dot"></span></div>
    <div class="nav-label">工作空间</div><nav aria-label="主导航"><button id="nav-feeds" class="nav-button active"><span>▤</span>订阅源<span id="nav-count" class="nav-count">0</span></button><button id="nav-groups" class="nav-button"><span>▦</span>分组管理</button></nav>
    <div class="nav-label group-heading">我的分组<button id="sidebar-add-group" title="新建分组" aria-label="新建分组">+</button></div><div id="group-nav"></div>
    <div class="sidebar-bottom"><div class="engine"><span class="workspace-dot"></span>Fever 同步引擎<small>RSS · Atom · JSON Feed</small></div><button id="logout" class="nav-button"><span>↪</span>退出登录</button><small class="sidebar-caption">少一点噪音，多一点好内容。</small></div>
  </aside>
  <div class="main-shell"><header class="topbar"><span>工作空间 <span class="crumb-divider">/</span> <strong id="breadcrumb">订阅源</strong></span><div class="topbar-actions"><span class="topbar-caption">你的信息，由你掌控。</span><button id="appearance-open" class="secondary" aria-haspopup="dialog" aria-controls="appearance">◐ 外观设置</button></div></header>
  <main><div class="page-heading"><div><div class="eyebrow">CONTENT, CONNECTED.</div><h1 id="page-title">订阅源</h1><p id="page-description">把值得阅读的内容，汇聚在一起。</p></div><button id="add-main" class="primary"><span>+</span> 添加订阅源</button></div>
  <section id="stats" class="stats" aria-label="订阅概览"></section>
  <section class="content-card"><div class="card-heading"><div><h2 id="list-title">所有订阅源 <span id="list-count" class="count-badge">0</span></h2><p id="list-description">管理订阅、查看状态，保持信息流畅通。</p></div><button id="reload" class="secondary">↻ 刷新列表</button></div>
    <div id="feed-tools" class="toolbar"><div class="search-wrap"><span>⌕</span><input id="search" type="search" placeholder="搜索订阅名称或 URL…" aria-label="搜索订阅源"></div><select id="group-filter" aria-label="筛选分组"><option value="all">所有分组</option></select><select id="status-filter" aria-label="筛选状态"><option value="all">所有状态</option><option value="healthy">HTTP 正常</option><option value="error">请求异常</option><option value="pending">等待抓取</option></select></div>
    <p id="list-error" class="error list-error" role="alert"></p><div id="list" aria-live="polite"></div><div id="list-footer" class="list-footer"></div>
  </section><footer class="main-footer"><span>Current <span class="footer-divider">/</span> Your feeds. Your flow.</span><span>数据直接来自你的订阅库</span></footer></main></div>
</div>
<dialog id="editor"><form id="editor-form"><div class="dialog-header"><h2 id="editor-title"></h2><button type="button" id="close-editor" class="icon-button" aria-label="关闭">×</button></div><div id="editor-fields"></div><p id="editor-error" class="error" role="alert"></p><div class="dialog-footer"><button type="button" id="cancel-editor" class="secondary">取消</button><button type="submit" class="primary">保存</button></div></form></dialog>
<dialog id="appearance" aria-labelledby="appearance-title"><div class="dialog-header"><h2 id="appearance-title">外观设置</h2><button type="button" id="appearance-close" class="icon-button" aria-label="关闭外观设置">×</button></div><p class="appearance-description">即时预览，自动保存在当前浏览器。</p><label>明暗主题<select id="appearance-theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label>主题强调色<select id="appearance-accent"><option value="green">森林绿</option><option value="blue">海洋蓝</option><option value="purple">鸢尾紫</option><option value="orange">暖橙色</option></select></label><label>字体大小<select id="appearance-font"><option value="small">小号</option><option value="standard">标准</option><option value="large">大号</option><option value="extra-large">特大</option></select></label><label>列表密度<select id="appearance-density"><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label><div class="appearance-preview"><strong>阅读，让好内容持续发生。</strong><p>Current · RSS / Atom / JSON Feed</p><span class="group-badge">外观预览</span></div><p id="appearance-status" class="appearance-description" role="status"></p><div class="dialog-footer"><button id="appearance-reset" type="button" class="secondary">恢复默认</button><button id="appearance-done" type="button" class="primary">完成</button></div></dialog>
<div id="toast" role="status" hidden></div>
</body></html>`;

const baseStyles = `
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#243b36;background:#f7f9f8;font-size:14px;font-synthesis:none}*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit}button,a,input,select{-webkit-tap-highlight-color:transparent}button{cursor:pointer}button:disabled{cursor:wait;opacity:.55}button,a,input,select{outline-offset:4px}button:focus-visible,a:focus-visible{outline:2px solid #168267}button{border:0;background:none;color:inherit}a{color:inherit}button span{pointer-events:none}[hidden]{display:none!important}.muted{color:#7d8b85}h1,h2,p{margin:0}h1{letter-spacing:-1px;font-size:32px;line-height:1.4}h2{font-size:16px}.eyebrow{font-size:10px;font-weight:650;letter-spacing:2.3px;color:#7b9288;margin-bottom:10px}.primary,.secondary{display:inline-flex;justify-content:center;align-items:center;gap:9px;padding:11px 18px;border-radius:7px;font-weight:550;white-space:nowrap}.primary{background:#19765d;color:white;box-shadow:0 2px 3px #174b3910}.primary:hover{background:#115f4a}.primary span{font-size:20px;line-height:1}.secondary{background:#fff;border:1px solid #dde5e0;color:#53665b}.secondary:hover{background:#f5f8f6}.brand-mark{display:inline-grid;place-items:center;background:#1b775c;color:#fff;font-size:27px;font-weight:750;border-radius:10px;width:39px;height:39px;letter-spacing:-3px;padding-right:3px}.app{display:flex;min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;width:242px;background:#fff;border-right:1px solid #e5ebe7;padding:29px 19px;display:flex;flex-direction:column}.brand{display:flex;gap:11px;align-items:center;font-size:24px;font-weight:650;letter-spacing:-1px;text-decoration:none}.version{font-size:9px;font-weight:500;letter-spacing:1px;color:#8a9890;background:#f3f6f4;padding:3px 5px;margin-left:auto;border:1px solid #e6ece8;border-radius:4px}.workspace{margin:35px 0 30px;display:flex;gap:10px;align-items:center;padding:13px 10px;border:1px solid #e5ebe7;border-radius:8px;font-size:12px;font-weight:550}.workspace small{display:block;color:#9aa59f;font-size:10px;margin-top:5px;font-weight:400}.workspace-icon{background:#eef3e7;color:#778b43;display:grid;place-items:center;border-radius:6px;width:30px;height:32px}.workspace-dot{width:6px;height:6px;display:inline-block;background:#459c75;border-radius:50%;flex-shrink:0}.workspace>.workspace-dot{margin-left:auto}.nav-label{font-size:10px;letter-spacing:1px;color:#99a59e;padding:0 12px;margin-bottom:12px}.nav-button{width:100%;text-align:left;display:flex;align-items:center;gap:11px;font-size:13px;padding:12px;border-radius:7px;margin:3px 0;color:#75847b}.nav-button>span:first-child{font-size:19px;width:19px;text-align:center;line-height:1}.nav-button:hover{background:#f5f8f6}.nav-button.active{background:#eaf3ee;color:#24664d;font-weight:600}.nav-count{margin-left:auto;background:#dbeadf;border-radius:4px;padding:2px 6px;font-size:10px}.group-heading{display:flex;align-items:center;justify-content:space-between;margin-top:33px}.group-heading button{font-size:20px;color:#809086;line-height:1}.group-link{display:flex;gap:10px;align-items:center;font-size:12px;width:100%;text-align:left;padding:10px 13px;color:#7e8e83;border-radius:6px}.group-link:hover,.group-link.active{background:#f1f6f3;color:#266c52}.group-link .group-dot{width:6px;height:6px;background:#97b1a0;border-radius:2px;flex-shrink:0}.group-link .group-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group-link small{margin-left:auto;color:#9ba69f}#group-nav{overflow-y:auto;min-height:30px;max-height:35vh}.sidebar-bottom{margin-top:auto;padding-top:28px}.engine{font-size:11px;color:#5f7566;padding:12px;margin-bottom:10px;border-top:1px solid #edf0ed}.engine>.workspace-dot{margin-right:7px}.engine small{display:block;font-size:10px;color:#a1aba5;margin:8px 0 0 14px}.sidebar-caption{font-size:10px;color:#b0b8b2;display:block;padding:10px 12px}.main-shell{margin-left:242px;flex:1;min-width:0}.topbar{height:73px;padding:0 43px;border-bottom:1px solid #e8ede9;display:flex;justify-content:space-between;align-items:center;background:#fff;font-size:11px;color:#9aa69e}.topbar strong{font-weight:500;color:#50665a}.crumb-divider{margin:0 15px;color:#cbd3cd}.topbar-caption{font-size:10px;letter-spacing:1px}main{max-width:1450px;padding:40px 43px 24px;margin:auto}.page-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:29px;gap:18px}.page-heading p{color:#89978d;margin-top:9px;font-size:12px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:17px;margin-bottom:31px}.stat{border:1px solid #e2e9e3;border-radius:9px;background:white;padding:20px 22px;position:relative}.stat-label{font-size:11px;color:#819087}.stat-value{font-size:31px;font-weight:600;letter-spacing:-1px;line-height:1.4;margin:10px 0 6px}.stat-note{font-size:10px;color:#9ba79f}.stat-symbol{position:absolute;right:18px;top:18px;border-radius:7px;padding:7px 9px;background:#f3f7f4;color:#82a28f;font-size:15px}.stat.alert .stat-symbol{background:#fff8eb;color:#b99b62}.content-card{background:white;border:1px solid #e1e8e2;border-radius:10px;overflow:hidden;box-shadow:0 3px 5px #213c2302}.card-heading{padding:24px 25px;display:flex;justify-content:space-between;align-items:center;gap:12px}.card-heading h2{display:flex;align-items:center;gap:9px;font-size:14px}.count-badge{font-size:10px;font-weight:500;color:#7f9284;background:#f0f4f0;padding:3px 7px;border-radius:5px}.card-heading p{font-size:11px;color:#98a39b;margin-top:8px}.card-heading .secondary{font-size:11px;padding:8px 12px}.toolbar{display:flex;gap:10px;padding:0 25px 21px}.search-wrap{display:flex;align-items:center;gap:9px;flex:1;border:1px solid #e3e9e4;border-radius:6px;padding:0 12px}.search-wrap span{font-size:22px;color:#9eaaa2}.search-wrap input{width:100%;border:0;outline:none;padding:10px 0;font-size:11px;background:transparent}.search-wrap:focus-within{border-color:#529d7a}.search-wrap input::placeholder{color:#a2aca5}select{background:#fff;border:1px solid #e3e9e4;border-radius:6px;padding:9px 25px 9px 12px;color:#7a8b7e;font-size:11px;max-width:190px}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;table-layout:fixed}thead{background:#f8faf8;font-size:10px;color:#94a095}th{font-weight:500;padding:12px 15px;border-top:1px solid #edf1ed;border-bottom:1px solid #edf1ed}th:first-child{padding-left:25px;width:41%}th:nth-child(2){width:14%}th:nth-child(3){width:14%}th:nth-child(4){width:16%}th:last-child{width:15%;text-align:right;padding-right:25px}td{padding:19px 15px;border-bottom:1px solid #eef2ee;font-size:11px;color:#819087}td:first-child{padding-left:25px}td:last-child{text-align:right;padding-right:25px}tr:last-child td{border-bottom:0}tbody tr:hover{background:#fcfdfb}.feed-identity{display:flex;gap:12px;align-items:center;min-width:0}.feed-avatar{flex-shrink:0;width:34px;height:35px;border:1px solid #e5ece4;background:#f0f5ee;color:#5f8064;border-radius:8px;display:grid;place-items:center;font-size:16px;font-weight:650}.feed-info{min-width:0}.feed-title{display:block;font-size:12px;font-weight:550;color:#364f3e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.feed-url{font-size:10px;color:#9eaaa2;margin-top:5px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}.feed-url:hover{text-decoration:underline}.group-badge{display:inline-block;background:#f3f6f2;border:1px solid #e6ece3;border-radius:4px;padding:4px 7px;color:#7e907a;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.status{white-space:nowrap;font-size:10px;color:#629575;display:inline-flex;gap:5px;align-items:center}.status:before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor}.status.error-state{color:#bf8760}.status.pending{color:#a0aaa3}.status-details{color:#a8b1aa;display:block;font-size:9px;margin-top:5px}.row-actions{display:flex;gap:2px;justify-content:flex-end}.icon-button{width:28px;height:28px;border-radius:5px;color:#96a59a;font-size:15px;display:inline-grid;place-items:center}.icon-button:hover{background:#eef4ee;color:#3c7b55}.icon-button.danger:hover{background:#fcf0ed;color:#b45d4c}.list-footer{font-size:10px;color:#9ca89e;background:#fbfcfa;border-top:1px solid #edf1ed;padding:14px 25px;display:flex;justify-content:space-between}.main-footer{display:flex;justify-content:space-between;font-size:10px;color:#a4afa6;margin-top:24px}.footer-divider{margin:0 10px;color:#c0c8c1}.empty{text-align:center;padding:65px 20px;color:#92a095;font-size:12px}.empty strong{display:block;color:#496451;font-size:16px;margin:10px 0}.empty p{margin:8px 0 20px;line-height:1.8}.empty-icon{font-size:32px;color:#8dad93}.error{font-size:12px;color:#b65d50;line-height:1.6;margin:12px 0}.error:empty{display:none}.list-error{padding:0 25px}.group-list{padding:0 25px}.group-row{display:flex;align-items:center;gap:12px;padding:19px 0;border-top:1px solid #edf1ed}.group-row .group-title{flex:1;font-weight:550}.group-row small{color:#98a99a}.login-shell{min-height:100vh;display:flex;flex-direction:column;background:radial-gradient(ellipse at 75% 12%,#e8f0e4 0,transparent 55%),#f7f9f5;padding:35px 48px}.login-brand{display:flex;align-items:center;gap:13px;font-size:18px;font-weight:550}.brand-dot{color:#a9baa7;margin:0 8px}.login-card{width:min(100%,430px);margin:auto;background:#fff;border:1px solid #e2e9df;border-radius:14px;padding:38px;box-shadow:0 15px 60px #43603c08}.login-card h1{margin:9px 0 12px}.login-card>.muted{font-size:12px;line-height:1.8;margin-bottom:28px}label{display:block;font-size:12px;color:#586e5d;margin:19px 0}label input,label select{display:block;width:100%;border:1px solid #dfe7df;border-radius:6px;padding:12px;margin-top:8px;font-size:12px;color:#304e37;max-width:none}label input:focus{outline:2px solid #b6d3bc;border-color:#6eaa7d;outline-offset:0}label input::placeholder{color:#a9b3a8}.login-card .primary{width:100%;justify-content:space-between;margin-top:8px}.login-note{font-size:10px;color:#a4afa1;text-align:center;line-height:1.8;margin-top:20px}.login-footer{font-size:10px;color:#9eac9a;margin-top:25px}dialog{border:1px solid #e1e9df;border-radius:12px;padding:27px;width:min(94vw,480px);color:#2e4834;box-shadow:0 20px 90px #0c241d20}dialog::backdrop{background:#1a302a55;backdrop-filter:blur(3px)}.dialog-header{display:flex;justify-content:space-between;align-items:center}.dialog-header h2{font-size:19px}.dialog-footer{display:flex;justify-content:flex-end;gap:10px;margin-top:25px}.field-hint{font-size:10px;color:#99a792;line-height:1.7;margin-top:-8px}#toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);padding:13px 22px;border-radius:8px;background:#233e30;color:#fff;box-shadow:0 6px 25px #142b2425;z-index:10;font-size:12px;max-width:90vw}
@media(min-width:1500px){main{padding-top:50px}.stats{gap:24px}.stat{padding:24px}.page-heading{margin-bottom:35px}}
@media(max-width:1150px){.sidebar{width:205px;padding:25px 14px}.main-shell{margin-left:205px}main{padding:30px 24px}.topbar{padding:0 24px}.stat{padding:16px}.stat-symbol{display:none}table{min-width:750px}.toolbar{flex-wrap:wrap}.search-wrap{min-width:210px}.version{display:none}}
@media(max-width:760px){.sidebar{position:static;width:100%;padding:15px 18px;display:block;border-right:0;border-bottom:1px solid #e5ebe7}.app{display:block}.brand{font-size:22px}.brand-mark{width:33px;height:33px;font-size:24px}.workspace,.nav-label,#group-nav,.engine,.sidebar-caption{display:none}.sidebar nav{display:flex;margin-top:14px;gap:10px}.nav-button{font-size:12px;padding:9px}.sidebar-bottom{position:absolute;right:12px;top:10px;margin:0;padding:0}.sidebar-bottom .nav-button{width:auto}.main-shell{margin:0}.topbar{height:49px;padding:0 20px}.topbar-caption{display:none}main{padding:24px 16px}.page-heading{align-items:flex-end;gap:10px}h1{font-size:27px}.page-heading p{font-size:11px;line-height:1.7}.page-heading .primary{padding:10px 12px;font-size:11px}.eyebrow{font-size:8px;letter-spacing:1.6px}.stats{grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:20px}.stat{padding:16px}.stat-value{font-size:27px}.card-heading{padding:19px 16px}.card-heading p{max-width:180px;line-height:1.7}.toolbar{padding:0 16px 17px;gap:8px}.search-wrap{min-width:100%;flex-basis:100%}.toolbar select{flex:1;max-width:none}.main-footer{font-size:9px;gap:12px}.main-footer>span:last-child{display:none}.login-shell{padding:24px 20px}.login-brand{font-size:14px}.login-card{padding:29px;margin-top:70px;margin-bottom:70px}.group-list{padding:0 16px}.list-footer{padding:13px 16px}.list-error{padding:0 16px}}
`;

function adminApp() {
  const $ = id => document.getElementById(id);
  let token = null;
  let feeds = [];
  let groups = [];
  let view = "feeds";
  let editing = null;
  let toastTimer;
  const statusOf = feed => !feed.last_fetched_on ? "pending" : feed.last_http_status >= 200 && feed.last_http_status < 300 ? "healthy" : "error";
  const statusNames = { healthy: "HTTP 正常", error: "请求异常", pending: "等待抓取" };
  const number = value => Number(value || 0).toLocaleString("zh-CN");
  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }
  function notify(message) {
    $("toast").textContent = message;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
  }
  function logout() {
    token = null; feeds = []; groups = [];
    $("dashboard").hidden = true;
    $("login").hidden = false;
    $("editor").close();
    $("list").replaceChildren();
    $("group-nav").replaceChildren();
    $("stats").replaceChildren();
    $("login-form").reset();
  }
  async function api(path, method = "GET", data) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data !== undefined) headers["Content-Type"] = "application/json";
    const result = await fetch(`/admin/api/${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), credentials: "omit" });
    const body = await result.json();
    if (!result.ok) {
      if (result.status === 401 && token) logout();
      throw new Error(body.error || "请求失败");
    }
    return body;
  }
  async function busy(button, action, onError = error => notify(error.message)) {
    button.disabled = true;
    try { await action(); }
    catch (error) { onError(error); }
    finally { button.disabled = false; }
  }
  function option(value, title) {
    const element = node("option", "", title); element.value = value; return element;
  }
  function renderNavigation() {
    $("nav-count").textContent = feeds.length;
    const previous = $("group-filter").value;
    $("group-filter").replaceChildren(option("all", "所有分组"), option("0", "未分组"), ...groups.map(group => option(String(group.id), group.title)));
    $("group-filter").value = [...$("group-filter").options].some(item => item.value === previous) ? previous : "all";
    const ungrouped = { id: 0, title: "未分组", subscription_count: feeds.filter(feed => !feed.group_id).length };
    $("group-nav").replaceChildren(...[...groups, ungrouped].map(group => {
      const button = node("button", "group-link");
      if (view === "feeds" && $("group-filter").value === String(group.id)) button.classList.add("active");
      button.append(node("span", "group-dot"), node("span", "group-name", group.title), node("small", "", number(group.subscription_count)));
      button.onclick = () => { view = "feeds"; $("group-filter").value = String(group.id); render(); };
      return button;
    }));
  }
  function renderStats() {
    const values = [
      ["订阅源总数", feeds.length, "每一份好内容，都值得订阅", "▤", ""],
      ["分组", groups.length, "为你的兴趣，分门别类", "▦", ""],
      ["未读文章", feeds.reduce((sum, feed) => sum + feed.unread_count, 0), "留给下一次灵感时刻", "▧", ""],
      ["请求异常", feeds.filter(feed => statusOf(feed) === "error").length, "根据最近一次 HTTP 请求判断", "◌", "alert"],
    ];
    $("stats").replaceChildren(...values.map(([label, value, note, symbol, className]) => {
      const card = node("div", `stat ${className}`);
      card.append(node("div", "stat-label", label), node("div", "stat-value", number(value)), node("div", "stat-note", note), node("span", "stat-symbol", symbol));
      return card;
    }));
  }
  function action(label, symbol, callback, danger = false) {
    const button = node("button", `icon-button${danger ? " danger" : ""}`, symbol);
    button.title = label; button.setAttribute("aria-label", label);
    button.onclick = () => busy(button, callback);
    return button;
  }
  function relativeTime(seconds) {
    if (!seconds) return "尚未抓取";
    const minutes = Math.floor(Math.max(0, Date.now() / 1000 - seconds) / 60);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
    return `${Math.floor(minutes / 1440)} 天前`;
  }
  function renderFeeds() {
    const query = $("search").value.trim().toLowerCase();
    const group = $("group-filter").value;
    const status = $("status-filter").value;
    const filtered = feeds.filter(feed => (!query || `${feed.title} ${feed.url}`.toLowerCase().includes(query)) && (group === "all" || String(feed.group_id) === group) && (status === "all" || statusOf(feed) === status));
    $("list-count").textContent = filtered.length;
    $("list-footer").replaceChildren(node("span", "", `显示 ${number(filtered.length)} 个订阅源，共 ${number(feeds.length)} 个`), node("span", "", "按添加时间排序"));
    if (!filtered.length) {
      const empty = node("div", "empty");
      empty.append(node("div", "empty-icon", "▤"), node("strong", "", feeds.length ? "没有匹配的订阅源" : "你的信息流，从这里开始"), node("p", "", feeds.length ? "试试其他关键词，或调整分组和状态筛选。" : "添加第一个 RSS、Atom 或 JSON Feed 订阅地址。"));
      const button = node("button", "primary", feeds.length ? "清除筛选" : "+ 添加订阅源");
      button.onclick = () => {
        if (!feeds.length) return openEditor("feed");
        $("search").value = ""; $("group-filter").value = "all"; $("status-filter").value = "all"; render();
      };
      empty.append(button); $("list").replaceChildren(empty); return;
    }
    const table = node("table");
    const head = node("thead"); const header = node("tr");
    for (const title of ["订阅源", "分组", "抓取状态", "最近抓取", "操作"]) header.append(node("th", "", title));
    head.append(header); table.append(head);
    const body = node("tbody");
    for (const feed of filtered) {
      const row = node("tr");
      const identityCell = node("td"); const identity = node("div", "feed-identity");
      const info = node("div", "feed-info");
      info.append(node("span", "feed-title", feed.title));
      const link = node("a", "feed-url", feed.url);
      // The server validates new URLs; historical database rows are also untrusted.
      try { if (["http:", "https:"].includes(new URL(feed.url).protocol)) { link.href = feed.url; link.target = "_blank"; link.rel = "noopener noreferrer"; } } catch { /* Display invalid historical URLs as text. */ }
      link.title = feed.url; info.append(link);
      identity.append(node("div", "feed-avatar", Array.from(feed.title || "R")[0].toUpperCase()), info); identityCell.append(identity);
      const groupCell = node("td"); groupCell.append(node("span", "group-badge", groups.find(group => group.id === feed.group_id)?.title || "未分组"));
      const statusCell = node("td"); const state = statusOf(feed);
      statusCell.append(node("span", `status ${state === "error" ? "error-state" : state}`, statusNames[state]));
      if (feed.last_fetched_on) statusCell.append(node("span", "status-details", feed.last_http_status ? `HTTP ${feed.last_http_status}` : "未收到 HTTP 响应"));
      const time = node("td", "", relativeTime(feed.last_fetched_on));
      if (feed.last_fetched_on) time.title = new Date(feed.last_fetched_on * 1000).toLocaleString("zh-CN");
      const actionsCell = node("td"); const actions = node("div", "row-actions");
      actions.append(action(`刷新 ${feed.title}`, "↻", async () => {
        const result = await api(`feeds/${feed.id}/refresh`, "POST");
        await refresh();
        notify(statusOf(result.feed) === "healthy" ? "抓取已完成，请求正常（解析详情见服务日志）" : `抓取已完成：${statusNames[statusOf(result.feed)]}`);
      }), action(`编辑 ${feed.title}`, "✎", () => openEditor("feed", feed)), action(`删除 ${feed.title}`, "×", async () => {
        if (!confirm(`删除「${feed.title}」？其文章、收藏和阅读记录也将删除，且无法恢复。`)) return;
        await api(`feeds/${feed.id}`, "DELETE"); await refresh(); notify("订阅源已删除");
      }, true));
      actionsCell.append(actions); row.append(identityCell, groupCell, statusCell, time, actionsCell); body.append(row);
    }
    table.append(body); const scroll = node("div", "table-scroll"); scroll.append(table); $("list").replaceChildren(scroll);
  }
  function renderGroups() {
    $("list-count").textContent = groups.length;
    $("list-footer").textContent = `共 ${number(groups.length)} 个分组 · 删除分组不会删除订阅源`;
    if (!groups.length) {
      const empty = node("div", "empty"); empty.append(node("div", "empty-icon", "▦"), node("strong", "", "让你的订阅井井有条"), node("p", "", "新建分组，再将订阅源放入合适的分类。"));
      const button = node("button", "primary", "+ 新建分组"); button.onclick = () => openEditor("group"); empty.append(button); $("list").replaceChildren(empty); return;
    }
    const list = node("div", "group-list");
    for (const group of groups) {
      const row = node("div", "group-row");
      row.append(node("span", "feed-avatar", "▦"), node("span", "group-title", group.title), node("small", "", `${number(group.subscription_count)} 个订阅源`), action(`编辑 ${group.title}`, "✎", () => openEditor("group", group)), action(`删除 ${group.title}`, "×", async () => {
        if (!confirm(`删除分组「${group.title}」？其中的订阅源将移至「未分组」，不会被删除。`)) return;
        await api(`groups/${group.id}`, "DELETE"); await refresh(); notify("分组已删除，订阅源保留");
      }, true));
      list.append(row);
    }
    $("list").replaceChildren(list);
  }
  function render() {
    const isFeeds = view === "feeds";
    $("nav-feeds").classList.toggle("active", isFeeds); $("nav-groups").classList.toggle("active", !isFeeds);
    $("page-title").textContent = $("breadcrumb").textContent = isFeeds ? "订阅源" : "分组管理";
    $("page-description").textContent = isFeeds ? "把值得阅读的内容，汇聚在一起。" : "为每一份兴趣，找到它的位置。";
    $("add-main").textContent = isFeeds ? "+ 添加订阅源" : "+ 新建分组";
    $("list-title").firstChild.textContent = isFeeds ? "所有订阅源 " : "我的分组 ";
    $("list-description").textContent = isFeeds ? "管理订阅、查看状态，保持信息流畅通。" : "按主题整理订阅，让阅读更有条理。";
    $("feed-tools").hidden = !isFeeds;
    renderNavigation(); renderStats(); if (isFeeds) renderFeeds(); else renderGroups();
  }
  async function refresh() {
    $("list-error").textContent = "";
    try {
      const data = await api("overview");
      if (!token) return;
      feeds = data.feeds; groups = data.groups; render();
    } catch (error) { $("list-error").textContent = `列表加载失败：${error.message}。请点击「刷新列表」重试。`; throw error; }
  }
  function field(labelText, name, value = "", type = "text", required = true) {
    const label = node("label", "", labelText); const input = node("input");
    input.name = name; input.type = type; input.required = required; input.maxLength = 2048; input.value = value;
    label.append(input); return label;
  }
  function openEditor(kind, item = null) {
    editing = { kind, id: item?.id };
    $("editor-title").textContent = `${item ? "编辑" : "新建"}${kind === "feed" ? "订阅源" : "分组"}`;
    $("editor-error").textContent = "";
    $("editor-fields").replaceChildren(field(kind === "feed" ? "订阅名称" : "分组名称", "title", item?.title));
    if (kind === "feed") {
      $("editor-fields").append(field("订阅地址", "url", item?.url, "url"), node("p", "field-hint", "请填写 RSS、Atom 或 JSON Feed 的完整地址，而非网页地址。"), field("网站地址（选填）", "site_url", item?.site_url, "url", false));
      const label = node("label", "", "所属分组"); const select = node("select"); select.name = "group_id";
      select.append(option("0", "未分组"), ...groups.map(group => option(String(group.id), group.title)));
      select.value = String(item?.group_id ?? ($("group-filter").value === "all" ? 0 : $("group-filter").value));
      label.append(select); $("editor-fields").append(label);
    }
    $("editor").showModal();
  }
  $("login-form").onsubmit = event => {
    event.preventDefault(); $("login-error").textContent = "";
    busy(event.submitter, async () => {
      const form = new FormData(event.target);
      const result = await api("login", "POST", { email: form.get("email"), password: form.get("password") });
      token = result.api_key; event.target.reset();
      $("login").hidden = true; $("dashboard").hidden = false;
      $("list").replaceChildren(node("div", "empty", "正在加载你的订阅…"));
      view = "feeds"; $("search").value = ""; $("group-filter").value = "all"; $("status-filter").value = "all";
      await refresh();
    }, error => { $("login-error").textContent = error.message; });
  };
  $("logout").onclick = logout;
  $("reload").onclick = () => busy($("reload"), refresh);
  $("nav-feeds").onclick = () => { view = "feeds"; $("group-filter").value = "all"; render(); };
  $("nav-groups").onclick = () => { view = "groups"; render(); };
  $("add-main").onclick = () => openEditor(view === "feeds" ? "feed" : "group");
  $("sidebar-add-group").onclick = () => openEditor("group");
  $("search").oninput = renderFeeds;
  $("group-filter").onchange = render;
  $("status-filter").onchange = renderFeeds;
  $("close-editor").onclick = $("cancel-editor").onclick = () => $("editor").close();
  $("editor-form").onsubmit = event => {
    event.preventDefault(); $("editor-error").textContent = "";
    busy(event.submitter, async () => {
      const values = Object.fromEntries(new FormData(event.target));
      if (editing.kind === "feed") values.group_id = Number(values.group_id);
      const path = `${editing.kind === "feed" ? "feeds" : "groups"}${editing.id ? `/${editing.id}` : ""}`;
      await api(path, editing.id ? "PUT" : "POST", values);
      $("editor").close(); notify("保存成功"); await refresh();
    }, error => { if ($("editor").open) $("editor-error").textContent = error.message; else notify(error.message); });
  };
}

// Scale typography rather than zooming the entire layout. Fixed geometry stays stable.
export const styles = baseStyles.replace(/font-size:(\d+(?:\.\d+)?)px/g,
  (_, pixels) => `font-size:${Number(pixels) / 14}rem`) + `
:root{font-size:14px;color-scheme:light;--bg:#f7f9f8;--surface:#fff;--subtle:#f1f5f2;--hover:#edf3ef;--line:#dfe7e1;--text:#243b36;--muted:#65796e;--accent:#19765d;--accent-hover:#115f4a;--tint:#eaf3ee;--accent-text:#24664d;--warning:#9b5b29;--error:#b24638;--success:#287748}
:root[data-font="small"]{font-size:12px}:root[data-font="large"]{font-size:16px}:root[data-font="extra-large"]{font-size:18px}
:root[data-accent="blue"]{--accent:#2463ad;--accent-hover:#194c89;--tint:#e9f0fb;--accent-text:#24558a}
:root[data-accent="purple"]{--accent:#7851a8;--accent-hover:#613e8c;--tint:#f0ebf8;--accent-text:#6c4695}
:root[data-accent="orange"]{--accent:#ac541b;--accent-hover:#893f12;--tint:#fcf0e5;--accent-text:#914712}
:root[data-theme="dark"]{color-scheme:dark;--bg:#141b1a;--surface:#1d2724;--subtle:#24322d;--hover:#2a3a32;--line:#3d5147;--text:#e2ece6;--muted:#abbdb0;--tint:#243c31;--accent-text:#91d8b5;--warning:#e3b17f;--error:#f49a8d;--success:#8ed5a7}
:root[data-theme="dark"][data-accent="blue"]{--tint:#22364d;--accent-text:#a5ccff}
:root[data-theme="dark"][data-accent="purple"]{--tint:#352b48;--accent-text:#d7baff}
:root[data-theme="dark"][data-accent="orange"]{--tint:#443022;--accent-text:#f9c296}
:root,body{background:var(--bg);color:var(--text)}
.sidebar,.topbar,.stat,.content-card,.login-card,dialog,.secondary,select,label input{background:var(--surface);color:var(--text)}
.login-shell{background:radial-gradient(ellipse at 75% 12%,var(--tint),transparent 55%),var(--bg)}
.workspace-icon,.version,.stat-symbol,.feed-avatar,.group-badge,.count-badge,.nav-count,thead,.list-footer,.appearance-preview{background:var(--subtle);color:var(--muted)}
.sidebar,.topbar,.stat,.content-card,.workspace,.version,.secondary,select,label input,.search-wrap,th,td,.feed-avatar,.group-badge,.list-footer,.engine,.group-row,.login-card,dialog,.appearance-preview{border-color:var(--line)}
.brand,.workspace,.stat-value,h1,h2,.feed-title,.group-title,.empty strong,.topbar strong,label{color:var(--text)}
.muted,.eyebrow,.nav-label,.nav-button,.group-link,.workspace small,.group-link small,.engine,.engine small,.sidebar-caption,.topbar,.topbar-caption,.page-heading p,.stat-label,.stat-note,.card-heading p,.search-wrap span,.feed-url,td,.status-details,.icon-button,.main-footer,.empty,.empty p,.group-row small,.login-note,.login-footer,.field-hint,.appearance-description{color:var(--muted)}
.search-wrap input{color:var(--text)}input::placeholder,label input::placeholder,.search-wrap input::placeholder{color:var(--muted);opacity:.8}
.secondary:hover,.nav-button:hover,.group-link:hover,tbody tr:hover,.icon-button:hover{background:var(--hover);color:var(--text)}
.nav-button.active,.group-link.active{background:var(--tint);color:var(--accent-text)}
.primary,.brand-mark{background:var(--accent);color:#fff}.primary:hover{background:var(--accent-hover)}
button:focus-visible,a:focus-visible{outline-color:var(--accent)}label input:focus{outline-color:var(--accent);border-color:var(--accent)}.search-wrap:focus-within{border-color:var(--accent)}
.group-link .group-dot,.workspace-dot{background:var(--accent)}.status{color:var(--success)}.status.error-state{color:var(--warning)}.status.pending{color:var(--muted)}.error,.icon-button.danger:hover{color:var(--error)}.icon-button.danger:hover{background:var(--subtle)}.stat.alert .stat-symbol{background:var(--subtle);color:var(--warning)}
.topbar-actions{display:flex;gap:18px;align-items:center}.topbar-actions .secondary{font-size:.85rem;padding:8px 12px}
.appearance-description{font-size:.85rem;line-height:1.8;margin:14px 0}.appearance-preview{border:1px solid var(--line);border-radius:8px;padding:18px;line-height:1.8}.appearance-preview strong{color:var(--text)}.appearance-preview p{font-size:.85rem;margin:5px 0 10px}
:root[data-density="compact"] td{padding-top:10px;padding-bottom:10px}:root[data-density="compact"] .group-row{padding-top:10px;padding-bottom:10px}
dialog{max-height:90vh;overflow-y:auto}.sidebar{overflow-y:auto}.sidebar-bottom{flex-shrink:0}
@media(max-width:760px){.topbar-actions{gap:0}.topbar{height:auto;min-height:49px;gap:12px;padding-top:8px;padding-bottom:8px}.page-heading{flex-wrap:wrap}.sidebar nav{flex-wrap:wrap}.group-row{flex-wrap:wrap}.topbar-actions .secondary{font-size:.8rem}}
`;

export const script = `(${initAppearance.toString()})(${normalizeAppearance.toString()});(${adminApp.toString()})();`;
