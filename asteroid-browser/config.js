globalThis.ASTEROID_SCRAMJET_CONFIG = Object.freeze({
  wispUrl: "wss://anura.pro/",
  fallbackWispUrl: "wss://wisp.mercurywork.shop/wisp/",
  searchEngine: "https://www.google.com/search?q=",
  aiEndpoint: "https://text.pollinations.ai/{prompt}",
  pageTitle: "Asteroid Browser",
  libcurlTransportVersion: "2.0.5",
  libcurlScriptUrls: [
    "./transport/libcurl.js",
    "https://cdn.jsdelivr.net/npm/@mercuryworkshop/libcurl-transport@2.0.5/dist/index.js",
    "https://unpkg.com/@mercuryworkshop/libcurl-transport@2.0.5/dist/index.js"
  ]
});
