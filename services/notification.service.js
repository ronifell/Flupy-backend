const db = require('../config/database');
const { Expo } = require('expo-server-sdk');

let firebaseAdmin = null;
let expo = null;

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

/**
 * Send push notification to a specific user
 */
async function sendToUser(userId, notification) {
  try {
    // In a single-device test scenario, the same Expo token gets reassigned
    // to the last logged-in account because `push_tokens.token` is unique.
    // When enabled, we deliver to the active token(s) regardless of user_id
    // so notifications show up during the test.
    const singleDeviceMode = process.env.PUSH_SINGLE_DEVICE_MODE === '1';

    const tokens = singleDeviceMode
      ? await db.query(
          'SELECT token, platform FROM push_tokens WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 5'
        )
      : await db.query(
          'SELECT token, platform FROM push_tokens WHERE user_id = ? AND is_active = 1',
          [userId]
        );

    if (tokens.length === 0) return;

    const expoTokens = tokens.filter((t) => isExpoToken(t.token));
    const fcmTokens = tokens.filter((t) => !isExpoToken(t.token));

    // ── Expo Push (ExponentPushToken[...]) ────────────────────
    if (expoTokens.length > 0) {
      const expoClient = getExpo();
      const messages = expoTokens.map((t) => ({
        to: t.token,
        sound: 'default',
        title: notification.title,
        body: notification.body,
        data: notification.data || {},
      }));

      const chunks = expoClient.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        // Each ticket corresponds to chunk[i]
        const tickets = await expoClient.sendPushNotificationsAsync(chunk);

        for (let i = 0; i < tickets.length; i++) {
          const ticket = tickets[i];
          if (ticket.status === 'error') {
            const err = ticket.details?.error;
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
          title: notification.title,
          body: notification.body,
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
