import { LAYERS, DEVIATION_LIMIT } from "./tasks.js";

// 页面处：只负责 HTML 与前端交互，不含存取与规则判断（规则以服务端返回为准）。
function clientScript() {
  return `
  const LAYERS = ${JSON.stringify(LAYERS)};
  const DEVIATION_LIMIT = ${DEVIATION_LIMIT};
  const stages = ["待检查","校准中","待复核","已交付"];
  const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
  let items = [], tensioners = [];

  async function api(path, options) {
    const res = await fetch(path, options && options.body ? { ...options, headers:{'Content-Type':'application/json'} } : options);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  }
  function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function renderForms() {
    document.querySelector('#fields').innerHTML = fields.map(function(f){
      return '<label>'+f[1]+'</label><input name="'+f[0]+'" type="'+f[2]+'" '+(f[0]==='code'?'required':'')+'>';
    }).join('');
  }

  function doneLayers(item) {
    const tasks = (item.tasks || []).filter(function(t){ return !t.voidedAt && t.targetTension; });
    return LAYERS.filter(function(l){
      return tasks.length > 0 && tasks.every(function(t){ return t.readings && t.readings[l.key]; });
    }).map(function(l){ return l.key; });
  }
  function currentLayer(item) {
    const done = doneLayers(item);
    for (const l of LAYERS) { if (!done.includes(l.key)) return l; }
    return null;
  }

  function layerCell(item, task, layer, curKey) {
    const r = task.readings && task.readings[layer.key];
    let body = '';
    if (r) {
      const pct = (r.deviation * 100).toFixed(1);
      const bad = r.deviation > DEVIATION_LIMIT;
      body = '<div class="rd '+(bad?'bad':'ok')+'"><b>'+esc(r.value)+'</b><span class="meta">目标 '+r.target+' · 偏离 '+pct+'%</span>'
        + '<span class="meta">'+esc(r.reader)+(r.reviewed ? ' · 已由'+esc(r.reviewer||'')+'复核('+esc(r.decision||'')+')' : '')+'</span></div>';
    } else if (curKey === layer.key && task.status !== '停用待复核') {
      body = '<form class="rdform" data-act="reading" data-item="'+esc(item.id)+'" data-task="'+esc(task.id)+'" data-layer="'+layer.key+'">'
        + '<label>'+layer.label+'读数（目标 '+(task.targetTension*layer.ratio).toFixed(2)+'）</label>'
        + '<input name="value" type="number" step="0.01" placeholder="读数" required>'
        + '<input name="reader" placeholder="记录师傅" required>'
        + '<button class="small">记'+layer.label+'</button></form>';
    } else {
      body = '<div class="rd lock"><span class="meta">'+layer.label+' 目标 '+(task.targetTension*layer.ratio).toFixed(2)+'</span><span class="meta">未到本层</span></div>';
    }
    return '<td class="cell"><div class="layer-tag">'+layer.label+'</div>'+body+'</td>';
  }

  function taskHtml(item, task) {
    if (!task.targetTension) {
      return '<tr class="rope legacy"><td>'+esc(task.position)+'<div class="meta">旧任务（'+esc(task.tension||'')+'），无分段张紧数据</div></td><td colspan="3" class="meta">'+esc(task.status||'')+'</td></tr>';
    }
    const cur = currentLayer(item);
    const blocked = task.status === '停用待复核';
    const r = blocked && cur && task.readings[cur.key];
    let review = '';
    if (blocked && r) {
      review = '<tr class="reviewrow"><td colspan="4"><div class="reviewbox"><span class="warn">⚠ 该索'+esc(r.layerLabel)+'读数偏离目标 '+(r.deviation*100).toFixed(1)+'%，已停下。换另一名师傅复核：</span>'
        + '<form data-act="review" data-item="'+esc(item.id)+'" data-task="'+esc(task.id)+'" data-layer="'+esc(cur.key)+'">'
        + '<input name="reviewer" placeholder="复核师傅（不能是 '+esc(r.reader)+'）" required>'
        + '<select name="decision"><option value="approve">复核放行，继续下一层</option><option value="reject">驳回，重新记录本层</option></select>'
        + '<input name="note" placeholder="复核意见（可选）">'
        + '<button class="small warnbtn">提交复核</button></form></div></td></tr>';
    }
    const cells = LAYERS.map(function(l){ return layerCell(item, task, l, cur && cur.key); }).join('');
    return '<tr class="rope '+(blocked?'blocked':'')+'"><td><b>'+esc(task.position)+'</b>'
      + '<div class="meta">目标张力 '+esc(task.targetTension)+' · 张紧器 '+esc(task.tensioner)+'</div>'
      + '<span class="pill">'+esc(task.status)+'</span></td>'+cells+'</tr>'+review;
  }

  function cardHtml(item) {
    const held = tensioners.filter(function(t){ return t.model === item.code; }).map(function(t){ return t.code; });
    const cur = currentLayer(item);
    const stageNote = cur ? ('当前层：<b>'+cur.label+'（'+Math.round(cur.ratio*100)+'%）</b>，所有帆索记完才进入下一层') : '<b>三层读数均已完成，整套张紧结束</b>';
    const ropes = (item.tasks || []).length
      ? '<table class="ropes"><tr><th>帆索</th><th>三成 30%</th><th>六成 60%</th><th>满张力 100%</th></tr>'+item.tasks.map(function(t){ return taskHtml(item,t); }).join('')+'</table>'
      : '<div class="meta">尚未登记帆索</div>';
    const logs = (item.logs || []).slice(-6).reverse().map(function(l){ return '<div><span class="meta">'+esc((l.at||'').slice(0,16).replace('T',' '))+'</span> '+esc(l.step)+'：'+esc(l.note)+'</div>'; }).join('');
    const voidNote = item.voidedRuns ? '<div class="warn">桅杆数量/帆索材料已变更 '+item.voidedRuns+' 次，旧张紧结果已失效并重做</div>' : '';
    const head = fields.map(function(f){ return '<span class="meta">'+f[1]+'：'+esc(item[f[0]])+'</span>'; }).join('');
    return '<article class="card'+(item.status==='待复核'?' alert':'')+'">'
      + '<div class="cardhead"><h3>'+esc(item.code)+'</h3>'
      + '<select class="statusselect" data-item="'+esc(item.id)+'">'+stages.map(function(s){ return '<option '+(s===item.status?'selected':'')+'>'+s+'</option>'; }).join('')+'</select></div>'
      + '<div class="metas">'+head+'</div>'
      + '<div class="meta">领用张紧器：'+(held.length?held.map(esc).join('、'):'无')+'（整套结束前不可转领）</div>'
      + '<div class="stage-note">'+stageNote+'</div>'+voidNote+ropes
      + '<details class="logs"><summary>审计记录（'+((item.logs||[]).length)+'）</summary>'+(logs||'<div class="meta">暂无记录</div>')+'</details>'
      + '</article>';
  }

  function renderSelects() {
    const opts = items.map(function(i){ return '<option value="'+esc(i.id)+'">'+esc(i.code)+' · '+esc(i.shipType||'')+'</option>'; }).join('');
    document.querySelector('#assignItem').innerHTML = opts;
    document.querySelector('#ropeItem').innerHTML = opts;
    const topts = tensioners.map(function(t){ return '<option value="'+esc(t.code)+'">'+esc(t.code)+(t.model?'（已领给 '+esc(t.model)+'）':'（空闲）')+'</option>'; }).join('');
    document.querySelector('#assignTensioner').innerHTML = topts;
    document.querySelector('#ropeTensioner').innerHTML = topts;
    document.querySelector('#tList').innerHTML = tensioners.length
      ? tensioners.map(function(t){ return '<span class="pill '+(t.model?'held':'')+'">'+esc(t.code)+'：'+(t.model?('→ '+esc(t.model)):'空闲')+'</span>'; }).join(' ')
      : '<span class="meta">尚未登记张紧器</span>';
  }

  function render() {
    renderSelects();
    const stats = Object.fromEntries(stages.map(function(s){ return [s,0]; }));
    items.forEach(function(i){ if (stats[i.status] !== undefined) stats[i.status]++; });
    document.querySelector('#stats').innerHTML = Object.entries(stats).map(function(kv){
      return '<div class="stat"><span>'+kv[0]+'</span><strong>'+kv[1]+'</strong></div>';
    }).join('');
    const status = document.querySelector('#statusFilter').value;
    const q = document.querySelector('#search').value.trim();
    const visible = items.filter(function(i){
      return (!status || i.status === status) && (!q || JSON.stringify(i).includes(q));
    });
    document.querySelector('#cards').innerHTML = visible.map(cardHtml).join('');
  }

  async function load() {
    [items, tensioners] = await Promise.all([api('/api/items'), api('/api/tensioners')]);
    render();
  }

  async function postForm(form, path) {
    const data = Object.fromEntries(new FormData(form).entries());
    try { await api(path, { method:'POST', body: JSON.stringify(data) }); form.reset(); await load(); }
    catch (e) { alert(e.message); }
  }

  document.querySelector('#createForm').onsubmit = function(e){
    e.preventDefault(); postForm(e.target, '/api/items');
  };
  document.querySelector('#tensionerForm').onsubmit = function(e){
    e.preventDefault(); postForm(e.target, '/api/tensioners');
  };
  document.querySelector('#assignForm').onsubmit = function(e){
    e.preventDefault();
    const id = document.querySelector('#assignItem').value;
    postForm(e.target, '/api/items/'+id+'/tensioners');
  };
  document.querySelector('#ropeForm').onsubmit = function(e){
    e.preventDefault();
    const id = document.querySelector('#ropeItem').value;
    postForm(e.target, '/api/items/'+id+'/tasks');
  };
  document.querySelector('#cards').addEventListener('click', async function(e){
    const btn = e.target.closest('form button');
    if (!btn) return;
    const form = btn.closest('form');
    const act = form.dataset.act;
    if (act !== 'reading' && act !== 'review') return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const base = '/api/items/'+form.dataset.item+'/tasks/'+form.dataset.task;
    const path = act === 'reading'
      ? base+'/readings/'+form.dataset.layer
      : base+'/reviews/'+form.dataset.layer;
    try { await api(path, { method:'POST', body: JSON.stringify(data) }); await load(); }
    catch (err) { alert(err.message); }
  });
  document.querySelector('#cards').addEventListener('change', async function(e){
    const sel = e.target.closest('.statusselect');
    if (!sel) return;
    try { await api('/api/items/'+sel.dataset.item, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); }
    catch (err) { alert(err.message); await load(); }
  });
  document.querySelector('#statusFilter').onchange = render;
  document.querySelector('#search').oninput = render;
  document.querySelector('#reload').onclick = load;

  renderForms(); load();
  `;
}

