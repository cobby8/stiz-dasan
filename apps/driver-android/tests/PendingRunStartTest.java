package kr.stiz.driver;

public final class PendingRunStartTest {
    private static int checks;
    private static void check(boolean value) { if (!value) throw new AssertionError("check " + (checks + 1)); checks++; }
    public static void main(String[] args) {
        PendingRunStart flow = new PendingRunStart();
        check(flow.next("a", true, 1, true, true) == PendingRunStart.Step.NONE);
        check(flow.consent("a", 10));
        check(flow.next("a", true, 11, false, false) == PendingRunStart.Step.LOCATION_PERMISSION);
        check(flow.next("a", true, 12, false, false) == PendingRunStart.Step.NONE);
        flow.permissionResult(true);
        check(flow.next("a", false, 13, true, false) == PendingRunStart.Step.NONE);
        check(flow.next("a", true, 14, true, false) == PendingRunStart.Step.NOTIFICATION_PERMISSION);
        flow.permissionResult(true);
        check(flow.next("a", false, 15, true, true) == PendingRunStart.Step.NONE);
        check(flow.next("a", true, 16, true, true) == PendingRunStart.Step.START);
        check(flow.next("a", true, 17, true, true) == PendingRunStart.Step.NONE);
        check(flow.consent("a", 20));
        check(!flow.consent("a", 21));
        flow.cancel();
        check(flow.next("a", true, 22, true, true) == PendingRunStart.Step.NONE);
        check(flow.consent("a", 30));
        check(flow.next("a", true, 31, false, true) == PendingRunStart.Step.LOCATION_PERMISSION);
        flow.permissionResult(false);
        check(flow.next("a", true, 32, true, true) == PendingRunStart.Step.NONE);
        check(flow.consent("a", 40));
        check(flow.next("b", true, 41, true, true) == PendingRunStart.Step.NONE);
        check(flow.next("a", true, 42, true, true) == PendingRunStart.Step.NONE);
        check(flow.consent("a", 50));
        check(flow.next("a", true, 50 + PendingRunStart.LIFETIME_MS, true, true) == PendingRunStart.Step.NONE);
        check(!flow.consent("", 60));
        flow.permissionResult(true); // A late callback cannot resurrect canceled consent.
        check(flow.next("a", true, 61, true, true) == PendingRunStart.Step.NONE);
        check(flow.consent("a", 70));
        check(flow.next("a", true, 71, true, false) == PendingRunStart.Step.NOTIFICATION_PERMISSION);
        flow.permissionResult(false);
        check(flow.next("a", true, 72, true, true) == PendingRunStart.Step.NONE);
        check(flow.consent("a", 80));
        check(flow.next("a", false, 81, true, true) == PendingRunStart.Step.NONE);
        check(flow.next("a", true, 82, true, true) == PendingRunStart.Step.START);
        flow.permissionResult(true);
        check(flow.next("a", true, 83, true, true) == PendingRunStart.Step.NONE);
        check(flow.consent("a", 90));
        check(flow.next("a", true, 91, false, false) == PendingRunStart.Step.LOCATION_PERMISSION);
        check(flow.next("b", false, 92, true, true) == PendingRunStart.Step.NONE);
        flow.permissionResult(true);
        check(flow.next("a", true, 93, true, true) == PendingRunStart.Step.NONE);
        System.out.println("PASS " + checks + " pending-start behavior checks");
    }
}
