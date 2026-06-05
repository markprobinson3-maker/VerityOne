import type { DayJournalRoutineContext, DayJournalRoutineDefinition } from "../routine-registry";
import type { DayJournalRoutineResult, DayJournalRoutineStatus } from "../validate";

type FetchLike = typeof fetch;

export interface MarketSpyQqqCloseDeps {
  fetch?: FetchLike;
}

type MarketRole = "equity" | "future";

interface MarketSymbol {
  key: string;
  yahooSymbol: string;
  label: string;
  role: MarketRole;
}

interface MarketCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  timestamp: number;
  session_date: string;
}

interface ParsedChart {
  symbol: MarketSymbol;
  url: string;
  candles: MarketCandle[];
  regular_market_price: number | null;
  regular_market_time: number | null;
}

interface SymbolObservation {
  symbol: string;
  label: string;
  role: MarketRole;
  url: string;
  session_date?: string;
  source_time?: string;
  stale: boolean;
  missing: boolean;
  error?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number | null;
  price?: number;
}

const ROUTINE_ID = "market.spy_qqq_close";
const TARGET_PATH = "journal.markets.spy_qqq_close";
const SCHEMA_ID = "market_spy_qqq_close_v1";
const SOURCE_ID = "yahoo_chart_v8";
const SOURCE_NAME = "Yahoo Chart API";
const SOURCE_RELIABILITY = "best_effort_public_market_data";
const FETCH_TIMEOUT_MS = 30_000;
const EQUITY_SYMBOLS = ["SPY", "QQQ"];
const FUTURE_SYMBOLS = ["ES_F", "NQ_F"];
const MARKET_SYMBOLS: MarketSymbol[] = [
  { key: "SPY", yahooSymbol: "SPY", label: "SPDR S&P 500 ETF", role: "equity" },
  { key: "QQQ", yahooSymbol: "QQQ", label: "Invesco QQQ Trust", role: "equity" },
  { key: "ES_F", yahooSymbol: "ES=F", label: "S&P 500 futures", role: "future" },
  { key: "NQ_F", yahooSymbol: "NQ=F", label: "Nasdaq 100 futures", role: "future" },
];

