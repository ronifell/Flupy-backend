-- ============================================================
-- FLUPY Database Schema
-- Service Marketplace Application
-- ============================================================

CREATE DATABASE IF NOT EXISTS u608599528_Flupy_Database
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE u608599528_Flupy_Database;

-- ============================================================
-- 1. USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email           VARCHAR(255)    NOT NULL UNIQUE,
  password_hash   VARCHAR(255)    NOT NULL,
  full_name       VARCHAR(150)    NOT NULL,
  phone           VARCHAR(30)     NULL,
  role            ENUM('customer','provider') NOT NULL DEFAULT 'customer',
  avatar_url      VARCHAR(500)    NULL,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_role (role),
  INDEX idx_users_email (email)
) ENGINE=InnoDB;

-- ============================================================
-- 2. USER ADDRESSES
-- ============================================================
CREATE TABLE IF NOT EXISTS user_addresses (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED    NOT NULL,
  label           VARCHAR(100)    NULL,          -- e.g. "Home", "Office"
  address_line    VARCHAR(500)    NOT NULL,
  city            VARCHAR(150)    NULL,
  state           VARCHAR(150)    NULL,
  zip_code        VARCHAR(20)     NULL,
  latitude        DECIMAL(10,7)   NOT NULL,
  longitude       DECIMAL(10,7)   NOT NULL,
  is_default      TINYINT(1)      NOT NULL DEFAULT 0,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_addr_user (user_id)
) ENGINE=InnoDB;

-- ============================================================
-- 3. PROVIDER PROFILES
-- ============================================================
CREATE TABLE IF NOT EXISTS provider_profiles (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED    NOT NULL UNIQUE,
  bio             TEXT            NULL,
  is_verified     TINYINT(1)      NOT NULL DEFAULT 0,
  is_available    TINYINT(1)      NOT NULL DEFAULT 0,
  current_lat     DECIMAL(10,7)   NULL,
  current_lng     DECIMAL(10,7)   NULL,
  location_updated_at TIMESTAMP   NULL,
  stripe_customer_id  VARCHAR(255) NULL,
  stripe_subscription_id VARCHAR(255) NULL,
  membership_status   ENUM('none','active','past_due','canceled') NOT NULL DEFAULT 'none',
  membership_expires_at DATETIME  NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_prov_available (is_available, is_verified, membership_status),
  INDEX idx_prov_location (current_lat, current_lng)
) ENGINE=InnoDB;

