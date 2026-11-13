/**
 * FurlPay Stellar Tokenized Equities, RWAs & SDEX/Soroban Execution Test Suite
 */

const assert = require("assert");
const test = require("node:test");
const {
  loadConfig,
  formatToml,
  parseTomlLike,
  LedgerSigner,
  Sep7Connector,
  ExtensionLoopbackBridge,
  KeystoreService,
  AgentKeyService,
  SmartOrderRouter,
  SdexTradingService,
  PathPaymentService,
  SorobanTradingService,
  OrderManager,
  RwaRegistry,
  X402Engine,
  McpStdioServer,
  KeypairSigner,
} = require("../dist/index");
const { Keypair } = require("@stellar/stellar-sdk");

test("FurlPay Stellar: Configuration & TOML Serialization", () => {
  const cfg = loadConfig();
  assert.ok(cfg.network.mainnet.horizonUrl.includes("stellar.org"));
  assert.strictEqual(cfg.trading.defaultSlippagePct, 0.5);
  assert.strictEqual(cfg.agent_trust.maxSingleTxUsd, 10.0);

  const toml = formatToml(cfg);
  assert.ok(toml.includes("[network.mainnet]"));
  assert.ok(toml.includes('active_profile = "mainnet"'));

  const parsed = parseTomlLike(toml);
  assert.strictEqual(parsed.network.activeProfile, "mainnet");
  assert.strictEqual(parsed.trading.defaultSlippagePct, 0.5);
});

test("FurlPay Stellar: Ledger Hardware Wallet Interface (APDU & Clear-Signing)", async () => {
  const ledger = new LedgerSigner(0);
  const info = await ledger.probe();
  assert.strictEqual(info.model, "Ledger Nano X");
  assert.strictEqual(info.derivationPath, "m/44'/148'/0'");
  assert.ok(info.publicKey.startsWith("G"));

  const clearSign = ledger.parseClearSigningDetails("DUMMY_XDR");
  assert.strictEqual(clearSign.operation, "Manage Buy Offer");
  assert.ok(clearSign.buying.includes("JQQQ"));
  assert.ok(clearSign.price.includes("USDC"));
});

test("FurlPay Stellar: SEP-0007 URI & ASCII Terminal QR", async () => {
  const sep7 = new Sep7Connector();
  const uri = sep7.generateSep7Uri("AAAA_SAMPLE_XDR", "https://callback.furlpay.io");
  assert.ok(uri.startsWith("web+stellar:tx?xdr=AAAA_SAMPLE_XDR"));
  assert.ok(uri.includes("callback="));

  const qr = sep7.renderAsciiQr(uri);
  assert.ok(qr.includes("SCAN WITH MOBILE WALLET"));
  assert.ok(qr.includes("████████"));
});

test("FurlPay Stellar: Browser Extension Loopback Bridge", async () => {
  const bridge = new ExtensionLoopbackBridge(4025);
  const pub = await bridge.getPublicKey();
  assert.ok(pub.startsWith("G"));
  bridge.close();
});

test("FurlPay Stellar: Encrypted Keystore (PBKDF2 & AES-256-GCM)", () => {
  const tmpKeystorePath = require("path").join(require("os").tmpdir(), `test-keystore-${Date.now()}.enc`);
  const ks = new KeystoreService(tmpKeystorePath);

  const testSecret = Keypair.random().secret();
  const entry = ks.importSecretKey("desk-trader", testSecret, "super-secret-password");
  assert.strictEqual(entry.name, "desk-trader");
  assert.strictEqual(entry.type, "secret_key");

  const retrieved = ks.getKey("desk-trader", "super-secret-password");
  assert.strictEqual(retrieved.secret, testSecret);

  assert.throws(() => {
    ks.getKey("desk-trader", "wrong-password");
  });
});

