package kr.stiz.driver;

public final class LocationSamplePolicyTest {
    private static int checks;
    private static void expect(LocationSamplePolicy.Decision expected, long now, long start, boolean hasSample, long sample, long last) {
        LocationSamplePolicy.Decision actual = LocationSamplePolicy.decide(now, start, hasSample, sample, last);
        if (actual != expected) throw new AssertionError("check " + (checks + 1) + ": " + actual + " != " + expected);
        checks++;
    }
    public static void main(String[] args) {
        long second = 1_000_000_000L;
        long start = 100 * second;
        expect(LocationSamplePolicy.Decision.WAIT_INITIAL, start, start, false, 0, 0);
        expect(LocationSamplePolicy.Decision.WAIT_INITIAL, start + 25 * second, start, false, 0, 0);
        expect(LocationSamplePolicy.Decision.WAIT_DELAYED, start + 25 * second + 1, start, false, 0, 0);
        expect(LocationSamplePolicy.Decision.SEND, start + 25 * second, start, true, start, 0);
        expect(LocationSamplePolicy.Decision.WAIT_DELAYED, start + 25 * second + 1, start, true, start, 0);
        expect(LocationSamplePolicy.Decision.DUPLICATE, start + second, start, true, start, start);
        // A failed attempt consumes this fix too: only a newer fix may be sent next.
        expect(LocationSamplePolicy.Decision.DUPLICATE, start + second, start, true, start, start + 1);
        expect(LocationSamplePolicy.Decision.SEND, start + second, start, true, start + second, start);
        expect(LocationSamplePolicy.Decision.WAIT_DELAYED, start, start, true, start + 1, 0);
        expect(LocationSamplePolicy.Decision.WAIT_DELAYED, start, start, true, 0, 0);
        expect(LocationSamplePolicy.Decision.WAIT_DELAYED, start, start, true, -1, 0);
        // Cached stale data stays stale regardless of its position in the sequence.
        expect(LocationSamplePolicy.Decision.WAIT_DELAYED, start + 26 * second, start, true, start, start);
        expect(LocationSamplePolicy.Decision.SEND, start + 100 * second, start, true, start + 100 * second, start);
        System.out.println("PASS " + checks + " location sample behavior checks");
    }
}
