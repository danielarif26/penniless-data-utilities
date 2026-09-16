#!/usr/bin/env node

import { runLiveVerification } from "../client/scripts/verify-live.mjs";

await runLiveVerification({ baseUrl: process.env.SERVICE_ORIGIN });
console.log("live verification: OK");
