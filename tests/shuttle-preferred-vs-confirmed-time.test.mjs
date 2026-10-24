import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// 2026-10-02 옛 노선 편성 화면(ShuttleRouteAdminClient) 삭제로 그 화면을 읽던 검사는 뺐다(서버·API 검사는 유지).
const staffClient = read("../src/app/staff/shuttle/StaffShuttleDashboardClient.tsx");
const myPage = read("../src/app/mypage/MyPageClient.tsx");
const enrollForm = read("../src/app/apply/enroll/EnrollApplicationLaterSteps.tsx");
const service = read("../src/lib/shuttle/service.ts");

test("희망시간은 이미 서버에서 내려오므로 조회 코드를 건드리지 않는다", () => {
    // 대상자를 게이트웨이에서 읽도록 바뀌면서 변수명이 request → entry 가 됐다.
    // 지켜야 할 것은 "희망시간을 조회에서 잃지 않는다"이지 변수 이름이 아니다.
    assert.match(service, /pickupTime: \w+\.pickupTime/);
});

// ② 기사 앱에 확정시간이 보여야 한다.
test("기사 앱 Stop 타입에 plannedAt이 있고 확정 시간을 표시한다", () => {
    assert.match(staffClient, /plannedAt\?: string \| Date \| null;/);
    assert.match(staffClient, /confirmedTimeLabel\(stop\.plannedAt\)/);
    assert.match(staffClient, /확정 시간 \{plannedTime\}/);
});

test("학부모 마이페이지 확정 시간은 한국시간으로 고정한다", () => {
    assert.match(myPage, /toLocaleTimeString\("ko-KR", \{ timeZone: "Asia\/Seoul"/);
});

// 라벨 통일.
test("확정/희망 라벨을 화면별로 통일한다", () => {
    assert.match(myPage, /dark:text-gray-400">확정 시간<\/dt>/);
    assert.doesNotMatch(myPage, />예정 시간</);
    assert.match(enrollForm, /helper="참고용입니다\. 실제 탑승시간은 배차 확정 후 안내됩니다\."/);
});
