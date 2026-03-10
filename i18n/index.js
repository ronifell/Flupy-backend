const i18next = require('i18next');

const en = require('./locales/en.json');
const es = require('./locales/es.json');

i18next.init({
  resources: {
    en: { translation: en },
    es: { translation: es },
  },
  lng: 'en', // Default language
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

// Helper function to get translation
// Accepts language from request header or query param
function t(key, options = {}, language = 'en') {
  return i18next.getFixedT(language)(key, options);
}

// Middleware to set language from request
function i18nMiddleware(req, res, next) {
  // Check for language in query param, header, or default to 'en'
  const lang = req.query.lang || req.headers['accept-language']?.split(',')[0]?.split('-')[0] || 'en';
  // Only support en and es
  req.language = (lang === 'es') ? 'es' : 'en';
  next();
}

module.exports = {
  t,
  i18nMiddleware,
  i18next,
};
