import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePreviewSnapshot } from './real-preview-snapshot.mjs';

function source({ role = 'ADMIN', adminFound = true } = {}) {
  const calls = [];
  const rows = {
    User: [{ id: 'admin', name: '관리자', role, __hasUsername: false, phone: '비공개', phoneVerifiedAt: null }, { id: 'teacher', name: '선생님', role: 'INSTRUCTOR', __hasUsername: true, phone: null }, { id: 'parent', name: '학부모', role: 'PARENT', __hasUsername: false, phone: null }],
    Student: [{ id: 'student', name: '실제 이름', parentId: 'parent', birthDate: new Date('2000-01-01') }],
    Class: [{ id: 'class', name: '실제 반', instructorId: 'teacher' }],
    ShuttleVehicle: [{ id: 'vehicle', name: '1호차', capacity: 15, isActive: true }],
    ParentRequest: [{ id: 'request', userId: 'parent', studentId: 'student', type: 'OTHER', title: '학부모 요청', content: '비공개', status: 'PENDING' }],
    EnrollmentChangeRequest: [{ id: 'change', studentId: 'student', kind: 'PAUSE', status: 'APPROVED', effectiveFrom: new Date('2026-11-01T00:00:00Z'), waitlisted: false }],
    ApplicationContactLog: [{ id: 'contact', targetType: 'TRIAL', trialLeadId: 'lead', action: 'CONTACTED', nextFollowUpAt: new Date('2026-10-21T00:00:00Z') }],
    Session: [{ id: 'session-a', classId: 'class', sessionKey: 'class:2026-10-20', date: new Date('2026-10-20T06:00:00Z') }, { id: 'session-b', classId: 'class', sessionKey: 'class:2026-10-21', date: new Date('2026-10-21T06:00:00Z') }],
    SheetSlotCache: [{ id: 'singleton', slotsJson: '[{"slotKey":"Mon-1","grades":["초4"],"phone":"01012345678","note":"비밀"}]' }],
    RegularDispatchRoute: [{ id: 'dispatch', serviceMonth: '2026-10', payload: { vehicles: [{ stops: [{ studentName: '실제 이름', etaLabel: '14:38', phone: '01012345678', token: 'SECRET', address: '개인주소', label: '아파트 정문', latitude: 37.0, note: '비밀' }] }] } }],
  };
  const columns = {
    User: 'id name role username phone phoneVerifiedAt email authUserId', Student: 'id name parentId birthDate', Class: 'id name instructorId', Session: 'id classId sessionKey date', SheetSlotCache: 'id slotsJson', RegularDispatchRoute: 'id serviceMonth payload', ShuttleVehicle: 'id name capacity isActive plateNumber notes',
    ParentRequest: 'id userId studentId type title content date status createdAt updatedAt adminNote',
    EnrollmentChangeRequest: 'id studentId kind status effectiveFrom waitlisted reason decisionNote invoicedPaymentId',
    ApplicationContactLog: 'id targetType trialLeadId action nextFollowUpAt note createdByName',
  };
  return { calls, async query(sql, params) {
    calls.push({ sql, params });
    assert.match(sql, /^SELECT /);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|CREATE|DROP)\b/);
    if (sql.includes('information_schema')) return { rows: Object.entries(columns).flatMap(([table_name, fields]) => fields.split(' ').map((column_name) => ({ table_name, column_name, is_nullable: 'YES', data_type: 'text' }))) };
    if (sql.includes('lower("email")')) return { rows: adminFound ? [{ id: 'admin', role }] : [] };
    const name = sql.match(/FROM "public"\."([^"]+)"/)[1];
    return { rows: rows[name] ?? [] };
  } };
}

test('업무 자료·연결을 유지하고 인증정보는 새 값으로 만든다', async () => {
  const client = source();
  const snapshot = await capturePreviewSnapshot(client, { now: '2026-10-20T00:00:00Z' });
  const table = (name) => snapshot.tables.find((t) => t.name === name).rows;
  assert.equal(table('Student')[0].name, '실제 이름');
  assert.equal(table('Class')[0].name, '실제 반');
  assert.equal(snapshot.accounts.admin.id, 'admin');
  assert.equal(snapshot.accounts.teacher.id, 'teacher');
  assert.equal(snapshot.accounts.parent.id, 'parent');
  assert.match(snapshot.accounts.admin.email, /@preview\.invalid$/);
  assert.match(snapshot.accounts.admin.authId, /^[a-f\d-]{36}$/);
  assert.equal(table('User')[0].username, null);
  assert.match(table('User')[1].username, /^preview-/);
  const userSelect = client.calls.find((call) => call.sql.includes('FROM "public"."User"') && !call.sql.includes('lower("email")')).sql;
  assert.doesNotMatch(userSelect, /"email"|"authUserId"/);
  assert.match(userSelect, /CASE WHEN "phone" IS NULL/);
});

test('JSON 원문·주소·토큰·사진·연락처·좌표를 전달하지 않는다', async () => {
  const snapshot = await capturePreviewSnapshot(source());
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['01012345678', 'SECRET', '개인주소', '비밀', 'latitude']) assert.ok(!serialized.includes(secret));
  const slot = JSON.parse(snapshot.tables.find((t) => t.name === 'SheetSlotCache').rows[0].slotsJson)[0];
  assert.equal(slot.slotKey, 'Mon-1');
  assert.deepEqual(slot.grades, ['초4']);
  const stop = snapshot.tables.find((t) => t.name === 'RegularDispatchRoute').rows[0].payload.vehicles[0].stops[0];
  assert.equal(stop.studentName, '실제 이름');
  assert.equal(stop.etaLabel, '14:38');
  assert.equal(stop.label, '아파트 정문');
});

