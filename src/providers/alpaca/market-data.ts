import type { AlpacaClient } from "./client";
import type { Bar, Quote, Snapshot, BarsParams, MarketDataProvider } from "../types";

interface AlpacaBarsResponse {
  bars: Record<string, AlpacaBar[]>;
  next_page_token?: string;
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  vw: number;
}

interface AlpacaLatestBarsResponse {
  bars: Record<string, AlpacaBar>;
}

interface AlpacaQuotesResponse {
  quotes: Record<string, AlpacaQuote>;
}

interface AlpacaQuote {
  ap: number;
  as: number;
  bp: number;
  bs: number;
  t: string;
}

interface AlpacaSnapshotsResponse {
  [symbol: string]: AlpacaSnapshot;
}

interface AlpacaSnapshot {
  latestTrade: {
    p: number;
    s: number;
    t: string;
  };
  latestQuote: AlpacaQuote;
  minuteBar: AlpacaBar;
  dailyBar: AlpacaBar;
  prevDailyBar: AlpacaBar;
}

function parseBar(raw: AlpacaBar): Bar {
  return {
    t: raw.t,
    o: raw.o,
    h: raw.h,
    l: raw.l,
    c: raw.c,
    v: raw.v,
    n: raw.n,
    vw: raw.vw,
  };
}

function parseQuote(symbol: string, raw: AlpacaQuote): Quote {
  return {
    symbol,
    bid_price: raw.bp,
    bid_size: raw.bs,
    ask_price: raw.ap,
    ask_size: raw.as,
    timestamp: raw.t,
  };
}

function parseSnapshot(symbol: string, raw: AlpacaSnapshot): Snapshot {
  return {
    symbol,
    latest_trade: {
      price: raw.latestTrade.p,
      size: raw.latestTrade.s,
      timestamp: raw.latestTrade.t,
    },
    latest_quote: parseQuote(symbol, raw.latestQuote),
    minute_bar: parseBar(raw.minuteBar),
    daily_bar: parseBar(raw.dailyBar),
    prev_daily_bar: parseBar(raw.prevDailyBar),
  };
}


// Crypto Interfaces
interface AlpacaCryptoBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  vw: number;
}

interface AlpacaCryptoBarsResponse {
  bars: Record<string, AlpacaCryptoBar[]>;
  next_page_token?: string;
}

interface AlpacaCryptoSnapshot {
  latestTrade: {
    p: number;
    s: number;
    t: string;
    i: number;
  };
  latestQuote: {
    bp: number;
    bs: number;
    ap: number;
    as: number;
    t: string;
  };
  minuteBar: AlpacaCryptoBar;
  dailyBar: AlpacaCryptoBar;
  prevDailyBar: AlpacaCryptoBar;
}

interface AlpacaCryptoSnapshotsResponse {
  snapshots: Record<string, AlpacaCryptoSnapshot>;
}

export class AlpacaMarketDataProvider implements MarketDataProvider {
  constructor(private client: AlpacaClient) { }

  private isCrypto(symbol: string): boolean {
    return symbol.includes('/');
  }

  async getBars(
    symbol: string,
    timeframe: string,
    params?: BarsParams
  ): Promise<Bar[]> {
    // Without a start date Alpaca returns only today's bar regardless of limit.
    // Compute a default start far enough back to cover the requested limit.
    const defaultStart = (limit: number | undefined): string | undefined => {
      if (params?.start) return undefined; // caller provided one
      const days = timeframe === "1Day" ? (limit ?? 100) * 2
                 : timeframe === "1Week" ? (limit ?? 52) * 10
                 : timeframe === "1Month" ? (limit ?? 12) * 45
                 : (limit ?? 200); // intraday: 1 calendar day per bar is safe upper bound
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - days);
      return d.toISOString().split("T")[0];
    };

    if (this.isCrypto(symbol)) {
      const response = await this.client.dataRequest<AlpacaCryptoBarsResponse>(
        "GET",
        `/v1beta3/crypto/us/bars`,
        {
          symbols: symbol,
          timeframe,
          start: params?.start ?? defaultStart(params?.limit),
          end: params?.end,
          limit: params?.limit,
        }
      );

      if (!response.bars || !response.bars[symbol]) {
        return [];
      }
      return response.bars[symbol].map(parseBar);
    }

