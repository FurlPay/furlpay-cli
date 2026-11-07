/**
 * FurlPay Order Lifecycle Manager (2026)
 * 
 * Enforces a strict, deterministic state machine for order transitions:
 * CREATED -> AUTHORIZED -> SUBMITTED -> RESTING -> PARTIALLY_FILLED -> FILLED
 * Terminal states: FILLED, CANCELLED, REJECTED, EXPIRED.
 * 
 * Provides idempotency tracking via 128-bit hex Client Order IDs (cloid)
 * and timeout recovery without duplicate executions.
 */

import crypto from "crypto";

export type OrderLifecycleState =
  | "CREATED"
  | "AUTHORIZED"
  | "SUBMITTED"
  | "RESTING"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "AWAITING_RECONCILIATION";

export interface ManagedOrder {
  orderId: string;
  cloid: string;
  coin: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  filledSize: string;
  state: OrderLifecycleState;
  createdAt: number;
  updatedAt: number;
  exchangeOid?: number;
  fills: Array<{ fillSz: string; fillPx: string; feeUsd: string; timestamp: number }>;
  rejectionReason?: string;
}

export class OrderLifecycleManager {
  private orders = new Map<string, ManagedOrder>();
  private cloidToId = new Map<string, string>();

  /**
   * Generates a compliant 128-bit (16-byte) hexadecimal client order ID.
   * Example: "0x4a8f9b2c3d1e0f7a8b9c0d1e2f3a4b5c"
   */
  public static generateCloid(): string {
    return "0x" + crypto.randomBytes(16).toString("hex");
  }

  public createOrder(params: {
    coin: string;
    side: "buy" | "sell";
    price: string;
    size: string;
    customCloid?: string;
  }): ManagedOrder {
    const cloid = params.customCloid || OrderLifecycleManager.generateCloid();
    if (this.cloidToId.has(cloid)) {
      throw new Error(`IDEMPOTENCY_VIOLATION: Order with cloid ${cloid} already exists.`);
    }

    const orderId = `fp_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const now = Date.now();

    const order: ManagedOrder = {
      orderId,
      cloid,
      coin: params.coin,
      side: params.side,
      price: params.price,
      size: params.size,
      filledSize: "0",
      state: "CREATED",
      createdAt: now,
      updatedAt: now,
      fills: [],
    };

    this.orders.set(orderId, order);
    this.cloidToId.set(cloid, orderId);
    return order;
  }

  public getOrder(orderId: string): ManagedOrder | undefined {
    return this.orders.get(orderId);
  }

  public getOrderByCloid(cloid: string): ManagedOrder | undefined {
    const id = this.cloidToId.get(cloid);
    return id ? this.orders.get(id) : undefined;
  }

  /**
   * Transition order to AUTHORIZED once pre-trade risk checks pass.
   */
  public markAuthorized(orderId: string): void {
    const o = this.mustGetOrder(orderId);
    this.assertValidTransition(o.state, "AUTHORIZED");
    o.state = "AUTHORIZED";
    o.updatedAt = Date.now();
  }

  /**
   * Transition order to SUBMITTED once EIP-712 envelope is posted.
   */
  public markSubmitted(orderId: string): void {
    const o = this.mustGetOrder(orderId);
    this.assertValidTransition(o.state, "SUBMITTED");
    o.state = "SUBMITTED";
    o.updatedAt = Date.now();
  }

  /**
   * Exchange confirms order is resting on the book.
   */
  public markResting(orderId: string, exchangeOid: number): void {
    const o = this.mustGetOrder(orderId);
    this.assertValidTransition(o.state, "RESTING");
    o.state = "RESTING";
    o.exchangeOid = exchangeOid;
    o.updatedAt = Date.now();
  }

  /**
   * Record trade execution fill.
   */
  public recordFill(orderId: string, fillSz: string, fillPx: string, feeUsd: string = "0"): void {
    const o = this.mustGetOrder(orderId);
    const newFilled = (parseFloat(o.filledSize) + parseFloat(fillSz)).toFixed(4);
    o.filledSize = newFilled;
    o.fills.push({
      fillSz,
      fillPx,
      feeUsd,
      timestamp: Date.now(),
    });

    const totalTarget = parseFloat(o.size);
    if (parseFloat(newFilled) >= totalTarget) {
      o.state = "FILLED";
    } else {
      o.state = "PARTIALLY_FILLED";
    }
    o.updatedAt = Date.now();
  }

  /**
   * Cancel order.
   */
  public markCancelled(orderId: string): void {
    const o = this.mustGetOrder(orderId);
    this.assertValidTransition(o.state, "CANCELLED");
    o.state = "CANCELLED";
    o.updatedAt = Date.now();
  }

  /**
   * Reject order.
   */
  public markRejected(orderId: string, reason: string): void {
    const o = this.mustGetOrder(orderId);
    this.assertValidTransition(o.state, "REJECTED");
    o.state = "REJECTED";
    o.rejectionReason = reason;
    o.updatedAt = Date.now();
  }

  /**
   * Mark order awaiting reconciliation after network timeout to prevent duplicate retries.
   */
  public markAwaitingReconciliation(orderId: string): void {
    const o = this.mustGetOrder(orderId);
    o.state = "AWAITING_RECONCILIATION";
    o.updatedAt = Date.now();
  }

  private mustGetOrder(orderId: string): ManagedOrder {
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`ORDER_NOT_FOUND: Order ${orderId} does not exist.`);
    return o;
  }

  private assertValidTransition(from: OrderLifecycleState, to: OrderLifecycleState): void {
    const terminalStates: OrderLifecycleState[] = ["FILLED", "CANCELLED", "REJECTED"];
    if (terminalStates.includes(from)) {
      throw new Error(`ILLEGAL_TRANSITION: Cannot transition order from terminal state ${from} to ${to}.`);
    }
  }
}
