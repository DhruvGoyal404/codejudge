-- migrate:up
-- Effective per-test time limit per language, in ms: the problem's limit times
-- the language multiplier, computed by the judge's own code at import
-- (problem.EffectiveTimeLimit). The problem page lists them; NULL until the
-- next `judge-admin import`.
ALTER TABLE problems ADD COLUMN time_limits_ms jsonb;

-- migrate:down
ALTER TABLE problems DROP COLUMN time_limits_ms;
