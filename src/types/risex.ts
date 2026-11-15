export type TimeframeKey = '24h' | '7d' | '30d' | 'all';

export interface MarketConfig {
  name: string;
  quote: string;
  step_size: string;
  step_price: string;
  maintenance_margin_factor: string;
  max_leverage: string;
  min_order_size: string;
  unlocked: boolean;
  open_interest_limit: string;
  match_price_band: string;
}

export interface RisexMarket {
  market_id: string;
  config: MarketConfig;
  base_asset_symbol: string;
  quote_asset_symbol: string;
  underlying: string;
  display_name: string;
  quote_volume_24h: string;
  change_24h: string;
  high_24h: string;
  low_24h: string;
  last_price: string;
  mark_price: string;
  index_price: string;
  max_position_size: string;
  open_interest: string;
  funding_interval: string;
  next_funding_time: string;
  post_only: boolean;
  predicted_funding_rate: string;
  current_funding_rate: string;
  funding_rate_8h: string;
  active: boolean;
  category: string;
  search_tags: string[];
  is_new: boolean;
}

export interface PortfolioSummary {
  collateral_margin_balance: string;
  cross_margin_balance: string;
  margin_usage: string;
  account_leverage: string;
  in_liquidation: boolean;
  free_collateral: string;
  total_account_value: string;
  total_notional: string;
  usdc_balance: string;
  total_unrealized_pnl: string;
  total_initial_margin: string;
  total_maintenance_margin: string;
  realized_pnl: string;
  margin_health: string;
  unsettled_usdc: string;
  risk_level: string;
}

export interface HeaderWindowStat {
  volume: string;
  volume_rank: string;
  market_exposure: string;
  market_exposure_rank: string;
}

export interface PortfolioHeader {
  account: string;
  h24: HeaderWindowStat;
  d7: HeaderWindowStat;
  d30: HeaderWindowStat;
  all_time: HeaderWindowStat;
}

export interface PortfolioStats {
  account: string;
  period: string;
  performance: {
    max_drawdown: string;
    win_rate: string;
    sharpe_ratio: string;
    profit_factor: string;
  };
  analytics: {
    longest_win_streak: string;
    avg_trade_duration_seconds: string;
    median_trade_duration_seconds: string;
  };
}

export interface IndexedPositionRow {
  address: string;
  username?: string | null;
  avatarUrl?: string | null;
  portfolioValue: number;
  accountLeverage: number;
  marketId: string;
  marketName: string;
  side: 'LONG' | 'SHORT';
  size: number;
  notionalUsd: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  leverage: number;
  unrealizedPnl: number;
  realizedPnl?: number | null;
  /** Whether the full opening-to-now fill history was observed for this active position. */
  realizedPnlComplete?: boolean;
  roiPct: number;
  marginBalance: number;
  marginMode: 'Cross' | 'Isolated';
}

export interface IndexedTrader {
  address: string;
  username: string | null;
  avatarUrl: string | null;
  xHandle: string | null;
  accountValue: number;
  usdcBalance: number;
  totalNotional: number;
  accountLeverage: number;
  marginUsagePct: number;
  unrealizedPnl: number;
  realizedPnlAll: number;
  totalPnlAll: number;
  roiAllPct: number;
  pnl24h: number | null;
  pnl7d: number | null;
  pnl30d: number | null;
  roi24hPct: number | null;
  roi7dPct: number | null;
  roi30dPct: number | null;
  volume24h: number;
  volume7d: number;
  volume30d: number;
  volumeAll: number;
  volumeRank24h: number;
  volumeRankAll: number;
  winRate: number | null;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
  profitFactor: number | null;
  openPositionsCount: number;
  positions: IndexedPositionRow[];
  riskLevel: string;
  inLiquidation: boolean;
  portfolioEnriched: boolean;
  lastUpdated: number;
  sources: string[];
}

export interface LeaderboardResponse {
  traders: IndexedTrader[];
  totalDiscovered: number;
  totalEnriched: number;
  indexingInProgress: boolean;
  lastRefresh: number;
}

export interface MarketCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderbookLevel {
  price: string;
  size: string;
}

export interface MarketTrade {
  id: string;
  maker_side: string;
  price: string;
  size: string;
  time: string;
  block_number: string;
  log_index: string;
  market_id?: string;
  market_name?: string;
}

export interface FundingRateRecord {
  time: string;
  funding_rate: string;
  funding_rate_8h?: string;
  index_price?: string;
  start_time?: string;
  end_time?: string;
  block_number?: string;
  block_time?: string;
  tx_hash?: string;
}

