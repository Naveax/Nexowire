/** Read-only dashboard state. No field is a dispatch credential or grants
 * permission to issue a privileged operation. Epoch namespaces are distinct. */
export interface CoreRevocationDashboardReadback {
  version:1;
  source:'D1_REMOTE_AUTHORIZATION';
  remoteAuthorization:{state:'ACTIVE'|'REVOKED'|'UNKNOWN';authorizationEpoch:number|null;observedAtMs:number|null};
  localStop:'UNKNOWN';
  pendingRevoke:'UNKNOWN';
  nativeDrain:'UNKNOWN';
  effectReadback:'UNKNOWN';
  /** Source is explicitly limited to the remote D1 row until a separately
   * accepted protected local/native readback contract is installed. */
  nativeEvidence:'NOT_AVAILABLE';
}
export interface ProductDeviceSummary {
  id: string;
  name: string;
  online: boolean;
  platform: string;
  accessMode: 'safe' | 'full';
  rootMode: { active: boolean; expiresAt: string | null };
  persistentMaintenance: { enabled: boolean; active: boolean; updatedAt: string | null };
  physicalConsole?: {localEnrolled:boolean;active:boolean;observedAtMs:number|null;
    enrollmentRequested?:boolean;deviceReady?:boolean};
  coreRevocation?:CoreRevocationDashboardReadback;
  bridgePreference: { desiredMode: 'auto' | 'on' | 'off'; applied: false; updatedAt: string | null };
  agentVersion: string | null;
  privilegeMode: 'direct' | 'broker' | null;
  adminBridgeReady: boolean | null;
  lastSeenAt: string | null;
  folderId: string | null;
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
  folders: { id: string; name: string }[];
  autoSelectDevices: boolean;
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
