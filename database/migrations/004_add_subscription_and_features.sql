-- Migration: Add subscription plan, accreditation tier, blood donor network, and profile picture requirements
-- Date: 2024

USE u608599528_Flupy_Database;

-- ============================================================
-- 1. Add subscription_plan to provider_profiles
-- ============================================================
ALTER TABLE provider_profiles
ADD COLUMN subscription_plan ENUM('basic', 'professional', 'premium') NULL DEFAULT NULL AFTER membership_status;

-- ============================================================
-- 2. Add accreditation_tier to provider_profiles
-- ============================================================
ALTER TABLE provider_profiles
ADD COLUMN accreditation_tier VARCHAR(50) NULL DEFAULT NULL AFTER subscription_plan;

-- ============================================================
-- 3. Create blood_donor_network table
-- ============================================================
CREATE TABLE IF NOT EXISTS blood_donor_network (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED    NOT NULL UNIQUE,
  is_registered   TINYINT(1)      NOT NULL DEFAULT 0,
  blood_type      VARCHAR(10)     NULL,              -- e.g. "A+", "B-", "O+", "AB+"
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_blood_donor_user (user_id),
  INDEX idx_blood_type (blood_type)
) ENGINE=InnoDB;

-- ============================================================
-- 4. Add profile_picture_url to provider_profiles for verification
-- ============================================================
ALTER TABLE provider_profiles
ADD COLUMN profile_picture_url VARCHAR(500) NULL DEFAULT NULL AFTER membership_expires_at;

-- ============================================================
-- 5. Update provider_documents to track profile picture separately
-- ============================================================
ALTER TABLE provider_documents
ADD COLUMN is_profile_picture TINYINT(1) NOT NULL DEFAULT 0 AFTER document_type;

-- ============================================================
-- Index for faster accreditation tier queries
-- ============================================================
CREATE INDEX idx_provider_accreditation ON provider_profiles(accreditation_tier);
