import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const adminAction = fs.readFileSync("src/app/actions/admin.ts", "utf8");
const notification = fs.readFileSync("src/lib/notification.ts", "utf8");

test("체험 일정 확정 문자는 부모와 담당자 발송 결과를 모두 기다려 반환한다", () => {
    assert.match(
        adminAction,
        /const parentDelivery = await sendParentSmsWithResult\([\s\S]*?eventType: "TRIAL_SCHEDULED"/,
    );
    assert.match(adminAction, /const staffDelivery = await notifyAdmins\(/);
    assert.match(adminAction, /coachTrigger: "TRIAL_SCHEDULED_COACH"/);
    assert.match(adminAction, /scheduledDate: dateStr/);
    assert.match(adminAction, /className/);
    assert.match(
        adminAction,
        /return \{[\s\S]*?attendedSms: attendedSmsResult,[\s\S]*?scheduledSms: scheduledSmsResult/,
    );
    assert.doesNotMatch(
        adminAction,
        /sendParentSms\(parentPhone, "TRIAL_SCHEDULED_PARENT"[\s\S]{0,300}\.catch\(\(\) => \{\}\)/,
    );
    assert.match(
        adminAction,
        /try \{[\s\S]*?\[updateTrialLead scheduled SMS\] failed:[\s\S]*?일정은 저장됐지만 문자 발송 준비 중 오류가 발생했습니다/,
    );
});

test("수강 승인 액션은 승인용 강사 템플릿을 직접 발송하지 않는다", () => {
    const approval = adminAction.slice(
        adminAction.indexOf("export async function approveEnrollApplication"),
        adminAction.indexOf("export async function rejectEnrollApplication"),
    );
    assert.doesNotMatch(approval, /coachTrigger: "ENROLL_APPROVED_COACH"/);
    assert.match(adminAction, /ENROLL_APPROVED_COACH/);
});

test("동일 일정 중복 발송은 막고 반이나 시간이 바뀌면 새 안내를 보낸다", () => {
    assert.match(
        adminAction,
        /const scheduledEventId = \[[\s\S]*?"trial",[\s\S]*?id,[\s\S]*?"scheduled",[\s\S]*?new Date\(scheduledDate\)\.toISOString\(\),[\s\S]*?classId \|\| "no-class"/,
    );
    assert.match(adminAction, /eventId: scheduledEventId/);
    assert.match(notification, /ON CONFLICT \("dedupeKey"\) DO NOTHING/);
    assert.match(notification, /claim\.duplicateStatus === "SENT"[\s\S]*?"DUPLICATE_SKIPPED"/);
});

test("담당 슬롯이나 담당 코치가 없으면 전체 코치에게 대신 발송하지 않는다", () => {
    assert.match(
        adminAction,
        /slotKeys: classSlotKey \? \[classSlotKey\] : undefined,[\s\S]*?requireMatchedCoach: true/,
    );
    assert.match(
        notification,
        /else if \(!smsOptions\?\.requireMatchedCoach\)[\s\S]*?SELECT phone FROM "Coach"/,
    );
    assert.match(
        notification,
        /if \(smsOptions\?\.notifyCoaches !== false && smsOptions\?\.requireMatchedCoach && coachPhones\.length === 0\)/,
    );
});
