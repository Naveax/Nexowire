import {
  isReadOnlyCapability,
} from '../../../src/protocol/capabilities.js';
import type { SkillManifest } from '../../../src/skills/manifest.js';

export interface CapabilityPromiseReview {
  skill: string;
  field: 'requires' | 'requiresAny' | 'prefers';
  capability: string;
  group?: number;
}

/**
 * Metadata consistency review only. A non-read-only capability in a skill
 * labelled read-only is a reason for owner review, not proof of a mutation.
 */
export function reviewReadOnlyPromise(skill: SkillManifest): CapabilityPromiseReview[] {
  if (skill.mutation !== 'read-only') return [];
  const findings: CapabilityPromiseReview[] = [];
  for (const capability of skill.requires) {
    if (!isReadOnlyCapability(capability)) {
      findings.push({ skill: skill.name, field: 'requires', capability });
    }
  }
  for (const [group, alternatives] of (skill.requiresAny ?? []).entries()) {
    for (const capability of alternatives) {
      if (!isReadOnlyCapability(capability)) {
        findings.push({ skill: skill.name, field: 'requiresAny', capability, group });
      }
    }
  }
  for (const capability of skill.prefers ?? []) {
    if (!isReadOnlyCapability(capability)) {
      findings.push({ skill: skill.name, field: 'prefers', capability });
    }
  }
  return findings;
}
