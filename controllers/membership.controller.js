const stripe = require('../config/stripe');
const db = require('../config/database');
const { AppError } = require('../middleware/errorHandler');

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

  const session = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    payment_method_types: ['card'],
    mode: 'subscription',
    line_items: [{
      price: process.env.STRIPE_MONTHLY_PRICE_ID,
      quantity: 1,
    }],
    success_url: `${req.headers.origin || 'flupy://'}membership/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${req.headers.origin || 'flupy://'}membership/cancel`,
    metadata: { flupy_user_id: userId.toString() },
  });

  res.json({ session_id: session.id, url: session.url });
}

/**
 * Get membership status
 */
async function getMembershipStatus(req, res) {
  const userId = req.user.id;

  const [profile] = await db.query(
    'SELECT membership_status, membership_expires_at, stripe_subscription_id FROM provider_profiles WHERE user_id = ?',
    [userId]
  );

  if (!profile) {
    throw new AppError('Provider profile not found', 404);
  }

  res.json({
    status: profile.membership_status,
    expires_at: profile.membership_expires_at,
    has_subscription: !!profile.stripe_subscription_id,
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

  res.json({ message: 'Membership will be canceled at the end of the billing period' });
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
      if (session.subscription) {
        await db.query(
          `UPDATE provider_profiles
           SET stripe_subscription_id = ?, membership_status = 'active'
           WHERE user_id = ?`,
          [session.subscription, userId]
        );
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
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      await db.query(
        `UPDATE provider_profiles
         SET membership_status = 'past_due'
         WHERE stripe_subscription_id = ?`,
        [invoice.subscription]
      );
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      await db.query(
        `UPDATE provider_profiles
         SET membership_status = 'canceled', stripe_subscription_id = NULL
         WHERE stripe_subscription_id = ?`,
        [subscription.id]
      );
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
  const notificationService = require('../services/notification.service');

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

    for (const provider of expiringSoon) {
      notificationService.sendToUser(provider.user_id, {
        title: 'Membership Expiring Soon',
        body: `Your membership expires on ${new Date(provider.membership_expires_at).toLocaleDateString()}. Renew to keep receiving orders.`,
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
      notificationService.sendToUser(provider.user_id, {
        title: 'Membership Expired',
        body: 'Your membership has expired. Renew to continue receiving orders.',
        data: { type: 'membership_expired' },
      });
    }

    if (res) {
      res.json({
        message: 'Membership check complete',
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
