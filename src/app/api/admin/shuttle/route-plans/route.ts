import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guard';
import { getRoutePlans, mutateRoutePlan } from '@/lib/enrollment/route-plan-query';
import { shuttleReviewBody, shuttleReviewErrorResponse } from '@/lib/enrollment/shuttle-review-api';
import { dispatchConfirmedRouteVersion } from '@/lib/enrollment/route-plan-worker';
import { koreaServiceMonth } from '@/lib/regular/serviceMonth';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
    let actor;
    try {
        actor = await requireAdmin();
    }
    catch {
        return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
    }
    try {
        const p = new URL(request.url).searchParams;
        return NextResponse.json(await getRoutePlans(actor, p.get('month') ?? koreaServiceMonth(), true, p.get('id')), { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        return shuttleReviewErrorResponse(error);
    }
}
export async function POST(request: Request) {
    let actor;
    try {
        actor = await requireAdmin();
    }
    catch {
        return NextResponse.json({ error: '로그인이 필요합니다.' }, { status: 401 });
    }
    try {
        const result = await mutateRoutePlan(actor, await shuttleReviewBody(request), true);
        if ('versionId' in result && typeof result.versionId === 'string') {
            const dispatch = await dispatchConfirmedRouteVersion(result.versionId).catch(() => ({ status: 'PENDING_REVIEW' }));
            return NextResponse.json({ ...result, dispatch }, { headers: { 'Cache-Control': 'no-store' } });
        }
        return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        return shuttleReviewErrorResponse(error);
    }
}
