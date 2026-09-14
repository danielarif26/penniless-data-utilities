import app from "./index.js";
import { buildAgentManifest } from "./agent-manifest.js";

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
    return app.fetch(request, env, executionCtx);
  },
};
