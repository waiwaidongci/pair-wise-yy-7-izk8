// 任务处：分段张紧的业务规则。纯函数，不碰文件、不碰 HTTP。
export const STAGES = [
  { key: "三成", ratio: 0.3 },
  { key: "六成", ratio: 0.6 },
  { key: "满张力", ratio: 1 }
];
export const TOLERANCE = 0.05;

let ropeSeq = 0;
export function newRopeId() {
  ropeSeq += 1;
  return "SP-" + Date.now().toString(36) + "-" + ropeSeq.toString(36);
}

export class TaskError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const keyOf = (item) => item.code || item.id;

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// 登记一根帆索：目标张力 + 张紧器。张紧器被别的模型领用时拒绝。
export function registerRope(item, input, holds) {
  const position = String(input.position || "").trim();
  const tensioner = String(input.tensioner || "").trim();
  const targetTension = asNumber(input.targetTension);
  if (!position) throw new TaskError("position_required", "索具位置必填");
  if (!Number.isFinite(targetTension) || targetTension <= 0)
    throw new TaskError("target_required", "目标张力必须是正数（牛）");
  if (!tensioner) throw new TaskError("tensioner_required", "张紧器编号必填");

  const key = keyOf(item);
  const holder = holds.get(tensioner);
  if (holder && holder.modelCode !== key)
    throw new TaskError(
      "tensioner_busy",
      `张紧器 ${tensioner} 已被模型 ${holder.modelCode} 领用，整套张紧结束前不能再发给别的模型`,
      409
    );

  const rope = {
    id: newRopeId(),
    position,
    targetTension,
    tensioner,
    stageIndex: -1, // 已记完的层下标：-1=尚未开始，0=三成，1=六成，2=满张力
    readings: [],
    locked: false,
    lock: null,
    voided: 0,
    status: "待张紧"
  };
  return { rope, needIssue: !holder };
}

// 记一层读数。层级由服务端按进度决定，前端无法跳层。
export function recordStage(item, rope, input) {
  if (rope.locked)
    throw new TaskError("rope_locked", "该索已因偏差停机，须由另一名师傅复核后才能继续", 422);
  const master = String(input.master || "").trim();
  if (!master) throw new TaskError("master_required", "请填写读数师傅姓名");
  const value = asNumber(input.reading);
  if (!Number.isFinite(value) || value <= 0)
    throw new TaskError("reading_required", "读数必须是正数");

  const nextIndex = rope.stageIndex + 1;
  if (nextIndex >= STAGES.length)
    throw new TaskError("already_done", "三层读数均已记完", 422);

  // 整套分层推进：本层所有索都记完，才允许进入下一层。
  for (const other of item.ropes || []) {
    if (other.id === rope.id || other.status === "已失效") continue;
    if (other.locked)
      throw new TaskError(
        "set_paused",
        `整套张紧暂停：${other.position} 偏差停机，等另一名师傅复核`,
        422
      );
    if (other.stageIndex < nextIndex - 1)
      throw new TaskError(
        "layer_blocked",
        `要等所有索都记完「${STAGES[nextIndex - 1].key}」，才能进入「${STAGES[nextIndex].key}」`,
        422
      );
  }

  const stage = STAGES[nextIndex];
  const expected = rope.targetTension * stage.ratio;
  const deviation = Math.abs(value - expected) / expected;
  const at = new Date().toISOString();

  if (deviation > TOLERANCE) {
    rope.locked = true;
    rope.status = "偏差停机";
    rope.lock = { stage: stage.key, expected, value, master, deviation, at };
    return { stage, expected, value, master, deviation, at, locked: true };
  }

  const reading = { stage: stage.key, ratio: stage.ratio, expected, value, master, deviation, at };
  rope.readings.push(reading);
  rope.stageIndex = nextIndex;
  rope.status = nextIndex === STAGES.length - 1 ? "张紧完成" : "张紧中";
  return { ...reading, locked: false, completed: nextIndex === STAGES.length - 1 };
}

// 偏差停机后的复核：必须换一名师傅，不能读数人自己放行。
export function reviewRope(rope, input) {
  if (!rope.locked) throw new TaskError("not_locked", "该索不在停机复核状态", 422);
  const reviewer = String(input.reviewer || "").trim();
  const note = String(input.note || "").trim();
  if (!reviewer) throw new TaskError("reviewer_required", "请填写复核师傅姓名");
  if (reviewer === rope.lock.master)
    throw new TaskError(
      "reviewer_must_differ",
      "必须换另一名师傅复核，读数人不能自己放行",
      422
    );
  const lock = rope.lock;
  rope.locked = false;
  rope.lock = null;
  rope.status = "张紧中";
  return { reviewer, note, lock };
}

export const activeRopes = (item) =>
  (item.ropes || []).filter((rope) => rope.status !== "已失效");

export function setCompleted(item) {
  const ropes = activeRopes(item);
  return ropes.length > 0 && ropes.every((rope) => rope.stageIndex === STAGES.length - 1);
}

export function heldTensioners(item, holds) {
  const key = keyOf(item);
  return [...holds.entries()].filter(([, h]) => h.modelCode === key).map(([t]) => t);
}

// 桅杆数量或帆索材料变更：旧张紧结果全部失效，任务退回三成重拉。
// 失效读数由调用方写进记录台账，任务上不再保留。
export function applyConfigChange(item, patch) {
  const changes = {};
  if (patch.mastCount !== undefined) {
    const next = asNumber(patch.mastCount);
    if (!Number.isFinite(next) || next <= 0)
      throw new TaskError("mast_required", "桅杆数量必须是正数");
    if (next !== asNumber(item.mastCount)) changes.mastCount = { from: item.mastCount, to: next };
  }
  if (patch.riggingMaterial !== undefined) {
    const next = String(patch.riggingMaterial).trim();
    if (!next) throw new TaskError("material_required", "帆索材料不能为空");
    if (next !== String(item.riggingMaterial || ""))
      changes.riggingMaterial = { from: item.riggingMaterial, to: next };
  }

  const changed = Object.keys(changes).length > 0;
  const voided = [];
  if (changed) {
    for (const rope of item.ropes || []) {
      for (const reading of rope.readings)
        voided.push({ ropeId: rope.id, position: rope.position, ...reading });
      if (rope.readings.length || rope.locked) rope.voided += 1;
      rope.readings = [];
      rope.stageIndex = -1;
      rope.locked = false;
      rope.lock = null;
      rope.status = "待张紧";
    }
  }
  return { changed, changes, voided };
}
