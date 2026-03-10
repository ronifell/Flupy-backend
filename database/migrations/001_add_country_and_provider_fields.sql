-- Migration: Add country and provider type fields
-- Run this script on existing databases to add the new fields

USE u608599528_Flupy_Database;

-- Add country field to users table (if it doesn't exist)
SET @exist := (SELECT COUNT(*) FROM information_schema.columns 
               WHERE table_schema = DATABASE() 
               AND table_name = 'users' 
               AND column_name = 'country');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE users ADD COLUMN country VARCHAR(100) NOT NULL DEFAULT ''DR'' AFTER phone',
  'SELECT ''Column country already exists in users''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add index for country (if it doesn't exist)
SET @exist := (SELECT COUNT(*) FROM information_schema.statistics 
               WHERE table_schema = DATABASE() 
               AND table_name = 'users' 
               AND index_name = 'idx_users_country');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE users ADD INDEX idx_users_country (country)',
  'SELECT ''Index idx_users_country already exists''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add provider type fields to provider_profiles table
SET @exist := (SELECT COUNT(*) FROM information_schema.columns 
               WHERE table_schema = DATABASE() 
               AND table_name = 'provider_profiles' 
               AND column_name = 'provider_type');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE provider_profiles ADD COLUMN provider_type ENUM(''Person'',''Company'') NOT NULL DEFAULT ''Person'' AFTER user_id',
  'SELECT ''Column provider_type already exists''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.columns 
               WHERE table_schema = DATABASE() 
               AND table_name = 'provider_profiles' 
               AND column_name = 'rnc');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE provider_profiles ADD COLUMN rnc VARCHAR(50) NULL AFTER provider_type',
  'SELECT ''Column rnc already exists''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.columns 
               WHERE table_schema = DATABASE() 
               AND table_name = 'provider_profiles' 
               AND column_name = 'personal_id');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE provider_profiles ADD COLUMN personal_id VARCHAR(50) NULL AFTER rnc',
  'SELECT ''Column personal_id already exists''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add index for provider_type
SET @exist := (SELECT COUNT(*) FROM information_schema.statistics 
               WHERE table_schema = DATABASE() 
               AND table_name = 'provider_profiles' 
               AND index_name = 'idx_prov_type');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE provider_profiles ADD INDEX idx_prov_type (provider_type)',
  'SELECT ''Index idx_prov_type already exists''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add country field to service_categories table
SET @exist := (SELECT COUNT(*) FROM information_schema.columns 
               WHERE table_schema = DATABASE() 
               AND table_name = 'service_categories' 
               AND column_name = 'country');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE service_categories ADD COLUMN country VARCHAR(100) NOT NULL DEFAULT ''DR'' AFTER icon_url',
  'SELECT ''Column country already exists in service_categories''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Drop old unique constraints if they exist (they may not exist)
-- Note: MySQL doesn't support IF EXISTS for constraints, so we'll handle errors gracefully
SET @exist := (SELECT COUNT(*) FROM information_schema.table_constraints 
               WHERE constraint_schema = DATABASE() 
               AND table_name = 'service_categories' 
               AND constraint_name = 'name');

SET @sqlstmt := IF(@exist > 0, 
  'ALTER TABLE service_categories DROP INDEX name',
  'SELECT "Index name does not exist"');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.table_constraints 
               WHERE constraint_schema = DATABASE() 
               AND table_name = 'service_categories' 
               AND constraint_name = 'slug');

SET @sqlstmt := IF(@exist > 0, 
  'ALTER TABLE service_categories DROP INDEX slug',
  'SELECT "Index slug does not exist"');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Drop old unique constraints if they exist
SET @exist := (SELECT COUNT(*) FROM information_schema.table_constraints 
               WHERE constraint_schema = DATABASE() 
               AND table_name = 'service_categories' 
               AND constraint_name = 'name');

SET @sqlstmt := IF(@exist > 0, 
  'ALTER TABLE service_categories DROP INDEX name',
  'SELECT ''Index name does not exist''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.table_constraints 
               WHERE constraint_schema = DATABASE() 
               AND table_name = 'service_categories' 
               AND constraint_name = 'slug');

SET @sqlstmt := IF(@exist > 0, 
  'ALTER TABLE service_categories DROP INDEX slug',
  'SELECT ''Index slug does not exist''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add new unique constraints with country
SET @exist := (SELECT COUNT(*) FROM information_schema.table_constraints 
               WHERE constraint_schema = DATABASE() 
               AND table_name = 'service_categories' 
               AND constraint_name = 'uq_service_country');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE service_categories ADD UNIQUE KEY uq_service_country (name, country)',
  'SELECT ''Constraint uq_service_country already exists''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.table_constraints 
               WHERE constraint_schema = DATABASE() 
               AND table_name = 'service_categories' 
               AND constraint_name = 'uq_slug_country');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE service_categories ADD UNIQUE KEY uq_slug_country (slug, country)',
  'SELECT ''Constraint uq_slug_country already exists''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add indexes for country
SET @exist := (SELECT COUNT(*) FROM information_schema.statistics 
               WHERE table_schema = DATABASE() 
               AND table_name = 'service_categories' 
               AND index_name = 'idx_service_country');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE service_categories ADD INDEX idx_service_country (country)',
  'SELECT ''Index idx_service_country already exists''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exist := (SELECT COUNT(*) FROM information_schema.statistics 
               WHERE table_schema = DATABASE() 
               AND table_name = 'service_categories' 
               AND index_name = 'idx_service_active');

SET @sqlstmt := IF(@exist = 0, 
  'ALTER TABLE service_categories ADD INDEX idx_service_active (is_active, country)',
  'SELECT ''Index idx_service_active already exists''');

PREPARE stmt FROM @sqlstmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Update existing service categories to have a default country
UPDATE service_categories SET country = 'DR' WHERE country IS NULL OR country = '';
