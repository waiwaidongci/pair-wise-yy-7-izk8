// 端到端验证：起服务，按真实业务流程打 API。数据写在临时目录，不动正式数据。
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = "http://localhost:3099";
const dataDir = mkdtempSync(join(tmpdir(), "tension-e2e-"));
let failed = 0;
function check(name, cond, extra = "") {
  console.log((cond ? "PASS" : "FAIL") + " - " + name + (extra ? " :: " + extra : ""));
  if (!cond) failed++;
}
async function call(method, path, payload) {
  const res = await fetch(base + path, {
    method,
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

const srv = spawn("node", ["server.js"], {
  env: { ...process.env, PORT: "3099", DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"]
});
srv.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
srv.stderr.on("data", (d) => process.stderr.write("[err] " + d));
await sleep(600);

try {
  // 建档两个模型
  let r = await call("POST", "/api/items", { code: "E2E-1", shipType: "福船", mastCount: 3, riggingMaterial: "蜡线", status: "待检查" });
  check("建档 E2E-1", r.status === 201);
  r = await call("POST", "/api/items", { code: "E2E-2", shipType: "广船", mastCount: 2, riggingMaterial: "棉线" });
  check("建档 E2E-2", r.status === 201);
  r = await call("POST", "/api/items", { code: "E2E-1", shipType: "重复" });
  check("编号重复被拒", r.status === 409);

  // 登记两根索：目标 100N，三成 30 / 六成 60 / 满 100
  r = await call("POST", "/api/items/E2E-1/ropes", { position: "前桅侧支索", targetTension: 100, tensioner: "TJ-07" });
  check("登记索A", r.status === 201 && r.json.targetTension === undefined && r.json.ropeCount === 1);
  r = await call("POST", "/api/items/E2E-1/ropes", { position: "后桅侧支索", targetTension: 100, tensioner: "TJ-08" });
  check("登记索B", r.status === 201);

  // 张紧器被别的模型领用时拒绝
  r = await call("POST", "/api/items/E2E-2/ropes", { position: "主桅升帆索", targetTension: 50, tensioner: "TJ-07" });
  check("张紧器占用拒绝（409）", r.status === 409, r.json.message);

  // 未记三成直接不能记六成——通过分层规则间接验证；先试缺字段
  r = await call("POST", "/api/items/E2E-1/ropes", { position: "x", targetTension: 0, tensioner: "TJ-09" });
  check("目标张力非正数拒绝", r.status === 400);

  // 同一模型可再领一台空闲张紧器（后加的索，整体退回该索的三成，分层门控会拦住）
  r = await call("POST", "/api/items/E2E-1/ropes", { position: "尾桅稳索", targetTension: 100, tensioner: "TJ-09" });
  check("登记后加索C（同一模型可用别的张紧器）", r.status === 201);

  // A 记三成 30N，合格
  const ropes = () => call("GET", "/api/items").then(x => x.json.find(i => i.code === "E2E-1").ropes);
  let all = await ropes();
  const idA = all.find(x => x.position === "前桅侧支索").id;
  const idB = all.find(x => x.position === "后桅侧支索").id;
  const idC = all.find(x => x.position === "尾桅稳索").id;

  r = await call("POST", `/api/items/E2E-1/ropes/${idA}/readings`, { reading: 30, master: "张师傅" });
  check("A 三成 30N 合格", r.status === 201 && r.json.rope.stageIndex === 0);

  // B 还没记三成，A 不能进六成（三层都记完才进入下一层 = 本层全到齐）
  r = await call("POST", `/api/items/E2E-1/ropes/${idA}/readings`, { reading: 60, master: "张师傅" });
  check("同层未齐，A 被拦在六成外", r.status === 422, r.json.message);

  // C 是后加的索，三层门控：B/C 没记三成，不影响 A 但 A 不能越级（上面已验证）
  // B 记三成 30.9N（偏差 3%，合格）
  r = await call("POST", `/api/items/E2E-1/ropes/${idB}/readings`, { reading: 30.9, master: "李师傅" });
  check("B 三成偏差 3% 合格", r.status === 201);

  // C 没记三成，A 仍不能进六成
  r = await call("POST", `/api/items/E2E-1/ropes/${idA}/readings`, { reading: 60, master: "张师傅" });
  check("C 未记三成，仍拦六成", r.status === 422);

  // C 记三成，偏差 10% -> 停机
  r = await call("POST", `/api/items/E2E-1/ropes/${idC}/readings`, { reading: 33, master: "王师傅" });
  check("C 三成偏差 10% 停机", r.status === 422 && r.json.rope.locked === true, r.json.message);

  // 停机后本层没全齐，且存在停机索，任何人都不能进六层
  r = await call("POST", `/api/items/E2E-1/ropes/${idA}/readings`, { reading: 60, master: "张师傅" });
  check("有停机索时六层禁止", r.status === 422);

  // 读数人自己复核 -> 拒绝（必须换师傅）
  r = await call("POST", `/api/items/E2E-1/ropes/${idC}/review`, { reviewer: "王师傅", note: "我觉得没问题" });
  check("读数人自复核拒绝", r.status === 422, r.json.message);

  // 换师傅复核放行
  r = await call("POST", `/api/items/E2E-1/ropes/${idC}/review`, { reviewer: "赵师傅", note: "重收半圈，复测" });
  check("换师傅复核放行", r.status === 201 && r.json.rope.locked === false);

  // C 重记三成，这次合格（停机读数不入正式读数）
  r = await call("POST", `/api/items/E2E-1/ropes/${idC}/readings`, { reading: 30.5, master: "王师傅" });
  check("C 复核后重记三成合格", r.status === 201 && r.json.rope.stageIndex === 0);

  // 三成全齐 -> 六层。边界：偏差正好 5% 合格（>5% 才停）
  r = await call("POST", `/api/items/E2E-1/ropes/${idA}/readings`, { reading: 63, master: "张师傅" });
  check("A 六层 63N（偏差正好5%）合格", r.status === 201);
  r = await call("POST", `/api/items/E2E-1/ropes/${idB}/readings`, { reading: 58, master: "李师傅" });
  check("B 六层 58N（偏差3.3%）合格", r.status === 201);
  r = await call("POST", `/api/items/E2E-1/ropes/${idC}/readings`, { reading: 61, master: "王师傅" });
  check("C 六层 61N 合格", r.status === 201);

  // 六层未全满前不能记满张力
  // （此时三根都记完六层，直接进满层；先验 A 满 101N）
  r = await call("POST", `/api/items/E2E-1/ropes/${idA}/readings`, { reading: 101, master: "张师傅" });
  check("A 满张力 101N（偏差1%）合格", r.status === 201 && r.json.completed === true && r.json.setCompleted === false);

  // A 想再记第四层
  r = await call("POST", `/api/items/E2E-1/ropes/${idA}/readings`, { reading: 100, master: "张师傅" });
  check("三层记完拒绝再记", r.status === 422);

  r = await call("POST", `/api/items/E2E-1/ropes/${idB}/readings`, { reading: 99, master: "李师傅" });
  check("B 满张力合格", r.status === 201);
  r = await call("POST", `/api/items/E2E-1/ropes/${idC}/readings`, { reading: 100, master: "王师傅" });
  check("C 满张力合格且整套完成", r.status === 201 && r.json.setCompleted === true);

  // 整套完成：模型自动待复核，张紧器归还，别的模型可领用
  let items = (await call("GET", "/api/items")).json;
  const done = items.find(i => i.code === "E2E-1");
  check("整套完成模型转待复核", done.status === "待复核");
  check("张紧器全部归还", done.heldTensioners.length === 0, JSON.stringify(done.heldTensioners));
  r = await call("POST", "/api/items/E2E-2/ropes", { position: "主桅升帆索", targetTension: 50, tensioner: "TJ-07" });
  check("归还后张紧器可给别的模型", r.status === 201);

  // 桅杆数量变更：旧结果失效，读数清空、退回三成，台账留 voided 证据；张紧器 E2E-2 的不受影响
  r = await call("PATCH", "/api/items/E2E-1", { mastCount: 4 });
  check("桅杆数变更 200", r.status === 200);
  all = await ropes();
  check("全部索退回三成（stageIndex=-1）", all.every(x => x.stageIndex === -1));
  check("旧读数已归档清空", all.every(x => x.readings.length === 0));
  check("模型回到校准中", (await call("GET", "/api/items")).json.find(i => i.code === "E2E-1").status === "校准中");
  // 重拉时可以再次记三成
  r = await call("POST", `/api/items/E2E-1/ropes/${idA}/readings`, { reading: 30, master: "张师傅" });
  check("失效后可从三成重拉", r.status === 201);

  // 材料变更也失效
  r = await call("PATCH", "/api/items/E2E-1", { riggingMaterial: "尼龙线" });
  check("材料变更 200", r.status === 200);
  all = await ropes();
  check("材料变更同样作废", all.every(x => x.stageIndex === -1));
  const voidCount = all.find(x => x.id === idA).voided;
  check("作废次数累计", voidCount === 2, "voided=" + voidCount);

  // 台账只追加：事件类型齐全
  const ledger = (await call("GET", "/api/tension-ledger")).json;
  const types = [...new Set(ledger.entries.map(e => e.type))];
  for (const t of ["model_created","rope_registered","tensioner_issue","stage_recorded","reading_deviation","review_passed","set_completed","config_invalidated","status_changed"])
    check("台账含事件 " + t, types.includes(t));
  const inv = ledger.entries.filter(e => e.type === "config_invalidated");
  check("失效事件保存作废读数明细", inv.length === 2 && inv[0].voidedCount === 9 && inv[1].voidedCount === 1,
    "voided=" + inv.map(e => e.voidedCount).join(","));

  // 页面能打开
  const pageRes = await fetch(base + "/");
  const html = await pageRes.text();
  check("页面 200 且含分段张紧文案", pageRes.status === 200 && html.includes("三成") && html.includes("满张力"));
} catch (e) {
  console.error(e);
  failed++;
} finally {
  srv.kill();
  rmSync(dataDir, { recursive: true, force: true });
  console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
