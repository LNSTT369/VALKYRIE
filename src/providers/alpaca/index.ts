import { createAlpacaClient, type AlpacaClientConfig } from "./client";
import { createAlpacaTradingProvider, AlpacaTradingProvider } from "./trading";
import { createAlpacaMarketDataProvider, AlpacaMarketDataProvider } from "./market-data";
import { createAlpacaOptionsProvider, AlpacaOptionsProvider } from "./options";
import { parseBoolean } from "../../lib/utils";
import type { Env } from "../../env.d";

export interface AlpacaProviders {
  trading: AlpacaTradingProvider;
  marketData: AlpacaMarketDataProvider;
  options: AlpacaOptionsProvider;
}

export function createAlpacaProviders(
  env: Env,
  tenantConfig?: Partial<AlpacaClientConfig>
): AlpacaProviders {
  const config: AlpacaClientConfig = {
    apiKey: tenantConfig?.apiKey ?? env.ALPACA_API_KEY,
    apiSecret: tenantConfig?.apiSecret ?? env.ALPACA_API_SECRET,
    paper: tenantConfig?.paper !== undefined ? tenantConfig.paper : parseBoolean(env.ALPACA_PAPER, true),
  };

  const client = createAlpacaClient(config);

  return {
    trading: createAlpacaTradingProvider(client),
    marketData: createAlpacaMarketDataProvider(client),
    options: createAlpacaOptionsProvider(client),
  };
}

export { AlpacaTradingProvider } from "./trading";
export { AlpacaMarketDataProvider } from "./market-data";
export { AlpacaClient, createAlpacaClient } from "./client";