    const response = await this.client.dataRequest<AlpacaBarsResponse | { bars: AlpacaBar[] }>(
      "GET",
      `/v2/stocks/${encodeURIComponent(symbol)}/bars`,
      {
        timeframe,
        start: params?.start ?? defaultStart(params?.limit),
        end: params?.end,
        limit: params?.limit,
        adjustment: params?.adjustment,
        feed: params?.feed,
      }
    );

    if (!response || !response.bars) {
      return [];
    }

    if (Array.isArray(response.bars)) {
      return response.bars.map(parseBar);
    }

    const bars = (response as AlpacaBarsResponse).bars[symbol];
    return bars ? bars.map(parseBar) : [];
  }

  async getMultiBars(
    symbols: string[],
    timeframe: string,
    params?: BarsParams
  ): Promise<Record<string, Bar[]>> {
    if (symbols.length === 0) return {};

    const defaultStart = (limit: number | undefined): string | undefined => {
      if (params?.start) return undefined;
      const days = timeframe === "1Day" ? (limit ?? 100) * 2
                 : timeframe === "1Week" ? (limit ?? 52) * 10
                 : timeframe === "1Month" ? (limit ?? 12) * 45
                 : (limit ?? 200);
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - days);
      return d.toISOString().split("T")[0];
    };

    const cryptoSymbols = symbols.filter(s => this.isCrypto(s));
    const stockSymbols = symbols.filter(s => !this.isCrypto(s));

    const result: Record<string, Bar[]> = {};

    if (cryptoSymbols.length > 0) {
      try {
        const response = await this.client.dataRequest<AlpacaCryptoBarsResponse>(
          "GET",
          `/v1beta3/crypto/us/bars`,
          {
            symbols: cryptoSymbols.join(","),
            timeframe,
            start: params?.start ?? defaultStart(params?.limit),
            end: params?.end,
            limit: params?.limit,
          }
        );
        if (response && response.bars) {
          for (const [sym, rawBars] of Object.entries(response.bars)) {
            result[sym] = rawBars.map(parseBar);
          }
        }
      } catch (error) {
        console.error(`[AlpacaMarketDataProvider] getMultiBars crypto error:`, error);
      }
    }

    if (stockSymbols.length > 0) {
      const chunkSize = 100;
      for (let i = 0; i < stockSymbols.length; i += chunkSize) {
        const chunk = stockSymbols.slice(i, i + chunkSize);
        try {
          const response = await this.client.dataRequest<AlpacaBarsResponse>(
            "GET",
            "/v2/stocks/bars",
            {
              symbols: chunk.join(","),
              timeframe,
              start: params?.start ?? defaultStart(params?.limit),
              end: params?.end,
              limit: params?.limit,
              adjustment: params?.adjustment,
              feed: params?.feed,
            }
          );
          if (response && response.bars) {
            for (const [sym, rawBars] of Object.entries(response.bars)) {
              result[sym] = rawBars.map(parseBar);
            }
          }
        } catch (error) {
          console.error(`[AlpacaMarketDataProvider] getMultiBars stock chunk error:`, error);
        }
      }
    }

    return result;
  }

  async getLatestBar(symbol: string): Promise<Bar> {
    // Crypto doesn't have a specific "latest bar" endpoint usually, just use getBars with limit 1
    if (this.isCrypto(symbol)) {
      const bars = await this.getBars(symbol, "1Min", { limit: 1 });
      if (bars.length === 0) throw new Error(`No bar data for ${symbol}`);
      return bars[0]!;
    }

    const response = await this.client.dataRequest<AlpacaLatestBarsResponse>(
      "GET",
      `/v2/stocks/${encodeURIComponent(symbol)}/bars/latest`
    );

    const bar = response.bars[symbol];
    if (!bar) {
      throw new Error(`No bar data for ${symbol}`);
    }
    return parseBar(bar);
  }

  async getLatestBars(symbols: string[]): Promise<Record<string, Bar>> {
    // Mixed symbols complexity omitted for now - assuming all stock or caller handles separation
    // For simplicity, falling back to stock implementation or erroring if mixed could be better, 
    // but here we just keep stock logic. To support batch crypto, we'd need more logic.
    // Assuming this is mostly used for stocks in this version.

    const response = await this.client.dataRequest<AlpacaLatestBarsResponse>(
      "GET",
      "/v2/stocks/bars/latest",
      { symbols: symbols.join(",") }
    );

    const result: Record<string, Bar> = {};
    for (const [symbol, bar] of Object.entries(response.bars)) {
      result[symbol] = parseBar(bar);
    }
    return result;
  }

  async getQuote(symbol: string): Promise<Quote> {
    if (this.isCrypto(symbol)) {
      // Crypto quotes not fully implemented here as getSnapshot is preferred
      // But we can implement via snapshot if needed, or specific quote endpoint
      const snapshot = await this.getSnapshot(symbol);
      return snapshot.latest_quote;
    }

    const response = await this.client.dataRequest<AlpacaQuotesResponse>(
      "GET",
      `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`
    );

    const quote = response.quotes[symbol];
    if (!quote) {
      throw new Error(`No quote data for ${symbol}`);
    }
    return parseQuote(symbol, quote);
  }

  async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const response = await this.client.dataRequest<AlpacaQuotesResponse>(
      "GET",
      "/v2/stocks/quotes/latest",
      { symbols: symbols.join(",") }
    );

    const result: Record<string, Quote> = {};
    for (const [symbol, quote] of Object.entries(response.quotes)) {
      result[symbol] = parseQuote(symbol, quote);
    }
    return result;
  }

  async getSnapshot(symbol: string): Promise<Snapshot> {
    if (this.isCrypto(symbol)) {
      const response = await this.client.dataRequest<AlpacaCryptoSnapshotsResponse>(
        "GET",
        "/v1beta3/crypto/us/snapshots",
        { symbols: symbol }
      );

      const snapshot = response.snapshots && response.snapshots[symbol];
      if (!snapshot) {
        throw new Error(`No snapshot data for ${symbol}`);
      }

      return {
        symbol,
        latest_trade: {
          price: snapshot.latestTrade.p,
          size: snapshot.latestTrade.s,
          timestamp: snapshot.latestTrade.t,
        },
        latest_quote: {
          symbol,
          bid_price: snapshot.latestQuote.bp,
          bid_size: snapshot.latestQuote.bs,
          ask_price: snapshot.latestQuote.ap,
          ask_size: snapshot.latestQuote.as,
          timestamp: snapshot.latestQuote.t,
        },
        minute_bar: snapshot.minuteBar ? parseBar(snapshot.minuteBar) : { t: new Date().toISOString(), o: 0, h: 0, l: 0, c: 0, v: 0, n: 0, vw: 0 },
        daily_bar: snapshot.dailyBar ? parseBar(snapshot.dailyBar) : { t: new Date().toISOString(), o: 0, h: 0, l: 0, c: 0, v: 0, n: 0, vw: 0 },
        prev_daily_bar: snapshot.prevDailyBar ? parseBar(snapshot.prevDailyBar) : { t: new Date().toISOString(), o: 0, h: 0, l: 0, c: 0, v: 0, n: 0, vw: 0 },
      };
    }

    const response = await this.client.dataRequest<AlpacaSnapshotsResponse | AlpacaSnapshot>(
      "GET",
      `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`
    );

    if (!response) {
      throw new Error(`No snapshot data for ${symbol} (market may be closed)`);
    }

    if ('latestTrade' in response) {
      return parseSnapshot(symbol, response as AlpacaSnapshot);
    }

    const snapshot = (response as AlpacaSnapshotsResponse)[symbol];
    if (!snapshot) {
      throw new Error(`No snapshot data for ${symbol} (market may be closed)`);
    }
    return parseSnapshot(symbol, snapshot);
  }

  async getSnapshots(symbols: string[]): Promise<Record<string, Snapshot>> {
    const response = await this.client.dataRequest<AlpacaSnapshotsResponse>(
      "GET",
      "/v2/stocks/snapshots",
      { symbols: symbols.join(",") }
    );

    const result: Record<string, Snapshot> = {};
    for (const [symbol, snapshot] of Object.entries(response)) {
      result[symbol] = parseSnapshot(symbol, snapshot);
    }
    return result;
  }
}

export function createAlpacaMarketDataProvider(
  client: AlpacaClient
): AlpacaMarketDataProvider {
  return new AlpacaMarketDataProvider(client);
}
