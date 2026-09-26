import http from "node:http";
import { loadDb, saveDb, now, log, summarize, computeStats } from "./lib/records.js";
import {
  TaskError,
  findItem,
  registerTensioner,
  assignTensioner,
  registerRope,
  recordReading,
  reviewReading,
  applyModelChanges,
} from "./lib/tasks.js";
import { page } from "./lib/pages.js";

const port = Number(process.env.PORT || 3038);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function newId() {
  return "MR-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
}
function match(path, pattern) {
  return path.match(pattern);
}

const server = http.createServer(async (req, res) => {
  let db;
  try {
    db = await loadDb();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page());
    }

    if (req.method === "GET" && p === "/api/items") {
      return send(res, 200, db.items.map(summarize));
    }
    if (req.method === "GET" && p === "/api/tensioners") {
      return send(res, 200, db.tensioners);
    }
    if (req.method === "GET" && p === "/api/stats") {
      return send(res, 200, computeStats(db.items));
    }

    // 建档
    if (req.method === "POST" && p === "/api/items") {
      const input = await readBody(req);
      if (!String(input.code || "").trim()) throw new TaskError("模型编号必填");
      const item = {
        id: newId(),
        code: String(input.code).trim(),
        shipType: input.shipType || "",
        scale: input.scale || "",
        mastCount: input.mastCount ?? "",
        riggingMaterial: input.riggingMaterial || "",
        owner: input.owner || "",
        dueDate: input.dueDate || "",
        status: input.status || "待检查",
        tasks: [],
        tensioners: [],
        logs: [],
      };
      log(item, "建档", "创建模型");
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }

    // 修改模型：桅杆数量/帆索材料变更时旧张紧结果失效；或仅改状态
    let m = match(p, /^\/api\/items\/([^/]+)$/);
    if (m && req.method === "PATCH") {
      const item = findItem(db, decodeURIComponent(m[1]));
      const patch = await readBody(req);
      if (Object.keys(patch).length === 1 && patch.status !== undefined) {
        item.status = patch.status;
        log(item, "状态", "更新为 " + item.status);
      } else {
        applyModelChanges(db, item, patch);
      }
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    // 张紧器登记
    if (req.method === "POST" && p === "/api/tensioners") {
      const t = registerTensioner(db, await readBody(req));
      await saveDb(db);
      return send(res, 201, t);
    }

    // 张紧器领给模型
    m = match(p, /^\/api\/items\/([^/]+)\/tensioners$/);
    if (m && req.method === "POST") {
      const t = assignTensioner(db, decodeURIComponent(m[1]), await readBody(req));
      await saveDb(db);
      return send(res, 201, t);
    }

    // 登记帆索：目标张力 + 张紧器
    m = match(p, /^\/api\/items\/([^/]+)\/tasks$/);
    if (m && req.method === "POST") {
      const t = registerRope(db, decodeURIComponent(m[1]), await readBody(req));
      await saveDb(db);
      return send(res, 201, t);
    }

    // 分段读数：三成 / 六成 / 满张力
    m = match(p, /^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/readings\/(p30|p60|p100)$/);
    if (m && req.method === "POST") {
      const input = await readBody(req);
      const r = recordReading(db, decodeURIComponent(m[1]), decodeURIComponent(m[2]), {
        layer: m[3],
        value: input.value,
        reader: input.reader,
      });
      await saveDb(db);
      return send(res, 201, r);
    }

    // 换人复核
    m = match(p, /^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/reviews\/(p30|p60|p100)$/);
    if (m && req.method === "POST") {
      const input = await readBody(req);
      const r = reviewReading(db, decodeURIComponent(m[1]), decodeURIComponent(m[2]), {
        layer: m[3],
        reviewer: input.reviewer,
        decision: input.decision,
        note: input.note,
      });
      await saveDb(db);
      return send(res, 201, r);
    }

    return send(res, 404, { error: "not_found" });
  } catch (error) {
    const status = error instanceof TaskError ? error.status : 400;
    return send(res, status, { error: error.message || "请求失败" });
  }
});

server.listen(port, () =>
  console.log("古船模型帆索分段张紧 listening on http://localhost:" + port),
);
