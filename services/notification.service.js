const db = require('../config/database');

let firebaseAdmin = null;

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

    const admin = getFirebaseAdmin();
    if (!admin) return;

    const messages = tokens.map((t) => ({
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

    const results = await Promise.allSettled(
      messages.map((msg) => admin.messaging().send(msg))
    );

    // Deactivate invalid tokens
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const errorCode = results[i].reason?.code;
        if (
          errorCode === 'messaging/invalid-registration-token' ||
          errorCode === 'messaging/registration-token-not-registered'
        ) {
          await db.query(
            'UPDATE push_tokens SET is_active = 0 WHERE token = ?',
            [tokens[i].token]
          );
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
