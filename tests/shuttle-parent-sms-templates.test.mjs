import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const templates = fs.readFileSync("src/lib/smsTemplate.ts", "utf8");
const migration = fs.readFileSync(
  "prisma/migrations/20260724060000_add_shuttle_parent_sms_automations/migration.sql",
  "utf8",
);

function loadRenderTemplate() {
  const match = templates.match(
    /export function renderTemplate\([^)]*\): string \{([\s\S]*?)\n\}/,
  );
  assert.ok(match, "renderTemplate 구현을 찾을 수 있어야 한다");
  return new Function("body", "variables", match[1]);
}

test("셔틀 학부모 안내 템플릿 2종을 기본 템플릿으로 제공한다", () => {
  assert.match(templates, /"SHUTTLE_ROUTE_CONFIRMED_PARENT"/);
  assert.match(templates, /"SHUTTLE_NO_SHOW_PARENT"/);
  // 2026-11-09: 두 문구는 알림톡 금고 틀이 정본(문자 = 알림톡 본문, 머리말 [스티즈농구교실])
  assert.match(templates, /parentAlimtalkSmsTemplateBody\("SHUTTLE_ROUTE_CONFIRMED_PARENT"\)/);
  assert.match(templates, /parentAlimtalkSmsTemplateBody\("SHUTTLE_NO_SHOW_PARENT"\)/);
  const registry = fs.readFileSync("src/lib/messaging/parent-alimtalk-templates.ts", "utf8");
  assert.match(registry, /`\$\{P\} #\{학생명\} 셔틀 #\{운행방향\} 안내`,\n\s+"#\{운행일\} #\{예정시간\} \/ #\{정류장\}"/);
  assert.match(registry, /`\$\{P\} #\{학생명\} 학생이 오늘 #\{운행방향\} 셔틀에 미탑승 처리되었습니다\. 확인 부탁드립니다\.`/);
  assert.match(templates, /\\p\{L\}/, "한글 변수명도 실제 값으로 치환해야 한다");
});

test("renderTemplate이 한글 셔틀 변수를 실제 안내문으로 치환한다", () => {
  const renderTemplate = loadRenderTemplate();
  const rendered = renderTemplate(
    "[STIZ] {{학생명}} 셔틀 {{운행방향}} 안내\n{{운행일}} {{예정시간}} / {{정류장}}",
    {
      학생명: "박윤우",
      운행방향: "등원",
      운행일: "7월 24일",
      예정시간: "오후 2시 30분",
      정류장: "다산자이 정문",
    },
  );

  assert.equal(
    rendered,
    "[STIZ] 박윤우 셔틀 등원 안내\n7월 24일 오후 2시 30분 / 다산자이 정문",
  );
  assert.equal(renderTemplate("{{학생명}} {{없는값}}", { 학생명: "박윤우" }), "박윤우 ");
});

test("마이그레이션은 두 템플릿을 외부 학부모 SMS 자동화로 활성화한다", () => {
  assert.match(migration, /'SHUTTLE_ROUTE_CONFIRMED_PARENT'/);
  assert.match(migration, /'SHUTTLE_NO_SHOW_PARENT'/);
  assert.match(migration, /'EXTERNAL'/);
  assert.match(migration, /'PARENT'/);
  assert.match(migration, /"requestedChannel"[\s\S]*?'SMS'/);
  assert.match(migration, /"fallbackEnabled"[\s\S]*?true/);
  assert.match(migration, /"fallbackChannel"[\s\S]*?'SMS'/);
  assert.match(migration, /"isActive"[\s\S]*?true/);
  assert.match(migration, /ON CONFLICT \(trigger\) DO UPDATE/);
});

test("기존 자동화 충돌 시 관리자가 정한 활성화·채널·대체발송 설정을 보존한다", () => {
  const automationUpsert = migration.slice(
    migration.indexOf('INSERT INTO public."MessageAutomationRule"'),
  );
  const conflictUpdate = automationUpsert.slice(
    automationUpsert.indexOf("ON CONFLICT (trigger) DO UPDATE"),
  );

  assert.doesNotMatch(conflictUpdate, /"isActive"\s*=/);
  assert.doesNotMatch(conflictUpdate, /"requestedChannel"\s*=/);
  assert.doesNotMatch(conflictUpdate, /"fallbackEnabled"\s*=/);
  assert.doesNotMatch(conflictUpdate, /"fallbackChannel"\s*=/);
  assert.match(conflictUpdate, /"templateId"\s*=\s*EXCLUDED\."templateId"/);
});
