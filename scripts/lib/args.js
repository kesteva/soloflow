'use strict';

// Lightweight argv parser.
// Supports: --flag, --key value, --key=value, positional args.
// Repeated --multi foo --multi bar => { multi: ['foo', 'bar'] } only if keys is in `repeatable`.

function parse(argv, { repeatable = new Set() } = {}) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    let key, val;
    if (eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const peek = argv[i + 1];
      if (peek === undefined || peek.startsWith('--')) {
        val = true;
      } else {
        val = peek;
        i++;
      }
    }
    if (repeatable.has(key)) {
      if (!opts[key]) opts[key] = [];
      opts[key].push(val);
    } else {
      opts[key] = val;
    }
  }
  return { opts, positional };
}

function die(prefix, msg, code = 1) {
  process.stderr.write(`${prefix}: ${msg}\n`);
  process.exit(code);
}

module.exports = { parse, die };
