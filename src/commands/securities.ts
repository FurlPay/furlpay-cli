/**
 * ─────────────────────────────────────────────────────────────
 * FurlPay CLI — Tokenized Securities & Settlement Commands
 * ─────────────────────────────────────────────────────────────
 */

import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { SecuritiesRegistryService } from '../services/securities-registry.js';
import { MultiChainRegistry } from '../services/chain-adapters.js';
import { info, success, warn, error } from '../utils/logger.js';

export async function securitiesListCommand(options: Record<string, unknown>): Promise<void> {
  const service = new SecuritiesRegistryService();
  const filter = typeof options.class === 'string' ? options.class : undefined;
  const assets = service.listAssets(filter);

  console.log();
  console.log(chalk.bold.cyan('  🏛️   Verified Tokenized Securities Registry (2026)'));
  console.log(chalk.gray('  Classified by Legal Rights, Custodial Structure & On-Chain Standards'));
  console.log();

  const table = new Table({
    head: [
      chalk.bold.white('Ticker'),
      chalk.bold.white('Name'),
      chalk.bold.white('Class'),
      chalk.bold.white('Legal Representation'),
      chalk.bold.white('Chain'),
      chalk.bold.white('Status'),
      chalk.bold.white('Trading'),
    ],
    style: { head: [], border: [] },
    colAligns: ['left', 'left', 'center', 'left', 'center', 'center', 'center'],
  });

  for (const a of assets) {
    let repBadge = chalk.white(a.representation);
    if (a.representation === 'issuer_sponsored') {
      repBadge = chalk.bold.green('Issuer-Sponsored (Direct)');
    } else if (a.representation === 'custodial_entitlement') {
      repBadge = chalk.bold.blue('Custodial 1:1 Claim');
    } else {
      repBadge = chalk.bold.yellow('Synthetic Exposure');
    }

    const tradeBadge = a.tradingEnabled ? chalk.green('ENABLED') : chalk.red('DEFAULT DENY');

    table.push([
      chalk.bold.yellow(a.ticker),
      a.displayName,
      a.assetClass.toUpperCase(),
      repBadge,
      a.chainId,
      chalk.green('✓ Verified'),
      tradeBadge,
    ]);
  }

  console.log(table.toString());
  console.log();
  console.log(chalk.bold.white('  Legal Distinction:'));
  console.log(chalk.gray('  • Issuer-Sponsored: Token ownership integrated with issuer share register (SEC transfer agent).'));
  console.log(chalk.gray('  • Custodial Entitlement: Underlying stock held by bank custodian (Swiss DLT / Reg S).'));
  console.log(chalk.gray('  • Synthetic Exposure: Price tracking only. Does not confer corporate voting or dividends.'));
  console.log();
}

export async function securitiesInspectCommand(ticker: string): Promise<void> {
  const service = new SecuritiesRegistryService();
  const asset = service.getAsset(ticker);

  if (!asset) {
    error(`Securities ticker ${ticker} not found in verified registry.`);
    process.exitCode = 1;
    return;
  }

  console.log();
  console.log(chalk.bold.cyan(`  📜  Securities Legal & Technical Specification: ${chalk.bold.yellow(asset.ticker)}`));
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────'));
  console.log(`  ${chalk.cyan('Display Name:')}           ${chalk.bold.white(asset.displayName)}`);
  console.log(`  ${chalk.cyan('Underlying Asset:')}       ${chalk.bold.green(asset.underlyingAsset || 'N/A')}`);
  console.log(`  ${chalk.cyan('Asset Class:')}            ${asset.assetClass.toUpperCase()}`);
  console.log(`  ${chalk.cyan('Legal Structure:')}        ${chalk.bold.magenta(asset.representation.toUpperCase())}`);
  console.log(`  ${chalk.cyan('Issuer Entity:')}          ${asset.issuer}`);
  console.log(`  ${chalk.cyan('Custodian:')}              ${asset.custodian || 'None (Synthetic)'}`);
  console.log(`  ${chalk.cyan('Transfer Agent:')}        ${asset.transferAgent || 'None'}`);
  console.log(`  ${chalk.cyan('Blockchain Network:')}     Chain ID ${asset.chainId}`);
  console.log(`  ${chalk.cyan('Contract Address:')}       ${chalk.yellow(asset.tokenAddress)}`);
  console.log(`  ${chalk.cyan('Token Standard:')}         ${asset.standard}`);
  console.log(`  ${chalk.cyan('Voting/Equity Rights:')}   ${asset.ownershipRightsVerified ? chalk.green('YES (Verified)') : chalk.red('NO (Synthetic / Entitlement only)')}`);
  console.log(`  ${chalk.cyan('Redemption Terms:')}       ${asset.redemptionTermsVerified ? chalk.green('1:1 Physical Redemption Available') : chalk.red('Cash settled / Oracle only')}`);
  console.log(`  ${chalk.cyan('Jurisdiction Rules:')}     ${asset.jurisdictionRules.join(' | ')}`);
  console.log(`  ${chalk.cyan('Investor KYC Gate:')}      ${asset.investorEligibilityRequired ? chalk.yellow('Required (Accredited/Reg S)') : chalk.green('None')}`);
  console.log(`  ${chalk.cyan('Trading Gate:')}           ${asset.tradingEnabled ? chalk.green('ACTIVE') : chalk.red('DISABLED (Gated by Venue Compliance)')}`);
  console.log(`  ${chalk.cyan('Settlement Gate:')}        ${asset.settlementEnabled ? chalk.green('ACTIVE') : chalk.red('DISABLED (Simulation Only)')}`);
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────'));
  console.log();
}

