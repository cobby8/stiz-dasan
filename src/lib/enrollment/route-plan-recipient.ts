import { createHash } from 'node:crypto';
/** 번호 자체를 안내 기준 키로 노출하지 않도록 계정 ID와 함께 묶는다. */
export function routeRecipientKey(parentId: string, phone: string) { return createHash('sha256').update(JSON.stringify({ parentId, phone: phone.replace(/\D/g, '') })).digest('hex'); }
