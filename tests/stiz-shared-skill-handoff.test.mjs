import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import test from "node:test";

const root = process.cwd();
const skillPath = resolve(root, ".agents/skills/stiz-monthly-billing/SKILL.md");
const handoffPath = resolve(root, ".Codex/HANDOFF.md");
const setupPath = resolve(root, "docs/codex-handoff-setup.md");

test("공용 STIZ 스킬과 인수인계 문서가 저장소에 존재한다", () => {
  for (const path of [skillPath, handoffPath, setupPath, resolve(root, "AGENTS.md")]) {
    assert.equal(existsSync(path), true, `${path} 파일이 필요합니다.`);
  }
});

test("공용 스킬의 frontmatter와 참조 링크가 유효하다", () => {
  const skill = readFileSync(skillPath, "utf8");
  assert.match(skill, /^---\r?\nname: stiz-monthly-billing\r?\ndescription: .+\r?\n---/);

  const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((match) => match[1]);
  assert.ok(links.length >= 4);
  for (const link of links) {
    assert.equal(existsSync(resolve(dirname(skillPath), link)), true, `${link} 참조가 필요합니다.`);
  }
});

test("외부 작업은 세 시스템 대조와 실행 직전 승인을 요구한다", () => {
  const skill = readFileSync(skillPath, "utf8");

  for (const required of [
    "Google Sheets",
    "Rallyz",
    "stiz-dasan.kr",
    "dry-run",
    "HELD",
    "action-time preview",
    "parent invitations",
    "re-read",
    "partial",
  ]) {
    assert.ok(skill.includes(required), `SKILL.md에 ${required} 안전 계약이 필요합니다.`);
  }
});

test("신규 학생 최초 등록은 청구 알림과 Rallyz 학부모 초대까지 완료한다", () => {
  const skill = readFileSync(skillPath, "utf8");
  const changeSync = readFileSync(resolve(dirname(skillPath), "references/change-request-sync.md"), "utf8");
  const billing = readFileSync(resolve(dirname(skillPath), "references/billing-policies.md"), "utf8");

  // 2026-09-30 방침 변경(사이트가 기준, 10월부터 시트 장부 신규 생성 중단)에 맞춘 문장이다.
  // 문장은 바뀌었어도 지켜야 할 안전 계약(완료 조건·HELD·대상 특정·실행 후 재확인)은 그대로 검사한다.
  const firstRegistration = readFileSync(resolve(dirname(skillPath), "references/first-registration.md"), "utf8");
  assert.match(skill, /registration is not complete merely because the student and class rows exist/);
  assert.match(skill, /invoice and notification, and parent invitation/);
  assert.match(skill, /This is a required outcome, not blanket execution permission/);
  // 보류 해제 조건까지 한 문장으로 묶어 검사한다 — 해제 조건이 느슨해지면 여기서 걸린다.
  assert.match(skill, /Keep the invoice, invoice notification, and Rallyz parent invitation `HELD` until the user's current request or an action-time preview authorizes the specific student, branch, class, period, amount, masked recipient, delivery method, and item count/);
  assert.match(skill, /Re-read the applicable systems, invoice state, and parent connection after execution/);
  assert.match(firstRegistration, /send its requested parent notification, and invite the verified guardian once/);
  assert.match(firstRegistration, /Do not resend an invitation or recreate an invoice after an uncertain response/);
  assert.match(changeSync, /required completion steps but remain separate `HELD` actions/);
  assert.match(billing, /Mid-month first registration is prorated from the remaining confirmed sessions/);
  assert.match(billing, /parent is not already connected/);
});

test("인수인계는 단일 ACTIVE 실행기와 비밀정보 금지를 명시한다", () => {
  const setup = readFileSync(setupPath, "utf8");
  const handoff = readFileSync(handoffPath, "utf8");
  assert.match(setup, /한 실행기에서만 `ACTIVE`/);
  assert.match(handoff, /ACTIVE 실행기 ID: `[^`]+`/);
  assert.doesNotMatch(handoff, /ACTIVE 실행기 ID: `(?:미정|UNKNOWN|UNASSIGNED)`/);
  assert.match(handoff, /ACTIVE 확인시각\(KST\): \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(handoff, /학원 PC 실행기 ID: 미등록, 반드시 `PAUSED`/);
  assert.match(handoff, /기존 실행기 PAUSED 확인시각/);
  assert.match(setup, /\.env\.local/);
  assert.match(setup, /private key/);
  assert.match(handoff, /전체 전화번호, 주소, 생년월일 원문 없음/);
});

test("공용 파일에는 secret, DB URL, 전체 휴대폰 번호가 없다", () => {
  const targets = [
    resolve(root, "AGENTS.md"),
    skillPath,
    ...[...readFileSync(skillPath, "utf8").matchAll(/\]\((references\/[^)]+)\)/g)]
      .map((match) => resolve(dirname(skillPath), match[1])),
    handoffPath,
    setupPath,
    resolve(root, ".Codex/scratchpad.md"),
    resolve(root, ".Codex/knowledge/index.md"),
    resolve(root, ".Codex/knowledge/decisions.md"),
  ];
  const combined = targets.map((path) => readFileSync(path, "utf8")).join("\n");

  assert.doesNotMatch(combined, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i);
  assert.doesNotMatch(combined, /\bAIza[0-9A-Za-z_-]{20,}\b/);
  assert.doesNotMatch(combined, /\bsk-[0-9A-Za-z_-]{20,}\b/);
  assert.doesNotMatch(combined, /\bpostgres(?:ql)?:\/\/[^\s]+/i);
  assert.doesNotMatch(combined, /\b010-\d{4}-\d{4}\b/);
});
