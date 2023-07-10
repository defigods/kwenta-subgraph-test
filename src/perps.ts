import { Address, BigInt, Bytes, log, store } from '@graphprotocol/graph-ts';

import {
  FuturesMarket as FuturesMarketEntity,
  FuturesMarginTransfer,
  FuturesMarginAccount,
  FuturesPosition,
  FuturesTrade,
  FuturesStat,
  FuturesCumulativeStat,
  FuturesAggregateStat,
  FundingPayment,
  FundingRateUpdate,
  FuturesOrder,
  SmartMarginOrder,
  FundingRatePeriod,
} from '../generated/subgraphs/perps/schema';
import {
  MarketAdded as MarketAddedEvent,
  MarketRemoved as MarketRemovedEvent,
} from '../generated/subgraphs/perps/futures_FuturesMarketManager_0/FuturesMarketManager';
import {
  PositionLiquidated as PositionLiquidatedEvent,
  PositionModified as PositionModifiedEvent,
  MarginTransferred as MarginTransferredEvent,
} from '../generated/subgraphs/perps/templates/PerpsMarket/PerpsV2MarketProxyable';
import {
  DelayedOrderSubmitted as DelayedOrderSubmittedEvent,
  DelayedOrderRemoved as DelayedOrderRemovedEvent,
  FundingRecomputed as FundingRecomputedEvent,
  PositionModified1 as PositionModifiedV2Event,
  PositionLiquidated1 as PositionLiquidatedV2Event,
} from '../generated/subgraphs/perps/templates/PerpsMarket/PerpsV2MarketProxyable';
import { PerpsMarket } from '../generated/subgraphs/perps/templates';
import {
  DAY_SECONDS,
  ETHER,
  FUNDING_RATE_PERIOD_TYPES,
  FUNDING_RATE_PERIODS,
  ONE,
  ONE_HOUR_SECONDS,
  ZERO,
  ZERO_ADDRESS,
} from './lib/helpers';
import { SmartMarginAccount } from '../generated/subgraphs/perps/schema';

let SINGLE_INDEX = '0';

// Timeframes to aggregate stats in seconds
export const AGG_PERIODS = [ONE_HOUR_SECONDS, DAY_SECONDS];

export function handleV2MarketAdded(event: MarketAddedEvent): void {
  const marketKey = event.params.marketKey.toString();

  // create futures market
  let marketEntity = new FuturesMarketEntity(event.params.market.toHex());
  marketEntity.asset = event.params.asset;
  marketEntity.marketKey = event.params.marketKey;

  // create market cumulative stats
  let marketStats = getOrCreateMarketCumulativeStats(event.params.marketKey.toHex());
  marketStats.save();
  marketEntity.marketStats = marketStats.id;
  marketEntity.save();

  // Check that it's a v2 market before adding
  if (marketKey.endsWith('PERP')) {
    log.info('New V2 market added: {}', [marketKey]);

    // perps v2 market
    PerpsMarket.create(event.params.market);
  }
}

export function handleMarketRemoved(event: MarketRemovedEvent): void {
  store.remove('PerpsMarket', event.params.market.toHex());
}

