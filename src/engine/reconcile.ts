import type { Household, Observation, ObservableField, Property, SourceTag } from './types';

/**
 * A household arrives across several documents and several years, and the same fact
 * reads differently in each. This module refuses to average: when sources disagree,
 * the fact is a Conflict and the engine will not run until a human picks the source
 * they are willing to stand behind.
 */

export const AGREEMENT_TOLERANCE = 1; // dollars

export interface Conflict {
  key: string;
  propertyId: string;
  propertyName: string;
  field: ObservableField;
  label: string;
  options: Observation[];
}

export type ProvenanceStatus = 'single' | 'agreed' | 'chosen';

export interface ResolvedFact {
  key: string;
  value: number;
  source: SourceTag;
  status: ProvenanceStatus;
  alternatives: Observation[];
}

export interface Reconciliation {
  household: Household;
  conflicts: Conflict[];
  facts: Record<string, ResolvedFact>;
}

export const observationKey = (o: Pick<Observation, 'propertyId' | 'field'>) => `${o.propertyId}.${o.field}`;

export function fieldLabel(field: ObservableField, p?: Property): string {
  if (field === 'accumulatedDepreciation') return 'Accumulated depreciation';
  if (field === 'currentValue') return 'Current market value';
  if (field === 'suspendedLoss') return 'Suspended passive losses (§469)';
  const loanId = field.split(':')[1];
  const loan = p?.loans.find((l) => l.id === loanId);
  return `${loan?.label ?? loanId} balance`;
}

function applyField(p: Property, field: ObservableField, value: number, source: SourceTag) {
  if (field === 'accumulatedDepreciation') p.accumulatedDepreciation = value;
  else if (field === 'currentValue') p.currentValue = value;
  else if (field === 'suspendedLoss') p.suspendedLoss = value;
  else {
    const loan = p.loans.find((l) => l.id === field.split(':')[1]);
    if (!loan) throw new Error(`Observation references unknown loan ${field} on ${p.id}`);
    loan.balance = value;
    loan.source = source;
    return;
  }
  p.sources[field] = source;
}

/** `resolutions` maps a conflict key to the id of the observation the advisor chose. */
export function reconcile(h: Household, resolutions: Record<string, string>): Reconciliation {
  const household: Household = structuredClone(h);
  const groups = new Map<string, Observation[]>();
  for (const o of h.observations) {
    const k = observationKey(o);
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }

  const conflicts: Conflict[] = [];
  const facts: Record<string, ResolvedFact> = {};

  for (const [key, obs] of groups) {
    const p = household.properties.find((x) => x.id === obs[0].propertyId);
    if (!p) throw new Error(`Observation for unknown property ${obs[0].propertyId}`);
    const distinct = obs.filter(
      (o, i) => obs.findIndex((x) => Math.abs(x.value - o.value) <= AGREEMENT_TOLERANCE) === i,
    );

    let chosen: Observation | undefined;
    let status: ProvenanceStatus;
    if (distinct.length === 1) {
      // Prefer the most authoritative document when all agree: the latest one.
      chosen = [...obs].sort((a, b) => b.source.asOf.localeCompare(a.source.asOf))[0];
      status = obs.length === 1 ? 'single' : 'agreed';
    } else {
      chosen = obs.find((o) => o.id === resolutions[key]);
      status = 'chosen';
    }

    if (!chosen) {
      conflicts.push({
        key,
        propertyId: p.id,
        propertyName: p.name,
        field: obs[0].field,
        label: fieldLabel(obs[0].field, p),
        options: obs,
      });
      continue;
    }
    applyField(p, chosen.field, chosen.value, chosen.source);
    facts[key] = { key, value: chosen.value, source: chosen.source, status, alternatives: obs.filter((o) => o !== chosen) };
  }

  return { household, conflicts, facts };
}
