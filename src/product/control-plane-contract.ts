export interface ProductDeviceSummary {
  id: string;
  name: string;
  online: boolean;
  platform: string;
  accessMode: 'safe' | 'full';
  agentVersion: string | null;
  privilegeMode: 'direct' | 'broker' | null;
  adminBridgeReady: boolean | null;
  lastSeenAt: string | null;
}

export interface ProductUsageSummary {
  usedCredits: number;
  monthlyCredits: number | null;
  prepaidCredits: number | null;
  periodStart: string;
  periodEnd: string;
}

export interface ProductStabilitySummary {
  successRate: number | null;
  medianLatencyMs: number | null;
  reconnects30d: number | null;
}

export interface UserDashboardSnapshot {
  accountId: string;
  displayName: string | null;
  planId: 'free' | 'plus' | 'pro' | 'custom';
  billingMode: 'free' | 'subscription' | 'prepaid-metered';
  usage: ProductUsageSummary;
  devices: ProductDeviceSummary[];
  stability: ProductStabilitySummary;
  privateControlsIncluded: boolean;
}

export interface AdminOverviewSnapshot {
  generatedAt: string;
  users: {
    total: number;
    active24h: number;
    paid: number;
  };
  devices: {
    total: number;
    online: number;
  };
  usage: {
    calls24h: number;
    calls30d: number;
    successRate: number | null;
  };
  infrastructure: {
    ownerPaidSpendAllowed: false;
    providerAutoUpgradeAllowed: false;
    freeCapacityPercent: number | null;
    prepaidCapacityCredits: number;
  };
}