function yahooChartUrl(symbol: string): string {
  const encoded = encodeURIComponent(symbol);
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=5d&interval=1d&includePrePost=false`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateInNewYork(epochSeconds: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochSeconds * 1000));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

function isoFromEpochSeconds(epochSeconds: number | null): string | undefined {
  return epochSeconds === null ? undefined : new Date(epochSeconds * 1000).toISOString();
}

function parseYahooChartJson(symbol: MarketSymbol, url: string, json: unknown): ParsedChart {
  const root = json as any;
  const result = root?.chart?.result?.[0];
  if (!result || root?.chart?.error) {
    throw new Error(`yahoo_chart_schema_invalid:${symbol.key}`);
  }

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  if (
    !Array.isArray(timestamps) ||
    !quote ||
    !Array.isArray(quote.open) ||
    !Array.isArray(quote.high) ||
    !Array.isArray(quote.low) ||
    !Array.isArray(quote.close)
  ) {
    throw new Error(`yahoo_chart_schema_invalid:${symbol.key}`);
  }

  const candles: MarketCandle[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const timestamp = finiteNumber(timestamps[i]);
    const open = finiteNumber(quote.open[i]);
    const high = finiteNumber(quote.high[i]);
    const low = finiteNumber(quote.low[i]);
    const close = finiteNumber(quote.close[i]);
    if (timestamp === null || open === null || high === null || low === null || close === null) continue;
    const volume = finiteNumber(Array.isArray(quote.volume) ? quote.volume[i] : null);
    candles.push({
      open,
      high,
      low,
      close,
      volume,
      timestamp,
      session_date: dateInNewYork(timestamp),
    });
  }

  const meta = result.meta || {};
  return {
    symbol,
    url,
    candles,
    regular_market_price: finiteNumber(meta.regularMarketPrice),
    regular_market_time: finiteNumber(meta.regularMarketTime),
  };
}

async function fetchYahooChart(
  symbol: MarketSymbol,
  fetchImpl: FetchLike,
  parentSignal: AbortSignal,
): Promise<ParsedChart | SymbolObservation> {
  const url = yahooChartUrl(symbol.yahooSymbol);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  const timeout = controller
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS)
    : undefined;
  const abortFromParent = () => controller?.abort(parentSignal.reason);
  if (controller) {
    if (parentSignal.aborted) {
      abortFromParent();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        "user-agent": "VerityOne-DayJournal/1.0",
      },
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch {
    return {
      symbol: symbol.yahooSymbol,
      label: symbol.label,
      role: symbol.role,
      url,
      stale: false,
      missing: true,
      error: controller?.signal.aborted
        ? `source_unreachable:${symbol.key}:${timedOut ? "timeout" : "aborted"}`
        : `source_unreachable:${symbol.key}`,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
  if (!response.ok) {
    return {
      symbol: symbol.yahooSymbol,
      label: symbol.label,
      role: symbol.role,
      url,
      stale: false,
      missing: true,
      error: `source_unreachable:${symbol.key}:${response.status}`,
    };
  }

  try {
    return parseYahooChartJson(symbol, url, await response.json());
  } catch {
    return {
      symbol: symbol.yahooSymbol,
      label: symbol.label,
      role: symbol.role,
      url,
      stale: false,
      missing: true,
      error: `yahoo_chart_schema_invalid:${symbol.key}`,
    };
  }
}

function latestCandle(parsed: ParsedChart): MarketCandle | null {
  return [...parsed.candles].sort((a, b) => a.timestamp - b.timestamp).at(-1) || null;
}

function targetDateCandle(parsed: ParsedChart, targetDate: string): MarketCandle | null {
  return parsed.candles.find((candle) => candle.session_date === targetDate) || latestCandle(parsed);
}

function observeEquity(parsed: ParsedChart, targetDate: string): SymbolObservation {
  const candle = targetDateCandle(parsed, targetDate);
  if (!candle) {
    return {
      symbol: parsed.symbol.yahooSymbol,
      label: parsed.symbol.label,
      role: parsed.symbol.role,
      url: parsed.url,
      stale: false,
      missing: true,
      error: `no_session_data:${parsed.symbol.key}`,
    };
  }
  const stale = candle.session_date !== targetDate;
  return {
    symbol: parsed.symbol.yahooSymbol,
    label: parsed.symbol.label,
    role: parsed.symbol.role,
    url: parsed.url,
    session_date: candle.session_date,
    source_time: isoFromEpochSeconds(candle.timestamp),
    stale,
    missing: false,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };
}

function observeFuture(parsed: ParsedChart, targetDate: string): SymbolObservation {
  const candle = latestCandle(parsed);
  const price = parsed.regular_market_price ?? candle?.close ?? null;
  const sourceTime = parsed.regular_market_time ?? candle?.timestamp ?? null;
  if (price === null || sourceTime === null) {
    return {
      symbol: parsed.symbol.yahooSymbol,
      label: parsed.symbol.label,
      role: parsed.symbol.role,
      url: parsed.url,
      stale: false,
      missing: true,
      error: `no_future_price:${parsed.symbol.key}`,
    };
  }
  const sourceDate = dateInNewYork(sourceTime);
  return {
    symbol: parsed.symbol.yahooSymbol,
    label: parsed.symbol.label,
    role: parsed.symbol.role,
    url: parsed.url,
    session_date: sourceDate,
    source_time: isoFromEpochSeconds(sourceTime),
    stale: sourceDate !== targetDate,
    missing: false,
    price,
  };
}

function recordObservations(observations: SymbolObservation[], role: MarketRole): Record<string, SymbolObservation> {
  const out: Record<string, SymbolObservation> = {};
  for (const observation of observations.filter((item) => item.role === role)) {
    out[observation.symbol] = observation;
  }
  return out;
}

function determineStatus(observations: SymbolObservation[]): DayJournalRoutineStatus {
  const equities = observations.filter((item) => item.role === "equity");
  const futures = observations.filter((item) => item.role === "future");
  const freshEquities = equities.filter((item) => !item.missing && !item.stale);
  const freshFutures = futures.filter((item) => !item.missing && !item.stale);
  const sourceFailures = observations.filter(
    (item) => item.error?.startsWith("source_unreachable") || item.error?.startsWith("yahoo_chart_schema_invalid"),
  );

  if (freshEquities.length === EQUITY_SYMBOLS.length && freshFutures.length === FUTURE_SYMBOLS.length) return "ok";
  if (freshEquities.length > 0) return "partial";
  if (sourceFailures.length > 0) return "error";
  return "skipped";
}

function closeSummary(observations: SymbolObservation[], status: DayJournalRoutineStatus, targetDate: string): string {
  const equities = observations.filter((item) => item.role === "equity");
  const futures = observations.filter((item) => item.role === "future");
  const equityText = equities
    .map((item) => `${item.symbol} ${item.close === undefined || item.stale ? "unavailable" : item.close.toFixed(2)}`)
    .join(", ");
  const futureText = futures
    .map((item) => `${item.symbol} ${item.price === undefined || item.stale ? "unavailable" : item.price.toFixed(2)}`)
    .join(", ");
  if (status === "ok") return `Market close: ${equityText}; futures at capture: ${futureText}.`;
  if (status === "partial") return `Market close partial: ${equityText}; futures at capture: ${futureText}.`;
  if (status === "skipped") return `Market close skipped: no fresh SPY/QQQ session data for ${targetDate}.`;
  return "Market close error: Yahoo chart API did not return usable SPY/QQQ data.";
}

function dataQuality(observations: SymbolObservation[], status: DayJournalRoutineStatus): Record<string, unknown> {
  return {
    status,
    source_reliability: SOURCE_RELIABILITY,
    fresh_symbols: observations.filter((item) => !item.missing && !item.stale).map((item) => item.symbol),
    stale_symbols: observations.filter((item) => !item.missing && item.stale).map((item) => item.symbol),
    missing_symbols: observations.filter((item) => item.missing && !item.error).map((item) => item.symbol),
    error_symbols: observations.filter((item) => item.error).map((item) => item.symbol),
    errors: observations
      .filter((item) => item.error)
      .map((item) => ({ symbol: item.symbol, error: item.error })),
  };
}

function marketErrorMessage(observations: SymbolObservation[]): string {
  const errors = observations
    .filter((item) => item.error)
    .map((item) => `${item.symbol}:${item.error}`);
  return errors.length > 0 ? `yahoo_chart_unusable: ${errors.join("; ")}` : "yahoo_chart_unusable";
}

export async function runMarketSpyQqqClose(
  ctx: DayJournalRoutineContext,
  deps: MarketSpyQqqCloseDeps = {},
): Promise<DayJournalRoutineResult> {
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch_unavailable");

  const fetched = await Promise.all(MARKET_SYMBOLS.map((symbol) => fetchYahooChart(symbol, fetchImpl, ctx.signal)));
  const observations = fetched.map((item) => {
    if ("candles" in item) {
      return item.symbol.role === "equity" ? observeEquity(item, ctx.targetDate) : observeFuture(item, ctx.targetDate);
    }
    return item;
  });
  const status = determineStatus(observations);
  const payload = {
    source: SOURCE_ID,
    provider: SOURCE_NAME,
    source_reliability: SOURCE_RELIABILITY,
    routine_class: "context_only",
    context_only: true,
    historical_context_only: true,
    equities: recordObservations(observations, "equity"),
    futures_at_capture: recordObservations(observations, "future"),
    data_quality: dataQuality(observations, status),
  };

  return {
    ok: status !== "error",
    routine_id: ROUTINE_ID,
    schema: SCHEMA_ID,
    target_path: TARGET_PATH,
    captured_at: ctx.now.toISOString(),
    session_date: ctx.targetDate,
    status,
    summary_line: closeSummary(observations, status, ctx.targetDate),
    tags: ["markets", "spy", "qqq"],
    payload,
    source_refs: MARKET_SYMBOLS.map((symbol) => ({
      type: "market_data",
      url: yahooChartUrl(symbol.yahooSymbol),
      label: `${SOURCE_NAME} ${symbol.yahooSymbol}`,
    })),
    ...(status === "error" ? { error: marketErrorMessage(observations) } : {}),
  };
}

export const MARKET_SPY_QQQ_CLOSE: DayJournalRoutineDefinition = {
  id: ROUTINE_ID,
  label: "SPY/QQQ Close",
  description: "Capture a market-close journal note for SPY and QQQ.",
  domain: "markets",
  sensitivity: "financial",
  routineClass: "context_only",
  defaultSchedule: "weekday@15:05",
  defaultEnabled: false,
  payloadSizeLimitBytes: 65536,
  payloadPreviewLimitBytes: 4096,
  timeoutMs: 30_000,
  dryRunMode: "hosted_metadata_ok",
  permissions: ["journal_write", "network", "finance"],
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  run: runMarketSpyQqqClose,
};
