const db = require('../config/database');
const { Expo } = require('expo-server-sdk');

let firebaseAdmin = null;
let expo = null;
let singleDeviceModeWarned = false;

/**
 * Initialize Firebase Admin SDK (lazy load)
 */
function getFirebaseAdmin() {
  if (!firebaseAdmin) {
    try {
      const { initializeFirebase, admin } = require('../config/firebase');
      initializeFirebase();
      firebaseAdmin = admin;
    } catch (err) {
      console.warn('Firebase not available, push notifications disabled');
    }
  }
  return firebaseAdmin;
}

/**
 * Lazy init Expo SDK (for ExponentPushToken[...] tokens)
 */
function getExpo() {
  if (!expo) {
    expo = new Expo();
  }
  return expo;
}

function isExpoToken(token) {
  try {
    return Expo.isExpoPushToken(token);
  } catch {
    return false;
  }
}

/** Shown in notification tray / banner so users see it is from Flupy (not a generic Expo client). */
const PUSH_APP_NAME = 'Flupy';

function brandPushTitle(title) {
  if (title == null || String(title).trim() === '') {
    return PUSH_APP_NAME;
  }
  const t = String(title).trim();
  if (/^flupy\s*([\u00b7\u2022]|\.|\||:|\-|\u2014)/i.test(t)) {
    return t;
  }
  return PUSH_APP_NAME + ' \u00b7 ' + t;
}

/**
 * Send push notification to a specific user
 */
async function sendToUser(userId, notification) {
  try {
    // Production / two devices: omit PUSH_SINGLE_DEVICE_MODE or set "0".
    // Notifications go only to tokens for userId (the recipient).
    // PUSH_SINGLE_DEVICE_MODE=1 only for one phone switching accounts (shared Expo token).
    const singleDeviceMode = process.env.PUSH_SINGLE_DEVICE_MODE === '1';
    if (singleDeviceMode && !singleDeviceModeWarned) {
      singleDeviceModeWarned = true;
      console.warn('[Push] PUSH_SINGLE_DEVICE_MODE=1 ignores recipient user_id. Set to 0 for two-device chat.');
    }

    const tokens = singleDeviceMode
      ? await db.query(
          'SELECT token, platform FROM push_tokens WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 5'
        )
      : await db.query(
          'SELECT token, platform FROM push_tokens WHERE user_id = ? AND is_active = 1',
          [userId]
        );

    const expoTokens = tokens.filter((t) => isExpoToken(t.token));
    const fcmTokens = tokens.filter((t) => !isExpoToken(t.token));
    const debug = process.env.PUSH_DEBUG === '1';

    if (tokens.length === 0) {
      if (debug) {
        console.log('[Push] No active tokens for user', { userId, singleDeviceMode });
      }
      return;
    }

    const pushTitle = brandPushTitle(notification.title);
    const pushBody = notification.body;

    if (debug) {
      console.log('[Push] sendToUser', {
        userId,
        singleDeviceMode,
        total_tokens: tokens.length,
        expo_tokens: expoTokens.length,
        fcm_tokens: fcmTokens.length,
        title: pushTitle,
      });
    }

    // ── Expo Push (ExponentPushToken[...]) ────────────────────
    if (expoTokens.length > 0) {
      const expoClient = getExpo();
      const messages = expoTokens.map((t) => ({
        to: t.token,
        sound: 'default',
        title: pushTitle,
        body: pushBody,
        channelId: 'flupy_orders',
        priority: 'high',
        data: notification.data || {},
      }));

      const chunks = expoClient.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        // Each ticket corresponds to chunk[i]
        const tickets = await expoClient.sendPushNotificationsAsync(chunk);
        if (debug) console.log('[Push] Expo tickets:', tickets);

        for (let i = 0; i < tickets.length; i++) {
          const ticket = tickets[i];
          if (ticket.status === 'error') {
            const err = ticket.details?.error;
            if (debug) console.warn('[Push] Expo error ticket:', ticket);
            if (err === 'DeviceNotRegistered') {
              const badToken = chunk[i]?.to;
              if (badToken) {
                await db.query('UPDATE push_tokens SET is_active = 0 WHERE token = ?', [badToken]);
              }
            }
          }
        }
      }
    }

    // ── FCM Push (if you later store real FCM registration tokens) ──
    if (fcmTokens.length > 0) {
      const admin = getFirebaseAdmin();
      if (!admin) return;

      const messages = fcmTokens.map((t) => ({
        token: t.token,
        notification: {
          title: pushTitle,
          body: pushBody,
        },
        data: notification.data
          ? Object.fromEntries(Object.entries(notification.data).map(([k, v]) => [k, String(v)]))
          : {},
        ...(t.platform === 'android' && {
          android: {
            priority: 'high',
            notification: { channelId: 'flupy_orders' },
          },
        }),
        ...(t.platform === 'ios' && {
          apns: {
            payload: { aps: { sound: 'default', badge: 1 } },
          },
        }),
      }));

      const results = await Promise.allSettled(messages.map((msg) => admin.messaging().send(msg)));

      // Deactivate invalid tokens
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          const errorCode = results[i].reason?.code;
          if (
            errorCode === 'messaging/invalid-registration-token' ||
            errorCode === 'messaging/registration-token-not-registered'
          ) {
            await db.query('UPDATE push_tokens SET is_active = 0 WHERE token = ?', [fcmTokens[i].token]);
          }
        }
      }
    }
  } catch (error) {
    console.error('Push notification error:', error.message);
  }
}

/**
 * Send push notification to multiple users
 */
async function sendToUsers(userIds, notification) {
  await Promise.allSettled(
    userIds.map((userId) => sendToUser(userId, notification))
  );
}

module.exports = { sendToUser, sendToUsers };
