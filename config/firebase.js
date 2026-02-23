const admin = require('firebase-admin');
require('dotenv').config();

let firebaseApp = null;

function initializeFirebase() {
  if (firebaseApp) return firebaseApp;

  try {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
    });
    console.log('✅ Firebase initialized successfully');
  } catch (error) {
    console.warn('⚠️  Firebase initialization failed:', error.message);
    console.warn('   Push notifications will not work.');
  }

  return firebaseApp;
}

module.exports = { initializeFirebase, admin };
