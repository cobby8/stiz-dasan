// 운영 조회 없이 새로 만든 합성 자료. 날짜만 실행일(KST)에 맞춘다.
export function sandboxFixtures(now = new Date(), { pendingChange = false } = {}) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const student = { id: 'sandbox-student', name: '합성 학생', birthDate: '2016-01-01', gender: null,
    enrollments: [{ id: 'sandbox-enrollment', classId: 'sandbox-class', className: '합성 초등 농구반', dayOfWeek: 'Wed', startTime: '16:00', endTime: '17:00', programName: '합성 농구' }],
    attendance: { total: 4, present: 3, absent: 1, late: 0, records: [] },
    payments: [{ id: 'sandbox-payment', amount: 120000, status: 'PENDING', dueDate: today, paidDate: null, invoiceId: null, description: '합성 수강료(결제 불가)' }] };
  const lesson = { id: 'sandbox-class', name: '합성 초등 농구반', startTime: '16:00', endTime: '17:00', location: '합성 체육관', studentCount: 1, sessionId: 'sandbox-session', sessionStatus: 'IN_PROGRESS', plannedContent: '합성 드리블', startedAt: null, kind: 'REGULAR', scheduleKey: 'sandbox-schedule', sessionDateId: null };
  const summary = { rosterId: 'sandbox-seat', studentId: student.id, amount: 120000, status: 'UNPAID', statusLabel: '미납', sourceLabel: '합성 청구(발행 불가)', note: null, paymentIds: ['sandbox-payment'], period: 'MONTHLY' };
  const driverRows = ['합성 다산푸르지오 정문', '합성 긴이름아파트 후문'].map((label, index) => ({
    key: `sandbox-stop-${index}`, label, time: index ? '15:05' : '14:38', minutes: index ? 905 : 878, seq: index + 1,
    kind: 'REGULAR', direction: 'PICKUP', groupKey: 'sandbox-group', groupLabel: '합성 농구반', subLabel: null,
    lat: null, lng: null, isHub: false, isTerminal: false, pending: false, warn: false,
    riders: [{ key: `R:sandbox-${index}`, checkId: `sandbox-${index}`, kind: 'REGULAR', direction: 'PICKUP', name: index ? '합성 학생 둘' : student.name, grade: '초4', parentPhone: null, studentPhone: null, absent: false }],
  }));
  const dashboard = { stats: { studentCount: 1, programCount: 1, coachCount: 1, classCount: 1 }, pendingRequests: [], pendingCount: 0,
    enrollStats: { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0, total: 0 },
    extendedStats: { thisMonthRevenue: 0, lastMonthRevenue: 0, attendanceRate: 75, unpaidCount: 1, unpaidAmount: 120000, monthlyRevenue: [], monthlyAttendance: [], programStudents: [] },
    todayClasses: [{ id: lesson.id, name: lesson.name, startTime: lesson.startTime, endTime: lesson.endTime, capacity: 12, programName: '합성 농구', enrolled: 1 }], recentStudents: [], todayLabel: `${today} 합성 시험` };
  const adminStudents = { students: [{ id: student.id, name: student.name, birthDate: student.birthDate, gender: null,
    parentId: 'sandbox-parent', phone: null, school: '합성 초등학교', grade: '초4', address: null,
    enrollDate: today, createdAt: `${today}T00:00:00Z`, currentStatus: 'ACTIVE',
    parent: { name: '합성 보호자', phone: null, email: null },
    enrollments: [{ classId: lesson.id, className: lesson.name, status: 'ACTIVE', dayOfWeek: 'Wed',
      startTime: '16:00', slotKey: null, createdAt: `${today}T00:00:00Z` }] }],
    classes: [{ id: lesson.id, name: lesson.name, dayOfWeek: 'Wed', startTime: '16:00', endTime: '17:00',
      slotKey: null, program: { id: 'sandbox-program', name: '합성 농구' } }] };
  const people = [{ id: student.id, name: student.name, school: '합성 초등학교', grade: '초4', studentPhone: null,
    todayStatus: null, guardians: [{ id: 'sandbox-parent', name: '합성 보호자', phone: null, relation: '보호자', isPrimary: true }],
    billing: { unpaidCount: 1, unpaidAmount: 120000 }, recentAttendance: { total: 4, present: 3, late: 0, absent: 1 },
    memo: '합성 자료 · 전화·문자·저장 불가' }];
  return { today, dashboard, summary, adminStudents, people,
    teacher: { dateKey: today, classes: [lesson] },
    session: { session: { id: lesson.sessionId, classId: lesson.id, className: lesson.name, startTime: lesson.startTime, endTime: lesson.endTime, location: lesson.location, studentCount: 1, status: 'IN_PROGRESS', plannedContent: '합성 드리블', content: null, notes: null, photos: [], startedAt: now.toISOString(), endedAt: null, sessionDateId: null },
      initialStudents: [{ id: 'sandbox-seat', attendanceKey: 'sandbox-seat', studentId: student.id, name: student.name, grade: '초4', phone: null, status: null, attendanceNote: null, arrivedAt: null, absenceReport: null }], initialView: 'attendance' },
    parent: { data: { parent: { id: 'sandbox-parent', name: '합성 보호자', email: '', phone: null }, children: [student] }, feedbacks: [], myRequests: [], notifications: [], unreadCount: 0, parentShuttleOverview: [], shuttleDriverContact: null },
    change: { initial: { effectiveFrom: today, minEffectiveFrom: today, maxEffectiveFrom: '2030-12-31', children: [{ studentId: student.id, studentName: student.name, enrollmentId: 'sandbox-enrollment', currentClassId: lesson.id, currentClassName: lesson.name, currentProgramName: '합성 농구', pending: pendingChange ? { id: 'sandbox-change', kind: 'CLASS_CHANGE', toClassName: '합성 다음 반', effectiveFrom: today, waitlisted: false } : null }], classes: [{ classId: 'sandbox-class-next', className: '합성 다음 반', programName: '합성 농구', dayOfWeek: 'Sat', startTime: '10:00', endTime: '11:00', capacity: 12, enrolled: 1, full: false }] } },
    driver: { token: 'sandbox-only', date: today, today, rows: driverRows, initialBoarding: {}, prevDate: null, nextDate: null, driverLabel: '합성 기사(위치 수집 없음)' },
  };
}