test("FurlPay Stellar: Delegated Agent Session Key Policies", () => {
  const tmpPolicyDir = require("path").join(require("os").tmpdir(), `test-policies-${Date.now()}`);
  const agentService = new AgentKeyService(tmpPolicyDir);

  const gen = agentService.generateAgentKey({
    name: "agent-quant",
    dailyLimit: 100.0,
    allowedAssets: ["USDC", "JQQQ"],
    singleTxCap: 15.0,
  });

  assert.strictEqual(gen.policy.dailyLimitUsd, 100.0);
  assert.strictEqual(gen.policy.singleTxCapUsd, 15.0);

  // Check spend within cap
  const pass = agentService.validateAgentSpend(gen.policy, 10.0, "JQQQ");
  assert.strictEqual(pass.allowed, true);

  // Check spend exceeding singleTxCap
  const overCap = agentService.validateAgentSpend(gen.policy, 25.0, "JQQQ");
  assert.strictEqual(overCap.allowed, false);
  assert.ok(overCap.reason.includes("exceeds single transaction cap"));

  // Check unauthorized asset
  const wrongAsset = agentService.validateAgentSpend(gen.policy, 5.0, "BTC");
  assert.strictEqual(wrongAsset.allowed, false);
  assert.ok(wrongAsset.reason.includes("whitelist"));
});

test("FurlPay Stellar: Smart Order Router (SDEX & Soroban AMM Multi-Hop)", async () => {
  const router = new SmartOrderRouter();
  const quote = await router.findBestRoute("USDC", "JQQQ", 1000.0, 0.5);

  assert.strictEqual(quote.sourceAsset, "USDC");
  assert.strictEqual(quote.targetAsset, "JQQQ");
  assert.ok(quote.expectedReceiveAmount > 9.0);
  assert.strictEqual(quote.orderingProperties.frontRunningRisk, "REDUCED_NOT_ELIMINATED");
  assert.strictEqual(quote.orderingProperties.publicMempool, false);
});

test("FurlPay Stellar: SDEX Limit Order Execution with SEP-8 & Fee-Bump Sponsorship", async () => {
  const sdex = new SdexTradingService();
  const kp = Keypair.random();
  const signer = new KeypairSigner(kp);

  const res = await sdex.executeLimitOrder(signer, {
    side: "buy",
    asset: "JQQQ:GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ",
    against: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    amount: "25",
    price: "104.20",
    sponsor: true,
  });

  assert.strictEqual(res.status, "FILLED");
  assert.strictEqual(res.filledAmount, "25");
  assert.strictEqual(res.totalCost, "2605.0000");
  assert.strictEqual(res.sponsored, true);
  // JQQQ is a SEP-8 regulated asset: this build never contacts an approval
  // server, so the result must NOT claim compliance — it must say plainly
  // that issuer authorization was not performed.
  assert.strictEqual(res.sep8Compliant, false);
  assert.strictEqual(res.sep8Status, "not_performed");
  assert.ok(res.sep8Note.includes("not implemented in this build"));
  assert.ok(res.feePaidUsd.includes("Sponsored"));
});