export function page() {
  const stages = ["待检查", "校准中", "待复核", "已交付"];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索分段张紧</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 10px; font-size:16px; } h3 { margin:0; font-size:18px; }
    main { display:grid; grid-template-columns:360px 1fr; gap:18px; padding:18px 24px; align-items:start; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
    .leftcol { display:grid; gap:12px; position:sticky; top:12px; max-height:calc(100vh - 24px); overflow:auto; }
    label { display:block; margin:8px 0 4px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; width:100%; margin-top:10px; }
    button.small { width:auto; padding:6px 10px; font-size:13px; } .warnbtn { background:var(--warn); }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:12px; }
    .stat strong { display:block; font-size:22px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; } .toolbar select,.toolbar input { width:auto; min-width:150px; }
    .cards { display:grid; gap:12px; } .card { display:grid; gap:8px; } .card.alert { border-color:var(--warn); border-width:2px; }
    .cardhead { display:flex; justify-content:space-between; align-items:center; gap:10px; }
    .cardhead select { width:auto; }
    .metas { display:flex; flex-wrap:wrap; gap:6px 14px; }
    .meta { color:var(--muted); font-size:12.5px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:12px; }
    .pill.held { border-color:var(--warn); color:var(--warn); }
    .stage-note { background:#eef3ea; border-radius:6px; padding:7px 10px; font-size:13px; }
    table.ropes { width:100%; border-collapse:collapse; } table.ropes th { text-align:left; font-size:12px; color:var(--muted); padding:4px 6px; border-bottom:1px solid var(--line); }
    table.ropes td { vertical-align:top; padding:8px 6px; border-bottom:1px solid var(--line); }
    tr.blocked { background:#f7ece9; } tr.legacy { opacity:.7; }
    .cell { width:25%; } .layer-tag { font-weight:700; font-size:12px; color:var(--accent); margin-bottom:4px; }
    .rd { display:grid; gap:2px; } .rd.ok b { color:var(--accent); } .rd.bad b { color:var(--warn); }
    .rd.lock { color:#9aa398; }
    .rdform input { margin-bottom:5px; }
    .reviewbox { display:grid; gap:6px; border-left:3px solid var(--warn); padding-left:10px; }
    .reviewbox form { padding:0; border:0; display:grid; gap:6px; grid-template-columns:1fr 1.2fr 1fr auto; align-items:center; }
    .reviewbox form input,.reviewbox form select { margin:0; }
    .warn { color:var(--warn); font-weight:700; font-size:13px; }
    .logs { border-top:1px solid var(--line); padding-top:6px; font-size:12.5px; max-height:120px; overflow:auto; } .logs summary { cursor:pointer; color:var(--muted); }
    @media (max-width:980px){ header{display:block;padding:16px;} main{grid-template-columns:1fr;padding:14px;} .leftcol{position:static;max-height:none;} .reviewbox form{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古船模型帆索分段张紧</h1>
    <div class="meta">每根索登记目标张力与张紧器，按三成 / 六成 / 满张力分段记录读数；三层都记完才进下一层，偏离目标 5% 停下换人复核。</div></div>
    <button id="reload" style="width:auto">刷新</button>
  </header>
  <main>
    <div class="leftcol">
      <form id="createForm"><h2>① 新增模型</h2><div id="fields"></div>
        <label>初始状态</label><select name="status">${stages.map((s) => "<option>" + s + "</option>").join("")}</select>
        <button>保存模型</button>
        <div class="meta" style="margin-top:6px">桅杆数量或帆索材料日后修改，旧张紧结果自动失效。</div>
      </form>
      <form id="tensionerForm"><h2>② 登记张紧器</h2>
        <label>张紧器编号</label><input name="code" required placeholder="如 JIN-07">
        <label>备注</label><input name="note" placeholder="量程/型号（可选）">
        <button>登记</button>
      </form>
      <form id="assignForm"><h2>③ 把张紧器领给模型</h2>
        <label>模型</label><select id="assignItem" name="code2"></select>
        <label>张紧器</label><select id="assignTensioner" name="code"></select>
        <button>领用</button>
        <div class="meta" style="margin-top:6px">领给模型后，整套张紧结束前不能再给别的模型。</div>
        <div id="tList" style="margin-top:8px"></div>
      </form>
      <form id="ropeForm"><h2>④ 登记帆索（目标张力 + 张紧器）</h2>
        <label>模型</label><select id="ropeItem"></select>
        <label>索具位置</label><input name="position" required placeholder="如 前桅侧支索">
        <label>目标张力（满张力读数）</label><input name="targetTension" type="number" step="0.01" min="0" required>
        <label>使用张紧器（须已领给本模型）</label><select name="tensioner" id="ropeTensioner"></select>
        <button>登记帆索</button>
      </form>
    </div>
    <div>
      <div class="stats" id="stats"></div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部状态</option>${stages.map((s) => "<option>" + s + "</option>").join("")}</select>
        <input id="search" placeholder="搜索编号或关键词">
      </div>
      <div class="cards" id="cards"></div>
    </div>
  </main>
  <script>${clientScript()}</script>
</body>
</html>`;
}
