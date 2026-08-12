/* Scramjet 2 same-origin service worker wrapper. */
importScripts("./controller/controller.sw.js");

self.addEventListener("install", (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (event) => {
  let shouldRoute = false;
  try { shouldRoute = Boolean(globalThis.$scramjetController?.shouldRoute?.(event)); }
  catch (error) { console.error("Scramjet route check failed", error); }
  if (!shouldRoute) return;
  event.respondWith(Promise.resolve(globalThis.$scramjetController.route(event)).then((response) => {
    if (!(response instanceof Response)) throw new TypeError("Scramjet returned an invalid response");
    return response;
  }).catch((error) => {
    console.error("Scramjet route failed", error);
    return new Response("Asteroid Browser could not complete this request.", {
      status: 502,
      statusText: "Proxy Request Failed",
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }));
});