// 가족 연결 실기기용 합성 원장. 실제 계정·인증 공급자·DB를 사용하지 않는다.
export const SYNTHETIC_FAMILY = Object.freeze({ familyName: '합성 기존보호자', familyPhone: '00000000000', childName: '합성 자녀', childBirthDate: '2016-01-01' });
export function createSyntheticFamily({ issueId, now = () => Date.now() }) {
  const verified = new Set(), challenges = new Map();
  let request = null, linked = false;
  const actors = new Set(['requester', 'approver']);
  const fail = (status, error) => ({ status, body: { error, synthetic: true } });
  const row = () => ({ id: request.id, status: request.status, relation: request.relation, createdAt: request.createdAt });
  function state(actor) {
    if (!actors.has(actor)) return { enabled: false, verified: false, outgoing: [], incoming: [], synthetic: true };
    return { enabled: actors.has(actor), verified: verified.has(actor), synthetic: true,
      outgoing: actor === 'requester' && request ? [row()] : [],
      incoming: actor === 'approver' && verified.has(actor) && request ? [{ ...row(), childName: SYNTHETIC_FAMILY.childName, requesterName: '합성 추가보호자', requesterPhoneLast4: '0001' }] : [],
      syntheticAccess: verified.has(actor) && (actor === 'approver' || (actor === 'requester' && linked)) };
  }
  function command(actor, body) {
    if (!actors.has(actor) || !body || typeof body !== 'object' || Array.isArray(body)) return fail(403, '합성 시험 세션이 필요합니다.');
    if (body.action === 'start-verification') {
      for (const [key, value] of challenges) if (value.used || now() - value.issuedAt > 300000) challenges.delete(key);
      if (challenges.size >= 32) return fail(429, '합성 인증 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
      const id = issueId(); challenges.set(id, { actor, issuedAt: now(), completed: false, used: false });
      return { status: 200, body: { identityVerificationId: id, synthetic: true } };
    }
    if (body.action === 'complete-synthetic-verification' || body.action === 'cancel-synthetic-verification') {
      const challenge = challenges.get(body.identityVerificationId);
      if (!challenge || challenge.actor !== actor || challenge.used || challenge.completed || now() - challenge.issuedAt > 300000) return fail(409, '합성 인증 요청이 만료되었거나 이미 처리되었습니다.');
      if (body.action === 'cancel-synthetic-verification') { challenge.used = true; return { status: 200, body: { canceled: true, synthetic: true } }; }
      challenge.completed = true; return { status: 200, body: { completed: true, synthetic: true } };
    }
    if (body.action === 'verify') {
      const challenge = challenges.get(body.identityVerificationId);
      if (!challenge || challenge.actor !== actor || challenge.used || !challenge.completed || now() - challenge.issuedAt > 300000) return fail(409, '합성 인증 결과를 확인하지 못했습니다.');
      challenge.used = true; verified.add(actor);
      return { status: 200, body: { verified: true, linkedCount: actor === 'approver' ? 1 : linked ? 1 : 0, synthetic: true } };
    }
    if (!verified.has(actor)) return fail(403, '먼저 합성 본인인증을 완료해 주세요.');
    if (body.action === 'request') {
      if (actor !== 'requester' || linked || request?.status === 'PENDING') return fail(409, '진행 중이거나 완료된 합성 요청을 확인해 주세요.');
      if (body.familyName !== SYNTHETIC_FAMILY.familyName || body.familyPhone !== SYNTHETIC_FAMILY.familyPhone || body.childName !== SYNTHETIC_FAMILY.childName || (body.childBirthDate && body.childBirthDate !== SYNTHETIC_FAMILY.childBirthDate) || !['PARENT', 'OTHER'].includes(body.relation)) return fail(400, '입력한 정보로 연결 요청을 접수할 수 없습니다. 시험 안내의 합성 정보만 입력해 주세요.');
      request = { id: issueId(), status: 'PENDING', relation: body.relation, createdAt: new Date(now()).toISOString() };
      return { status: 200, body: { ok: true, synthetic: true } };
    }
    if (body.action === 'decide') {
      if (actor !== 'approver' || !request || request.status !== 'PENDING' || body.requestId !== request.id || !['APPROVE', 'REJECT'].includes(body.decision)) return fail(403, '기존 합성 보호자만 대기 요청을 처리할 수 있습니다.');
      request.status = body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'; linked = request.status === 'APPROVED';
      return { status: 200, body: { ok: true, synthetic: true } };
    }
    if (body.action === 'cancel') {
      if (actor !== 'requester' || !request || request.status !== 'PENDING' || body.requestId !== request.id) return fail(409, '취소할 합성 요청을 확인해 주세요.');
      request.status = 'CANCELED'; return { status: 200, body: { ok: true, synthetic: true } };
    }
    return fail(403, '격리 시험에서 지원하지 않는 요청입니다.');
  }
  return { state, command };
}
