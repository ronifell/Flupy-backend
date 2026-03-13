-- Migration: Allow NULL order_id in order_conversations for direct provider-customer chat
-- This enables customers to chat with providers without an active order

-- IMPORTANT: Before running this migration, find the foreign key constraint name:
-- Run: SHOW CREATE TABLE order_conversations;
-- Look for the CONSTRAINT name on the order_id foreign key (usually something like order_conversations_ibfk_1)
-- Replace 'order_conversations_ibfk_1' below with the actual constraint name from your database

-- Step 1: Drop the foreign key constraint on order_id
-- Replace 'order_conversations_ibfk_1' with the actual constraint name from SHOW CREATE TABLE
ALTER TABLE order_conversations DROP FOREIGN KEY order_conversations_ibfk_1;

-- Step 2: Remove UNIQUE constraint/index on order_id (since multiple conversations can have NULL)
ALTER TABLE order_conversations DROP INDEX order_id;

-- Step 3: Modify order_id to allow NULL
ALTER TABLE order_conversations MODIFY order_id INT UNSIGNED NULL;

-- Step 4: Recreate the foreign key constraint (only enforces for non-NULL values)
-- Note: MySQL foreign keys don't enforce for NULL values, which is what we want
ALTER TABLE order_conversations 
ADD CONSTRAINT fk_order_conversations_order 
FOREIGN KEY (order_id) REFERENCES service_orders(id) ON DELETE CASCADE;

-- Step 5: Add a new unique constraint that allows multiple NULLs but ensures one conversation per order
-- MySQL allows multiple NULLs in a UNIQUE constraint, so this works
-- This ensures: one conversation per order (when order_id is not NULL)
-- And allows multiple direct conversations (when order_id is NULL)
ALTER TABLE order_conversations ADD UNIQUE KEY uq_order_conversation (order_id, customer_id, provider_id);
