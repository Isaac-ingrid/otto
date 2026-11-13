// Parse before resolving profiles or credentials. An explicit option must never fall back
// to a default just because its value was omitted or another flag followed it.
const valued = new Set(['config', 'endpoint', 'model', 'out', 'limit', 'only', 'concurrency']);
export function parseEvalArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (typeof option !== 'string' || !option.startsWith('--')) throw new Error('Expected an eval option');
    const name = option.slice(2);
    if (name !== 'selftest' && !valued.has(name)) throw new Error('Unknown eval option');
    if (Object.hasOwn(result, name)) throw new Error(`Duplicate --${name}`);
    if (name === 'selftest') { result[name] = true; continue; }
    const value = argv[++i];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    result[name] = value;
  }
  return result;
}
