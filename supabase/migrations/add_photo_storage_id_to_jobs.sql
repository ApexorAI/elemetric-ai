-- Add photo_storage_id to jobs table
-- This links a saved job to its folder in Supabase Storage (job-photos bucket).
-- Path pattern: {user_id}/{photo_storage_id}/{item}-{timestamp}.jpg
alter table jobs
  add column if not exists photo_storage_id text;
