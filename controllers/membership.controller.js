const stripe = require('../config/stripe');
const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { t } = require('../i18n');
const notificationService = require('../services/notification.service');

/**
 * Create a Stripe checkout session for provider membership
 */
async function createCheckoutSession(req, res) {
  const userId = req.user.id;

  const [profile] = await db.query(
    'SELECT * FROM provider_profiles WHERE user_id = ?',
    [userId]
  );

  if (!profile) {
    throw new AppError('Provider profile not found', 404);
  }

  // Get or create Stripe customer
  let stripeCustomerId = profile.stripe_customer_id;

  if (!stripeCustomerId) {
    const [user] = await db.query('SELECT email, full_name FROM users WHERE id = ?', [userId]);
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.full_name,
      metadata: { flupy_user_id: userId.toString() },
    });
    stripeCustomerId = customer.id;
    await db.query(
      'UPDATE provider_profiles SET stripe_customer_id = ? WHERE user_id = ?',
      [stripeCustomerId, userId]
    );
  }

  // Get plan type from request (default to 'basic' if not provided)
  const { plan_type = 'basic' } = req.body;
  
  // Validate plan type
  if (!['basic', 'professional', 'premium'].includes(plan_type)) {
    throw new AppError('Invalid plan type. Must be basic, professional, or premium', 400);
  }

  // Map plan types to Stripe price IDs (you'll need to set these in your .env)
  const priceIdMap = {
    basic: process.env.STRIPE_BASIC_PRICE_ID || process.env.STRIPE_MONTHLY_PRICE_ID,
    professional: process.env.STRIPE_PROFESSIONAL_PRICE_ID || process.env.STRIPE_MONTHLY_PRICE_ID,
    premium: process.env.STRIPE_PREMIUM_PRICE_ID || process.env.STRIPE_MONTHLY_PRICE_ID,
  };

  const priceId = priceIdMap[plan_type];
  if (!priceId) {
    throw new AppError('Stripe price ID not configured for this plan', 500);
  }

  const session = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{
      price: priceId,
      quantity: 1,
    }],
    success_url: `${req.headers.origin || 'flupy://'}membership/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${req.headers.origin || 'flupy://'}membership/cancel`,
    metadata: { 
      flupy_user_id: userId.toString(),
      plan_type: plan_type,
    },
  });

  res.json({ session_id: session.id, url: session.url });
}

/**
 * Get membership status
 */
async function getMembershipStatus(req, res) {
  const userId = req.user.id;

  const [profile] = await db.query(
    'SELECT membership_status, membership_expires_at, stripe_subscription_id, subscription_plan FROM provider_profiles WHERE user_id = ?',
    [userId]
  );

  if (!profile) {
    throw new AppError('Provider profile not found', 404);
  }

  res.json({
    status: profile.membership_status,
    expires_at: profile.membership_expires_at,
    has_subscription: !!profile.stripe_subscription_id,
    plan: profile.subscription_plan || null,
  });
}

/**
 * Cancel membership subscription
 */
async function cancelMembership(req, res) {
  const userId = req.user.id;

  const [profile] = await db.query(
    'SELECT stripe_subscription_id FROM provider_profiles WHERE user_id = ?',
    [userId]
  );

  if (!profile || !profile.stripe_subscription_id) {
    throw new AppError('No active subscription found', 404);
  }

  await stripe.subscriptions.update(profile.stripe_subscription_id, {
    cancel_at_period_end: true,
  });

  const language = req.language || 'en';
  res.json({ message: t('messages.membershipCanceled', {}, language) });
}

/**
 * Handle Stripe webhooks
 */
