require('dotenv').config();

const SYSTEM_PROMPTS = {
  customer: `You are FLUPY's customer support assistant. You ONLY answer questions about using the FLUPY service app.
Topics you can help with:
- How to create a service order
- How to describe a problem effectively
- How to take useful photos for service requests
- How to track order status
- How to chat with your assigned provider
- How to rate a provider after service completion
- How to manage your addresses and profile
- General FLUPY app navigation

If the user asks about anything unrelated to the FLUPY app, politely redirect them.
Keep answers concise and helpful. Respond in the same language the user writes in.`,

  provider: `You are FLUPY's provider support assistant. You ONLY answer questions about using the FLUPY service app as a provider.
Topics you can help with:
- How to set up your provider profile
- How to manage your service offerings
- How to handle assigned orders
- How to start, complete, or manage orders
- How to upload evidence/before-after photos
- How to manage your availability and location
- How to handle scheduled appointments
- How to manage your membership/subscription
- How to rate customers

If the user asks about anything unrelated to the FLUPY app, politely redirect them.
Keep answers concise and helpful. Respond in the same language the user writes in.`,
};

/**
 * Get contextual AI help response
 */
async function getContextualHelp(userMessage, conversationHistory, role, context) {
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL || 'gpt-4';

  if (!apiKey) {
    return getFallbackResponse(userMessage, role);
  }

  try {
    const systemPrompt = SYSTEM_PROMPTS[role] || SYSTEM_PROMPTS.customer;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map((msg) => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      })),
    ];

    // Using fetch to call OpenAI API (no extra dependency needed)
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 500,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || getFallbackResponse(userMessage, role);
  } catch (error) {
    console.error('AI service error:', error.message);
    return getFallbackResponse(userMessage, role);
  }
}

/**
 * Fallback responses when AI is not available
 */
function getFallbackResponse(message, role) {
  const lowerMsg = message.toLowerCase();

  if (role === 'customer') {
    if (lowerMsg.includes('order') || lowerMsg.includes('create')) {
      return 'To create a new order:\n1. Go to the Home screen\n2. Select the service category you need\n3. Describe your problem and upload photos\n4. Choose ASAP or schedule a time\n5. Confirm your address and submit!';
    }
    if (lowerMsg.includes('photo') || lowerMsg.includes('picture')) {
      return 'Tips for taking useful photos:\n1. Make sure there is good lighting\n2. Take photos from multiple angles\n3. Include close-up shots of the problem area\n4. Show any visible damage or issues clearly\n5. You can upload up to 10 photos per order.';
    }
    if (lowerMsg.includes('chat') || lowerMsg.includes('message')) {
      return 'Chat becomes available after a provider is assigned to your order. You can send text messages and share images or files with your provider.';
    }
    if (lowerMsg.includes('rate') || lowerMsg.includes('review')) {
      return 'After your service is completed, you\'ll be prompted to rate your provider from 1-5 stars and leave an optional comment.';
    }
  }

  if (role === 'provider') {
    if (lowerMsg.includes('order') || lowerMsg.includes('start')) {
      return 'When you receive an order:\n1. You\'ll get a push notification\n2. Review the order details\n3. Accept the order\n4. Navigate to the customer\'s location\n5. Tap "Start Order" when you begin work\n6. Tap "Complete Order" when finished';
    }
    if (lowerMsg.includes('evidence') || lowerMsg.includes('photo')) {
      return 'To attach evidence photos:\n1. Open the order details\n2. Tap "Upload Photos"\n3. Take or select before/after photos\n4. These help document your work quality.';
    }
    if (lowerMsg.includes('membership') || lowerMsg.includes('subscription')) {
      return 'An active membership is required to receive orders. Go to Profile > Membership to manage your subscription.';
    }
  }

  return 'I\'m here to help you with the FLUPY app! Please ask me about creating orders, managing your profile, chatting with providers/customers, or any other app-related question.';
}

module.exports = { getContextualHelp };