test('JSON 표시값의 지번 주소·일반전화·생년월일도 가린다', async () => {
  for (const text of ['다산동 123-4', '서울시 강남구 테헤란로 123', '101동 1001호', '0212345678', '031-123-4567', '2015-03-01', '20150301']) {
    const client = source();
    const query = client.query.bind(client);
    client.query = async (...args) => {
      const result = await query(...args);
      if (args[0].includes('FROM "public"."SheetSlotCache"')) return { rows: [{ id: 'singleton', slotsJson: JSON.stringify([{ label: text, slotKey: 'Mon-1' }]) }] };
      return result;
    };
    const snapshot = await capturePreviewSnapshot(client);
    const slot = JSON.parse(snapshot.tables.find((t) => t.name === 'SheetSlotCache').rows[0].slotsJson)[0];
    assert.equal(slot.label, '비공개', text);
    assert.equal(slot.slotKey, 'Mon-1');
  }
});

test('한국시각 월 경계와 연도 경계를 적용한다', async () => {
  const { summary } = await capturePreviewSnapshot(source(), { now: '2026-12-31T16:00:00Z' });
  assert.deepEqual(summary.timewindow.shuttleMonths, ['2027-01', '2027-02']);
  assert.equal(summary.timewindow.lessonsFrom, '2026-11-30T15:00:00.000Z');
  assert.equal(summary.timewindow.lessonsBefore, '2027-01-31T15:00:00.000Z');
  assert.equal(summary.timewindow.registrationMonth, '2027-01');
});

test('날짜가 포함된 수업 고유키 두 개와 실제 수업 일정을 보존한다', async () => {
  const snapshot = await capturePreviewSnapshot(source(), { now: '2026-10-20T00:00:00Z' });
  const sessions = snapshot.tables.find((table) => table.name === 'Session').rows;
  assert.deepEqual(sessions.map((row) => row.sessionKey), ['class:2026-10-20', 'class:2026-10-21']);
  assert.equal(new Set(sessions.map((row) => row.sessionKey)).size, 2);
  assert.deepEqual(sessions.map((row) => row.date.toISOString()), ['2026-10-20T06:00:00.000Z', '2026-10-21T06:00:00.000Z']);
});

test('차량 이름·정원·활성 상태만 읽고 번호판·메모는 조회하지 않는다', async () => {
  const client = source();
  const snapshot = await capturePreviewSnapshot(client);
  const vehicle = snapshot.tables.find((table) => table.name === 'ShuttleVehicle').rows[0];
  assert.deepEqual(vehicle, { id: 'vehicle', name: '1호차', capacity: 15, isActive: true });
  const sql = client.calls.find((call) => call.sql.includes('FROM "public"."ShuttleVehicle"')).sql;
  assert.doesNotMatch(sql, /plateNumber|notes/);
});

test('신청 상태·예약 이력은 유지하고 요청 원문·사유·담당자 이름은 읽지 않는다', async () => {
  const client = source();
  const snapshot = await capturePreviewSnapshot(client);
  const table = (name) => snapshot.tables.find((item) => item.name === name).rows;
  assert.equal(table('ParentRequest')[0].status, 'PENDING');
  assert.equal(table('ParentRequest')[0].title, '학부모 요청');
  assert.equal(table('ParentRequest')[0].content, '비공개');
  assert.equal(table('EnrollmentChangeRequest')[0].status, 'APPROVED');
  assert.equal(table('ApplicationContactLog')[0].action, 'CONTACTED');
  assert.equal(snapshot.summary.redactions.requestBodiesReplaced, 1);
  const parentSql = client.calls.find((call) => call.sql.includes('FROM "public"."ParentRequest"')).sql;
  assert.match(parentSql, /'학부모 요청' AS "title"/);
  assert.match(parentSql, /'비공개' AS "content"/);
  const changeSql = client.calls.find((call) => call.sql.includes('FROM "public"."EnrollmentChangeRequest"')).sql;
  const contactSql = client.calls.find((call) => call.sql.includes('FROM "public"."ApplicationContactLog"')).sql;
  assert.doesNotMatch(parentSql + changeSql + contactSql, /adminNote|reason|decisionNote|invoicedPaymentId|createdByName|"note"/);
});

test('관리자가 아니면 역할을 올려 만들지 않고 거부한다', async () => {
  await assert.rejects(capturePreviewSnapshot(source({ role: 'PARENT' })), /관리자 계정/);
  await assert.rejects(capturePreviewSnapshot(source({ adminFound: false })), /관리자 계정/);
});

test('요약에는 이름·안정 ID·연락처가 들어가지 않는다', async () => {
  const { summary } = await capturePreviewSnapshot(source());
  assert.doesNotMatch(JSON.stringify(summary), /실제 이름|관리자|student|01012345678/);
  assert.ok(summary.redactions.omittedTables.length > 0);
});

test('잘못된 기준일에는 원본 조회를 시작하지 않는다', async () => {
  const client = source();
  await assert.rejects(capturePreviewSnapshot(client, { now: 'invalid' }), /기준일/);
  assert.equal(client.calls.length, 0);
});
