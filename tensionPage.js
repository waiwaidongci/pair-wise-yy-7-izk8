// 页面处：分段张紧的界面。不含业务规则，规则以服务端返回为准。
const stages = ["待检查", "校准中", "待复核", "已交付"];

export function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索分段张紧</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --ok:#3f6d4e; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:16px; } main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    form+form { margin-top:14px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:12px; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .warn { color:var(--warn); font-weight:700; } .ok { color:var(--ok); font-weight:700; }
    .rope { border-top:1px dashed var(--line); padding-top:8px; display:grid; gap:4px; }
    .steps { display:flex; gap:6px; flex-wrap:wrap; }
    .step { border:1px solid var(--line); border-radius:6px; padding:2px 8px; font-size:12px; color:var(--muted); }
    .step.done { border-color:var(--ok); color:var(--ok); } .step.locked { border-color:var(--warn); color:var(--warn); font-weight:700; }
    .step.cur { border-style:dashed; color:var(--ink); }
    .ledger { margin:0 28px 28px; } .ledger .row { display:grid; grid-template-columns:160px 110px 1fr; gap:10px; padding:8px 4px; border-bottom:1px solid var(--line); font-size:13px; }
    .ledger .head { font-weight:700; color:var(--muted); }
    .tag { font-size:12px; border-radius:4px; padding:1px 6px; background:#eef2ea; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .ledger{margin:0 16px 16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古船模型帆索分段张紧</h1><div class="meta">每根索登记目标张力与张紧器，按三成 → 六成 → 满张力逐层记录；偏差超 5% 停机，换师傅复核</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section>
      <form id="createForm">
        <h2>① 新增模型</h2>
        <div id="fields"></div>
        <label>初始状态</label><select name="status">${stages.map(s => "<option>" + s + "</option>").join("")}</select>
        <button>保存模型</button>
      </form>

      <form id="ropeForm">
        <h2>② 登记帆索（目标张力 + 张紧器）</h2>
        <label>选择模型</label><select name="modelCode" id="ropeModel"></select>
        <label>索具位置</label><input name="position" required placeholder="如：前桅侧支索">
        <label>目标张力（N，满张力值）</label><input name="targetTension" type="number" step="0.1" min="0" required>
        <label>张紧器编号</label><input name="tensioner" required placeholder="如：TJ-07（领给本模型后整套结束前不能再给别的模型）">
        <button>登记帆索</button>
      </form>

      <form id="readForm">
        <h2>③ 记一层读数</h2>
        <label>选择模型</label><select id="readModel"></select>
        <label>选择帆索</label><select name="ropeId" id="readRope"></select>
        <div class="meta" id="readHint">本层目标：—</div>
        <label>读数（N）</label><input name="reading" type="number" step="0.1" min="0" required>
        <label>读数师傅</label><input name="master" required placeholder="谁拉的、谁读的">
        <button>提交本层读数</button>
        <div class="meta">三层按顺序记：三成 → 六成 → 满张力；同层所有索记完才进入下一层。读数偏离本层目标 ±5% 自动停机。</div>
      </form>

      <form id="reviewForm">
        <h2>④ 偏差停机 · 换师傅复核</h2>
        <label>选择模型</label><select id="reviewModel"></select>
        <label>停机帆索</label><select name="ropeId" id="reviewRope"></select>
        <label>复核师傅（必须与读数人不同）</label><input name="reviewer" required>
        <label>复核意见 / 处置</label><input name="note" placeholder="如：重新收紧半圈后复测合格">
        <button class="secondary">复核放行</button>
      </form>

      <form id="changeForm">
        <h2>⑤ 桅杆数量 / 帆索材料变更</h2>
        <label>选择模型</label><select id="changeModel"></select>
        <label>新桅杆数量（不改可留空）</label><input name="mastCount" type="number" min="1">
        <label>新帆索材料（不改可留空）</label><input name="riggingMaterial" placeholder="如：尼龙线">
        <button class="secondary">提交变更</button>
        <div class="meta warn">变更后旧张紧结果立即失效，所有索从三成重新张紧；张紧器仍由本模型占用。</div>
      </form>
    </section>

    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar">
        <select id="statusFilter"><option value="">全部状态</option>${stages.map(s => "<option>" + s + "</option>").join("")}</select>
        <input id="search" placeholder="搜索编号、船型、索位或张紧器">
      </div>
      <div class="panel">
        <h2>模型张紧进度</h2>
        <div class="grid" id="cards"></div>
      </div>
    </section>
  </main>

  <section class="panel ledger">
    <h2>张紧台账（只追加，不涂改）</h2>
    <div class="toolbar"><select id="logFilter"><option value="">全部模型</option></select></div>
    <div class="row head"><div>时间</div><div>模型</div><div>事件</div></div>
    <div id="ledgerRows"></div>
  </section>

  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const STAGE_DEFS = [["三成",0.3],["六成",0.6],["满张力",1]];
    const TYPE_LABELS = {
      model_created:"建档", rope_registered:"登记帆索", tensioner_issue:"张紧器领用",
      stage_recorded:"分段读数", reading_deviation:"偏差停机", review_passed:"复核放行",
      set_completed:"整套完成", config_invalidated:"结果失效", status_changed:"状态变更"
    };
    let items = [], entries = [], tensioners = [];

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? Object.assign({}, options, { headers:{ "Content-Type":"application/json" } }) : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "请求失败");
      return data;
    }
    function esc(v) {
      return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
    }
    const findItem = code => items.find(i => (i.id || i.code) === code);
    const itemOptions = () => items.map(i => "<option value=\""+esc(i.id||i.code)+"\">"+esc(i.code)+" · "+esc(i.shipType)+"</option>").join("");

    function renderFields() {
      document.querySelector("#fields").innerHTML = fields.map(([key,label,type]) =>
        "<label>"+label+"</label><input name=\""+key+"\" type=\""+type+"\" "+(key==="code"?"required":"")+">").join("");
    }

    function syncSelects() {
      ["ropeModel","readModel","reviewModel","changeModel"].forEach(id => {
        const el = document.querySelector("#"+id);
        const keep = el.value;
        el.innerHTML = itemOptions();
        if ([...el.options].some(o => o.value === keep)) el.value = keep;
      });
      const lf = document.querySelector("#logFilter");
      const keepLog = lf.value;
      lf.innerHTML = "<option value=\"\">全部模型</option>" + itemOptions();
      if (keepLog) lf.value = keepLog;
      syncRopeSelects();
    }

    function syncRopeSelects() {
      const readModel = findItem(document.querySelector("#readModel").value);
      const readRope = document.querySelector("#readRope");
      const readKeep = readRope.value;
      const readRopes = readModel ? (readModel.ropes||[]).filter(r => r.status !== "已失效" && r.stageIndex < 2 && !r.locked) : [];
      readRope.innerHTML = readRopes.map(r => "<option value=\""+esc(r.id)+"\">"+esc(r.position)+" · "+nextLabel(r)+"</option>").join("");
      if ([...readRope.options].some(o => o.value === readKeep)) readRope.value = readKeep;
      updateReadHint();

      const reviewModel = findItem(document.querySelector("#reviewModel").value);
      const reviewRope = document.querySelector("#reviewRope");
      const reviewKeep = reviewRope.value;
      const locked = reviewModel ? (reviewModel.ropes||[]).filter(r => r.locked) : [];
      reviewRope.innerHTML = locked.length
        ? locked.map(r => "<option value=\""+esc(r.id)+"\">"+esc(r.position)+" · "+esc(r.lock.stage)+" 读数 "+esc(r.lock.value)+"N 偏差 "+(r.lock.deviation*100).toFixed(1)+"%</option>").join("")
        : "<option value=\"\">（无停机索）</option>";
      if (reviewKeep && [...reviewRope.options].some(o => o.value === reviewKeep)) reviewRope.value = reviewKeep;
    }

    function nextLabel(rope) {
      const idx = rope.stageIndex + 1;
      return idx < STAGE_DEFS.length ? STAGE_DEFS[idx][0] : "完成";
    }
    function updateReadHint() {
      const model = findItem(document.querySelector("#readModel").value);
      const rope = model && (model.ropes||[]).find(r => r.id === document.querySelector("#readRope").value);
      const hint = document.querySelector("#readHint");
      if (!rope || rope.stageIndex >= 2) { hint.textContent = "本层目标：—"; return; }
      const [label, ratio] = STAGE_DEFS[rope.stageIndex + 1];
      const expected = Math.round(rope.targetTension * ratio * 100) / 100;
      hint.textContent = "本层：" + label + " · 目标读数 " + expected + " N（允许 ±5%）· 张紧器 " + rope.tensioner;
    }

    function stepsHtml(rope) {
      return "<div class=\"steps\">" + STAGE_DEFS.map(([label], i) => {
        let cls = "step";
        let text = label;
        if (rope.locked && rope.lock && rope.lock.stage === label) { cls += " locked"; text += " 停机"; }
        else if (i <= rope.stageIndex) {
          cls += " done";
          const r = rope.readings.find(x => x.stage === label);
          text += " ✓ " + (r ? r.value + "N/" + r.master : "");
        } else if (i === rope.stageIndex + 1) { cls += " cur"; text += " 待记"; }
        return "<span class=\""+cls+"\">"+esc(text)+"</span>";
      }).join("") + "</div>";
    }

    function ropeHtml(rope) {
      const lockLine = rope.locked
        ? "<div class=\"warn\">停机："+esc(rope.lock.stage)+" 读数 "+esc(rope.lock.value)+"N，目标 "+esc(Math.round(rope.lock.expected*100)/100)+"N，偏差 "+(rope.lock.deviation*100).toFixed(1)+"%；读数人 "+esc(rope.lock.master)+"，须另一名师傅复核</div>"
        : (rope.stageIndex >= 2 ? "<div class=\"ok\">三层读数已记完</div>" : "");
      const voidLine = rope.voided ? "<div class=\"meta warn\">已作废重拉 "+rope.voided+" 次（桅杆数或材料变更）</div>" : "";
      return "<div class=\"rope\"><div><b>"+esc(rope.position)+"</b> <span class=\"pill\">"+esc(rope.status)+"</span></div>"+
        "<div class=\"meta\">目标 "+esc(rope.targetTension)+"N · 张紧器 "+esc(rope.tensioner)+"</div>"+stepsHtml(rope)+lockLine+voidLine+"</div>";
    }

    function cardHtml(item) {
      const main = fields.slice(0,5).map(([key,label]) => "<div class=\"meta\">"+label+"："+esc(item[key] ?? "")+"</div>").join("");
      const ropes = (item.ropes||[]).length
        ? (item.ropes||[]).map(ropeHtml).join("")
        : "<div class=\"meta\">尚未登记帆索</div>";
      const held = (item.heldTensioners||[]).length ? "<div class=\"meta\">在用张紧器："+esc(item.heldTensioners.join("、"))+"</div>" : "";
      return "<article class=\"card\"><h3>"+esc(item.code)+"</h3><span class=\"pill\">"+esc(item.status)+"</span>"+main+held+
        "<label>模型状态</label><select data-status=\""+esc(item.id||item.code)+"\">"+
        stages.map(s => "<option "+(s===item.status?"selected":"")+">"+s+"</option>").join("")+"</select>"+ropes+"</article>";
    }

    function entryDetail(e) {
      switch (e.type) {
        case "model_created": return "建档 " + esc(e.shipType || "");
        case "rope_registered": return "登记「"+esc(e.position)+"」目标 "+esc(e.targetTension)+"N，张紧器 "+esc(e.tensioner);
        case "tensioner_issue": return "张紧器 "+esc(e.tensioner)+" 领给本模型，整套结束前不另发";
        case "stage_recorded": return esc(e.position)+" · "+esc(e.stage)+" 读数 "+esc(e.value)+"N，目标 "+esc(Math.round(e.expected*100)/100)+"N，偏差 "+(e.deviation*100).toFixed(1)+"%，师傅 "+esc(e.master);
        case "reading_deviation": return "<span class=\"warn\">停机：</span>"+esc(e.position)+" · "+esc(e.stage)+" 读数 "+esc(e.value)+"N，目标 "+esc(Math.round(e.expected*100)/100)+"N，偏差 "+(e.deviation*100).toFixed(1)+"%（超 ±5%），读数人 "+esc(e.master)+"，等待另一名师傅复核";
        case "review_passed": return "复核放行「"+esc(e.position)+"」，复核师傅 "+esc(e.reviewer)+"（读数人 "+esc(e.originalMaster)+"）"+(e.note ? "："+esc(e.note) : "");
        case "set_completed": return "<span class=\"ok\">整套张紧三层全部记完</span>，张紧器 "+esc((e.released||[]).join("、"))+" 已归还";
        case "config_invalidated": {
          const cs = [];
          if (e.changes && e.changes.mastCount) cs.push("桅杆数量 "+esc(e.changes.mastCount.from)+" → "+esc(e.changes.mastCount.to));
          if (e.changes && e.changes.riggingMaterial) cs.push("帆索材料 "+esc(e.changes.riggingMaterial.from)+" → "+esc(e.changes.riggingMaterial.to));
          return "<span class=\"warn\">旧张紧结果作废</span>（"+cs.join("；")+"），作废读数 "+esc(e.voidedCount)+" 条，全部索从三成重拉";
        }
        case "status_changed": return "状态 "+esc(e.from)+" → "+esc(e.to);
        default: return esc(e.type);
      }
    }

    function render() {
      document.querySelector("#stats").innerHTML = stages.map(s =>
        "<div class=\"stat\"><span>"+s+"</span><strong>"+items.filter(i => i.status === s).length+"</strong></div>").join("");
      const status = document.querySelector("#statusFilter").value;
      const q = document.querySelector("#search").value.trim();
      const visible = items.filter(item =>
        (!status || item.status === status) &&
        (!q || JSON.stringify(item).includes(q)));
      document.querySelector("#cards").innerHTML = visible.map(cardHtml).join("");

      document.querySelectorAll("[data-status]").forEach(sel => sel.onchange = async () => {
        try { await api("/api/items/"+sel.dataset.status, { method:"PATCH", body: JSON.stringify({ status: sel.value }) }); await load(); }
        catch (err) { alert(err.message); await load(); }
      });

      const code = document.querySelector("#logFilter").value;
      const rows = entries.filter(e => !code || e.modelCode === code).slice().reverse();
      document.querySelector("#ledgerRows").innerHTML = rows.map(e =>
        "<div class=\"row\"><div class=\"meta\">"+esc(e.at.replace("T"," ").slice(0,19))+"</div>"+
        "<div><span class=\"tag\">"+esc(e.modelCode)+"</span></div><div><span class=\"tag\">"+esc(TYPE_LABELS[e.type]||e.type)+"</span> "+entryDetail(e)+"</div></div>"
      ).join("") || "<div class=\"meta\" style=\"padding:10px 4px\">暂无台账记录</div>";
    }

    async function load() {
      [items, ledger] = await Promise.all([api("/api/items"), api("/api/tension-ledger")]);
      entries = ledger.entries; tensioners = ledger.tensioners;
      syncSelects(); render();
    }

    function bindForm(id, url, form, after) {
      document.querySelector("#"+id).onsubmit = async event => {
        event.preventDefault();
        try {
          await api(url, { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
          form.reset(); await load();
        } catch (err) { alert(err.message); }
      };
    }

    document.querySelector("#createForm").onsubmit = async event => {
      event.preventDefault();
      const form = event.target;
      try {
        await api("/api/items", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); await load();
      } catch (err) { alert(err.message); }
    };
    bindForm("ropeForm", () => "/api/items/"+document.querySelector("#ropeModel").value+"/ropes", document.querySelector("#ropeForm"));
    document.querySelector("#readForm").onsubmit = async event => {
      event.preventDefault();
      const form = event.target;
      try {
        await api("/api/items/"+document.querySelector("#readModel").value+"/ropes/"+form.ropeId.value+"/readings",
          { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reading.value = ""; await load();
      } catch (err) { alert(err.message); }
    };
    document.querySelector("#reviewForm").onsubmit = async event => {
      event.preventDefault();
      const form = event.target;
      try {
        await api("/api/items/"+document.querySelector("#reviewModel").value+"/ropes/"+form.ropeId.value+"/review",
          { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); await load();
      } catch (err) { alert(err.message); }
    };
    document.querySelector("#changeForm").onsubmit = async event => {
      event.preventDefault();
      const form = event.target;
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.mastCount && !data.riggingMaterial) { alert("至少填一项变更"); return; }
      if (!confirm("桅杆数量或帆索材料变更会作废全部旧张紧结果，确定提交？")) return;
      try {
        await api("/api/items/"+document.querySelector("#changeModel").value,
          { method:"PATCH", body: JSON.stringify(data) });
        form.reset(); await load();
      } catch (err) { alert(err.message); }
    };

    ["readModel","readRope"].forEach(id => document.querySelector("#"+id).onchange = id === "readModel" ? syncRopeSelects : updateReadHint);
    ["reviewModel"].forEach(id => document.querySelector("#reviewModel").onchange = syncRopeSelects);
    document.querySelector("#statusFilter").onchange = render;
    document.querySelector("#search").oninput = render;
    document.querySelector("#logFilter").onchange = render;
    document.querySelector("#reload").onclick = load;

    renderFields(); load();
  </script>
</body>
</html>`;
}
