import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STAGES,
  TaskError,
  keyOf,
  registerRope,
  recordStage,
  reviewRope,
  setCompleted,
  heldTensioners,
  applyConfigChange
} from "./tensionTasks.js";
import { loadLedger, saveLedger, append, currentHolds } from "./tensionRecords.js";
import { page } from "./tensionPage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ? join(process.env.DATA_DIR) : join(__dirname, "data");
const dbPath = join(dataDir, "model-rigging-calibration.json");
const ledgerPath = join(dataDir, "tension-ledger.json");
const port = Number(process.env.PORT || 3038);

const seed = {
  "items": [
    {
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-06-28",
      "status": "校准中",
      "tasks": [],
      "ropes": [],
      "logs": []
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "MR-" + Date.now(); }
function findItem(db, code) {
  return db.items.find(x => x.id === code || x.code === code);
}
function summarize(item, holds) {
  const ropes = item.ropes || [];
  return {
    ...item,
    ropeCount: ropes.length,
    lockedCount: ropes.filter(r => r.locked).length,
    doneCount: ropes.filter(r => r.stageIndex === STAGES.length - 1).length,
    heldTensioners: heldTensioners(item, holds)
  };
}

async function loadState() {
  const [db, ledger] = await Promise.all([loadDb(), loadLedger(ledgerPath)]);
  return { db, ledger, holds: currentHolds(ledger) };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { db, ledger, holds } = await loadState();
    const persist = async () => { await Promise.all([saveDb(db), saveLedger(ledgerPath, ledger)]); };

    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    if (req.method === "GET" && url.pathname === "/api/items")
      return send(res, 200, db.items.map(item => summarize(item, holds)));

    if (req.method === "GET" && url.pathname === "/api/tension-ledger")
      return send(res, 200, { entries: ledger.entries, tensioners: [...holds.entries()].map(([tensioner, h]) => ({ tensioner, ...h })) });

    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      if (!input.code) throw new TaskError("code_required", "模型编号必填");
      if (findItem(db, input.code)) throw new TaskError("code_duplicate", "模型编号已存在", 409);
      if (input.mastCount !== undefined && !(Number(input.mastCount) > 0))
        throw new TaskError("mast_required", "桅杆数量必须是正数");
      const item = {
        id: newId(),
        code: input.code,
        shipType: input.shipType || "",
        scale: input.scale || "",
        mastCount: Number(input.mastCount) || null,
        riggingMaterial: input.riggingMaterial || "",
        owner: input.owner || "",
        dueDate: input.dueDate || "",
        status: input.status || "待检查",
        tasks: [],
        ropes: [],
        logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }]
      };
      db.items.unshift(item);
      append(ledger, "model_created", { modelCode: item.code, shipType: item.shipType });
      await persist();
      return send(res, 201, summarize(item, holds));
    }

    // 登记帆索：目标张力 + 张紧器；新领用写台账，占用到整套完成。
    const ropePost = url.pathname.match(/^\/api\/items\/([^/]+)\/ropes$/);
    if (ropePost && req.method === "POST") {
      const item = findItem(db, ropePost[1]);
      if (!item) return send(res, 404, { error: "item_not_found", message: "模型不存在" });
      const input = await body(req);
      const { rope, needIssue } = registerRope(item, input, holds);
      item.ropes ||= [];
      item.ropes.push(rope);
      if (item.status === "待检查") {
        const from = item.status;
        item.status = "校准中";
        append(ledger, "status_changed", { modelCode: keyOf(item), from, to: "校准中" });
      }
      append(ledger, "rope_registered", {
        modelCode: keyOf(item), ropeId: rope.id, position: rope.position,
        targetTension: rope.targetTension, tensioner: rope.tensioner
      });
      if (needIssue) {
        holds.set(rope.tensioner, { modelCode: keyOf(item), at: new Date().toISOString() });
        append(ledger, "tensioner_issue", { modelCode: keyOf(item), tensioner: rope.tensioner });
      }
      await persist();
      return send(res, 201, summarize(item, holds));
    }

    // 记一层读数：顺序与分层由任务处把关；偏差超 5% 停机并写台账。
    const readingPost = url.pathname.match(/^\/api\/items\/([^/]+)\/ropes\/([^/]+)\/readings$/);
    if (readingPost && req.method === "POST") {
      const item = findItem(db, readingPost[1]);
      if (!item) return send(res, 404, { error: "item_not_found", message: "模型不存在" });
      const rope = (item.ropes || []).find(r => r.id === readingPost[2]);
      if (!rope) return send(res, 404, { error: "rope_not_found", message: "帆索不存在" });

      const input = await body(req);
      const result = recordStage(item, rope, input);
      if (result.locked) {
        append(ledger, "reading_deviation", {
          modelCode: keyOf(item), ropeId: rope.id, position: rope.position, tensioner: rope.tensioner,
          stage: result.stage.key, expected: result.expected, value: result.value,
          deviation: result.deviation, master: result.master
        });
        await persist();
        return send(res, 422, { error: "reading_deviation", message: "读数偏离目标超过 5%，已停机；须换另一名师傅复核才能继续", rope });
      }

      append(ledger, "stage_recorded", {
        modelCode: keyOf(item), ropeId: rope.id, position: rope.position, tensioner: rope.tensioner,
        stage: result.stage, expected: result.expected, value: result.value,
        deviation: result.deviation, master: result.master
      });

      if (result.completed && setCompleted(item)) {
        const released = heldTensioners(item, holds);
        for (const tensioner of released) holds.delete(tensioner);
        const from = item.status;
        item.status = "待复核";
        append(ledger, "status_changed", { modelCode: keyOf(item), from, to: "待复核" });
        append(ledger, "set_completed", { modelCode: keyOf(item), released });
      }
      await persist();
      return send(res, 201, { rope, completed: result.completed, setCompleted: setCompleted(item) });
    }

    // 偏差复核：必须是另一名师傅，放行后可继续本层。
    const reviewPost = url.pathname.match(/^\/api\/items\/([^/]+)\/ropes\/([^/]+)\/review$/);
    if (reviewPost && req.method === "POST") {
      const item = findItem(db, reviewPost[1]);
      if (!item) return send(res, 404, { error: "item_not_found", message: "模型不存在" });
      const rope = (item.ropes || []).find(r => r.id === reviewPost[2]);
      if (!rope) return send(res, 404, { error: "rope_not_found", message: "帆索不存在" });
      const input = await body(req);
      const result = reviewRope(rope, input);
      append(ledger, "review_passed", {
        modelCode: keyOf(item), ropeId: rope.id, position: rope.position,
        reviewer: result.reviewer, note: result.note, originalMaster: result.lock.master,
        stage: result.lock.stage, value: result.lock.value, deviation: result.lock.deviation
      });
      await persist();
      return send(res, 201, { rope });
    }

    const itemPatch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (itemPatch && req.method === "PATCH") {
      const item = findItem(db, itemPatch[1]);
      if (!item) return send(res, 404, { error: "item_not_found", message: "模型不存在" });
      const input = await body(req);
      const allowed = ["shipType", "scale", "owner", "dueDate", "status", "mastCount", "riggingMaterial"];
      const patch = {};
      for (const key of allowed) if (input[key] !== undefined && input[key] !== "") patch[key] = input[key];

      // 桅杆数量或帆索材料变更：旧张紧结果立即失效。
      if (patch.mastCount !== undefined || patch.riggingMaterial !== undefined) {
        const invalidation = applyConfigChange(item, patch);
        if (invalidation.changed) {
          append(ledger, "config_invalidated", {
            modelCode: keyOf(item),
            changes: invalidation.changes,
            voidedCount: invalidation.voided.length,
            voided: invalidation.voided
          });
          if (item.status === "待复核" || item.status === "已交付") {
            const from = item.status;
            item.status = "校准中";
            append(ledger, "status_changed", { modelCode: keyOf(item), from, to: "校准中" });
          }
        }
      }
      const from = item.status;
      Object.assign(item, patch);
      if (patch.status && patch.status !== from) {
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "状态", note: from + " → " + item.status });
        append(ledger, "status_changed", { modelCode: keyOf(item), from, to: item.status });
      }
      await persist();
      return send(res, 200, summarize(item, holds));
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof TaskError) return send(res, error.status, { error: error.code, message: error.message });
    send(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log("古船模型帆索分段张紧 listening on http://localhost:" + port));
