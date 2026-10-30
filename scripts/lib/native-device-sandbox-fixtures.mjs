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
