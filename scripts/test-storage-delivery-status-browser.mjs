import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createStatusBrowserTest, parentProps, staffProps, driverProps } from '../tests/status-browser.integration.mjs';

const t = await createStatusBrowserTest();
const json = (route, data, status = 200) => route.fulfill({ status, json: data });
const summary = { recipientCount: 1, inAppCount: 1, pushAcceptedCount: 0, pushPartialCount: 0, pushFailedCount: 0, noSubscriptionCount: 0, skippedCount: 0, pendingCount: 0, unknownCount: 0, driverLinked: false };
const item = { id: 'fixture-change', studentId: 'fixture-child', studentName: '검사용 학생', serviceDate: '2026-10-19', direction: 'PICKUP', kind: 'SKIP', location: null, note: null, notificationStatus: summary };
const boarding = { ok: true, boarding: { 'fixture-row': 'BOARDED' }, checkedAt: { 'fixture-row': '2026-10-19T06:00:00.000Z' } };
const submit = page => page.getByRole('button', { name: '변경 저장하고 알림 요청', exact: true });
async function run(name, role, props, respond, exercise) {
  await t.check(name, async () => {
    const screen = await t.screen(role, props, respond);
    screen.page.setDefaultTimeout(5000);
    try { await exercise(screen); } finally { await screen.close(); }
  });
  console.log(`${t.cases.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
async function compose(page) {
  const tools = page.locator('details').filter({ has: page.locator('button').filter({ hasText: '수업 공지' }) }).first();
  await tools.locator('summary').click();
  await page.getByRole('button', { name: /수업 공지/ }).click();
  await page.getByPlaceholder('공지 제목').fill('검사용 공지');
  await page.getByPlaceholder('공지 내용을 입력해 주세요.').fill('검사용 본문');
  await page.getByRole('button', { name: '공지 저장·알림 요청', exact: true }).click();
}
try {
  await run('학부모 저장과 기사 확인을 구분', 'parent', parentProps, route => json(route, { ok: true, notificationStatus: summary }), async ({ page }) => {
    await submit(page).click(); await page.getByText(/변경 저장 완료 ·/).waitFor();
    assert.match(await page.locator('body').innerText(), /담당 기사 연결/);
    assert.doesNotMatch(await page.locator('body').innerText(), /기사님께 전달됐습니다|기사님 확인 완료/);
  });
  await run('학부모 푸시 미구독은 저장 실패가 아님', 'parent', parentProps, route => json(route, { ok: true, notificationStatus: { ...summary, noSubscriptionCount: 1, skippedCount: 1 } }), async ({ page }) => {
    await submit(page).click(); await page.getByText(/푸시 구독 미등록/).waitFor();
    assert.match(await page.locator('body').innerText(), /변경 저장 완료/);
  });
  await run('학부모 응답 유실 후 조회 복구', 'parent', parentProps, (route, query) => query.method === 'POST' ? route.abort() : json(route, { upcoming: [item] }), async ({ page, requests }) => {
    await submit(page).click(); await page.getByText(/변경 저장 완료 ·/).waitFor();
    assert.equal(requests.filter(query => query.method === 'POST').length, 1);
  });
  await run('학부모 조회 실패는 중복 제출 잠금', 'parent', parentProps, (route, query) => query.method === 'POST' ? route.abort() : json(route, { error: '조회 실패' }, 500), async ({ page, requests }) => {
    await submit(page).click(); await page.getByRole('alert').waitFor();
    assert.equal(await submit(page).isDisabled(), true);
    await page.getByRole('button', { name: '저장 결과 다시 확인', exact: true }).click();
    await page.getByRole('alert').waitFor(); assert.equal(requests.filter(query => query.method === 'POST').length, 1);
  });
  await run('학부모 입력 오류는 초안을 보존', 'parent', parentProps, route => json(route, { error: '날짜를 확인해주세요' }, 400), async ({ page }) => {
    await page.locator('#shuttle-note').fill('검사용 변경 메모');
    await submit(page).click(); await page.getByRole('alert').waitFor();
    assert.equal(await submit(page).isEnabled(), true);
    assert.equal(await page.locator('#shuttle-note').inputValue(), '검사용 변경 메모');
  });
  await run('학부모 취소 결과도 저장과 전달 구분', 'parent', { initial: { ...parentProps.initial, upcoming: [item] } }, route => json(route, { ok: true, noOp: true, notificationStatus: summary }), async ({ page, requests }) => {
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await page.getByText(/취소 저장 완료/).waitFor(); assert.equal(requests[0].body.action, 'cancel');
  });
  await run('교사 부분 푸시는 공지 저장과 별도 안내', 'staff', staffProps, route => json(route, { ok: true, noticeId: 'fixture-notice', recipientCount: 1, notificationStatus: { ...summary, pushPartialCount: 1 } }), async ({ page }) => {
    await compose(page); await page.getByRole('status').waitFor();
    assert.match(await page.getByRole('status').innerText(), /공지 저장 완료.*일부 기기 실패/);
  });
  await run('교사 응답 유실은 동일 작업 ID로 조회', 'staff', staffProps, (route, query) => query.path.endsWith('createStaffClassNotice') ? route.abort() : json(route, { ok: true, savedTitle: '저장된 제목', savedContent: '저장된 본문', recipientCount: 1, notificationStatus: summary }), async ({ page, requests }) => {
    await compose(page); await page.getByRole('status').waitFor();
    assert.equal(requests[0].body.operationId, requests[1].body.operationId);
    assert.equal(await page.getByPlaceholder('공지 제목').inputValue(), '저장된 제목');
  });
  await run('교사 저장 기록 없음은 같은 작업으로 재시도', 'staff', staffProps, (route, query) => query.path.endsWith('createStaffClassNotice') ? route.abort() : json(route, { ok: false, code: 'NOT_FOUND', message: '같은 작업으로 다시 제출할 수 있습니다.' }), async ({ page, requests }) => {
    await compose(page); await page.getByRole('alert').waitFor();
    assert.equal(await page.getByPlaceholder('공지 제목').isEnabled(), true);
    await page.getByRole('button', { name: '공지 저장·알림 요청', exact: true }).click();
    await page.getByRole('alert').waitFor();
    const posts = requests.filter(query => query.path.endsWith('createStaffClassNotice'));
    assert.equal(posts.length, 2); assert.equal(posts[0].body.operationId, posts[1].body.operationId);
  });
  await run('교사 수신자 0명은 발송 성공으로 안내하지 않음', 'staff', staffProps, route => json(route, { ok: true, noticeId: 'fixture-notice', recipientCount: 0, notificationStatus: { ...summary, recipientCount: 0, inAppCount: 0 } }), async ({ page }) => {
    await compose(page); await page.getByRole('status').waitFor(); assert.match(await page.getByRole('status').innerText(), /알림 대상이 없습니다/);
  });
  await run('교사 장부 대상 일부 누락은 재조회 후에도 경고', 'staff', staffProps, route => json(route, { ok: true, noticeId: 'fixture-notice', recipientCount: 2, notificationStatus: summary }), async ({ page }) => {
    await compose(page); await page.getByRole('status').waitFor(); assert.match(await page.getByRole('status').innerText(), /수신 대상·전달 결과 확인이 필요/);
  });
  await run('기사 응답 유실 후 서버 저장 확인', 'driver', driverProps, (route, query) => query.method === 'POST' ? route.abort() : json(route, boarding), async ({ page, requests }) => {
    await page.getByRole('button', { name: '탑승', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /저장 완료/ }).waitFor();
    assert.equal(requests.filter(query => query.method === 'POST').length, 1);
  });
  let getCount = 0;
  await run('기사 GET 실패는 잠금 후 조회만 재시도', 'driver', driverProps, (route, query) => query.method === 'POST' ? json(route, { ok: true }) : ++getCount === 1 ? json(route, { error: '조회 실패' }, 503) : json(route, boarding), async ({ page, requests }) => {
    await page.getByRole('button', { name: '탑승', exact: true }).click();
    await page.getByText(/결과 확인 필요/).waitFor();
    assert.equal(await page.getByRole('button', { name: '탑승', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '저장 상태 확인', exact: true }).click();
    await page.getByText(/서버 상태 확인 완료/).waitFor();
    assert.equal(requests.filter(query => query.method === 'POST').length, 1);
  });
  await run('기사 최초 조회 실패는 미체크로 오인하지 않음', 'driver', { ...driverProps, initialBoardingReliable: false }, route => json(route, boarding), async ({ page, requests }) => {
    await page.getByText(/체크 기록 확인 필요/).waitFor();
    assert.equal(await page.getByRole('button', { name: '탑승', exact: true }).isDisabled(), true); assert.equal(requests.length, 0);
  });
  await run('기사 연속 클릭은 한 번만 저장', 'driver', driverProps, (route, query) => json(route, query.method === 'POST' ? { ok: true } : boarding), async ({ page, requests }) => {
    await page.getByRole('button', { name: '탑승', exact: true }).evaluate(button => { button.click(); button.click(); button.click(); });
    await page.getByRole('status').filter({ hasText: /저장 완료/ }).waitFor();
    assert.equal(requests.filter(query => query.method === 'POST').length, 1);
  });
  for (const accepted of [false, true]) {
    await run(`기사 GPS 서버 ${accepted ? '접수 성공' : '접수 실패'} 구분`, 'driver', driverProps, route => json(route, { ok: accepted }, accepted ? 200 : 500), async ({ page, context }) => {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'geolocation', { value: {
          watchPosition(success) { queueMicrotask(() => success({ coords: { latitude: 0, longitude: 0, accuracy: 8, speed: null, heading: null } })); return 1; },
          clearWatch() {},
        } });
      });
      await page.reload(); await page.getByRole('button', { name: /운행 시작/ }).click();
      if (accepted) await page.getByText(/마지막 서버 접수/).waitFor();
      else {
        await page.getByText(/위치 전송 확인 필요/).waitFor();
        assert.doesNotMatch(await page.locator('body').innerText(), /마지막 서버 접수 ·/);
      }
      await page.getByRole('button', { name: /운행 종료/ }).click();
      await page.getByText(accepted ? /서버 중단 접수 완료/ : /서버 공유 중단은 확인 필요/).waitFor();
    });
  }
  await run('관리자 조회 오류는 빈 목록 아님', 'delivery', {}, route => json(route, { error: '검사용 조회 실패' }, 500), async ({ page }) => {
    await page.getByRole('alert').waitFor(); assert.doesNotMatch(await page.locator('body').innerText(), /선택한 조건의 전달 기록이 없습니다/);
  });
} finally { await t.close(); }
await mkdir('.tmp/status-qa', { recursive: true });
await writeFile('.tmp/status-qa/replay-report.json', JSON.stringify({ cases: t.cases, passed: t.cases.length - t.failures.length, failed: t.failures.length }, null, 2));
assert.deepEqual(t.failures, [], '브라우저 상태 검증 실패');