export interface AccountTradeFill {
  id: string;
  market_id: string;
  order_id: string;
  side: string;
  price: string;
  size: string;
  fee: string;
  liquidity_indicator: string;
  time: string;
  blockchain_data?: {
    block_number?: string;
    tx_hash?: string;
  };
}

export interface AccountOrder {
  id: string;
  price: string;
  size: string;
  market_id: string;
  side: string | number;
  type: string | number;
  time_in_force: string | number;
  post_only: boolean;
  reduce_only: boolean;
  filled_size?: string;
  status?: string;
  avg_price?: string;
  created_at?: string;
  block_number?: string;
}

export interface RealizedPnlEvent {
  timestamp: string;
  market_id: string;
  side: string;
  entry_price: string;
  exit_price: string;
  size: string;
  pnl: string;
  funding: string;
}

export interface FundingPaymentRecord {
  market_id: string;
  funding_payment: string;
  position_size: string;
  block_number: string;
  block_time: string;
  tx_hash: string;
  side: string;
  funding_rate: string;
  is_settled: boolean;
  entry_type: string;
}

export interface TransferRecord {
  address: string;
  type: string;
  block_number: string;
  transaction_hash: string;
  token_address: string;
  amount: string;
  block_time: string;
}

export interface ChartPoint {
  timestamp: string;
  value: string;
}

export interface PnlCalendarDay {
  date: string;
  pnl: string;
}

export interface TraderCompetitionInfo {
  username: string | null;
  avatar_url: string | null;
  banner_url?: string | null;
  x_account?: {
    username?: string;
    name?: string;
    profile_image_url?: string;
  } | null;
  total_competitions?: number;
  best_rank?: string;
  total_volume?: string;
  total_realized_pnl?: string;
  history?: { slug: string; name: string; rank: string; trading_score: string; qualified: boolean }[];
}

export interface ClosedTradeRecord {
  id: string;
  marketId: string;
  marketName: string;
  side: 'LONG' | 'SHORT';
  maxSize: number;
  closedSize: number;
  entryPrice: number;
  exitPrice: number;
  openTime: string;
  closeTime: string;
  fillsCount: number;
  fees: number;
  funding: number;
  realizedPnl: number;
  officialEventCount: number;
}

export interface WalletProfileData {
  address: string;
  profile: TraderCompetitionInfo | null;
  summary: PortfolioSummary | null;
  positions: IndexedPositionRow[];
  closedTrades: ClosedTradeRecord[];
  tradesCapped?: boolean;
  realizedEventsCapped?: boolean;
  unverifiedCyclesCount?: number;
  unattributedRealizedEvents?: number;
  header: PortfolioHeader | null;
  statsByPeriod: Record<string, PortfolioStats | null>;
  pnlChart: Record<string, ChartPoint[]>;
  equityChart: Record<string, ChartPoint[]>;
  pnlCalendar: {
    days: PnlCalendarDay[];
    win_days: number;
    best_day?: PnlCalendarDay;
    period_totals?: {
      '24h': number;
      '7d': number;
      '30d': number;
      all: number;
    };
  } | null;
  realizedPnlHistory: RealizedPnlEvent[];
  realizedSummary: {
    totalEvents: number;
    netRealizedPnl: number;
    grossProfit: number;
    grossLoss: number;
    totalFunding: number;
    wins: number;
    losses: number;
    winRatePct: number;
    profitFactor: number | null;
    bestClose: number;
    worstClose: number;
  };
  trades: AccountTradeFill[];
  openOrders: AccountOrder[];
  orderHistory: AccountOrder[];
  fundingPayments: FundingPaymentRecord[];
  transfers: TransferRecord[];
  periodMetrics: {
    '24h': { pnl: number; roiPct: number | null; volume: number; rank: number; exposure: number };
    '7d': { pnl: number; roiPct: number | null; volume: number; rank: number; exposure: number };
    '30d': { pnl: number; roiPct: number | null; volume: number; rank: number; exposure: number };
    'all': { pnl: number; roiPct: number | null; volume: number; rank: number; exposure: number };
  };
  fetchedAt: number;
}

export interface ExplorerBlock {
  height: number;
  hash: string;
  timestamp: string;
  tx_count?: number;
  transactions_count?: number;
  gas_used: string;
  gas_limit: string;
  miner?: { hash: string };
}

export interface ExplorerTx {
  hash: string;
  block_number: number;
  timestamp: string;
  from: { hash: string; is_contract?: boolean };
  to: { hash: string; name?: string; is_contract?: boolean } | null;
  method?: string;
  status: string;
  value: string;
  fee?: { value: string };
  gas_used?: string;
}

