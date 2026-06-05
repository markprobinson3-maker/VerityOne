import type { ViAdapter } from "./types";

export const adapter: ViAdapter = {
  name: "market",
  source_type: "market_api",
  description: "Market data — stock prices, crypto, indices via free APIs",
  default_schedule: "*/5 9-16 * * 1-5",
  webhook_enabled: false,
  auth: { type: "api_key", key_env: "ALPHA_VANTAGE_KEY", required: false },

  async extract(input) {
    const provider = input.config?.provider || "coingecko";
    const chunks = [];

    if (provider === "coingecko") {
      const coins = input.config?.coins || "bitcoin,ethereum,solana";
      const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coins}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`);
      const data: any = await resp.json();
      let text = "Crypto Market Update:\n\n";
      for (const [coin, info] of Object.entries(data) as any) {
        text += `${coin.toUpperCase()}: $${info.usd.toLocaleString()} (${info.usd_24h_change?.toFixed(2)}% 24h) | MCap: $${(info.usd_market_cap / 1e9).toFixed(1)}B\n`;
      }
      chunks.push({ content: text, chunk_index: 0, chunk_total: 1, metadata: { provider, coins } });

    } else if (provider === "alphavantage") {
      const symbol = input.config?.symbol || "SPY";
      const apiKey = process.env.ALPHA_VANTAGE_KEY;
      if (!apiKey) throw new Error("ALPHA_VANTAGE_KEY not set");
      const resp = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`);
      const data: any = await resp.json();
      const q = data["Global Quote"] || {};
      const text = `${symbol}: $${q["05. price"]} (${q["10. change percent"]}) | Open: $${q["02. open"]} | High: $${q["03. high"]} | Low: $${q["04. low"]} | Vol: ${q["06. volume"]}`;
      chunks.push({ content: text, chunk_index: 0, chunk_total: 1, metadata: { provider, symbol } });

    } else if (provider === "fear-greed") {
      const resp = await fetch("https://api.alternative.me/fng/?limit=1");
      const data: any = await resp.json();
      const fg = data.data?.[0];
      const text = `Crypto Fear & Greed Index: ${fg?.value} (${fg?.value_classification}) — ${fg?.timestamp ? new Date(fg.timestamp * 1000).toISOString().slice(0, 10) : "today"}`;
      chunks.push({ content: text, chunk_index: 0, chunk_total: 1, metadata: { provider } });
    }

    return {
      title: `Market: ${provider} — ${new Date().toISOString().slice(0, 16)}`,
      source_id: `market:${provider}:${new Date().toISOString().slice(0, 13)}`,
      chunks,
    };
  },
};
