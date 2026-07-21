import { readFile } from 'node:fs/promises';

const schema = JSON.parse(await readFile(new URL('./capability-attempt-observation.v1.schema.json', import.meta.url)));

function typeMatches(value, type) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function validate(value, contract, path = '$') {
  if (contract.const !== undefined && value !== contract.const) throw new Error(`${path}: const mismatch`);
  if (contract.enum && !contract.enum.includes(value)) throw new Error(`${path}: enum mismatch`);
  if (contract.type && !typeMatches(value, contract.type)) throw new Error(`${path}: expected ${contract.type}`);
  if (contract.type === 'object') {
    for (const key of contract.required ?? []) if (!(key in value)) throw new Error(`${path}.${key}: required`);
    if (contract.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (contract.properties ?? {}))) throw new Error(`${path}.${key}: unknown`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childContract = contract.properties?.[key] ?? contract.additionalProperties;
      if (childContract && typeof childContract === 'object') validate(child, childContract, `${path}.${key}`);
    }
  }
  if (contract.type === 'array') {
    if (contract.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) throw new Error(`${path}: duplicate item`);
    if (contract.items) value.forEach((item, index) => validate(item, contract.items, `${path}[${index}]`));
  }
}

export function validateCapabilityObservation(observation) {
  validate(observation, schema);
  return observation;
}
