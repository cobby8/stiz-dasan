import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

const file = 'src/app/admin/students/StudentManagementClient.tsx';
// 개편 직전 소스를 고정해 이후 커밋 뒤에도 기존 동작과 대조합니다.
const baselineRevision = 'd251261ee860dd8895b2c144dd91ed828bc42140';
const before = execFileSync('git', ['show', `${baselineRevision}:${file}`], { encoding: 'utf8', maxBuffer: 4e6 });
const after = await readFile(file, 'utf8');
const filterBlock = source => source.slice(source.indexOf('    const filtered = useMemo('), source.indexOf('    const hasAnyFilter =')).replaceAll('\r\n', '\n');
assert.equal(filterBlock(after), filterBlock(before), '필터 AND·정렬·50명 페이지 초기화 원본 유지');
const loadBlock = source => source.slice(source.indexOf('    const loadData = useCallback('), source.indexOf('    // 기본 필터를')).replaceAll('\r\n', '\n');
assert.equal(loadBlock(after), loadBlock(before), '추가 조회·등록·연결·저장 함수 원본 유지');
const fixture = Array.from({ length: 67 }, (_, index) => ({
  id: `synthetic-${index}`, name: `합성학생${String(index).padStart(2, '0')}`, birthDate: '2015-01-01',
  gender: null, parentId: `parent-${index}`, createdAt: '2026-01-01', phone: null, address: null, enrollDate: null,
  school: index % 2 ? '합성초' : '테스트초', grade: index % 3 ? '초4' : '초5',
  parent: { name: index % 2 ? '합성보호자' : '테스트보호자', phone: '000-0000-0000', email: null },
  currentStatus: index < 54 ? 'ACTIVE' : index < 59 ? 'PAUSED' : index < 63 ? 'WITHDRAWN' : null,
  enrollments: index < 63 ? [{ classId: index % 2 ? 'class-a' : 'class-b', className: '합성반', status: index < 54 ? 'ACTIVE' : index < 59 ? 'PAUSED' : 'WITHDRAWN', dayOfWeek: 'MON', startTime: '15:00', slotKey: null }] : [],
}));
const classes = ['a', 'b'].map(key => ({ id: `class-${key}`, name: `합성반 ${key}`, dayOfWeek: 'MON', startTime: '15:00', endTime: '16:00', slotKey: null, program: null }));
const out = '.tmp/student-compact-filters'; await mkdir(out, { recursive: true });
await writeFile(`${out}/baseline.tsx`, before);
const globals = await readFile('src/app/globals.css', 'utf8');
const css = (await postcss([tailwind()]).process(globals.replace('@import "tailwindcss";', '@import "tailwindcss" source(none); @source "./admin/students/StudentManagementClient.tsx"; @source "../../.tmp/student-compact-filters/baseline.tsx"; @source "../components/academy/CompactListFilters.tsx";'), { from: 'src/app/globals.css' })).css + await readFile('src/app/academy-theme.css', 'utf8');
const harness = await startStatusBrowserHarness({ css, mocks: {
  '@/qa/before': ts.transpileModule(before.replaceAll('./ExcelUploadModal', '@/qa/ExcelUploadModal'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText,
  '@/qa/ExcelUploadModal': `export default function Excel(){return null}`,
  '@/app/actions/admin': `export async function createStudent(){throw Error('쓰기 차단')}export async function updateStudent(){throw Error('쓰기 차단')}export async function deleteStudent(){throw Error('쓰기 차단')}export async function enrollStudent(){throw Error('쓰기 차단')}`,
}, entry: `import React from'react';import{createRoot}from'react-dom/client';import Before from'@/qa/before';import After from'@/app/admin/students/StudentManagementClient';const Component=location.search.includes('before')?Before:After;createRoot(document.getElementById('root')).render(React.createElement('main',{className:'academy-app',style:{padding:16}},React.createElement(Component,{students:${JSON.stringify(fixture)},classes:${JSON.stringify(classes)},sheetImportSummary:null,sheetRetired:true})));` });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const checks = []; const check = (name, passed, detail) => { checks.push({ name, passed, detail }); assert.ok(passed, name + ' ' + JSON.stringify(detail)); };
const ids = page => page.locator('tbody a[href^="/admin/students/"]').evaluateAll(links => links.map(link => link.getAttribute('href').split('/').at(-1)));
try {
  const oldPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const newPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; for (const page of [oldPage, newPage]) { page.on('pageerror', error => errors.push(error.message)); await page.route('**/*', route => route.request().url().startsWith(harness.url + '/') ? route.continue() : route.abort()); }
  await oldPage.goto(harness.url + '/?before'); await newPage.goto(harness.url); await newPage.getByRole('heading', { name: '원생 관리' }).waitFor();
  check('기본 활성·50명 페이지 결과 동등', JSON.stringify(await ids(oldPage)) === JSON.stringify(await ids(newPage)) && (await ids(newPage)).length === 50);
  const beforeTable = await oldPage.locator('table').boundingBox(); const afterTable = await newPage.locator('table').boundingBox();
  check('기본 목록 시작 높이 절약', beforeTable.y - afterTable.y >= 80, { before: beforeTable.y, after: afterTable.y, saved: beforeTable.y - afterTable.y });
  await newPage.getByRole('button', { name: /필터/, exact: false }).first().click();
  for (const status of ['ACTIVE', '', 'PAUSED', 'WITHDRAWN', 'NONE']) {
    for (const [classId, grade, school, query] of [['', '', '', ''], ['class-a', '', '', ''], ['', '초5', '테스트초', ''], ['', '', '', '보호자'], ['class-b', '초4', '테스트초', '학생'], ['', '', '', '존재안함']]) {
      for (const [page, selectors] of [[oldPage, ['select', 'select', 'select', 'select']], [newPage, ['select', 'select', 'select', 'select']]]) {
        const selects = page.locator(selectors[0]); await selects.nth(0).selectOption(classId); await selects.nth(1).selectOption(grade); await selects.nth(2).selectOption(school); await selects.nth(3).selectOption(status);
        await page.locator('input').first().fill(query);
      }
      check(`동일 학생 ID ${status || '전체'}-${classId}-${grade}-${school}-${query}`, JSON.stringify(await ids(oldPage)) === JSON.stringify(await ids(newPage)));
    }
  }
  await newPage.getByRole('searchbox').fill('합성');
  await newPage.getByRole('button', { name: '필터 초기화', exact: true }).click();
  check('초기화는 활성 복원·검색 보존', await newPage.getByRole('combobox', { name: '수강 상태', exact: true }).inputValue() === 'ACTIVE' && await newPage.getByRole('searchbox').inputValue() === '합성');
  check('초기 활성은 추가조건 0개', await newPage.getByRole('button', { name: '필터 초기화', exact: true }).count() === 0);
  await newPage.getByRole('searchbox').fill('');
  await newPage.getByRole('combobox', { name: '학교', exact: true }).selectOption('합성초');
  await newPage.getByRole('button', { name: /필터/, exact: false }).first().click();
  await newPage.getByRole('button', { name: /필터/, exact: false }).first().click();
  check('접기 재열기 조건 유지', await newPage.getByRole('combobox', { name: '학교', exact: true }).inputValue() === '합성초');
  await newPage.getByRole('button', { name: '필터 초기화', exact: true }).click();
  await newPage.getByRole('button', { name: /필터/, exact: false }).first().click();
  await newPage.getByRole('button', { name: '50명 더 보기' }).click();
  check('더 보기 기존 50명에서54명 표시', (await ids(newPage)).length === 54);
  await newPage.getByRole('searchbox').fill('합성'); await newPage.getByRole('searchbox').fill('');
  check('검색 변경 후 페이지50명 초기화', (await ids(newPage)).length === 50);
  for (const width of [320, 360, 402, 750, 834, 1024, 1440]) {
    await newPage.setViewportSize({ width, height: width === 750 ? 292 : 900 });
    const collapsed = await newPage.getByRole('region', { name: '목록 검색과 필터' }).evaluate(element => { const r=element.getBoundingClientRect(); return {height:r.height, doc:document.documentElement.scrollWidth, inputSize:getComputedStyle(element.querySelector('input')).fontSize}; });
    check(`${width} 접힌 도구 모음 넘침 없음·17px 입력`, collapsed.doc <= width && parseFloat(collapsed.inputSize) >= 17, collapsed);
    await newPage.evaluate(() => window.scrollTo(0, 0));
    await newPage.screenshot({ path: `${out}/${width}-collapsed.png` });
    await newPage.getByRole('button', { name: /^tune 필터|^필터/ }).first().click();
    const boxes = await newPage.getByRole('combobox').evaluateAll(elements => elements.map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height,width:r.width};}));
    check(`${width} 펼친 필터44px·정렬`, boxes.length === 4 && boxes.every(box=>box.left>=0 && box.right<=width && box.height>=44 && box.width>100), boxes);
    await newPage.evaluate(() => window.scrollTo(0, 0));
    await newPage.screenshot({ path: `${out}/${width}-open.png` });
    await newPage.getByRole('button', { name: /^tune 필터|^필터/ }).first().click();
  }
  check('JS 오류 없음', errors.length === 0, errors);
} finally { await browser.close(); await harness.close(); }
await writeFile(`${out}/browser.json`, JSON.stringify({ source: '실제 원생 JSX+공통필터+Tailwind CSS, 고정 개편 전 JSX와 합성학생 ID 결과 직접 비교. 운영 API·저장·기기 미접속.', passed: checks.length + 2, checks }, null, 2));
console.log(`원생 컴팩트 필터 ${checks.length + 2}/${checks.length + 2} 통과`);
