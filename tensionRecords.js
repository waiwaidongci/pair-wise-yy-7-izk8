// 记录处：张紧台账。只追加不改写；张紧器领用/归还状态由事件推导。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { STAGES } from "./tensionTasks.js";

export async function loadLedger(path) {
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ entries: [] }, null, 2));
  }
  return JSON.parse(await readFile(path, "utf8"));
}

export async function saveLedger(path, ledger) {
  await writeFile(path, JSON.stringify(ledger, null, 2));
}

let seq = 0;
export function append(ledger, type, payload) {
  const entry = {
    id: "L-" + Date.now().toString(36) + "-" + (++seq).toString(36),
    at: new Date().toISOString(),
    type,
    ...payload
  };
  ledger.entries.push(entry);
  return entry;
}

// 当前被领用的张紧器：tensionerId -> { modelCode, at }
// 归还事件按整模型清除其所有领用；失效事件不归还（仍在返工）。
export function currentHolds(ledger) {
  const holds = new Map();
  for (const entry of ledger.entries) {
    if (entry.type === "tensioner_issue") {
      holds.set(entry.tensioner, { modelCode: entry.modelCode, at: entry.at });
    } else if (entry.type === "set_completed") {
      for (const [tensioner, h] of holds)
        if (h.modelCode === entry.modelCode) holds.delete(tensioner);
    }
  }
  return holds;
}

export function nextStageLabel(rope) {
  const idx = rope.stageIndex + 1;
  return idx < STAGES.length
    ? `${STAGES[idx].key}（目标 ${Math.round(rope.targetTension * STAGES[idx].ratio * 100) / 100} N）`
    : "三层已记完";
}