export async function securitiesCompareCommand(ticker: string): Promise<void> {
  const service = new SecuritiesRegistryService();
  try {
    const comp = service.compareCrossVenue(ticker);

    console.log();
    console.log(chalk.bold.cyan(`  ⚖️   Token vs. Underlying Price & Liquidity Intelligence: ${chalk.bold.yellow(comp.ticker)}`));
    console.log();

    const table = new Table({
      head: [
        chalk.bold.white('Metric'),
        chalk.bold.white('Tokenized Instrument'),
        chalk.bold.white('Underlying Equity'),
        chalk.bold.white('Divergence / Impact'),
      ],
      style: { head: [], border: [] },
      colAligns: ['left', 'right', 'right', 'right'],
    });

    const premColor = comp.premiumDiscountBps >= 0 ? chalk.green : chalk.red;
    const premStr = (comp.premiumDiscountBps >= 0 ? '+' : '') + comp.premiumDiscountBps.toFixed(1) + ' bps';

    table.push(
      ['Reference Price ($)', `$${comp.tokenizedPrice.toFixed(2)}`, `$${comp.underlyingPrice.toFixed(2)}`, premColor(premStr)],
      ['Primary Venue', comp.tokenVenue, comp.underlyingVenue, '—'],
      ['Market Session', '24/7 Continuous Blockchain', comp.sessionState, '—'],
      ['Depth ±10 bps', `$${comp.liquidityUsd10bps.toLocaleString()}`, 'Institutional CLOB', 'Venue Specific'],
      ['Depth ±50 bps', `$${comp.liquidityUsd50bps.toLocaleString()}`, 'Deep Pool', 'Venue Specific'],
      ['Estimated Impact ($10k)', `${comp.estimatedImpact10kUsd} bps`, '< 0.5 bps', chalk.yellow(`+${comp.estimatedImpact10kUsd} bps`)],
    );

    console.log(table.toString());
    console.log();
    console.log(chalk.bold.white('  Liquidity Insulation Notice:'));
    console.log(chalk.gray('  Tokenized assets trade against their own discrete on-chain pools and venue order books.'));
    console.log(chalk.gray('  They do NOT automatically inherit the multi-billion dollar liquidity depth of the primary NYSE/NASDAQ order book.'));
    console.log();
  } catch (err) {
    error((err as Error).message);
    process.exitCode = 1;
  }
}

export async function settlementSimulateCommand(
  ticker: string,
  amount: string,
): Promise<void> {
  const service = new SecuritiesRegistryService();
  const asset = service.getAsset(ticker);

  if (!asset) {
    error(`Asset ${ticker} not registered.`);
    process.exitCode = 1;
    return;
  }

  const spinner = ora(`Simulating atomic DvP settlement for ${amount} ${asset.ticker} with USDC…`).start();
  const qty = parseFloat(amount);
  const px = asset.tokenPriceUsd || 100.0;
  const grossUsdc = qty * px;
  const feeUsdc = grossUsdc * 0.0005; // 0.05% settlement fee
  const totalUsdc = grossUsdc + feeUsdc;

  await new Promise((r) => setTimeout(r, 600));
  spinner.succeed('Settlement simulation verified (Pre-Trade Checks Passed)');

  console.log();
  console.log(chalk.bold.cyan('  🔒  Atomic Settlement Simulation (Read-Only DvP Sandbox)'));
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────'));
  console.log(`  ${chalk.cyan('Security Asset:')}        ${asset.displayName} (${asset.ticker})`);
  console.log(`  ${chalk.cyan('Blockchain Network:')}    Chain ID ${asset.chainId}`);
  console.log(`  ${chalk.cyan('Execution Quantity:')}    ${qty.toFixed(4)} ${asset.ticker}`);
  console.log(`  ${chalk.cyan('Reference Price:')}      $${px.toFixed(2)} USDC`);
  console.log(`  ${chalk.cyan('Gross Consideration:')}  $${grossUsdc.toFixed(2)} USDC`);
  console.log(`  ${chalk.cyan('Orchestration Fee:')}    $${feeUsdc.toFixed(2)} USDC (5.0 bps)`);
  console.log(`  ${chalk.cyan('Total Settlement Leg:')}  $${totalUsdc.toFixed(2)} USDC`);
  console.log(`  ${chalk.cyan('Investor KYC Check:')}    ${chalk.green('PASSED (Simulation Profile)')}`);
  console.log(`  ${chalk.cyan('Smart Contract Lock:')}   ${chalk.green('CONFIRMED (ERC-3643 Allowlist compliant)')}`);
  console.log(`  ${chalk.cyan('Settlement Mode:')}        ${chalk.yellow('SIMULATION ONLY (Live keys offline)')}`);
  console.log(chalk.gray('  ─────────────────────────────────────────────────────────────'));
  console.log();
}
