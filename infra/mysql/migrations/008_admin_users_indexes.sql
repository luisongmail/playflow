-- ============================================================
-- Migration 008: Admin users query indexes
-- Indexes to support filtered, paginated user listing
-- without full-table scans at volume.
-- ============================================================

-- Composite index for the most common admin query pattern:
-- status filter + created_at ORDER BY
ALTER TABLE users
  ADD INDEX idx_users_status_created (status, created_at DESC);

-- Full-text index for name/email search (avoids LIKE '%...%' full scans)
ALTER TABLE users
  ADD FULLTEXT INDEX idx_users_ft_search (email, display_name);

-- Composite index for role_assignments JOIN used in user listing:
-- (user_id, resource_type, resource_id, status) covers the LEFT JOIN condition
ALTER TABLE role_assignments
  ADD INDEX idx_ra_listing (user_id, resource_type, resource_id, status);

-- Composite index for mfa_enabled filter
ALTER TABLE users
  ADD INDEX idx_users_mfa_status (mfa_enabled, status);