export interface SystemConfig {
  chain: {
    name: string;
    chain_id: string;
    block_time: string;
  };
  addresses: Record<string, string>;
}

export type CohortTierId = 'whale' | 'shark' | 'dolphin' | 'fish' | 'shrimp';

export interface CohortSummaryRow {
  id: CohortTierId;
  label: string;
  thresholdDesc: string;
  tradersCount: number;
  activeTradersCount: number;
  totalEquity: number;
  totalNotional: number;
  longNotional: number;
  shortNotional: number;
  biasPct: number;
  biasLabel: 'NET LONG' | 'NET SHORT' | 'NEUTRAL';
  avgLeverage: number;
  netUnrealizedPnl: number;
  netTotalPnl: number;
  pctInProfit: number;
}

export interface PerformanceCohortRow {
  id: 'top-winners' | 'profitable' | 'flat' | 'underwater';
  label: string;
  ruleDesc: string;
  tradersCount: number;
  activeTradersCount: number;
  totalEquity: number;
  longNotional: number;
  shortNotional: number;
  biasPct: number;
  avgLeverage: number;
  netUnrealizedPnl: number;
}

export interface MarketCohortRow {
  marketId: string;
  symbol: string;
  displayName: string;
  markPrice: number;
  volume24h: number;
  openInterestUsd: number;
  fundingRate1hPct: number;
  fundingAprPct: number;
  totalIndexedNotional: number;
  overallBiasPct: number;
  whaleLong: number;
  whaleShort: number;
  whaleBiasPct: number;
  dolphinBiasPct: number;
  retailLong: number;
  retailShort: number;
  retailBiasPct: number;
  divergencePct: number;
  positionsCount: number;
}

export interface CohortPositionRow extends IndexedPositionRow {
  cohort: CohortTierId;
  cohortLabel: string;
  distanceToLiqPct: number | null;
}

export interface CohortsAnalyticsResponse {
  summary: {
    enrichedTraders: number;
    activeTradersWithPositions: number;
    totalIndexedEquity: number;
    totalIndexedNotional: number;
    totalLongNotional: number;
    totalShortNotional: number;
    globalBiasPct: number;
    totalMarketOiUsd: number;
    totalMarketVolume24h: number;
  };
  sizeCohorts: CohortSummaryRow[];
  performanceCohorts: PerformanceCohortRow[];
  marketCohorts: MarketCohortRow[];
  topPositions: CohortPositionRow[];
  liquidationRadar: CohortPositionRow[];
  updatedAt: number;
}

export type {
  SyncDiagnosticStatus,
  DiagnosticSnapshotSummary,
  DiagnosticLiveSummary,
  DiagnosticDriftMetrics,
  DiagnosticRealizedEventRow,
  DiagnosticTradeFillRow,
  DiagnosticOnChainTxRow,
  SyncDiagnosticReport,
} from '../utils/pnlDiagnostic';

export interface DefiLlamaTvlPoint {
  date: number;
  tvl: number;
}

export interface DefiLlamaSnapshot {
  protocolTvl: number;
  chainTvl: number;
  tvl24hChangePct: number;
  risexShareOfChainPct: number;
  tvlHistory: DefiLlamaTvlPoint[];
  chainTvlHistory: DefiLlamaTvlPoint[];
  fetchedAt: number;
}

export interface OverviewBundleResponse {
  totalVolume24h: number;
  totalOpenInterestUsd: number;
  activeMarketsCount: number;
  totalMarketsCount: number;
  totalDiscoveredCount: number;
  indexedTradersCount: number;
  totalEquityTracked: number;
  totalOpenPositions: number;
  blockNumber: number | null;
  chainName: string;
  chainId: string;
  indexingInProgress: boolean;
  lastRefresh: number;
  defiLlama: DefiLlamaSnapshot | null;
  profitability: {
    totalAccounts: number;
    enrichedAccounts: number;
    inProfitCount: number;
    atLossCount: number;
    profitabilityPct: number;
    totalEquityUsd: number;
    totalPnlSumUsd: number;
    longOiUsd: number;
    shortOiUsd: number;
    longPositionsCount: number;
    shortPositionsCount: number;
    longOiSharePct: number;
  };
  markets: (RisexMarket & {
    indexedStats?: { count: number; longNotional: number; shortNotional: number };
  })[];
  topTraders: IndexedTrader[];
  recentTrades: MarketTrade[];
}



