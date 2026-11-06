const fs = require('fs');
const path = require('path');

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(obj) + '\n';
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function stableOmit(value, ignore) {
  const drop = new Set(ignore || []);
  const walk = (v) => {
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
    if (v && typeof v === 'object') {
      const keys = Object.keys(v).filter(k => !drop.has(k)).sort();
      return `{${keys.map(k => JSON.stringify(k) + ':' + walk(v[k])).join(',')}}`;
    }
    return JSON.stringify(v);
  };
  return walk(value);
}

// Skip the write when only a volatile timestamp changed, so idle runs do not dirty git.
function writeJsonIfChanged(file, obj, ignoreKeys) {
  if (fs.existsSync(file)) {
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stableOmit(prev, ignoreKeys) === stableOmit(obj, ignoreKeys)) return false;
    } catch (_) { /* rewrite unreadable files */ }
  }
  writeJson(file, obj);
  return true;
}

module.exports = { readJson, writeJson, writeJsonIfChanged, stableOmit };
