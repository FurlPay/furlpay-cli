/**
 * Dynamic Provider & Adapter Registry
 * 
 * Manages runtime registration, dynamic connectivity verification, health monitoring,
 * and graceful failover across multiple blockchain networks and trading venues.
 * 
 * Invariants:
 * - A configured adapter is NEVER marked "connected" without verifying live connectivity.
 * - One failing adapter or provider MUST NOT disrupt or disable other operational adapters.
 * - Exponential backoff and circuit-breaking protect against cascading rate limits.
 */

import {
  ExchangeAdapter,
  NetworkProvider,
  TokenDiscoveryProvider,
  AdapterHealth,
  ChainId,
  ConnectionStatus,
  VenueCapabilities,
} from "./types";

export interface RegistryConfig {
  healthCheckIntervalMs?: number;
  circuitBreakerThreshold?: number;
  backoffBaseMs?: number;
}

export class ProviderRegistry {
  private adapters: Map<string, ExchangeAdapter> = new Map();
  private networkProviders: Map<string, NetworkProvider> = new Map();
  private tokenProviders: Map<string, TokenDiscoveryProvider> = new Map();
  
  // Health and circuit-breaker tracking
  private healthCache: Map<string, AdapterHealth> = new Map();
  private consecutiveFailures: Map<string, number> = new Map();
  private circuitOpenUntil: Map<string, number> = new Map();

  private readonly config: Required<RegistryConfig>;

  constructor(config?: RegistryConfig) {
    this.config = {
      healthCheckIntervalMs: config?.healthCheckIntervalMs || 30_000,
      circuitBreakerThreshold: config?.circuitBreakerThreshold || 3,
      backoffBaseMs: config?.backoffBaseMs || 2_000,
    };
  }

  /**
   * Dynamically register an exchange adapter.
   */
  registerAdapter(adapter: ExchangeAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.consecutiveFailures.set(adapter.id, 0);
    this.healthCache.set(adapter.id, {
      adapterId: adapter.id,
      status: "unconfigured",
      latencyMs: 0,
      lastChecked: 0,
      message: "Registered, pending initial health check",
      activeMarketsCount: 0,
    });
  }

  /**
   * Unregister an exchange adapter at runtime.
   */
  unregisterAdapter(adapterId: string): boolean {
    this.healthCache.delete(adapterId);
    this.consecutiveFailures.delete(adapterId);
    this.circuitOpenUntil.delete(adapterId);
    return this.adapters.delete(adapterId);
  }

  /**
   * Register a network provider for blockchain connectivity.
   */
  registerNetworkProvider(name: string, provider: NetworkProvider): void {
    this.networkProviders.set(name, provider);
  }

  /**
   * Register a token discovery provider.
   */
  registerTokenProvider(name: string, provider: TokenDiscoveryProvider): void {
    this.tokenProviders.set(name, provider);
  }

  getAdapter(adapterId: string): ExchangeAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  listAdapters(): ExchangeAdapter[] {
    return Array.from(this.adapters.values());
  }

  listNetworkProviders(): NetworkProvider[] {
    return Array.from(this.networkProviders.values());
  }

  /**
   * Check health of an individual adapter with circuit-breaker protection.
   */
  async checkAdapterHealth(adapterId: string, forceCheck = false): Promise<AdapterHealth> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      return {
        adapterId,
        status: "disconnected",
        latencyMs: 0,
        lastChecked: Date.now(),
        message: "Adapter not registered",
        activeMarketsCount: 0,
      };
    }

    const cached = this.healthCache.get(adapterId);
    const now = Date.now();

    // Circuit breaker check
    const openUntil = this.circuitOpenUntil.get(adapterId) || 0;
    if (now < openUntil && !forceCheck) {
      return {
        adapterId,
        status: "error",
        latencyMs: 0,
        lastChecked: cached?.lastChecked || now,
        message: `Circuit breaker active until ${new Date(openUntil).toISOString()}`,
        activeMarketsCount: 0,
      };
    }

    // Cache hit
    if (!forceCheck && cached && cached.status !== "unconfigured" && (now - cached.lastChecked < this.config.healthCheckIntervalMs)) {
      return cached;
    }

    try {
      const health = await adapter.checkHealth();
      this.healthCache.set(adapterId, health);
      this.consecutiveFailures.set(adapterId, 0);
      this.circuitOpenUntil.delete(adapterId);
      return health;
    } catch (err: any) {
      const failures = (this.consecutiveFailures.get(adapterId) || 0) + 1;
      this.consecutiveFailures.set(adapterId, failures);

      if (failures >= this.config.circuitBreakerThreshold) {
        const coolDown = this.config.backoffBaseMs * Math.pow(2, failures - this.config.circuitBreakerThreshold);
        this.circuitOpenUntil.set(adapterId, now + Math.min(coolDown, 60_000));
      }

      const failedHealth: AdapterHealth = {
        adapterId,
        status: "error",
        latencyMs: 0,
        lastChecked: now,
        message: `Health check failed: ${err?.message || "Unknown error"}`,
        activeMarketsCount: 0,
      };
      this.healthCache.set(adapterId, failedHealth);
      return failedHealth;
    }
  }

  /**
   * Concurrently check health across all registered adapters.
   * Isolates failures so one failing adapter does not throw or block others.
   */
  async checkAllHealth(forceCheck = false): Promise<Map<string, AdapterHealth>> {
    const results = new Map<string, AdapterHealth>();
    const checks = Array.from(this.adapters.keys()).map(async (id) => {
      const health = await this.checkAdapterHealth(id, forceCheck);
      results.set(id, health);
    });

    await Promise.allSettled(checks);
    return results;
  }

  /**
   * Retrieve list of verified operational (connected) adapters.
   */
  async getOperationalAdapters(): Promise<ExchangeAdapter[]> {
    const healthMap = await this.checkAllHealth();
    const operational: ExchangeAdapter[] = [];

    for (const [id, adapter] of this.adapters.entries()) {
      const health = healthMap.get(id);
      if (health && (health.status === "connected" || health.status === "simulated")) {
        operational.push(adapter);
      }
    }

    return operational;
  }

  /**
   * Aggregate capabilities across all operational venues.
   */
  async aggregateCapabilities(): Promise<Map<string, VenueCapabilities>> {
    const operational = await this.getOperationalAdapters();
    const caps = new Map<string, VenueCapabilities>();
    for (const adapter of operational) {
      caps.set(adapter.id, adapter.getCapabilities());
    }
    return caps;
  }
}
