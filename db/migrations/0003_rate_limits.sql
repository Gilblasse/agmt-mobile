-- Counters for throttling callers we cannot identify.
--
-- The sign-in endpoints need no authentication, by design: a driver who has
-- lost their phone has no token to present. That leaves them reachable by
-- anyone. The per-driver cooldown and the per-code attempt limit bound how
-- fast codes can be issued and guessed, but they cannot tell the driver apart
-- from someone attacking them — so a stranger who knows a driver's name can
-- burn each code as it arrives and keep that driver locked out of their shift.
--
-- Held in the database rather than in process memory because the app is
-- expected to run as more than one instance; a counter per instance is not a
-- limit.
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket          text        PRIMARY KEY,
    window_started  timestamptz NOT NULL DEFAULT now(),
    hits            int         NOT NULL DEFAULT 0
);

-- Old windows are dead weight; a sweep can drop anything past its window.
CREATE INDEX IF NOT EXISTS rate_limits_window_started ON rate_limits (window_started);
