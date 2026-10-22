// Ronin Code — local host service.
// Cost center: the server-side price table (the GUI never prices
// anything) and per-turn usage finalization + budget-cap signals.

import { config } from "./config.js";
import { recordKeyUse, recordTurnUsage, sessionTotals } from "./usage.js";
import { broadcast } from "./sse.js";

export const PRICE_TABLE = {
  "claude-sonnet-4-5": { input: 3, output: 15, multiplier: 1 },
  "gpt-5": { input: 1.25, output: 10, multiplier: 1 },
  "gemini-2.5-pro": { input: 1.25, output: 10, multiplier: 1 },
  "openai/gpt-5": { input: 1.25, output: 10, multiplier: 1 },
};

export const DEFAULT_PRICE = { input: 0.5, output: 2, multiplier: 1 };

export function priceTurn(modelId, inputTokens, outputTokens, engineCost) {
  if (typeof engineCost === "number" && engineCost > 0) {
    return { costUsd: Math.round(engineCost * 1e6) / 1e6, estimated: false };
  }
  const p = PRICE_TABLE[modelId] || DEFAULT_PRICE;
  const cost =
    ((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * (p.multiplier || 1);
  return { costUsd: Math.round(cost * 1e6) / 1e6, estimated: true };
}

export function finalizeTurnUsage({ providerId, modelId, apiKey, usage, promptText, replyText, error }) {
  let inputTokens = usage?.input || 0;
  let outputTokens = usage?.output || 0;
  let estimated = false;
  if (!inputTokens && !outputTokens) {
    // Char-based estimate when the engine reported no usage.
    inputTokens = Math.ceil((promptText || "").length / 4);
    outputTokens = Math.ceil((replyText || "").length / 4);
    estimated = true;
  }
  // Subscription turns are metered in tokens server-side; the USD cost
  // is not known locally and must never be invented from the BYOK price
  // table — record the tokens with a zero cost.
  const isSubscription = providerId === "ronin-subscription";
  const { costUsd, estimated: priceEstimated } = isSubscription
    ? { costUsd: 0, estimated: false }
    : priceTurn(modelId, inputTokens, outputTokens, usage?.costTotal);
  const rec = {
    ts: new Date().toISOString(),
    provider: providerId,
    model: modelId,
    inputTokens,
    outputTokens,
    costUsd,
    estimated: estimated || priceEstimated,
  };
  recordTurnUsage(rec);
  if (apiKey) {
    recordKeyUse(providerId, apiKey, {
      error: !!error,
      inputTokens,
      outputTokens,
      cooldownMs: error && /429|rate.?limit|quota/i.test(error) ? 90_000 : error && /5\d\d|overloaded/i.test(error) ? 30_000 : 0,
    });
  }
  broadcast({
    type: "turn_usage",
    provider: providerId,
    model: modelId,
    inputTokens,
    outputTokens,
    costUsd,
    estimated: rec.estimated,
    sessionTotalUsd: sessionTotals().costUsd,
  });
  const cap = config.budgetCapUsd;
  if (cap) {
    const total = sessionTotals().costUsd;
    if (total >= cap) broadcast({ type: "budget_exceeded", capUsd: cap, totalUsd: total });
    else if (total >= cap * 0.8) broadcast({ type: "budget_warning", capUsd: cap, totalUsd: total });
  }
  return rec;
}

/**
 * Build the inline engine extension that enforces Ronin's trust layer:
 * approval gates, .env protection, secret redaction and RTK compression.
 * Runs inside the engine process via extensionFactories (see ENGINE.md).
 */
