import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const rows = ids.map((id,index)=>({key:`stop-${index}`,kind:'REGULAR',direction:'PICKUP',groupKey:'same-trip',groupLabel:'합성 수업',label:`검증 정류장 ${index+1}`,subLabel:null,time:index?'14:45':'14:38',minutes:index?885:878,seq:index,lat:0,lng:0,isTerminal:false,isHub:false,pending:false,warn:false,riders:[{key:`R:${id}`,checkId:id,kind:'REGULAR',direction:'PICKUP',name:`합성학생${index+1}`,grade:null,parentPhone:null,studentPhone:null,absent:false}]}));
const fixture={token:'synthetic-only',date:'2026-10-19',today:'2026-10-19',prevDate:null,nextDate:null,driverLabel:'합성 기사',initialBoarding:{},rows};
const harness=await startStatusBrowserHarness({
  mocks:{'@/hooks/useGpsShare':`export function useGpsShare(){return{state:'off',transmission:'idle',lastSentAt:null,accuracy:null,start(){},async stop(){}};}`},
  entry:`import React from'react';import{createRoot}from'react-dom/client';import Driver from'@/components/shuttle/UnifiedDriverClient';const root=createRoot(document.getElementById('root'));window.__render=p=>root.render(React.createElement(Driver,p));window.addEventListener('test:refresh',()=>{window.__refreshCount++;window.__render({...window.fixture,rows:window.savedRows});});window.__render(window.fixture);`,
});
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const cases=[];
async function check(name,exercise,responseMode='success'){
 const page=await browser.newPage({viewport:{width:390,height:844}});const requests=[];let savedRows=structuredClone(rows);
 await page.addInitScript(data=>{window.fixture=data;window.savedRows=data.rows;window.__refreshCount=0;},fixture);
 await page.route('**/api/**',async route=>{
  assert.equal(new URL(route.request().url()).pathname,'/api/shuttle/regular-order');const body=route.request().postDataJSON();requests.push(body);
  const updated=new Set(body.updates.flatMap(item=>item.rowIds)).size;
  if(responseMode==='error')return route.fulfill({status:409,json:{error:'확정 배차가 변경되었습니다. 다시 열어 확인해 주세요.'}});
  if(responseMode==='zero')return route.fulfill({json:{ok:true,verified:true,updated:0}});
  if(responseMode==='unverified')return route.fulfill({json:{ok:true,updated}});
  savedRows=savedRows.map(row=>{const change=body.updates.find(item=>item.rowIds.includes(row.riders[0].checkId));return change?{...row,time:change.arriveTime,minutes:change.arriveTime?Number(change.arriveTime.slice(0,2))*60+Number(change.arriveTime.slice(3)):null,seq:change.sortOrder}:row;}).sort((a,b)=>(a.minutes??Infinity)-(b.minutes??Infinity)||a.seq-b.seq);
  await page.evaluate(data=>{window.savedRows=data;},savedRows);
  return route.fulfill({json:{ok:true,verified:true,updated}});
 });
 try{await page.goto(harness.url);await page.getByRole('button',{name:/순서·시간 수정/}).click();await exercise(page,requests);cases.push({name,pass:true});}
 catch(error){cases.push({name,pass:false,error:error.message});}finally{await page.close();}
}
const card=(page,n)=>page.locator('.academy-driver-stop').filter({hasText:`검증 정류장 ${n}`});
try{
 await check('위로 이동은 시간 칸도 옮겨 저장·재조회·취소 후 동일 순서 유지',async(page,requests)=>{
  await page.getByRole('button',{name:'검증 정류장 2 순서 위로'}).click();
  assert.equal(await page.locator('.academy-driver-stop').first().getAttribute('draggable'),'true');
  assert.match(await page.locator('.academy-driver-stop').first().innerText(),/정류장 2/);
  assert.equal(await card(page,2).getByLabel('검증 정류장 2 정차 시간').inputValue(),'14:38');
  assert.equal(await card(page,1).getByLabel('검증 정류장 1 정차 시간').inputValue(),'14:45');
  await page.getByRole('button',{name:'저장',exact:true}).click();await page.getByText('저장 완료 · 2개 행 반영').waitFor();
  assert.deepEqual(requests[0].updates.map(u=>[u.rowIds[0],u.arriveTime]),[[ids[1],'14:38'],[ids[0],'14:45']]);
  assert.deepEqual(requests[0].baseline.map(u=>[u.rowIds[0],u.arriveTime]),[[ids[0],'14:38'],[ids[1],'14:45']]);
  await page.waitForFunction(()=>window.__refreshCount===1);
  await page.getByRole('button',{name:/순서·시간 수정/}).click();await page.getByRole('button',{name:'취소',exact:true}).click();
  assert.match(await page.locator('.academy-driver-stop').first().innerText(),/정류장 2/);
 });
 await check('시간 직접 수정은 표시·저장 순서도 시각순으로 맞춘다',async(page,requests)=>{
  await card(page,1).getByLabel('검증 정류장 1 정차 시간').fill('14:50');
  assert.match(await page.locator('.academy-driver-stop').first().innerText(),/정류장 2/);
  await page.getByRole('button',{name:'저장',exact:true}).click();await page.getByText('저장 완료 · 2개 행 반영').waitFor();
  assert.deepEqual(requests[0].updates.map(u=>u.arriveTime),['14:45','14:50']);
 });
 await check('직접 수정 후 순서 이동도 현재 표시 시각 슬롯을 교환한다',async page=>{
  await card(page,1).getByLabel('검증 정류장 1 정차 시간').fill('14:40');await page.getByRole('button',{name:'검증 정류장 2 순서 위로'}).click();
  assert.equal(await card(page,2).getByLabel('검증 정류장 2 정차 시간').inputValue(),'14:40');
  assert.equal(await card(page,1).getByLabel('검증 정류장 1 정차 시간').inputValue(),'14:45');
 });
 await check('드래그 이동도 시간 슬롯을 교환한다',async page=>{
  await card(page,2).dispatchEvent('dragstart');await card(page,1).dispatchEvent('dragover');await card(page,1).dispatchEvent('drop');
  assert.equal(await card(page,2).getByLabel('검증 정류장 2 정차 시간').inputValue(),'14:38');
 });
 await check('저장 뒤 새 서버 시각은 이전 편집값에 가리지 않는다',async page=>{
  await card(page,1).getByLabel('검증 정류장 1 정차 시간').fill('14:40');await page.getByRole('button',{name:'저장',exact:true}).click();
  await page.waitForFunction(()=>window.__refreshCount===1);
  await page.evaluate(()=>window.__render({...window.fixture,rows:window.savedRows.map(row=>({...row,time:row.key==='stop-0'?'14:42':row.time,minutes:row.key==='stop-0'?882:row.minutes}))}));
  await page.getByRole('button',{name:/순서·시간 수정/}).click();
  assert.equal(await card(page,1).getByLabel('검증 정류장 1 정차 시간').inputValue(),'14:42');
 });
 await check('편집 중 서버 갱신은 편집 원본 baseline을 바꾸지 않는다',async(page,requests)=>{
  await card(page,1).getByLabel('검증 정류장 1 정차 시간').fill('14:40');
  await page.evaluate(()=>window.__render({...window.fixture,rows:window.fixture.rows.map(row=>({...row,time:row.key==='stop-0'?'14:42':row.time,minutes:row.key==='stop-0'?882:row.minutes}))}));
  assert.equal(await card(page,1).getByLabel('검증 정류장 1 정차 시간').inputValue(),'14:40');
  await page.getByRole('button',{name:'저장',exact:true}).click();await page.waitForFunction(()=>window.__refreshCount===1);
  assert.equal(requests[0].baseline[0].arriveTime,'14:38');
 });
 for(const mode of['zero','unverified','error'])await check(`저장 ${mode} 응답은 성공·새로고침 없이 편집 유지`,async(page,requests)=>{
  await card(page,1).getByLabel('검증 정류장 1 정차 시간').fill('14:40');await page.getByRole('button',{name:'저장',exact:true}).click();
  await page.getByText(mode==='error'?/확정 배차가 변경되었습니다/:/저장 결과를 확인하지 못했습니다/).waitFor();
  assert.equal(await page.getByRole('button',{name:'저장',exact:true}).count(),1);assert.equal(await page.evaluate(()=>window.__refreshCount),0);assert.equal(requests.length,1);
 },mode);
}finally{await browser.close();await harness.close();}
await mkdir('.tmp/driver-order-qa',{recursive:true});await writeFile('.tmp/driver-order-qa/browser.json',JSON.stringify(cases,null,2));
console.log(JSON.stringify({cases:cases.length,failed:cases.filter(c=>!c.pass)}));assert.ok(cases.every(c=>c.pass));
