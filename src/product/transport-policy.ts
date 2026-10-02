export type ProductTransportRoute =
  | 'direct'
  | 'user-hosted'
  | 'shared-free-relay'
  | 'prepaid-relay';

export interface TransportAvailability {
  directAvailable: boolean;
  userHostedAvailable: boolean;
  sharedFreeRelayAvailable: boolean;
  prepaidRelayAvailable: boolean;
  prepaidRelayCredits: number;
}

export interface TransportDecision {
  allowed: boolean;
  route: ProductTransportRoute | null;
  denialReason: 'no-zero-owner-spend-route' | null;
}

export function selectZeroOwnerSpendTransport(
  availability: TransportAvailability,
): TransportDecision {
  if (
    !Number.isInteger(availability.prepaidRelayCredits) ||
    availability.prepaidRelayCredits < 0
  ) {
    throw new Error(
      'prepaidRelayCredits must be a non-negative integer.',
    );
  }

  if (availability.directAvailable) {
    return {
      allowed: true,
      route: 'direct',
      denialReason: null,
    };
  }

  if (availability.userHostedAvailable) {
    return {
      allowed: true,
      route: 'user-hosted',
      denialReason: null,
    };
  }

  if (availability.sharedFreeRelayAvailable) {
    return {
      allowed: true,
      route: 'shared-free-relay',
      denialReason: null,
    };
  }

  if (
    availability.prepaidRelayAvailable &&
    availability.prepaidRelayCredits > 0
  ) {
    return {
      allowed: true,
      route: 'prepaid-relay',
      denialReason: null,
    };
  }

  return {
    allowed: false,
    route: null,
    denialReason: 'no-zero-owner-spend-route',
  };
}
