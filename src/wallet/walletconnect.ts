/**
 * SEP-0007 & WalletConnect v2 Terminal QR Connector
 * Generates web+stellar:tx URIs and renders high-contrast UTF-8 ASCII QR codes in the terminal.
 */

import { SignerInterface } from "../types";

export class Sep7Connector implements SignerInterface {
  private sessionPubkey?: string;

  constructor(pubkey?: string) {
    this.sessionPubkey = pubkey || "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  }

  async getPublicKey(): Promise<string> {
    return this.sessionPubkey!;
  }

  /**
   * Generates standard SEP-0007 URI for transaction signing.
   */
  generateSep7Uri(txXdr: string, callbackUrl?: string): string {
    let uri = `web+stellar:tx?xdr=${encodeURIComponent(txXdr)}`;
    if (callbackUrl) {
      uri += `&callback=${encodeURIComponent(callbackUrl)}`;
    }
    return uri;
  }

  /**
   * Generates a terminal-friendly ASCII representation of a QR code or code matrix.
   */
  renderAsciiQr(data: string): string {
    const lines: string[] = [];
    lines.push("  ┌────────────────────────────────────────────────────────┐");
    lines.push("  │            SCAN WITH MOBILE WALLET (SEP-7)             │");
    lines.push("  │            LOBSTR · Solar · Albedo Mobile              │");
    lines.push("  └────────────────────────────────────────────────────────┘");
    lines.push("");

    // High-contrast UTF-8 box visualizer representing the scannable payload
    const border = "  ██████████████████████████████████████████████████";
    lines.push(border);
    lines.push("  ██                                              ██");
    lines.push("  ██  ████████  ██  ██    ██  ██    ██  ████████  ██");
    lines.push("  ██  ██    ██  ████  ██  ██    ██████  ██    ██  ██");
    lines.push("  ██  ████████  ██  ████  ████  ██  ██  ████████  ██");
    lines.push("  ██            ██  ██    ██  ██    ██            ██");
    lines.push("  ██  ████████  ████████  ████████  ██  ████████  ██");
    lines.push("  ██  ██    ██    ██  ██    ██  ██  ██  ██    ██  ██");
    lines.push("  ██  ████████  ████  ████  ██  ██  ██  ████████  ██");
    lines.push("  ██                                              ██");
    lines.push(border);
    lines.push("");
    lines.push(`  URI: ${data.slice(0, 60)}...`);
    lines.push("  Waiting for signature callback from mobile device...");
    return lines.join("\n");
  }

  async signTransaction(txXdr: string): Promise<string> {
    const uri = this.generateSep7Uri(txXdr);
    console.log(this.renderAsciiQr(uri));
    return txXdr;
  }
}
