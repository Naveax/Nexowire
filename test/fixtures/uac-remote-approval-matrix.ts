/**
 * #617 / worker #27: synthetic policy/observation fixtures, NOT local UAC evidence.
 * No fixture has authority to approve Windows consent or enroll a Broker.
 * "reported-elevated" means only an untrusted test double claims elevation.
 */
export type ConsentFixture = number | 'enumeration-error';
export type BrokerFixture = 'none' | 'reported-elevated' | 'not-elevated' | 'probe-error';
export type SessionFixture =
  | 'local-console'
  | 'remote-assistance'
  | 'remote-desktop'
  | 'headless'
  | 'uiaccess-app';

export interface UacApprovalFixture {
  readonly id: string;
  readonly session: SessionFixture;
  readonly consent: ConsentFixture;
  readonly accessMode: 'full' | 'safe';
  readonly broker: BrokerFixture;
  /** Descriptive only: no policy flag grants authorization. */
  readonly uiAccessPolicyEnabled: boolean;
  readonly remoteAssistanceAuthorized: boolean;
  readonly expectedObservation: 'pending' | 'clear' | 'unknown';
  readonly expectedAction:
    | 'use_preapproved_installer_broker'
    | 'local_user_consent_required'
    | 'investigate_process_visibility'
    | 'no_uac_prompt_detected';
}

export const UAC_REMOTE_APPROVAL_MATRIX: readonly UacApprovalFixture[] = [
  {
    id: 'local-visible-consent-unanswered',
    session: 'local-console', consent: 1, accessMode: 'full', broker: 'none',
    uiAccessPolicyEnabled: false, remoteAssistanceAuthorized: false,
    expectedObservation: 'pending', expectedAction: 'local_user_consent_required',
  },
  {
    id: 'local-visible-consent-and-reported-broker-not-approval',
    session: 'local-console', consent: 1, accessMode: 'full', broker: 'reported-elevated',
    uiAccessPolicyEnabled: false, remoteAssistanceAuthorized: false,
    expectedObservation: 'pending', expectedAction: 'use_preapproved_installer_broker',
  },
  {
    id: 'ordinary-remote-desktop-cannot-prove-consent',
    session: 'remote-desktop', consent: 1, accessMode: 'full', broker: 'none',
    uiAccessPolicyEnabled: false, remoteAssistanceAuthorized: false,
    expectedObservation: 'pending', expectedAction: 'local_user_consent_required',
  },
  {
    id: 'remote-assistance-policy-disabled',
    session: 'remote-assistance', consent: 1, accessMode: 'full', broker: 'none',
    uiAccessPolicyEnabled: false, remoteAssistanceAuthorized: true,
    expectedObservation: 'pending', expectedAction: 'local_user_consent_required',
  },
  {
    id: 'remote-assistance-policy-enabled-is-not-broker-authorization',
    session: 'remote-assistance', consent: 1, accessMode: 'full', broker: 'reported-elevated',
    uiAccessPolicyEnabled: true, remoteAssistanceAuthorized: true,
    expectedObservation: 'pending', expectedAction: 'use_preapproved_installer_broker',
  },
  {
    id: 'uiaccess-installed-is-not-elevation',
    session: 'uiaccess-app', consent: 0, accessMode: 'full', broker: 'not-elevated',
    uiAccessPolicyEnabled: true, remoteAssistanceAuthorized: false,
    expectedObservation: 'clear', expectedAction: 'no_uac_prompt_detected',
  },
  {
    id: 'headless-secure-desktop-unobservable',
    session: 'headless', consent: 'enumeration-error', accessMode: 'full', broker: 'none',
    uiAccessPolicyEnabled: false, remoteAssistanceAuthorized: false,
    expectedObservation: 'unknown', expectedAction: 'investigate_process_visibility',
  },
  {
    id: 'no-consent-process-is-only-a-snapshot',
    session: 'remote-desktop', consent: 0, accessMode: 'safe', broker: 'none',
    uiAccessPolicyEnabled: false, remoteAssistanceAuthorized: false,
    expectedObservation: 'clear', expectedAction: 'no_uac_prompt_detected',
  },
  {
    id: 'broker-health-unavailable',
    session: 'local-console', consent: 1, accessMode: 'full', broker: 'probe-error',
    uiAccessPolicyEnabled: false, remoteAssistanceAuthorized: false,
    expectedObservation: 'pending', expectedAction: 'local_user_consent_required',
  },
  {
    id: 'negative-enumeration-result-fails-closed',
    session: 'local-console', consent: -1, accessMode: 'full', broker: 'reported-elevated',
    uiAccessPolicyEnabled: false, remoteAssistanceAuthorized: false,
    expectedObservation: 'unknown', expectedAction: 'investigate_process_visibility',
  },
  {
    id: 'nonfinite-enumeration-result-fails-closed',
    session: 'local-console', consent: Number.NaN, accessMode: 'full', broker: 'reported-elevated',
    uiAccessPolicyEnabled: false, remoteAssistanceAuthorized: false,
    expectedObservation: 'unknown', expectedAction: 'investigate_process_visibility',
  },
  {
    id: 'safe-mode-does-not-use-broker',
    session: 'remote-assistance', consent: 1, accessMode: 'safe', broker: 'reported-elevated',
    uiAccessPolicyEnabled: true, remoteAssistanceAuthorized: true,
    expectedObservation: 'pending', expectedAction: 'local_user_consent_required',
  },
];
