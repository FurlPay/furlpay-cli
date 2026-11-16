# Stellar Wallets & SDEX Trading

Five custody options, all non-custodial — the CLI builds transactions, your signer approves them, and private keys never leave the device or keystore.

## Connect a wallet (`furlpay wallet`)

```bash
# Ledger Nano S/X/Stax over USB HID (derivation m/44'/148'/0')
furlpay wallet connect ledger --derivation-index 0

# Mobile wallets via SEP-0007 / WalletConnect v2 (high-contrast ASCII QR)
furlpay wallet connect walletconnect --qr
furlpay wallet connect sep7

# Browser loopback bridge on 127.0.0.1:4024 for Freighter & Albedo
furlpay wallet connect extension --port 4024

# Import a key or 12/24-word mnemonic into the encrypted keystore
# (stdin only — never argv; terminal echo is suppressed on a TTY)
printf '%s\n' "mnemonic words …" "keystore_password" | furlpay wallet import --name desk-primary --mnemonic
furlpay wallet list
```

The keystore is PBKDF2 (100k iterations, SHA-512) + AES-256-GCM.

## Issuer validation — no silent fallback

Asset issuers must be **checksum-valid Ed25519 public keys** (`StrKey.isValidEd25519PublicKey`). A typo'd or vanity issuer key refuses execution with instructions to resolve the real issuer from the asset's signed `stellar.toml` (SEP-1). There is **no fallback issuer** — an invalid key can never silently trade as an asset "issued" by Circle's USDC master account.

Bare `USDC` (no issuer) resolves to the documented Circle mainnet issuer `GA5Z…KZVN`, which is real, checksum-valid, and verified against Circle's own stellar.toml.

## SDEX trading (`furlpay trade`)

::: warning Honesty label
Stellar SDEX order placement and Soroban swaps are **clearly-labeled local simulations** in this build — no transactions are broadcast. SEP-8 status on regulated assets is `not_performed`, never claimed. See the [Honesty Matrix](/reference/honesty-matrix).
:::

```bash
# Limit order with gasless fee-bump sponsorship
furlpay trade limit \
  --side buy \
  --asset JQQQ:<real-issuer-from-stellar.toml> \
  --against USDC \
  --amount 25 --price 104.20 --sponsor

# Path payment strict-send (market buy) with dest-min slippage protection
furlpay trade market-buy \
  --asset JQQQ:<issuer> --with USDC --spend 1000.00 --slippage 0.5 --sponsor

# Soroban AMM SEP-41 swap with pre-flight gas simulation
furlpay trade swap --pool-id 7c8e99… --sell-asset USDC --sell-amount 500 --min-receive 4.88 --asset FOBXX

# Interactive ASCII depth chart & order book
furlpay trade terminal --pair JQQQ/USDC
```

## Order management (`furlpay order`)

```bash
furlpay order list --pair JQQQ/USDC
furlpay order inspect --offer-id 8829104
furlpay order cancel --offer-id 8829104 --sponsor
furlpay order cancel-all --pair NVDA/USDC
```

## Going live

To move SDEX/Soroban from simulation to real broadcast, the synthetic `sim_` hash return is replaced with `server.submitTransaction(tx)` — the transaction builders, signers and SEP-8 status plumbing are already in place. Config for a live environment:

```bash
export STELLAR_NETWORK=PUBLIC
export HORIZON_URL=https://horizon.stellar.org
```
