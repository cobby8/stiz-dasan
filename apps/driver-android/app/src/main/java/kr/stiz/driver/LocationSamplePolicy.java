package kr.stiz.driver;

/** Uses monotonic time only; waiting must never turn an old coordinate into a new send. */
final class LocationSamplePolicy {
    static final long MAX_AGE_NANOS = 25_000_000_000L;
    enum Decision { WAIT_INITIAL, WAIT_DELAYED, DUPLICATE, SEND }

    static Decision decide(long now, long startedAt, boolean hasSample, long sampledAt, long lastAttemptedSample) {
        if (!hasSample) return now - startedAt <= MAX_AGE_NANOS ? Decision.WAIT_INITIAL : Decision.WAIT_DELAYED;
        if (sampledAt <= 0 || sampledAt > now || now - sampledAt > MAX_AGE_NANOS) return Decision.WAIT_DELAYED;
        if (sampledAt <= lastAttemptedSample) return Decision.DUPLICATE;
        return Decision.SEND;
    }

    private LocationSamplePolicy() { }
}
