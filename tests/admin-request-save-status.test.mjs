import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// 실제 액션 본문을 격리 실행한다. 운영 DB·푸시에는 연결하지 않는다.
function fixture(options = {}) {
  const source = readFileSync('src/app/actions/admin.ts', 'utf8');
  const body = source.slice(source.indexOf('export async function updateRequestStatus'), source.indexOf('// 요청 삭제 (관리자)'));
  const exports = {};
  let row = options.missing ? null : { id: 'request-test', userId: 'parent-test', title: '문의', status: 'PENDING', adminNote: '기존 메모' };
  const calls = { update: 0, notification: 0, push: 0 };
  vm.runInNewContext(ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    exports,
    async requireAdmin() { if (options.denied) throw new Error('FORBIDDEN'); },
    revalidateRequestAdminCaches() {}, revalidatePath() {},
    prisma: {
      async $queryRawUnsafe(sql, ...args) {
        if (sql.startsWith('SELECT')) { if (options.readFails) throw new Error('unavailable'); return row ? [{ ...row }] : []; }
        calls.update++;
        if (options.writeFails) throw new Error('response lost');
        if (options.conflict) return [];
        row = { ...row, status: args[0], adminNote: args[1] };
        return [{ id: row.id }];
      },
      async $executeRawUnsafe() { calls.notification++; if (options.notificationFails) throw new Error('response lost'); },
    },
    require(name) {
      assert.equal(name, '@/lib/pushNotification');
      return { async sendPushToUser() { calls.push++; if (options.pushFails) throw new Error('push failed'); return { status: options.pushStatus ?? 'SENT' }; } };
    },
  });
  return { ...exports, calls, row: () => row };
}

test('관리자 외 사용자는 조회·변경을 할 수 없다', async () => {
  const f = fixture({ denied: true });
  await assert.rejects(f.updateRequestStatus('request-test', 'COMPLETED'), /FORBIDDEN/);
  await assert.rejects(f.getParentRequestStatusForAdmin('request-test'), /FORBIDDEN/);
  assert.equal(f.calls.update, 0);
});
test('잘못된 상태·과도한 메모·없는 대상을 쓰기 전에 거부한다', async () => {
  const f = fixture();
  await assert.rejects(f.updateRequestStatus('request-test', 'INVENTED'));
  await assert.rejects(f.updateRequestStatus('request-test', 'COMPLETED', 'a'.repeat(2001)));
  await assert.rejects(fixture({ missing: true }).updateRequestStatus('request-test', 'COMPLETED'));
  assert.equal(f.calls.update, 0);
});
test('메모 미입력은 기존 메모를 보존하고 동일 재시도는 알림을 중복 생성하지 않는다', async () => {
  const f = fixture();
  const first = await f.updateRequestStatus('request-test', 'COMPLETED');
  assert.equal(first.saved, true); assert.equal(first.notification, 'REGISTERED'); assert.equal(first.push, 'SENT');
  assert.equal(f.row().adminNote, '기존 메모');
  const repeat = await f.updateRequestStatus('request-test', 'COMPLETED');
  assert.equal(repeat.notification, 'UNCHANGED');
  assert.deepEqual(f.calls, { update: 1, notification: 1, push: 1 });
});
test('저장 실패·동시 수정은 알림을 보내지 않고 결과 확인 필요로 반환한다', async () => {
  for (const options of [{ writeFails: true }, { conflict: true }]) {
    const f = fixture(options); const result = await f.updateRequestStatus('request-test', 'COMPLETED', '답변');
    assert.equal(result.saved, false); assert.equal(result.notification, 'UNKNOWN');
    assert.equal(f.calls.notification, 0); assert.equal(f.calls.push, 0);
  }
});
test('사이트 알림 오류가 이미 저장된 상담 상태를 실패로 되돌리지 않는다', async () => {
  const f = fixture({ notificationFails: true }); const result = await f.updateRequestStatus('request-test', 'COMPLETED', '답변');
  assert.equal(result.saved, true); assert.equal(result.notification, 'UNKNOWN');
  assert.equal(f.row().status, 'COMPLETED'); assert.equal(f.calls.push, 0);
  await f.updateRequestStatus('request-test', 'COMPLETED', '답변');
  assert.equal(f.calls.notification, 1);
});
test('푸시 미등록·부분 실패·오류를 사이트 알림 등록 결과와 분리한다', async () => {
  for (const options of [{ pushStatus: 'NO_SUBSCRIPTION' }, { pushStatus: 'PARTIAL' }, { pushFails: true }]) {
    const f = fixture(options); const result = await f.updateRequestStatus('request-test', 'COMPLETED', '답변');
    assert.equal(result.saved, true); assert.equal(result.notification, 'REGISTERED');
    assert.equal(result.push, options.pushStatus ?? 'UNKNOWN');
  }
});
