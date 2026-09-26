import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 记录处：JSON 文件存取 + 审计日志，只负责“记下来”，不含张紧规则。
const __dirname = dirname(fileURLToPath(import.meta.url));
export const dbPath = join(__dirname, "..", "data", "model-rigging-calibration.json");

export const statLabels = ["待检查", "校准中", "待复核", "已交付"];
export const modelFields = [
  ["code", "模型编号", "text"],
  ["shipType", "船型", "text"],
  ["scale", "比例", "text"],
  ["mastCount", "桅杆数量", "number"],
  ["riggingMaterial", "帆索材料", "text"],
  ["owner", "负责人", "text"],
  ["dueDate", "交付日期", "date"],
];

const seed = {
  tensioners: [],
  items: [
    {
      code: "MR-001",
      shipType: "福船",
      scale: "1:48",
      mastCount: 3,
      riggingMaterial: "蜡线",
      owner: "周宁",
      dueDate: "2026-06-28",
      status: "校准中",
      tasks: [
        {
          id: "T-1",
          position: "前桅侧支索",
          tension: "偏松",
          status: "调整中",
          logs: [{ at: "2026-06-12", note: "已缩短2mm" }],
        },
      ],
      logs: [],
    },
  ],
};

export function now() {
  return new Date().toISOString();
}

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.tensioners ||= [];
  for (const item of db.items || []) {
    item.id ||= item.code;
    item.tasks ||= [];
    item.logs ||= [];
    for (const task of item.tasks) {
      task.readings ||= {};
      task.reviews ||= [];
    }
  }
  return db;
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

// 模型级审计记录（领用、读数、停用、复核、失效、整套结束都走这里）
export function log(item, step, note) {
  item.logs ||= [];
  item.logs.push({ at: now(), step, note });
}

export function summarize(item) {
  const logCount =
    (item.logs || []).length +
    (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}

export function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map((label) => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
