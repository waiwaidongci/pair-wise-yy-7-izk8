import { now, log } from "./records.js";

// 任务处：分段张紧规则。
// 三层：三成（30%）、六成（60%）、满张力（100%），每层登记读数。
export const LAYERS = [
  { key: "p30", label: "三成", ratio: 0.3 },
  { key: "p60", label: "六成", ratio: 0.6 },
  { key: "p100", label: "满张力", ratio: 1.0 },
];
export const DEVIATION_LIMIT = 0.05; // 读数偏离目标 5% 即停下复核

export class TaskError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function findItem(db, idOrCode) {
  const item = db.items.find((x) => x.id === idOrCode || x.code === idOrCode);
  if (!item) throw new TaskError("模型不存在", 404);
  return item;
}

export function findTensioner(db, code) {
  const t = db.tensioners.find((x) => x.code === code);
  if (!t) throw new TaskError("张紧器未登记：" + code, 404);
  return t;
}

function findTask(item, taskId) {
  const task = (item.tasks || []).find((t) => t.id === taskId);
  if (!task) throw new TaskError("帆索任务不存在", 404);
  return task;
}

function expectedAt(task, layer) {
  return task.targetTension * layer.ratio;
}

// 一层“完成”= 该模型每根索都有该层读数（停用的读数也算，因为已复核放行）
export function completedLayers(item) {
  const tasks = item.tasks || [];
  return LAYERS.filter((layer) =>
    tasks.length > 0 &&
    tasks.every((t) => t.readings && t.readings[layer.key]),
  ).map((l) => l.key);
}

// 当前应做的层：已完成层的下一层；全部完成返回 null
function currentLayer(item) {
  const done = new Set(completedLayers(item));
  return LAYERS.find((l) => !done.has(l.key)) || null;
}

// 整套张紧结束：三根层都完成
export function isFullComplete(item) {
  return completedLayers(item).length === LAYERS.length;
}

export function registerTensioner(db, input) {
  const code = String(input.code || "").trim();
  if (!code) throw new TaskError("张紧器编号必填");
  if (db.tensioners.some((t) => t.code === code))
    throw new TaskError("张紧器编号已存在");
  const tensioner = { code, model: input.model || "", note: input.note || "" };
  db.tensioners.push(tensioner);
  return tensioner;
}

// 张紧器领给模型后，整套张紧结束前不能给别的模型
export function assignTensioner(db, itemId, input) {
  const item = findItem(db, itemId);
  const tensioner = findTensioner(db, String(input.code || "").trim());
  if (tensioner.model && tensioner.model !== item.code)
    throw new TaskError(
      `张紧器 ${tensioner.code} 已领给模型 ${tensioner.model}，整套张紧结束前不能转领`,
      409,
    );
  if (isFullComplete(item))
    throw new TaskError("整套张紧已结束，请领给新模型或重新建档");
  tensioner.model = item.code;
  item.tensioners ||= [];
  if (!item.tensioners.includes(tensioner.code)) item.tensioners.push(tensioner.code);
  item.status = "校准中";
  log(item, "领张紧器", `${tensioner.code} 领给本模型`);
  return tensioner;
}

function heldTensioners(db, item) {
  return (db.tensioners || []).filter((t) => t.model === item.code);
}

export function registerRope(db, itemId, input) {
  const item = findItem(db, itemId);
  const position = String(input.position || "").trim();
  const targetTension = Number(input.targetTension);
  const tensionerCode = String(input.tensioner || "").trim();
  if (!position) throw new TaskError("索具位置必填");
  if (!Number.isFinite(targetTension) || targetTension <= 0)
    throw new TaskError("目标张力必须为正数");
  if (!tensionerCode) throw new TaskError("请选择张紧器");
  const tensioner = findTensioner(db, tensionerCode);
  if (tensioner.model !== item.code)
    throw new TaskError("请先把该张紧器领给本模型");
  if (isFullComplete(item))
    throw new TaskError("整套张紧已结束，新增帆索请另建模型");
  if ((item.tasks || []).some((t) => t.position === position && !t.voidedAt))
    throw new TaskError("该位置已登记帆索");
  item.tasks ||= [];
  const task = {
    id: "T-" + Date.now() + "-" + item.tasks.length,
    position,
    targetTension,
    tensioner: tensionerCode,
    status: "待张紧",
    readings: {},
    reviews: [],
    logs: [{ at: now(), note: `登记帆索：目标张力 ${targetTension}，张紧器 ${tensionerCode}` }],
  };
  item.tasks.push(task);
  item.status = "校准中";
  log(item, "登记帆索", `${position} · 目标 ${targetTension} · ${tensionerCode}`);
  return task;
}

function refreshStage(db, item) {
  if (isFullComplete(item)) {
    // 三层全部记完 → 整套张紧结束：释放张紧器，进入待检查
    for (const t of heldTensioners(db, item)) {
      log(item, "还张紧器", `${t.code} 整套结束，可领给别的模型`);
      t.model = "";
    }
    item.tensioners = [];
    if (item.status !== "待复核") {
      item.status = "待检查";
      log(item, "整套结束", "三成/六成/满张力三层读数均已登记");
    }
    for (const t of item.tasks) {
      if (!t.voidedAt) t.status = "已满张力";
    }
    return;
  }
  const blocked = (item.tasks || []).some((t) => t.status === "停用待复核");
  if (blocked) item.status = "待复核";
  else if (item.status !== "已交付") item.status = "校准中";
}

