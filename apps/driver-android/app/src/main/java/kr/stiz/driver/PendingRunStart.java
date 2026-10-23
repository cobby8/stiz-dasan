package kr.stiz.driver;

/** A user consent may resume after a permission dialog, never after an unrelated navigation. */
final class PendingRunStart {
    enum Step { NONE, LOCATION_PERMISSION, NOTIFICATION_PERMISSION, START }
    static final long LIFETIME_MS = 120_000;
    private String token;
    private long expiresAt;
    private boolean permissionPending;

    boolean consent(String requestedToken, long now) {
        if (requestedToken == null || requestedToken.isEmpty()) return false;
        if (token != null && now < expiresAt) return false;
        token = requestedToken; expiresAt = now + LIFETIME_MS; permissionPending = false;
        return true;
    }
    String token() { return token; }
    void cancel() { token = null; expiresAt = 0; permissionPending = false; }
    void permissionResult(boolean granted) {
        if (!granted) cancel();
        else permissionPending = false;
    }
    Step next(String currentToken, boolean visible, long now, boolean fineLocation, boolean notifications) {
        if (token == null) return Step.NONE;
        if (now >= expiresAt || !token.equals(currentToken)) { cancel(); return Step.NONE; }
        if (!visible || permissionPending) return Step.NONE;
        if (!fineLocation) { permissionPending = true; return Step.LOCATION_PERMISSION; }
        if (!notifications) { permissionPending = true; return Step.NOTIFICATION_PERMISSION; }
        cancel(); // Consume before starting the service; repeated resume cannot start it again.
        return Step.START;
    }
}
