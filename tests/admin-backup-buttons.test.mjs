import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('src/app/admin/AdminBackupButtons.tsx', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string') return node;
  return node?.props ? text(node.props.children) : '';
}
function find(node, predicate) {
  if (!node) return null;
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}
// 실제 클릭 함수는 실행하되 hook/JSX 상태만 가짜로 바꾼다. 브라우저·운영 fetch는 사용하지 않는다.
function fixture(options = {}) {
  const state = [];
  let cursor = 0;
  const calls = { fetch: 0, confirm: 0 };
  const dependencies = {
    react: {
      useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial;
        return [state[index], value => { state[index] = value; }]; },
      useRef(initial) { const index = cursor++; if (!(index in state)) state[index] = { current: initial }; return state[index]; },
    },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  };
  const exports = {};
  vm.compileFunction(code, ['require', 'exports', 'fetch', 'confirm'])(id => {
    assert.ok(Object.hasOwn(dependencies, id)); return dependencies[id];
  }, exports, async (url, request) => {
    calls.fetch++;
    assert.equal(url, '/api/admin/backup-now'); assert.equal(request.method, 'POST');
    if (options.wait) await options.wait;
    if (options.throw) throw new Error('synthetic secret');
    return { ok: options.ok ?? false, json: async () => options.body ?? {} };
  }, () => { calls.confirm++; return options.confirm ?? true; });
  const render = () => { cursor = 0; return exports.default(); };
  return { calls, click: () => find(render(), node => node.type === 'button' && text(node).includes('설정 백업 지금 저장')).props.onClick(),
    message: () => find(render(), node => node.props?.role === 'status') };
}

test('정상 응답만 완료 표시하고 전체 DB라고 표시하지 않는다', async () => {
  const f = fixture({ ok: true, body: { success: true, filename: 'backup.json' } });
  await f.click();
  assert.match(text(f.message()), /설정 백업 저장 완료/);
  assert.match(f.message().props.className, /text-green/);
  assert.equal(f.calls.fetch, 1);
});

for (const [body, pattern] of [
  [{ backupSaved: true, filename: 'candidate.json' }, /저장됐지만.*정리.*재저장하지/],
  [{ backupSaved: null, filename: 'candidate.json' }, /저장 여부 확인 필요.*candidate.json/],
  [{ backupSaved: false, error: 'synthetic secret' }, /완료하지 못했습니다/],
  [{ success: true }, /완료하지 못했습니다/],
]) {
  test(`비정상 응답은 완료색이나 자동 재시도로 처리하지 않는다: ${JSON.stringify(body)}`, async () => {
    const f = fixture({ body }); await f.click();
    assert.match(text(f.message()), pattern);
    assert.doesNotMatch(text(f.message()), /synthetic secret/);
    assert.match(f.message().props.className, /text-yellow/);
    assert.equal(f.calls.fetch, 1);
  });
}

test('응답 전체 유실도 미저장으로 단정하지 않는다', async () => {
  const f = fixture({ throw: true }); await f.click();
  assert.match(text(f.message()), /저장됐을 수 있으니/);
  assert.equal(f.calls.fetch, 1);
});

test('진행 중 중복 클릭은 요청 하나만 보내고 확인 취소는 요청하지 않는다', async () => {
  let resolve;
  const wait = new Promise(done => { resolve = done; });
  const f = fixture({ wait });
  const first = f.click(); await f.click();
  assert.equal(f.calls.fetch, 1);
  resolve(); await first;
  const canceled = fixture({ confirm: false }); await canceled.click();
  assert.equal(canceled.calls.fetch, 0);
});