-- ============================================================
-- 4. PROVIDER VERIFICATION DOCUMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS provider_documents (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id     INT UNSIGNED    NOT NULL,
  document_type   VARCHAR(100)    NOT NULL,      -- e.g. "ID", "License", "Certificate"
  document_url    VARCHAR(500)    NOT NULL,
  status          ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_at     TIMESTAMP       NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (provider_id) REFERENCES provider_profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 5. SERVICE CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS service_categories (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(100)    NOT NULL UNIQUE,
  slug            VARCHAR(100)    NOT NULL UNIQUE,
  description     TEXT            NULL,
  icon_url        VARCHAR(500)    NULL,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  sort_order      INT             NOT NULL DEFAULT 0,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ============================================================
-- 6. PROVIDER ↔ SERVICE (many-to-many)
-- ============================================================
CREATE TABLE IF NOT EXISTS provider_services (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id     INT UNSIGNED    NOT NULL,
  service_id      INT UNSIGNED    NOT NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_prov_svc (provider_id, service_id),
  FOREIGN KEY (provider_id) REFERENCES provider_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY (service_id) REFERENCES service_categories(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 7. SERVICE ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS service_orders (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  customer_id     INT UNSIGNED    NOT NULL,
  provider_id     INT UNSIGNED    NULL,
  service_id      INT UNSIGNED    NOT NULL,
  description     TEXT            NOT NULL,
  status          ENUM('CREATED','SEARCHING','ASSIGNED','IN_PROGRESS','COMPLETED','CANCELED')
                                  NOT NULL DEFAULT 'CREATED',
  order_mode      ENUM('ASAP','SCHEDULED') NOT NULL DEFAULT 'ASAP',
  address_id      INT UNSIGNED    NULL,
  address_text    VARCHAR(500)    NULL,
  latitude        DECIMAL(10,7)   NOT NULL,
  longitude       DECIMAL(10,7)   NOT NULL,
  cancel_reason   TEXT            NULL,
  assigned_at     TIMESTAMP       NULL,
  started_at      TIMESTAMP       NULL,
  completed_at    TIMESTAMP       NULL,
  canceled_at     TIMESTAMP       NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES users(id),
  FOREIGN KEY (provider_id) REFERENCES users(id),
  FOREIGN KEY (service_id)  REFERENCES service_categories(id),
  FOREIGN KEY (address_id)  REFERENCES user_addresses(id),
  INDEX idx_order_status (status),
  INDEX idx_order_customer (customer_id),
  INDEX idx_order_provider (provider_id),
  INDEX idx_order_mode (order_mode)
) ENGINE=InnoDB;

-- ============================================================
-- 8. ORDER APPOINTMENTS (Scheduled orders)
-- ============================================================
CREATE TABLE IF NOT EXISTS order_appointments (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id        INT UNSIGNED    NOT NULL,
  proposed_by     ENUM('customer','provider') NOT NULL DEFAULT 'customer',
  proposed_start  DATETIME        NOT NULL,
  proposed_end    DATETIME        NOT NULL,       -- typically +2 hours
  status          ENUM('PROPOSED','CONFIRMED','RESCHEDULE_REQUESTED','DECLINED')
                                  NOT NULL DEFAULT 'PROPOSED',
  reschedule_count INT            NOT NULL DEFAULT 0,
  response_note   TEXT            NULL,
  responded_at    TIMESTAMP       NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES service_orders(id) ON DELETE CASCADE,
  INDEX idx_appt_order (order_id)
) ENGINE=InnoDB;

-- ============================================================
-- 9. ORDER MEDIA (photos, before/after)
-- ============================================================
CREATE TABLE IF NOT EXISTS order_media (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id        INT UNSIGNED    NOT NULL,
  uploaded_by     INT UNSIGNED    NOT NULL,
  media_type      ENUM('photo','video','document') NOT NULL DEFAULT 'photo',
  media_url       VARCHAR(500)    NOT NULL,
  category        ENUM('problem','before','after','evidence') NOT NULL DEFAULT 'problem',
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id)    REFERENCES service_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB;

-- ============================================================
-- 10. ORDER ASSIGNMENT ATTEMPTS (audit)
-- ============================================================
CREATE TABLE IF NOT EXISTS order_assignment_attempts (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id        INT UNSIGNED    NOT NULL,
  attempt_number  INT             NOT NULL DEFAULT 1,
  search_radius_km DECIMAL(5,2)  NOT NULL,
  candidates_found INT           NOT NULL DEFAULT 0,
  assigned_provider_id INT UNSIGNED NULL,
  result          ENUM('ASSIGNED','NO_CANDIDATES','DECLINED','TIMEOUT') NOT NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES service_orders(id) ON DELETE CASCADE,
  INDEX idx_assign_order (order_id)
) ENGINE=InnoDB;

-- ============================================================
-- 11. ORDER ASSIGNMENT CANDIDATES (audit)
-- ============================================================
CREATE TABLE IF NOT EXISTS order_assignment_candidates (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  attempt_id      INT UNSIGNED    NOT NULL,
  provider_id     INT UNSIGNED    NOT NULL,
  distance_km     DECIMAL(7,2)    NOT NULL,
  rating          DECIMAL(3,2)    NULL,
  rating_count    INT             NOT NULL DEFAULT 0,
  rank_position   INT             NOT NULL,
  was_selected    TINYINT(1)      NOT NULL DEFAULT 0,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (attempt_id)  REFERENCES order_assignment_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ============================================================
-- 12. ORDER CONVERSATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS order_conversations (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id        INT UNSIGNED    NOT NULL UNIQUE,
  customer_id     INT UNSIGNED    NOT NULL,
  provider_id     INT UNSIGNED    NOT NULL,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id)    REFERENCES service_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES users(id),
  FOREIGN KEY (provider_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ============================================================
-- 13. CONVERSATION MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_messages (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT UNSIGNED    NOT NULL,
  sender_id       INT UNSIGNED    NOT NULL,
  message_text    TEXT            NULL,
  is_read         TINYINT(1)      NOT NULL DEFAULT 0,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES order_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id)       REFERENCES users(id),
  INDEX idx_msg_conv (conversation_id),
  INDEX idx_msg_read (is_read)
) ENGINE=InnoDB;

-- ============================================================
-- 14. MESSAGE ATTACHMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS message_attachments (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message_id      INT UNSIGNED    NOT NULL,
  file_url        VARCHAR(500)    NOT NULL,
  file_type       VARCHAR(50)     NOT NULL,      -- e.g. "image/jpeg", "application/pdf"
  file_name       VARCHAR(255)    NULL,
  file_size       INT UNSIGNED    NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES conversation_messages(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 15. ORDER RATINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS order_ratings (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id        INT UNSIGNED    NOT NULL,
  rater_id        INT UNSIGNED    NOT NULL,
  rated_id        INT UNSIGNED    NOT NULL,
  rating          TINYINT UNSIGNED NOT NULL,      -- 1-5
  comment         TEXT            NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rating (order_id, rater_id),
  FOREIGN KEY (order_id) REFERENCES service_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (rater_id) REFERENCES users(id),
  FOREIGN KEY (rated_id) REFERENCES users(id),
  INDEX idx_rating_rated (rated_id)
) ENGINE=InnoDB;

-- ============================================================
-- 16. USER RATING SUMMARY
-- ============================================================
CREATE TABLE IF NOT EXISTS user_rating_summary (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED    NOT NULL UNIQUE,
  average_rating  DECIMAL(3,2)    NOT NULL DEFAULT 0.00,
  total_ratings   INT UNSIGNED    NOT NULL DEFAULT 0,
  total_stars     INT UNSIGNED    NOT NULL DEFAULT 0,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 17. PUSH TOKENS
-- ============================================================
CREATE TABLE IF NOT EXISTS push_tokens (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED    NOT NULL,
  token           VARCHAR(500)    NOT NULL,
  platform        ENUM('ios','android','web') NOT NULL DEFAULT 'android',
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_push_token (token),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_push_user (user_id)
) ENGINE=InnoDB;

-- ============================================================
-- 18. AI SESSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_sessions (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED    NOT NULL,
  context         VARCHAR(50)     NOT NULL DEFAULT 'general', -- e.g. "order_help", "photo_guide"
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_ai_user (user_id)
) ENGINE=InnoDB;

-- ============================================================
-- 19. AI MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_messages (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id      INT UNSIGNED    NOT NULL,
  role            ENUM('user','assistant') NOT NULL,
  content         TEXT            NOT NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
  INDEX idx_ai_msg_session (session_id)
) ENGINE=InnoDB;

-- ============================================================
-- SEED DATA: Service Categories
-- ============================================================
INSERT INTO service_categories (name, slug, description, icon_url, sort_order) VALUES
  ('Electricity',       'electricity',        'Electrical repairs and installations',  'electricity.png',    1),
  ('Plumbing',          'plumbing',            'Pipe, faucet, and drain services',     'plumbing.png',       2),
  ('Air Conditioning',  'air-conditioning',    'AC repair, maintenance & installation','ac.png',             3),
  ('Refrigerators',     'refrigerators',       'Fridge and freezer repairs',           'fridge.png',         4),
  ('Washing Machines',  'washing-machines',    'Washer and dryer services',            'washer.png',         5),
  ('CCTV',              'cctv',                'Security camera installation & repair','cctv.png',           6),
  ('Painting',          'painting',            'Interior and exterior painting',       'painting.png',       7),
  ('Carpentry',         'carpentry',           'Wood and furniture repairs',           'carpentry.png',      8),
  ('General Handyman',  'general-handyman',    'Miscellaneous repair services',        'handyman.png',       9)
ON DUPLICATE KEY UPDATE name = VALUES(name);