test("FurlPay Stellar: Path Payment Strict Send with Guaranteed Dest Min", async () => {
  const pathService = new PathPaymentService();
  const kp = Keypair.random();
  const signer = new KeypairSigner(kp);

  const res = await pathService.executeMarketBuy(signer, {
    asset: "JQQQ:GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ",
    with: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    spend: "1000.00",
    slippage: 0.5,
    sponsor: true,
  });

  assert.strictEqual(res.sourceAsset, "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  assert.ok(parseFloat(res.receivedAmount) > 9.0);
  assert.strictEqual(res.sponsored, true);
});

test("FurlPay Stellar: Soroban AMM Swap Execution & Resource Simulation", async () => {
  const soroban = new SorobanTradingService();
  const kp = Keypair.random();
  const signer = new KeypairSigner(kp);

  const res = await soroban.executeSwap(signer, {
    poolId: "7c8e99_SOROBAN_AMM",
    sellAsset: "USDC",
    sellAmount: "500",
    minReceive: "4.88",
    asset: "FOBXX",
    sponsor: true,
  });

  assert.strictEqual(res.soldAmount, "500");
  assert.strictEqual(res.receivedAmount, "4.88");
  assert.ok(res.simulation.cpuInstructions > 1000000);
  assert.strictEqual(res.sponsored, true);
});

test("FurlPay Stellar: SDEX Order Management (List, Inspect, Cancel)", async () => {
  const orders = new OrderManager();
  const kp = Keypair.random();
  const signer = new KeypairSigner(kp);

  const list = await orders.listOrders("dummy_account");
  assert.strictEqual(list.length, 2);

  const inspect = await orders.inspectOrder("8829104");
  assert.strictEqual(inspect.buying.code, "JQQQ");
  assert.strictEqual(inspect.price, "104.2000000");

  const canceled = await orders.cancelOrder(signer, "8829104", true);
  assert.strictEqual(canceled.status, "CANCELED");
  assert.strictEqual(canceled.sponsored, true);

  const remaining = await orders.listOrders("dummy_account");
  assert.strictEqual(remaining.length, 1);
});

test("FurlPay Stellar: Institutional Tokenized Stocks & RWA Registry", () => {
  const rwa = new RwaRegistry();
  const all = rwa.list();
  assert.strictEqual(all.length, 5);

  const equities = rwa.list("equities");
  assert.strictEqual(equities.length, 3);

  const jqqq = rwa.inspect("JQQQ");
  assert.strictEqual(jqqq.code, "JQQQ");
  assert.ok(jqqq.regime.includes("SEC Reg D"));
  assert.strictEqual(jqqq.requiresSep8, true);

  // Yields are issuer-reported, time-varying facts — the registry must never
  // carry a hardcoded APY figure.
  const fobxx = rwa.inspect("FOBXX");
  assert.strictEqual(fobxx.apy, undefined);

  // No KYC provider is integrated: the flow must refuse to report an approval.
  const kyc = rwa.startKycFlow("FOBXX");
  assert.strictEqual(kyc.status, "NOT_IMPLEMENTED");
  assert.ok(kyc.instructions.includes("no approval was granted"));
});

test("FurlPay Stellar: HTTP 402 Micropayment Engine & TigerBeetle Netting", async () => {
  const x402 = new X402Engine();
  const challenge = x402.parseChallenge(
    'WWW-Authenticate: x402 recipient="GBLX99API", amount="0.0005", token="USDC", nonce="abcd1234"'
  );
  assert.strictEqual(challenge.recipient, "GBLX99API");
  assert.strictEqual(challenge.amount, "0.0005");
  assert.strictEqual(challenge.nonce, "abcd1234");

  // SIMULATION-ONLY semantics (2026-11-12 audit): the engine has no
  // TigerBeetle connection, so the result must SAY simulated — a canned
  // SETTLED here previously fabricated a settlement record.
  const settled = await x402.settleChallenge(challenge);
  assert.strictEqual(settled.status, "SIMULATED");
  assert.strictEqual(settled.settlementType, "LOCAL_SIMULATION");
  assert.match(settled.txId, /^furlpay_simnet_/);
  assert.ok(settled.authorizationHeader.startsWith("Authorization: x402"));
});

test("FurlPay Stellar: Model Context Protocol (MCP) Server Tool Calls", async () => {
  const mcp = new McpStdioServer();
  const tools = mcp.getToolDefinitions();
  assert.ok(tools.length >= 7, "Should register core trading and settlement MCP tools");
  const toolNames = tools.map((t) => t.name);
  assert.ok(toolNames.includes("furlpay_settle_invoice"));
  assert.ok(toolNames.includes("furlpay_sweep_treasury"));
  assert.ok(toolNames.includes("furlpay_trade"));
  assert.ok(toolNames.includes("furlpay_trade_perp"));
  assert.ok(toolNames.includes("furlpay_get_hlp_yield"));
  assert.ok(toolNames.includes("furlpay_balance"));
  assert.ok(toolNames.includes("furlpay_get_quote"));

  // Call furlpay_settle_invoice
  const invoiceRes = await mcp.handleCall("furlpay_settle_invoice", {
    challengeHeader: 'WWW-Authenticate: x402 recipient="GBLX99API", amount="0.0005", token="USDC"',
  });
  assert.strictEqual(invoiceRes.status, "SIMULATED", "settlement is local simulation only");
  assert.strictEqual(invoiceRes.settlement_type, "LOCAL_SIMULATION");

  // Call furlpay_sweep_treasury with FOBXX (Stellar Benji regulated yield)
  const fobxxSweep = await mcp.handleCall("furlpay_sweep_treasury", { amountUsd: 1000.0, target: "FOBXX" });
  assert.strictEqual(fobxxSweep.status, "SIMULATED", "FOBXX sweep has no live contract call — must be labeled simulated");
  assert.strictEqual(fobxxSweep.simulated, true);
  assert.strictEqual(fobxxSweep.vault, "STELLAR_FOBXX_BENJI");
  // No issuer data source exists in this build — APY must be null, never a
  // fabricated figure, with an explicit note explaining why.
  assert.strictEqual(fobxxSweep.apy, null);
  assert.ok(fobxxSweep.apy_note.includes("no issuer data source"));

  // Mutating tool without configured signer must strictly fail closed
  await assert.rejects(
    async () => {
      await mcp.handleCall("furlpay_sweep_treasury", { amountUsd: 1000.0, target: "HLP" });
    },
    { message: /No signer configured/ }
  );

  await assert.rejects(
    async () => {
      await mcp.handleCall("furlpay_trade_perp", {
        symbol: "BTC-PERP",
        side: "buy",
        size: 1,
        leverage: 5,
      });
    },
    { message: /No signer configured/ }
  );

  // Call furlpay_get_hlp_yield
  const hlpStats = await mcp.handleCall("furlpay_get_hlp_yield", {});
  assert.ok(hlpStats.trailing30dApyPct === null || hlpStats.trailing30dApyPct >= 0,
    "APY is live-derived or explicitly null — never a fabricated benchmark");
  assert.ok(hlpStats.sharePriceUsd === null, "share price must not be fabricated (exchange-determined)");
  assert.ok(hlpStats.vaultAddress.startsWith("0x"));

  // Call furlpay_balance
  const balRes = await mcp.handleCall("furlpay_balance", {});
  assert.ok(balRes.balances.length >= 4);
});

test("FurlPay Hyperliquid: L1 Perpetuals & HLP Clearinghouse Vault", async () => {
  const { HlpVaultService } = require("../dist/index");
  const { HyperliquidPerpService } = require("../dist/index");

  const hlp = new HlpVaultService();
  const stats = await hlp.getHlpStats();
  // P1 #7: figures derive from the live vaultDetails payload or are null —
  // the old 850M equity / 28.5% APY / 1.4285 NAV fallbacks must stay gone.
  if (stats.totalEquityUsd !== null) {
    assert.ok(stats.totalEquityUsd > 100_000_000, "live HLP equity > $100M");
  }
  if (stats.trailing30dApyPct !== null) {
    assert.ok(stats.trailing30dApyPct > 0, "live HLP APY > 0 (sign preserved)");
  }
  assert.strictEqual(stats.sharePriceUsd, null);
  assert.strictEqual(stats.activePositionsCount, null);

  // SEC-FAIL-CLOSED: Unauthenticated HLP deposit must strictly reject without a configured signer
  await assert.rejects(
    async () => {
      await hlp.deposit(500);
    },
    { message: /No signer configured/ }
  );

  const perp = new HyperliquidPerpService();
  const liqLong = perp.calculateLiquidationPrice(100, 10, "buy");
  // 100 * (1 - 0.1 + 0.03) = 93.00
  assert.strictEqual(liqLong, 93);

  const liqShort = perp.calculateLiquidationPrice(100, 10, "sell");
  // 100 * (1 + 0.1 - 0.03) = 107.00
  assert.strictEqual(liqShort, 107);

  // SEC-FAIL-CLOSED: Unauthenticated perp order must strictly reject without a configured signer
  await assert.rejects(
    async () => {
      await perp.executePerpOrder({
        symbol: "BTC-PERP",
        side: "buy",
        size: 0.01,
        leverage: 10,
        price: 75000,
        orderType: "limit",
      });
    },
    { message: /No signer configured/ }
  );
});
