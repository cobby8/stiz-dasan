/**
 * 랠리즈 피드 이관 스크립트 공용(원장 PC 전용) — 환경변수·DB 연결·스냅숏·인자.
 * 랠리즈에는 아무것도 쓰지 않는다(사진·영상 «내려받기»만). 학부모 알림을 보내는 코드는 부르지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");

/** KEY=VALUE 줄 읽기(따옴표 벗김) — dotenv 는 직접 의존성이 아니라 쓰지 않는다 */
export function parseEnvText(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/** 프로젝트 루트의 .env.rallyz-import → .env.local → .env 순서로 읽는다(이미 있는 값은 덮지 않는다) */
export function loadEnv() {
  for (const name of [".env.rallyz-import", ".env.local", ".env"]) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    for (const [k, v] of Object.entries(parseEnvText(fs.readFileSync(file, "utf8")))) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

/** --key value · --flag 모양 인자 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8").replace(/^﻿/, ""));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), JSON.stringify(value, null, 2), "utf8");
}

/** 작업 폴더(진행 상태·내려받은 파일·만든 SQL) — 기본 프로젝트 밖이 아니라 .tmp/rallyz-feed-import (gitignore) */
export function workDir(args) {
  const dir = path.resolve(args.work || path.join(ROOT, ".tmp", "rallyz-feed-import"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 실행 묶음 id — 되돌림 단위. 예: rz-feed-20261116-1530 */
export function newBatchId(prefix = "rz-feed") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${prefix}-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}

/** 운영 DB 연결(원장 PC .env.local 의 DATABASE_URL). readOnly 면 세션 전체를 읽기 전용으로 */
export async function connectDb({ readOnly = false } = {}) {
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL(.env.local)이 없습니다 — 원장 PC 에서 실행하세요.");
  const client = new pg.Client({
    connectionString,
    application_name: "stiz-rallyz-feed-import",
    connectionTimeoutMillis: 15000,
    statement_timeout: 60000,
    ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
  });
  await client.connect();
  return client;
}

/** 스냅숏: --snapshot 파일이 있으면 그것(PM 이 MCP 로 뽑은 것), 없으면 DB 에서 읽기 전용으로 */
export async function loadSnapshot(args) {
  if (args.snapshot) {
    const json = readJson(args.snapshot);
    // MCP 결과를 그대로 저장한 경우([{snapshot:{...}}]) 도 받는다
    const snap = Array.isArray(json) ? json[0]?.snapshot ?? json[0] : json.snapshot ?? json;
    if (!snap?.classes) throw new Error("스냅숏 파일 모양이 이상합니다(classes 없음).");
    return snap;
  }
  const client = await connectDb({ readOnly: true });
  try {
    const sql = fs.readFileSync(path.join(HERE, "snapshot.sql"), "utf8");
    const { rows } = await client.query(sql);
    return rows[0].snapshot;
  } finally {
    await client.end();
  }
}

/** 수동 반 매핑 파일(선택) — { "랠리즈 반 이름": "사이트 반 id 또는 이름" } */
export function loadClassMap(args) {
  return args["class-map"] ? readJson(args["class-map"]) : {};
}

/** 인자 날짜 확인 */
export function ymdArg(args, key) {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--${key} 는 YYYY-MM-DD 로 적어 주세요.`);
  return v;
}

/** --month 2026-11 → from/to */
export function monthRange(month) {
  if (!month) return {};
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("--month 는 YYYY-MM 로 적어 주세요.");
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}
