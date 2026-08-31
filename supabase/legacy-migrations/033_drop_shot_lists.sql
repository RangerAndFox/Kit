-- Remove the Shot List Canvas feature (formerly Feature #11).
--
-- The feature and all of its code were deleted; this drops its only schema
-- object. Migration 018 (which created shot_lists) is kept as history so the
-- migration chain still replays cleanly on a fresh database.

DROP TABLE IF EXISTS shot_lists;