export function handlePositionModified(event: PositionModifiedEvent): void {
  // handler for the position modified function
  // the PositionModified event it emitted any time a user interacts with a position
  // this handler is build to handle many different types of interactions:
  // - opening a new position
  // - modifying a position
  // - transferring margin in or out of a market
  // - liquidating a position (also see PositionLiquidated)

  let sendingAccount = event.params.account;
  let smartMarginAccount = SmartMarginAccount.load(sendingAccount.toHex());
  const account = smartMarginAccount ? smartMarginAccount.owner : sendingAccount;
  const accountType = smartMarginAccount ? 'smart_margin' : 'isolated_margin';

  let futuresMarketAddress = event.address as Address;
  let positionId = futuresMarketAddress.toHex() + '-' + event.params.id.toHex();
  let marketEntity = FuturesMarketEntity.load(futuresMarketAddress.toHex());
  let positionEntity = FuturesPosition.load(positionId);
  let statEntity = FuturesStat.load(account.toHex());
  let cumulativeEntity = getOrCreateCumulativeEntity();
  let marginAccountEntity = FuturesMarginAccount.load(sendingAccount.toHex() + '-' + futuresMarketAddress.toHex());

  // calculated values
  const synthetixFeePaid = event.params.fee;

  // each trader will have a stats entity created during their first transfer
  if (statEntity == null) {
    statEntity = new FuturesStat(account.toHex());
    statEntity.account = account;
    statEntity.feesPaid = ZERO;
    statEntity.pnl = ZERO;
    statEntity.pnlWithFeesPaid = ZERO;
    statEntity.liquidations = ZERO;
    statEntity.totalTrades = ZERO;
    statEntity.totalVolume = ZERO;
    statEntity.smartMarginVolume = ZERO;

    cumulativeEntity.totalTraders = cumulativeEntity.totalTraders.plus(BigInt.fromI32(1));
  }

  // if it's a new position, create a position entity
  if (positionEntity == null) {
    positionEntity = new FuturesPosition(positionId);
    positionEntity.market = futuresMarketAddress;
    if (marketEntity) {
      positionEntity.asset = marketEntity.asset;
      positionEntity.marketKey = marketEntity.marketKey;
    }
    positionEntity.account = account;
    positionEntity.abstractAccount = sendingAccount;
    positionEntity.accountType = accountType;
    positionEntity.isLiquidated = false;
    positionEntity.isOpen = true;
    positionEntity.size = event.params.size;
    positionEntity.timestamp = event.block.timestamp;
    positionEntity.openTimestamp = event.block.timestamp;
    positionEntity.avgEntryPrice = event.params.lastPrice;
    positionEntity.trades = ZERO;
    positionEntity.entryPrice = event.params.lastPrice;
    positionEntity.lastPrice = event.params.lastPrice;
    positionEntity.margin = event.params.margin;
    positionEntity.initialMargin = event.params.margin.plus(event.params.fee);
    positionEntity.pnl = ZERO;
    positionEntity.feesPaid = ZERO;
    positionEntity.netFunding = ZERO;
    positionEntity.pnlWithFeesPaid = ZERO;
    positionEntity.netTransfers = ZERO;
    positionEntity.totalDeposits = ZERO;
    positionEntity.totalVolume = ZERO;
    positionEntity.fundingIndex = event.params.fundingIndex;
  }

  // if there is an existing position, add funding accrued
  let fundingAccrued = ZERO;
  if (positionEntity.fundingIndex != event.params.fundingIndex) {
    // add accrued funding to position
    // funding is accrued from the last `fundingIndex` to the current `fundingIndex`
    let pastFundingEntity = FundingRateUpdate.load(
      futuresMarketAddress.toHex() + '-' + positionEntity.fundingIndex.toString(),
    );

    let currentFundingEntity = FundingRateUpdate.load(
      futuresMarketAddress.toHex() + '-' + event.params.fundingIndex.toString(),
    );

    if (pastFundingEntity && currentFundingEntity) {
      // accrued funding is equal to the difference between the entities per 1 unit of size
      // It is multiplied by the position size to get the total funding accrued in USD
      fundingAccrued = currentFundingEntity.funding
        .minus(pastFundingEntity.funding)
        .times(positionEntity.size)
        .div(ETHER);

      if (fundingAccrued.abs().gt(ZERO)) {
        let fundingPaymentEntity = new FundingPayment(
          positionId + '-' + event.transaction.hash.toHex() + '-' + event.logIndex.toString(),
        );
        fundingPaymentEntity.timestamp = event.block.timestamp;
        fundingPaymentEntity.account = account;
        fundingPaymentEntity.positionId = positionId;
        fundingPaymentEntity.marketKey = positionEntity.marketKey;
        fundingPaymentEntity.asset = positionEntity.asset;
        fundingPaymentEntity.amount = fundingAccrued;
        fundingPaymentEntity.save();
      }

      positionEntity.netFunding = positionEntity.netFunding.plus(fundingAccrued);
      statEntity.feesPaid = statEntity.feesPaid.minus(fundingAccrued);

      // set the new index
      positionEntity.fundingIndex = event.params.fundingIndex;
    }
  }

  // check that tradeSize is not zero to filter out margin transfers
  if (event.params.tradeSize.isZero() == false) {
    let tradeEntity = new FuturesTrade(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
    tradeEntity.timestamp = event.block.timestamp;
    tradeEntity.account = account;
    tradeEntity.abstractAccount = sendingAccount;
    tradeEntity.accountType = accountType;
    tradeEntity.margin = event.params.margin.plus(synthetixFeePaid);
    tradeEntity.size = event.params.tradeSize;
    tradeEntity.asset = ZERO_ADDRESS;
    tradeEntity.marketKey = ZERO_ADDRESS;
    tradeEntity.price = event.params.lastPrice;
    tradeEntity.positionId = positionId;
    tradeEntity.positionSize = event.params.size;
    tradeEntity.pnl = ZERO;
    tradeEntity.feesPaid = synthetixFeePaid;
    tradeEntity.fundingAccrued = fundingAccrued;
    tradeEntity.keeperFeesPaid = ZERO;
    tradeEntity.orderType = 'Market';
    tradeEntity.trackingCode = ZERO_ADDRESS;

    if (marketEntity) {
      tradeEntity.asset = marketEntity.asset;
      tradeEntity.marketKey = marketEntity.marketKey;
    }
    if (event.params.size.isZero()) {
      tradeEntity.positionClosed = true;
    } else {
      tradeEntity.positionClosed = false;
    }

    // update pnl and avg entry price
    // if the position is closed during this transaction...
    // set the exit price and set the position to closed
    if (event.params.size.isZero() == true) {
      // calculate pnl
      const newPnl = event.params.lastPrice.minus(positionEntity.avgEntryPrice).times(positionEntity.size).div(ETHER);

      // add pnl to this position and the trader's overall stats
      statEntity.pnl = statEntity.pnl.plus(newPnl);
      tradeEntity.pnl = newPnl;
      positionEntity.pnl = positionEntity.pnl.plus(newPnl);

      positionEntity.isOpen = false;
      positionEntity.exitPrice = event.params.lastPrice;
      positionEntity.closeTimestamp = event.block.timestamp;
    } else {
      // if the position is not closed...
      // check if the position changes sides, reset the entry price
      if (
        (positionEntity.size.lt(ZERO) && event.params.size.gt(ZERO)) ||
        (positionEntity.size.gt(ZERO) && event.params.size.lt(ZERO))
      ) {
        // calculate pnl
        const newPnl = event.params.lastPrice.minus(positionEntity.avgEntryPrice).times(positionEntity.size).div(ETHER);

        // add pnl to this position and the trader's overall stats
        tradeEntity.pnl = newPnl;
        statEntity.pnl = statEntity.pnl.plus(newPnl);
        positionEntity.pnl = positionEntity.pnl.plus(newPnl);

        positionEntity.entryPrice = event.params.lastPrice; // Deprecate this after migrating frontend
        positionEntity.avgEntryPrice = event.params.lastPrice;
      } else {
        // check if the position side increases (long or short)
        if (event.params.size.abs().gt(positionEntity.size.abs())) {
          // if so, calculate the new average price
          const existingSize = positionEntity.size.abs();
          const existingPrice = existingSize.times(positionEntity.entryPrice);

          const newSize = event.params.tradeSize.abs();
          const newPrice = newSize.times(event.params.lastPrice);
          positionEntity.entryPrice = existingPrice.plus(newPrice).div(event.params.size.abs()); // Deprecate this after migrating frontend
          positionEntity.avgEntryPrice = existingPrice.plus(newPrice).div(event.params.size.abs());
        } else {
          // if reducing position size, calculate pnl
          // calculate pnl
          const newPnl = event.params.lastPrice
            .minus(positionEntity.avgEntryPrice)
            .times(event.params.tradeSize.abs())
            .times(event.params.size.gt(ZERO) ? BigInt.fromI32(1) : BigInt.fromI32(-1))
            .div(ETHER);

          // add pnl to this position and the trader's overall stats
          tradeEntity.pnl = newPnl;
          statEntity.pnl = statEntity.pnl.plus(newPnl);
          positionEntity.pnl = positionEntity.pnl.plus(newPnl);
        }
      }
    }
    tradeEntity.save();

    // update cumulative stats
    let volume = tradeEntity.size.times(tradeEntity.price).div(ETHER).abs();
    cumulativeEntity.totalTrades = cumulativeEntity.totalTrades.plus(BigInt.fromI32(1));
    cumulativeEntity.totalVolume = cumulativeEntity.totalVolume.plus(volume);
    cumulativeEntity.averageTradeSize = cumulativeEntity.totalVolume.div(cumulativeEntity.totalTrades);

    // update trader stats
    statEntity.totalTrades = statEntity.totalTrades.plus(BigInt.fromI32(1));
    statEntity.totalVolume = statEntity.totalVolume.plus(volume);
    if (accountType === 'smart_margin') {
      statEntity.smartMarginVolume = statEntity.smartMarginVolume.plus(volume);
    }

    // update position stats
    positionEntity.trades = positionEntity.trades.plus(BigInt.fromI32(1));
    positionEntity.totalVolume = positionEntity.totalVolume.plus(volume);

    // update cumulative and aggregate stats
    // aggregate stats are created for various time periods
    if (marketEntity && marketEntity.asset) {
      let marketCumulativeStats = getOrCreateMarketCumulativeStats(marketEntity.asset.toHex());
      marketCumulativeStats.totalTrades = marketCumulativeStats.totalTrades.plus(BigInt.fromI32(1));
      marketCumulativeStats.totalVolume = marketCumulativeStats.totalVolume.plus(volume);
      marketCumulativeStats.averageTradeSize = marketCumulativeStats.totalVolume.div(marketCumulativeStats.totalTrades);
      marketCumulativeStats.save();

      // update aggregates
      updateAggregateStatEntities(
        accountType,
        positionEntity.marketKey,
        positionEntity.asset,
        event.block.timestamp,
        ONE,
        volume,
        synthetixFeePaid,
        ZERO,
      );
    }
  } else {
    // if the tradeSize is equal to zero, it must be a margin transfer or a liquidation
    const txHash = event.transaction.hash.toHex();
    let marginTransferEntity = FuturesMarginTransfer.load(
      futuresMarketAddress.toHex() + '-' + txHash + '-' + event.logIndex.minus(BigInt.fromI32(1)).toString(),
    );

    // this check is here to get around the fact that the sometimes a withdrawalAll margin transfer event
    // will trigger a trade entity liquidation to be created. guarding against this event for now.
    if (marginTransferEntity == null && event.params.size.isZero() && event.params.margin.isZero()) {
      // if its not a withdrawal (or deposit), it's a liquidation
      let tradeEntity = new FuturesTrade(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
      tradeEntity.timestamp = event.block.timestamp;
      tradeEntity.account = account;
      tradeEntity.abstractAccount = sendingAccount;
      tradeEntity.accountType = accountType;

      // recalculate pnl to ensure a 100% position loss
      // this calculation is required since the liquidation price could result in pnl slightly above/below 100%
      const newPositionPnlWithFeesPaid = positionEntity.initialMargin
        .plus(positionEntity.netTransfers)
        .times(BigInt.fromI32(-1));
      const newPositionPnl = newPositionPnlWithFeesPaid.plus(positionEntity.feesPaid).minus(positionEntity.netFunding);
      const newTradePnl = newPositionPnl.minus(positionEntity.pnl);

      // temporarily set the pnl to the difference in the position pnl
      // we will add liquidation fees during the PositionLiquidated handler
      tradeEntity.margin = ZERO;
      tradeEntity.size = ZERO;
      tradeEntity.asset = positionEntity.asset;
      tradeEntity.marketKey = positionEntity.marketKey;
      tradeEntity.price = event.params.lastPrice;
      tradeEntity.positionId = positionId;
      tradeEntity.positionSize = ZERO;
      tradeEntity.positionClosed = true;
      tradeEntity.pnl = newTradePnl;
      tradeEntity.feesPaid = synthetixFeePaid;
      tradeEntity.fundingAccrued = fundingAccrued;
      tradeEntity.keeperFeesPaid = ZERO;
      tradeEntity.orderType = 'Liquidation';
      tradeEntity.trackingCode = ZERO_ADDRESS;
      tradeEntity.save();

      // set position values
      positionEntity.pnl = newPositionPnl;
      positionEntity.pnlWithFeesPaid = newPositionPnlWithFeesPaid;

      // set stat values
      statEntity.pnl = statEntity.pnl.plus(newTradePnl);
    } else if (marginTransferEntity) {
      // if margin transfer exists, add it to net transfers
      positionEntity.netTransfers = positionEntity.netTransfers.plus(marginTransferEntity.size);

      // if a deposit, add to deposits
      if (marginTransferEntity.size.gt(ZERO)) {
        positionEntity.totalDeposits = positionEntity.totalDeposits.plus(marginTransferEntity.size);
      }
    }
  }

  // update global values
  statEntity.pnlWithFeesPaid = statEntity.pnl.minus(statEntity.feesPaid);
  statEntity.feesPaid = statEntity.feesPaid.plus(synthetixFeePaid);

  positionEntity.size = event.params.size;
  positionEntity.margin = event.params.margin;
  positionEntity.lastPrice = event.params.lastPrice;
  positionEntity.feesPaid = positionEntity.feesPaid.plus(synthetixFeePaid);
  positionEntity.pnlWithFeesPaid = positionEntity.pnl.minus(positionEntity.feesPaid).plus(positionEntity.netFunding);
  positionEntity.lastTxHash = event.transaction.hash;
  positionEntity.timestamp = event.block.timestamp;

  // update margin account
  if (marginAccountEntity) {
    marginAccountEntity.margin = event.params.margin;
    marginAccountEntity.timestamp = event.block.timestamp;
    marginAccountEntity.save();
  }

  positionEntity.save();
  statEntity.save();
  cumulativeEntity.save();
}

export function handlePositionModifiedV2(event: PositionModifiedV2Event): void {
  // Wrapper for handling PositionModified events after a contract upgrade
  // The new event has a different signature, so we need to handle it separately
  const v1Params = event.parameters.filter((value) => {
    return value.name !== 'skew';
  });

  const v1Event = new PositionModifiedEvent(
    event.address,
    event.logIndex,
    event.transactionLogIndex,
    event.logType,
    event.block,
    event.transaction,
    v1Params,
    event.receipt,
  );
  handlePositionModified(v1Event);
}

export function handlePositionLiquidated(event: PositionLiquidatedEvent): void {
  // handler for the PositionLiquidated event
  // get account entities
  let sendingAccount = event.params.account;
  let smartMarginAccount = SmartMarginAccount.load(sendingAccount.toHex());
  const account = smartMarginAccount ? smartMarginAccount.owner : sendingAccount;

  // get market, position, trade, and stat entities
  let futuresMarketAddress = event.address as Address;
  let positionId = futuresMarketAddress.toHex() + '-' + event.params.id.toHex();
  let positionEntity = FuturesPosition.load(positionId);
  let tradeEntity = FuturesTrade.load(
    event.transaction.hash.toHex() + '-' + event.logIndex.minus(BigInt.fromI32(1)).toString(),
  );
  let statEntity = FuturesStat.load(account.toHex());

  if (positionEntity) {
    // update position values
    positionEntity.isLiquidated = true;
    positionEntity.isOpen = false;
    positionEntity.closeTimestamp = event.block.timestamp;
    positionEntity.feesPaid = positionEntity.feesPaid.plus(event.params.fee);

    // adjust pnl for the additional fees paid
    positionEntity.pnl = positionEntity.pnl.plus(event.params.fee);
    positionEntity.pnlWithFeesPaid = positionEntity.pnl.minus(positionEntity.feesPaid).plus(positionEntity.netFunding);
    positionEntity.save();

    // update stats entity
    if (statEntity) {
      statEntity.liquidations = statEntity.liquidations.plus(BigInt.fromI32(1));
      statEntity.feesPaid = statEntity.feesPaid.plus(event.params.fee);
      statEntity.pnl = statEntity.pnl.plus(event.params.fee);
      statEntity.pnlWithFeesPaid = statEntity.pnl.minus(statEntity.feesPaid);
      statEntity.save();
    }

    // update trade entity
    if (tradeEntity) {
      tradeEntity.size = event.params.size.times(BigInt.fromI32(-1));
      tradeEntity.positionSize = ZERO;
      tradeEntity.feesPaid = tradeEntity.feesPaid.plus(event.params.fee);
      tradeEntity.pnl = tradeEntity.pnl.plus(event.params.fee);
      tradeEntity.save();
    }
  }

  // update cumulative entity
  let cumulativeEntity = getOrCreateCumulativeEntity();
  cumulativeEntity.totalLiquidations = cumulativeEntity.totalLiquidations.plus(BigInt.fromI32(1));
  cumulativeEntity.save();

  // update market cumulative entity
  if (positionEntity && positionEntity.asset) {
    let marketCumulativeStats = getOrCreateMarketCumulativeStats(positionEntity.asset.toHex());
    marketCumulativeStats.totalLiquidations = marketCumulativeStats.totalLiquidations.plus(BigInt.fromI32(1));
    marketCumulativeStats.save();
  }
}

export function handlePositionLiquidatedV2(event: PositionLiquidatedV2Event): void {
  // Wrapper for handling PositionLiquidated events after a contract upgrade
  // The new event has a different signature, so we need to handle it separately
  // The key difference is the calculation of a `totalFee` value from the individual fees:
  // - totalFee = flaggerFee + liquidatorFee + stakersFee
  // get account entities
  let sendingAccount = event.params.account;
  let smartMarginAccount = SmartMarginAccount.load(sendingAccount.toHex());
  const account = smartMarginAccount ? smartMarginAccount.owner : sendingAccount;

  // get market, position, trade, and stat entities
  let futuresMarketAddress = event.address as Address;
  let positionId = futuresMarketAddress.toHex() + '-' + event.params.id.toHex();
  let positionEntity = FuturesPosition.load(positionId);
  let tradeEntity = FuturesTrade.load(
    event.transaction.hash.toHex() + '-' + event.logIndex.minus(BigInt.fromI32(1)).toString(),
  );
  let statEntity = FuturesStat.load(account.toHex());

  // calculate total fee
  let totalFee = event.params.flaggerFee.plus(event.params.liquidatorFee).plus(event.params.stakersFee);
  if (positionEntity) {
    // update position
    positionEntity.isLiquidated = true;
    positionEntity.isOpen = false;
    positionEntity.closeTimestamp = event.block.timestamp;
    positionEntity.feesPaid = positionEntity.feesPaid.plus(totalFee);

    // adjust pnl for the additional fee paid
    positionEntity.pnl = positionEntity.pnl.plus(totalFee);
    positionEntity.pnlWithFeesPaid = positionEntity.pnl.minus(positionEntity.feesPaid).plus(positionEntity.netFunding);
    positionEntity.save();

    // update stats entity
    if (statEntity) {
      statEntity.liquidations = statEntity.liquidations.plus(BigInt.fromI32(1));
      statEntity.feesPaid = statEntity.feesPaid.plus(totalFee);
      statEntity.pnl = statEntity.pnl.plus(totalFee);
      statEntity.pnlWithFeesPaid = statEntity.pnl.minus(statEntity.feesPaid);
      statEntity.save();
    }

    // update trade entity
    if (tradeEntity) {
      tradeEntity.size = event.params.size.times(BigInt.fromI32(-1));
      tradeEntity.positionSize = ZERO;
      tradeEntity.feesPaid = tradeEntity.feesPaid.plus(totalFee);
      tradeEntity.pnl = tradeEntity.pnl.plus(totalFee);
      tradeEntity.save();
    }
  }

  // update cumulative entity
  let cumulativeEntity = getOrCreateCumulativeEntity();
  cumulativeEntity.totalLiquidations = cumulativeEntity.totalLiquidations.plus(BigInt.fromI32(1));
  cumulativeEntity.save();

  // update market cumulative entity
  if (positionEntity && positionEntity.asset) {
    let marketCumulativeStats = getOrCreateMarketCumulativeStats(positionEntity.asset.toHex());
    marketCumulativeStats.totalLiquidations = marketCumulativeStats.totalLiquidations.plus(BigInt.fromI32(1));
    marketCumulativeStats.save();
  }
}

function getOrCreateCumulativeEntity(): FuturesCumulativeStat {
  // helper function for creating a cumulative entity if one doesn't exist
  // this allows functions to safely call this function without checking for null
  let cumulativeEntity = FuturesCumulativeStat.load(SINGLE_INDEX);
  if (cumulativeEntity == null) {
    cumulativeEntity = new FuturesCumulativeStat(SINGLE_INDEX);
    cumulativeEntity.totalLiquidations = ZERO;
    cumulativeEntity.totalTrades = ZERO;
    cumulativeEntity.totalTraders = ZERO;
    cumulativeEntity.totalVolume = ZERO;
    cumulativeEntity.averageTradeSize = ZERO;
  }
  return cumulativeEntity as FuturesCumulativeStat;
}

function getOrCreateMarketCumulativeStats(marketKey: string): FuturesCumulativeStat {
  // helper function for creating a cumulative entity if one doesn't exist
  // this allows functions to safely call this function without checking for null
  let cumulativeEntity = FuturesCumulativeStat.load(marketKey);
  if (cumulativeEntity == null) {
    cumulativeEntity = new FuturesCumulativeStat(marketKey);
    cumulativeEntity.totalLiquidations = ZERO;
    cumulativeEntity.totalTrades = ZERO;
    cumulativeEntity.totalTraders = ZERO;
    cumulativeEntity.totalVolume = ZERO;
    cumulativeEntity.averageTradeSize = ZERO;
  }
  return cumulativeEntity as FuturesCumulativeStat;
}

function getOrCreateMarketAggregateStats(
  marketKey: Bytes,
  asset: Bytes,
  timestamp: BigInt,
  period: BigInt,
): FuturesAggregateStat {
  // helper function for creating a market aggregate entity if one doesn't exist
  // this allows functions to safely call this function without checking for null
  const id = `${timestamp.toString()}-${period.toString()}-${asset.toHex()}`;
  let aggregateEntity = FuturesAggregateStat.load(id);
  if (aggregateEntity == null) {
    aggregateEntity = new FuturesAggregateStat(id);
    aggregateEntity.period = period;
    aggregateEntity.timestamp = timestamp;
    aggregateEntity.marketKey = marketKey;
    aggregateEntity.asset = asset;
    aggregateEntity.trades = ZERO;
    aggregateEntity.volume = ZERO;
    aggregateEntity.feesKwenta = ZERO;
    aggregateEntity.feesSynthetix = ZERO;
    aggregateEntity.feesCrossMarginAccounts = ZERO;
  }
  return aggregateEntity as FuturesAggregateStat;
}

export function updateAggregateStatEntities(
  accountType: string,
  marketKey: Bytes,
  asset: Bytes,
  timestamp: BigInt,
  trades: BigInt,
  volume: BigInt,
  feesSynthetix: BigInt,
  feesKwenta: BigInt,
): void {
  // this function updates the aggregate stat entities for the specified account and market
  // it is called when users interact with positions or when positions are liquidated
  // to add new aggregate periods, update the `AGG_PERIODS` array in `constants.ts`
  // new aggregates will be created for any resolution present in the array
  for (let period = 0; period < AGG_PERIODS.length; period++) {
    const thisPeriod = AGG_PERIODS[period];
    const aggTimestamp = getTimeID(timestamp, thisPeriod);
    const totalFees = feesSynthetix.plus(feesKwenta);
    const feesCrossMarginAccounts = accountType === 'smart_margin' ? totalFees : ZERO;

    // update the aggregate for this market
    let aggStats = getOrCreateMarketAggregateStats(marketKey, asset, aggTimestamp, thisPeriod);
    aggStats.trades = aggStats.trades.plus(trades);
    aggStats.volume = aggStats.volume.plus(volume);
    aggStats.feesSynthetix = aggStats.feesSynthetix.plus(feesSynthetix);
    aggStats.feesKwenta = aggStats.feesKwenta.plus(feesKwenta);
    aggStats.feesCrossMarginAccounts = aggStats.feesCrossMarginAccounts.plus(feesCrossMarginAccounts);
    aggStats.save();

    // update the aggregate for all markets
    let aggCumulativeStats = getOrCreateMarketAggregateStats(new Bytes(0), new Bytes(0), aggTimestamp, thisPeriod);
    aggCumulativeStats.trades = aggCumulativeStats.trades.plus(trades);
    aggCumulativeStats.volume = aggCumulativeStats.volume.plus(volume);
    aggCumulativeStats.feesSynthetix = aggCumulativeStats.feesSynthetix.plus(feesSynthetix);
    aggCumulativeStats.feesKwenta = aggCumulativeStats.feesKwenta.plus(feesKwenta);
    aggCumulativeStats.feesCrossMarginAccounts =
      aggCumulativeStats.feesCrossMarginAccounts.plus(feesCrossMarginAccounts);
    aggCumulativeStats.save();
  }
}

function getTimeID(timestamp: BigInt, num: BigInt): BigInt {
  // helper function for reducing a timestamp by a given resolution
  let remainder = timestamp.mod(num);
  return timestamp.minus(remainder);
}

export function handleMarginTransferred(event: MarginTransferredEvent): void {
  // this function handles margin transfers
  // it is called when users transfer margin to or from an account
  // A new entity is created to represent the transfer
  // Another account entity is created or updated to track the account's margin balance
  let futuresMarketAddress = event.address as Address;
  const txHash = event.transaction.hash.toHex();
  let marketEntity = FuturesMarketEntity.load(futuresMarketAddress.toHex());

  // handle margin transfer
  let marginTransferEntity = new FuturesMarginTransfer(
    futuresMarketAddress.toHex() + '-' + txHash + '-' + event.logIndex.toString(),
  );
  marginTransferEntity.timestamp = event.block.timestamp;
  marginTransferEntity.account = event.params.account;
  marginTransferEntity.market = futuresMarketAddress;
  marginTransferEntity.size = event.params.marginDelta;
  marginTransferEntity.txHash = txHash;

  if (marketEntity) {
    marginTransferEntity.asset = marketEntity.asset;
    marginTransferEntity.marketKey = marketEntity.marketKey;
  }

  // handle margin account
  let marginAccountEntity = FuturesMarginAccount.load(
    event.params.account.toHex() + '-' + futuresMarketAddress.toHex(),
  );

  // make account if this is the first deposit
  if (marginAccountEntity == null) {
    marginAccountEntity = new FuturesMarginAccount(event.params.account.toHex() + '-' + futuresMarketAddress.toHex());

    marginAccountEntity.timestamp = event.block.timestamp;
    marginAccountEntity.account = event.params.account;
    marginAccountEntity.market = futuresMarketAddress;
    marginAccountEntity.margin = ZERO;
    marginAccountEntity.deposits = ZERO;
    marginAccountEntity.withdrawals = ZERO;

    if (marketEntity && marketEntity.asset) {
      marginAccountEntity.asset = marketEntity.asset;

      // add a new trader to market stats
      let marketStats = getOrCreateMarketCumulativeStats(marketEntity.asset.toHex());
      marketStats.totalTraders = marketStats.totalTraders.plus(BigInt.fromI32(1));
      marketStats.save();
    }
  }

  if (event.params.marginDelta.gt(ZERO)) {
    marginAccountEntity.deposits = marginAccountEntity.deposits.plus(event.params.marginDelta.abs());
  }

  if (event.params.marginDelta.lt(ZERO)) {
    marginAccountEntity.withdrawals = marginAccountEntity.withdrawals.plus(event.params.marginDelta.abs());
  }

  marginTransferEntity.save();
  marginAccountEntity.save();
}

export function handleFundingRecomputed(event: FundingRecomputedEvent): void {
  // this function handles funding recomputations
  // this handler simply creates a new entity to represent the update
  let futuresMarketAddress = event.address as Address;
  let marketEntity = FuturesMarketEntity.load(futuresMarketAddress.toHex());

  let fundingRateUpdateEntity = new FundingRateUpdate(
    futuresMarketAddress.toHex() + '-' + event.params.index.toString(),
  );
  fundingRateUpdateEntity.timestamp = event.params.timestamp;
  fundingRateUpdateEntity.market = futuresMarketAddress;
  fundingRateUpdateEntity.sequenceLength = event.params.index;
  fundingRateUpdateEntity.funding = event.params.funding;
  fundingRateUpdateEntity.fundingRate = event.params.fundingRate;
  fundingRateUpdateEntity.asset = ZERO_ADDRESS;
  fundingRateUpdateEntity.marketKey = ZERO_ADDRESS;

  if (marketEntity) {
    fundingRateUpdateEntity.asset = marketEntity.asset;
    fundingRateUpdateEntity.marketKey = marketEntity.marketKey;
    updateFundingRatePeriods(event.params.timestamp, marketEntity.asset.toString(), fundingRateUpdateEntity);
  }

  fundingRateUpdateEntity.save();
}

function updateFundingRatePeriods(timestamp: BigInt, asset: string, rate: FundingRateUpdate): void {
  for (let p = 0; p < FUNDING_RATE_PERIODS.length; p++) {
    let periodSeconds = FUNDING_RATE_PERIODS[p];
    let periodType = FUNDING_RATE_PERIOD_TYPES[p];
    let periodId = getTimeID(timestamp, periodSeconds);

    let id = asset + '-' + periodType + '-' + periodId.toString();

    let existingPeriod = FundingRatePeriod.load(id);

    if (existingPeriod == null) {
      let newPeriod = new FundingRatePeriod(id);
      newPeriod.fundingRate = rate.fundingRate;
      newPeriod.asset = rate.asset;
      newPeriod.marketKey = rate.marketKey;
      newPeriod.period = periodType;
      newPeriod.timestamp = timestamp.minus(timestamp.mod(periodSeconds)); // store the beginning of this period, rather than the timestamp of the first rate update.
      newPeriod.save();
    } else {
      existingPeriod.fundingRate = rate.fundingRate;
      existingPeriod.save();
    }
  }
}

export function handleDelayedOrderSubmitted(event: DelayedOrderSubmittedEvent): void {
  // this function handles delayed order submissions
  // a new order is created to represent the delayed order
  // this entity will be updated when the order is executed or cancelled
  let futuresMarketAddress = event.address as Address;
  let sendingAccount = event.params.account;
  let smartMarginAccount = SmartMarginAccount.load(sendingAccount.toHex());
  const account = smartMarginAccount ? smartMarginAccount.owner : sendingAccount;

  let marketEntity = FuturesMarketEntity.load(futuresMarketAddress.toHex());
  if (marketEntity) {
    let marketAsset = marketEntity.asset;

    const futuresOrderEntityId = `D-${marketAsset}-${sendingAccount.toHexString()}-${event.params.targetRoundId.toString()}`;

    let futuresOrderEntity = FuturesOrder.load(futuresOrderEntityId);
    if (futuresOrderEntity == null) {
      futuresOrderEntity = new FuturesOrder(futuresOrderEntityId);
    }

    futuresOrderEntity.size = event.params.sizeDelta;
    futuresOrderEntity.marketKey = marketEntity.marketKey;
    futuresOrderEntity.account = account;
    futuresOrderEntity.abstractAccount = sendingAccount;
    futuresOrderEntity.targetPrice = ZERO;
    futuresOrderEntity.marginDelta = ZERO;
    futuresOrderEntity.timestamp = event.block.timestamp;
    futuresOrderEntity.txnHash = event.transaction.hash;
    futuresOrderEntity.orderId = event.params.targetRoundId;
    futuresOrderEntity.orderType = event.params.isOffchain ? 'DelayedOffchain' : 'Delayed';
    futuresOrderEntity.status = 'Pending';
    futuresOrderEntity.keeper = ZERO_ADDRESS;

    futuresOrderEntity.save();
  }
}

export function handleDelayedOrderRemoved(event: DelayedOrderRemovedEvent): void {
  // this function handles delayed order executions
  // get the order entity and update the relevant fields
  let sendingAccount = event.params.account;
  let smartMarginAccount = SmartMarginAccount.load(sendingAccount.toHex());
  const account = smartMarginAccount ? smartMarginAccount.owner : sendingAccount;
  const accountType = smartMarginAccount ? 'smart_margin' : 'isolated_margin';

  let statEntity = FuturesStat.load(account.toHex());

  let futuresMarketAddress = event.address as Address;

  let marketEntity = FuturesMarketEntity.load(futuresMarketAddress.toHex());
  if (marketEntity) {
    let marketAsset = marketEntity.asset;

    const futuresOrderEntityId = `D-${marketAsset}-${sendingAccount.toHexString()}-${event.params.targetRoundId.toString()}`;

    let futuresOrderEntity = FuturesOrder.load(futuresOrderEntityId);
    let smartMarginOrderEntity = SmartMarginOrder.load(
      sendingAccount.toHex() + '-' + marketEntity.marketKey.toString(),
    );

    if (futuresOrderEntity) {
      futuresOrderEntity.keeper = event.transaction.from;
      let tradeEntity = FuturesTrade.load(
        event.transaction.hash.toHex() + '-' + event.logIndex.minus(BigInt.fromI32(1)).toString(),
      );

      if (statEntity && tradeEntity) {
        // if trade exists get the position
        let positionEntity = FuturesPosition.load(tradeEntity.positionId);

        // update order values
        futuresOrderEntity.status = 'Filled';
        tradeEntity.trackingCode = event.params.trackingCode;
        tradeEntity.orderType = futuresOrderEntity.orderType;
        if (smartMarginOrderEntity && smartMarginOrderEntity.recordTrade && smartMarginOrderEntity.orderType !== null) {
          tradeEntity.orderType = smartMarginOrderEntity.orderType;

          smartMarginOrderEntity.recordTrade = false;
          smartMarginOrderEntity.save();
        }

        // add fee if not self-executed
        if (futuresOrderEntity.keeper != futuresOrderEntity.account) {
          tradeEntity.feesPaid = tradeEntity.feesPaid.plus(event.params.keeperDeposit);
          tradeEntity.keeperFeesPaid = event.params.keeperDeposit;
          statEntity.feesPaid = statEntity.feesPaid.plus(event.params.keeperDeposit);
          if (positionEntity) {
            positionEntity.feesPaid = positionEntity.feesPaid.plus(event.params.keeperDeposit);
            positionEntity.save();
          }

          // add fees based on tracking code
          if (event.params.trackingCode.toString() == 'KWENTA') {
            updateAggregateStatEntities(
              accountType,
              marketEntity.marketKey,
              marketEntity.asset,
              event.block.timestamp,
              ZERO,
              ZERO,
              ZERO,
              tradeEntity.feesPaid,
            );
          }

          statEntity.save();
        }

        tradeEntity.save();
      } else {
        // if no trade exists, the order was cancelled
        futuresOrderEntity.status = 'Cancelled';
      }

      futuresOrderEntity.save();
    }
  }
}
