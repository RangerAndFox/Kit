-- Delivery profiles: extra video filters (Feature #12).
--
-- Closes the "360 videos / unique formats" delivery cases. The render builder
-- prepends this to the scale step, so a profile can carry e.g. a v360
-- projection conversion ("v360=e:c3x2") or any other FFmpeg video-filter chain.
-- High-quality upres is handled in the builder itself (lanczos scaling).

ALTER TABLE delivery_profiles ADD COLUMN IF NOT EXISTS video_filters text;

COMMENT ON COLUMN delivery_profiles.video_filters IS
  'Extra FFmpeg -vf chain prepended to scaling (e.g. v360 for 360 video). Plain argv, no shell.';
