'use strict';

// Minimal YAML subset tailored to SoloFlow config + frontmatter shapes.
// Supports: nested mappings, block lists, flow-style lists, inline scalars
// (strings, numbers, true/false, null, quoted strings), line comments (#).
// Does NOT support: anchors, aliases, tags, multi-line block scalars, flow-
// style maps, deep-nested flow sequences.
//
// If you hit a file this can't parse, simplify the file — we control every
// YAML site in the plugin. Do not reach for a npm dep.

function stripComment(line) {
  // Strip "  # comment" trailing (not inside quotes).
  let inSingle = false, inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line.replace(/\s+$/, '');
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((x) => parseScalar(x));
  }
  return s;
}

function indentOf(line) {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
}

// Parse a YAML document into a JS value. Block structure driven by indentation.
function parse(text) {
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  for (const l of rawLines) {
    const stripped = stripComment(l);
    if (stripped.trim() === '') continue;
    lines.push({ indent: indentOf(stripped), body: stripped.trimStart() });
  }

  let pos = 0;
  function parseBlock(minIndent) {
    // Peek first line; decide map vs list.
    if (pos >= lines.length) return null;
    const first = lines[pos];
    if (first.indent < minIndent) return null;

    if (first.body.startsWith('- ') || first.body === '-') {
      // List.
      const out = [];
      while (pos < lines.length) {
        const line = lines[pos];
        if (line.indent < minIndent) break;
        if (line.indent > minIndent) break; // shouldn't happen; defensive.
        if (!line.body.startsWith('-')) break;
        const afterDash = line.body === '-' ? '' : line.body.slice(2);
        pos++;
        if (afterDash === '') {
          // nested block starts on next line at deeper indent
          out.push(parseBlock(minIndent + 2));
        } else if (afterDash.includes(':') && !afterDash.startsWith('"') && !afterDash.startsWith("'")) {
          // inline map entry — treat as starting a map block at indent minIndent+2
          // rewind a synthetic line so parseBlock handles the whole inline map
          lines.splice(pos, 0, { indent: minIndent + 2, body: afterDash });
          out.push(parseBlock(minIndent + 2));
        } else {
          out.push(parseScalar(afterDash));
        }
      }
      return out;
    }

    // Map.
    const out = {};
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < minIndent) break;
      if (line.indent > minIndent) break;
      const colonIdx = findMapColon(line.body);
      if (colonIdx === -1) break;
      const key = line.body.slice(0, colonIdx).trim();
      const valuePart = line.body.slice(colonIdx + 1).trim();
      pos++;
      if (valuePart === '') {
        // nested block at deeper indent, or empty scalar if no deeper lines follow
        const next = lines[pos];
        if (next && next.indent > minIndent) {
          out[key] = parseBlock(next.indent);
        } else if (next && next.indent === minIndent && /^-(\s|$)/.test(next.body)) {
          // Compact block-sequence: `key:` followed by same-indent `- item` list.
          out[key] = parseBlock(next.indent);
        } else {
          out[key] = null;
        }
      } else {
        out[key] = parseScalar(valuePart);
      }
    }
    return out;
  }

  function findMapColon(body) {
    let inSingle = false, inDouble = false, inBracket = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === "'" && !inDouble) inSingle = !inSingle;
      else if (c === '"' && !inSingle) inDouble = !inDouble;
      else if (c === '[' && !inSingle && !inDouble) inBracket++;
      else if (c === ']' && !inSingle && !inDouble) inBracket--;
      else if (c === ':' && !inSingle && !inDouble && inBracket === 0) {
        if (i + 1 === body.length || body[i + 1] === ' ') return i;
      }
    }
    return -1;
  }

  return parseBlock(0) ?? {};
}

// Serialize a JS value as YAML (only the subset we produce).
function serialize(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return quoteIfNeeded(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '\n' + value.map((v) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const body = serializeMapInline(v, indent + 2);
        return pad + '- ' + body;
      }
      return pad + '- ' + serialize(v, indent + 2);
    }).join('\n');
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return '\n' + keys.map((k) => {
      const v = value[k];
      const rendered = serialize(v, indent + 2);
      if (rendered.startsWith('\n')) return pad + k + ':' + rendered;
      return pad + k + ': ' + rendered;
    }).join('\n');
  }
  return String(value);
}

function serializeMapInline(obj, indent) {
  // Emit first key inline after the `- `, rest indented below.
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const first = keys[0];
  const rest = keys.slice(1);
  const pad = ' '.repeat(indent);
  const firstRendered = serialize(obj[first], indent);
  const firstLine = firstRendered.startsWith('\n') ? first + ':' + firstRendered : first + ': ' + firstRendered;
  const restLines = rest.map((k) => {
    const rendered = serialize(obj[k], indent);
    if (rendered.startsWith('\n')) return pad + k + ':' + rendered;
    return pad + k + ': ' + rendered;
  });
  return [firstLine, ...restLines].join('\n');
}

function quoteIfNeeded(s) {
  if (s === '' || /^[-*?|>!%@`]/.test(s) || /^(true|false|null|~|yes|no|on|off)$/i.test(s) ||
      /^-?\d/.test(s) || /[#:\[\]{},&*!|>'"\n]/.test(s) || /^\s/.test(s) || /\s$/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }
  return s;
}

// Split a markdown document into {frontmatter: object | null, body: string}.
// Returns null frontmatter if the file has no `---\n...\n---` opener.
function splitFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { frontmatter: null, body: text };
  }
  const after = text.slice(4); // skip "---\n"
  const endMatch = after.match(/\n---\s*(\r?\n|$)/);
  if (!endMatch) return { frontmatter: null, body: text };
  const fmText = after.slice(0, endMatch.index);
  const bodyStart = endMatch.index + endMatch[0].length;
  const body = after.slice(bodyStart);
  return { frontmatter: parse(fmText), body, _rawFrontmatter: fmText };
}

function joinFrontmatter(fm, body) {
  const fmText = serialize(fm);
  // serialize() returns with leading '\n' for objects; strip it and add a clean wrapper.
  const inner = fmText.startsWith('\n') ? fmText.slice(1) : fmText;
  return '---\n' + inner + '\n---\n' + (body.startsWith('\n') ? body.slice(1) : body);
}

module.exports = { parse, serialize, splitFrontmatter, joinFrontmatter, parseScalar, stripComment };
