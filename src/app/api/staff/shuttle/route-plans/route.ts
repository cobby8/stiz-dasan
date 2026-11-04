import { NextResponse } from 'next/server';
import { requireStaff } from '@/lib/auth-guard';
import { getRoutePlans, mutateRoutePlan } from '@/lib/enrollment/route-plan-query';
import { shuttleReviewBody, shuttleReviewErrorResponse } from '@/lib/enrollment/shuttle-review-api';
import { koreaServiceMonth } from '@/lib/regular/serviceMonth';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
    let actor;
    try {
        actor = await requireStaff();
    }
    catch {
        return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
    }
    try {
        const p = new URL(request.url).searchParams;
        return NextResponse.json(await getRoutePlans(actor, p.get('month') ?? koreaServiceMonth(), false, p.get('id')), { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        return shuttleReviewErrorResponse(error);
    }
}
export async function POST(request: Request) {
    let actor;
    try {
        actor = await requireStaff();
    }
    catch {
        return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
    }
    try {
        return NextResponse.json(await mutateRoutePlan(actor, await shuttleReviewBody(request), false), { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        return shuttleReviewErrorResponse(error);
    }
}