async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook verification failed' });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata.flupy_user_id;
      const planType = session.metadata.plan_type || 'basic';
      if (session.subscription) {
        await db.query(
          `UPDATE provider_profiles
           SET stripe_subscription_id = ?, membership_status = 'active', subscription_plan = ?
           WHERE user_id = ?`,
          [session.subscription, planType, userId]
        );
        
        // Auto-set availability if provider is verified
        const updateAvailability = require('./provider.controller').updateAvailabilityIfEligible;
        if (updateAvailability) {
          await updateAvailability(userId, true); // true = use user_id instead of provider_id
        }
      }
      break;
    }

    case 'invoice.paid': {
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription;
      const periodEnd = new Date(invoice.lines.data[0]?.period?.end * 1000);
      await db.query(
        `UPDATE provider_profiles
         SET membership_status = 'active', membership_expires_at = ?
         WHERE stripe_subscription_id = ?`,
        [periodEnd, subscriptionId]
      );
      
      // Auto-set availability if provider is verified
      const [profiles] = await db.query(
        'SELECT id FROM provider_profiles WHERE stripe_subscription_id = ?',
        [subscriptionId]
      );
      if (profiles.length > 0) {
        const updateAvailability = require('./provider.controller').updateAvailabilityIfEligible;
        if (updateAvailability) {
          await updateAvailability(profiles[0].id, false); // false = use provider_id
        }
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const [profiles] = await db.query(
        'SELECT id FROM provider_profiles WHERE stripe_subscription_id = ?',
        [invoice.subscription]
      );
      await db.query(
        `UPDATE provider_profiles
         SET membership_status = 'past_due'
         WHERE stripe_subscription_id = ?`,
        [invoice.subscription]
      );
      // Auto-set availability (will set to 0 if not eligible)
      if (profiles.length > 0) {
        const updateAvailability = require('./provider.controller').updateAvailabilityIfEligible;
        if (updateAvailability) {
          await updateAvailability(profiles[0].id, false);
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const [profiles] = await db.query(
        'SELECT id FROM provider_profiles WHERE stripe_subscription_id = ?',
        [subscription.id]
      );
      await db.query(
        `UPDATE provider_profiles
         SET membership_status = 'canceled', stripe_subscription_id = NULL
         WHERE stripe_subscription_id = ?`,
        [subscription.id]
      );
      // Auto-set availability (will set to 0 since membership is canceled)
      if (profiles.length > 0) {
        const updateAvailability = require('./provider.controller').updateAvailabilityIfEligible;
        if (updateAvailability) {
          await updateAvailability(profiles[0].id, false);
        }
      }
      break;
    }

    default:
      break;
  }

  res.json({ received: true });
}

/**
 * Check for expiring memberships and send reminder notifications
 * Called periodically (e.g., via cron or a scheduled endpoint)
 */
async function checkExpiringMemberships(req, res) {

  try {
    // Find memberships expiring within 3 days
    const expiringSoon = await db.query(
      `SELECT pp.user_id, u.full_name, pp.membership_expires_at
       FROM provider_profiles pp
       JOIN users u ON u.id = pp.user_id
       WHERE pp.membership_status = 'active'
         AND pp.membership_expires_at IS NOT NULL
         AND pp.membership_expires_at <= DATE_ADD(NOW(), INTERVAL 3 DAY)
         AND pp.membership_expires_at > NOW()`
    );

    // Default to English for cron job notifications
    // TODO: Get user's language preference from database
    const defaultLang = 'en';
    
    for (const provider of expiringSoon) {
      const expiryDate = new Date(provider.membership_expires_at).toLocaleDateString();
      notificationService.sendToUser(provider.user_id, {
        title: t('notifications.membershipExpiringSoon.title', {}, defaultLang),
        body: t('notifications.membershipExpiringSoon.body', { date: expiryDate }, defaultLang),
        data: { type: 'membership_expiring' },
      });
    }

    // Find expired memberships that are still marked as active
    const expired = await db.query(
      `SELECT user_id FROM provider_profiles
       WHERE membership_status = 'active'
         AND membership_expires_at IS NOT NULL
         AND membership_expires_at < NOW()`
    );

    for (const provider of expired) {
      await db.query(
        `UPDATE provider_profiles SET membership_status = 'canceled', is_available = 0 WHERE user_id = ?`,
        [provider.user_id]
      );
      // Default to English for cron job notifications
      // TODO: Get user's language preference from database
      const defaultLang = 'en';
      notificationService.sendToUser(provider.user_id, {
        title: t('notifications.membershipExpired.title', {}, defaultLang),
        body: t('notifications.membershipExpired.body', {}, defaultLang),
        data: { type: 'membership_expired' },
      });
    }

    if (res) {
      const language = req.language || 'en';
      res.json({
        message: t('messages.membershipCheckComplete', {}, language),
        expiring_soon: expiringSoon.length,
        expired: expired.length,
      });
    }
  } catch (error) {
    console.error('Membership check error:', error.message);
    if (res) res.status(500).json({ error: 'Membership check failed' });
  }
}

module.exports = { createCheckoutSession, getMembershipStatus, cancelMembership, handleWebhook, checkExpiringMemberships };
