-- migrate:up
-- Phase 5.5 P: difficulty and tags from problem.yaml (judge-admin import sets
-- them; the default only covers rows imported before this migration until the
-- next import). Tags come from the loader's controlled vocabulary.
ALTER TABLE problems
    ADD COLUMN difficulty text NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
    ADD COLUMN tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 5);
ALTER TABLE problems ALTER COLUMN difficulty DROP DEFAULT;

-- migrate:down
ALTER TABLE problems DROP COLUMN tags, DROP COLUMN difficulty;
