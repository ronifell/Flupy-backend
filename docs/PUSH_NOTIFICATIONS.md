# Push notifications (two devices)

## Production / real two-device testing

1. **Backend `.env`**
   - `PUSH_SINGLE_DEVICE_MODE=0` or remove the variable.
   - Do **not** use `PUSH_SINGLE_DEVICE_MODE=1` unless one physical phone logs into multiple accounts (Expo token is unique per install).

2. **Each device**
   - Install a build that includes notification permissions (e.g. Android `POST_NOTIFICATIONS`).
   - Log in as the intended user, allow notifications when prompted.

3. **Database**
   - Each user should have at least one active row in `push_tokens`:

   ```sql
   SELECT user_id, platform, is_active, updated_at FROM push_tokens ORDER BY updated_at DESC;
   ```

4. **Debug**
   - `PUSH_DEBUG=1` logs push sends and missing tokens. Turn off when finished.

## Single phone, multiple accounts (dev only)

Set `PUSH_SINGLE_DEVICE_MODE=1` as a workaround when the same device switches accounts.