// 记录某一层的读数（三层都记完才进入下一层由这里强制）
export function recordReading(db, itemId, taskId, input) {
  const item = findItem(db, itemId);
  const task = findTask(item, taskId);
  if (task.voidedAt) throw new TaskError("该帆索旧结果已失效，请重新登记");
  if ((item.tasks || []).some((t) => t.status === "停用待复核"))
    throw new TaskError("有帆索读数偏离目标已停下，须换另一名师傅复核后整套才能继续", 409);

  const layerKey = String(input.layer || "");
  const layer = LAYERS.find((l) => l.key === layerKey);
  if (!layer) throw new TaskError("分段层级无效");

  const reader = String(input.reader || "").trim();
  if (!reader) throw new TaskError("请填写记录师傅");
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0) throw new TaskError("读数必须是非负数字");

  // 层级闸门：本模型每根索都完成上一层，本层才允许登记
  const layerIndex = LAYERS.findIndex((l) => l.key === layerKey);
  for (const prev of LAYERS.slice(0, layerIndex)) {
    const missing = (item.tasks || []).filter((t) => !t.voidedAt && !t.readings[prev.key]);
    if (missing.length)
      throw new TaskError(`${prev.label}还未全部记完（缺 ${missing.map((m) => m.position).join("、")}），不能进入${layer.label}`, 409);
  }
  // 已越过或已复核的层锁定，不能回头覆盖
  const existing = task.readings[layerKey];
  if (existing) {
    const wentBeyond = LAYERS.slice(layerIndex + 1).some((l) => task.readings[l.key]);
    if (existing.reviewed || wentBeyond)
      throw new TaskError(`${layer.label}读数已登记并锁定，需要调整请走复核/重新建档`, 409);
  }

  const target = expectedAt(task, layer);
  const deviation = value === 0 && target === 0 ? 0 : Math.abs(value - target) / target;
  const reading = {
    at: now(),
    layer: layerKey,
    layerLabel: layer.label,
    value,
    target,
    deviation: Number(deviation.toFixed(4)),
    reader,
    reviewed: false,
  };
  task.readings[layerKey] = reading;
  task.logs ||= [];
  task.logs.push({
    at: reading.at,
    note: `${layer.label}读数 ${value}（目标 ${target}，偏离 ${(deviation * 100).toFixed(1)}%）`,
  });

  if (deviation > DEVIATION_LIMIT) {
    task.status = "停用待复核";
    item.status = "待复核";
    log(item, "停用", `${task.position} ${layer.label}读数 ${value} 偏离目标 ${(deviation * 100).toFixed(1)}%，已停下`);
  } else {
    log(item, "读数", `${task.position} ${layer.label} ${value}（师傅 ${reader}）`);
    refreshStage(db, item);
  }
  return reading;
}

// 换另一名师傅复核：复核师傅必须与记录师傅不是同一人
export function reviewReading(db, itemId, taskId, input) {
  const item = findItem(db, itemId);
  const task = findTask(item, taskId);
  const layerKey = String(input.layer || "");
  const reading = task.readings && task.readings[layerKey];
  if (!reading) throw new TaskError("该层没有可复核的读数", 404);
  const reviewer = String(input.reviewer || "").trim();
  if (!reviewer) throw new TaskError("请填写复核师傅");
  if (reviewer === reading.reader)
    throw new TaskError("须换另一名师傅复核，复核人不能与记录人相同", 409);

  const approved = input.decision !== "reject";
  reading.reviewed = true;
  reading.reviewer = reviewer;
  reading.reviewAt = now();
  reading.decision = approved ? "放行" : "驳回";
  task.reviews.push({ layer: layerKey, reviewer, at: reading.reviewAt, decision: reading.decision, note: input.note || "" });
  task.logs.push({ at: reading.reviewAt, note: `${reading.layerLabel}复核${reading.decision}（师傅 ${reviewer}）${input.note ? "：" + input.note : ""}` });

  if (approved) {
    task.status = "复核放行";
    log(item, "复核", `${task.position} ${reading.layerLabel}由师傅 ${reviewer} 复核放行`);
  } else {
    // 驳回：删掉该层读数，回到该层重新记录；复核历史保留
    delete task.readings[layerKey];
    task.status = "待重记";
    log(item, "复核", `${task.position} ${reading.layerLabel}被师傅 ${reviewer} 驳回，读数需重记`);
  }
  refreshStage(db, item);
  return reading;
}

// 桅杆数量或帆索材料改了：旧张紧结果失效（清空分段读数，重新从三成开始）
export function applyModelChanges(db, item, patch) {
  const mastChanged =
    patch.mastCount !== undefined &&
    Number(patch.mastCount) !== Number(item.mastCount);
  const materialChanged =
    patch.riggingMaterial !== undefined &&
    String(patch.riggingMaterial) &&
    String(patch.riggingMaterial) !== String(item.riggingMaterial);

  const hadReadings = (item.tasks || []).some((t) => Object.keys(t.readings || {}).length);
  if ((mastChanged || materialChanged) && hadReadings) {
    const reasons = [];
    if (mastChanged) reasons.push(`桅杆数量 ${item.mastCount}→${patch.mastCount}`);
    if (materialChanged) reasons.push(`帆索材料 ${item.riggingMaterial}→${patch.riggingMaterial}`);
    const at = now();
    item.voidedRuns ||= 0;
    item.voidedRuns += 1;
    for (const t of item.tasks || []) {
      t.voidedAt = at;
      t.voidReason = reasons.join("；");
      t.status = "旧结果失效";
      t.logs.push({ at, note: `旧张紧结果失效：${reasons.join("；")}` });
    }
    item.tasks = [];
    item.status = "校准中";
    log(item, "旧结果失效", reasons.join("；") + "，分段张紧重新登记");
    // 张紧器仍领在本模型上，不释放；参数变了但同一套活还在做
  }

  for (const key of ["code", "shipType", "scale", "mastCount", "riggingMaterial", "owner", "dueDate"]) {
    if (patch[key] !== undefined) item[key] = patch[key];
  }
}
