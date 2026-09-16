import app from "./index.js";
import { buildAgentManifest } from "./agent-manifest.js";
import { TOOLS } from "./shared.js";
import {
  addV1PaymentRequiredBody, matchRequirement, mirrorV1Settlement, normalizeRequest,
  probeRequest, readPaymentRequired, readV1Payment, upgradeToV2,
} from "./v1compat.js";

export default {
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/.well-known/agent.json") {
      return new Response(`${JSON.stringify(buildAgentManifest())}\n`, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300",
          "access-control-allow-origin": "*",
        },
      });
    }

    // Only a paid path has terms to translate. Anywhere else an X-PAYMENT is
    // meaningless, and probing for a requirement that cannot exist would run
    // the free handler a second time for nothing.
    const { request: incoming, body, isV1 } = await normalizeRequest(request, Object.hasOwn(TOOLS, url.pathname));
    if (!isV1) return addV1PaymentRequiredBody(await app.fetch(incoming, env, executionCtx));

    // A v1 payer: read back the requirement the paywall is advertising right
    // now, re-envelope the payment against it, then serve the real request.
    // A payment that cannot be translated is passed through untouched and is
    // answered with a 402 carrying the v1 offer it needs.
    const v1Payload = readV1Payment(incoming);
    const probe = v1Payload ? await app.fetch(probeRequest(incoming), env, executionCtx) : null;
    const paymentRequired = probe ? readPaymentRequired(probe) : null;
    const requirement = paymentRequired ? matchRequirement(paymentRequired, v1Payload) : null;
    const upgraded = requirement
      ? upgradeToV2(incoming, body, v1Payload, requirement)
      : incoming;

    const response = await app.fetch(upgraded, env, executionCtx);
    return mirrorV1Settlement(await addV1PaymentRequiredBody(response));
  },
};
