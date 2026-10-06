// Pure helpers for flux-update-pr: no GitHub API, git or filesystem access, so they can be unit tested.

const BEGIN = '<!-- flux-update-pr:begin -->';
const END = '<!-- flux-update-pr:end -->';

// Release-note sections an operator must read before merging, lifted to the top of the PR.
const DEFAULT_DEPLOY_SECTIONS =
  '^(deploy(ment)?|upgrad(e|ing)|breaking|behaviou?r change|migration|action required|config(uration)? change|operator)';
const DEFAULT_BREAKING = 'breaking change|\\bBREAKING\\b|backwards?[- ]incompatible';

// The tag part of a setter value. Setters ending in :tag hold the bare tag; others hold a full image ref.
function tagOf(value, field) {
  value = value.replace(/@sha256:[a-f0-9]+$/, '');
  if (field === 'tag') return value;
  const colon = value.lastIndexOf(':');
  return colon > value.lastIndexOf('/') ? value.slice(colon + 1) : value;
}

// A YAML line carrying a Flux setter, e.g. `newTag: v1.2.3 # {"$imagepolicy": "ns:name:tag"}`.
function parseMarkerLine(line) {
  const hash = line.search(/#\s*\{.*"\$imagepolicy"/);
  if (hash < 0) return null;
  let marker;
  try {
    marker = JSON.parse(line.slice(line.indexOf('{', hash)));
  } catch {
    return null;
  }
  const [ns, name, field] = marker.$imagepolicy.split(':');
  const m = line.slice(0, hash).match(/^\s*(?:-\s*)?[^:\s]+\s*:\s*(.*?)\s*$/);
  if (!m) return null;
  const value = m[1].replace(/^["']|["']$/g, '');
  return { policy: `${ns}/${name}`, name, tag: tagOf(value, field) };
}

// Changes from a `git diff --unified=0`: removed and added setter lines are paired per file and policy.
// Returns [{ policy, name, from, to, files }], one per distinct policy/from/to.
function parseDiff(diff) {
  const removed = new Map();
  const added = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (line.startsWith('--- ') || !/^[+-]/.test(line)) continue;
    const parsed = parseMarkerLine(line.slice(1));
    if (!parsed) continue;
    const key = `${file}\0${parsed.policy}`;
    const into = line[0] === '-' ? removed : added;
    if (!into.has(key)) into.set(key, []);
    into.get(key).push(parsed);
  }

  const changes = new Map();
  for (const [key, adds] of added) {
    const dels = removed.get(key) || [];
    const [path] = key.split('\0');
    adds.forEach((a, i) => {
      const from = dels[i]?.tag;
      if (from === a.tag) return;
      const id = `${a.policy}|${from}|${a.tag}`;
      if (!changes.has(id)) changes.set(id, { policy: a.policy, name: a.name, from, to: a.tag, files: [] });
      changes.get(id).files.push(path);
    });
  }
  return [...changes.values()];
}

// The configured component a change belongs to, merged over the defaults.
function componentFor(change, cfg) {
  const defaults = cfg.defaults || {};
  for (const [id, c] of Object.entries(cfg.components || {})) {
    const policies = c.policies || [id];
    if (policies.some((p) => p === change.name || p.replace(':', '/') === change.policy)) {
      return { id, ...defaults, ...c };
    }
  }
  return { id: change.name, ...defaults };
}

function semver(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(s || '');
  return m && { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

function compareSemver(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true });
}

// Releases in (from, to], newest first. Drafts are skipped; prereleases only when asked for or when
// the target itself is one.
function selectReleases(releases, from, to, { prefix = '', includePrereleases = false } = {}) {
  const lo = semver(from);
  const hi = semver(to);
  if (!hi) return [];
  const wantPre = includePrereleases || Boolean(hi.pre);
  return releases
    .filter((r) => !r.draft && (wantPre || !r.prerelease) && r.tag_name.startsWith(prefix))
    .map((r) => ({ ...r, v: semver(r.tag_name.slice(prefix.length)) }))
    .filter((r) => r.v && compareSemver(r.v, hi) <= 0 && (!lo || compareSemver(r.v, lo) > 0))
    .sort((a, b) => compareSemver(b.v, a.v));
}

// Sections of a markdown body whose heading matches re, each running until the next heading of the
// same or a higher level.
function sectionsOf(body, re) {
  const out = [];
  let cur = null;
  for (const line of (body || '').split(/\r?\n/)) {
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h && cur && h[1].length <= cur.level) cur = null;
    if (h && !cur && re.test(h[2])) {
      cur = { level: h[1].length, heading: h[2], text: [] };
      out.push(cur);
      continue;
    }
    if (cur) cur.text.push(line);
  }
  return out.map((c) => ({ heading: c.heading, text: c.text.join('\n').trim() })).filter((c) => c.text);
}

// Short commit SHA of a `<sha>` or `<sha>-<timestamp>` tag.
function shaOf(tag) {
  return /^([a-f0-9]{7,40})(?:-\d+)?$/.exec(tag || '')?.[1];
}

// The managed part of the PR body. entries: [{ change, comp, fromVersion, toVersion, releases, deploy, breaking, notes }]
function renderBody(entries, { head, bodyLimit = 60000 }) {
  const code = (s) => (s ? `\`${s}\`` : '_new_');
  const ver = (tag, v) => (v && v !== tag ? `${code(tag)} (app ${code(v)})` : code(tag));
  const lines = [BEGIN, '## Updates', '', '| Component | From | To | Release notes | Files |', '|---|---|---|---|---|'];
  for (const e of entries) {
    const flags = [
      e.breaking.length && `:warning: breaking (${e.breaking.join(', ')})`,
      e.deploy.length && 'deploy notes',
    ].filter(Boolean);
    const notes = [`${e.releases.length}`, ...flags].join(', ');
    lines.push(`| ${e.comp.id} | ${ver(e.change.from, e.fromVersion)} | ${ver(e.change.to, e.toVersion)} | ${notes} | ${e.change.files.map(code).join('<br>')} |`);
  }
  if (entries.some((e) => e.breaking.length)) {
    lines.push('', '> [!WARNING]', '> Release notes in this update announce a breaking change. Read them before merging.');
  }
  if (entries.some((e) => e.deploy.length)) {
    lines.push('', '## Before merging', '');
    for (const e of entries) {
      for (const d of e.deploy) {
        lines.push(`#### ${e.comp.id} [${d.release.tag_name}](${d.release.html_url}): ${d.heading}`, '', d.text, '');
      }
    }
  }
  let truncated = false;
  for (const e of entries) {
    lines.push('', `## ${e.comp.id} ${e.change.from ? `${e.change.from} → ` : ''}${e.change.to}`, '');
    for (const r of e.releases) {
      const date = (r.published_at || r.created_at || '').slice(0, 10);
      const block = [
        `<details open><summary><b>${r.tag_name}</b> (${date}) <a href="${r.html_url}">release</a></summary>`,
        '',
        (r.body || '_No description._').trim(),
        '',
        '</details>',
        '',
      ];
      if (lines.join('\n').length + block.join('\n').length > bodyLimit) {
        truncated = true;
        lines.push(`- [${r.tag_name}](${r.html_url}) (${date})`);
      } else {
        lines.push(...block);
      }
    }
    lines.push(...e.notes);
  }
  if (truncated) lines.push('', '_Some release notes were too long for the PR body; follow the links above._');
  lines.push(
    '',
    `<sub>Generated by [flux-update-pr](https://github.com/pinax-network/.github/tree/main/actions/flux-update-pr) from \`${head}\`.</sub>`,
    END,
  );
  return lines.join('\n');
}

// Replace the managed part of an existing body, keeping what people wrote around it.
function mergeBody(old, managed) {
  old = old || '';
  const b = old.indexOf(BEGIN);
  const e = old.indexOf(END);
  if (b >= 0 && e > b) return old.slice(0, b) + managed + old.slice(e + END.length);
  return `${managed}\n\n${old}`.trim();
}

// `prod/pinax-account-api-updates` -> `prod`; `base-fluxcd-image-updates` -> `base`.
function titleFor(head, entries) {
  const scope = head.includes('/') ? head.split('/')[0] : head.replace(/-fluxcd-image-updates$/, '');
  const title = `${scope}: bump ${entries.map((e) => `${e.comp.id} to ${e.change.to}`).join(', ')}`;
  return title.length > 120 ? `${scope}: bump ${entries.length} components` : title;
}

module.exports = {
  BEGIN,
  END,
  DEFAULT_DEPLOY_SECTIONS,
  DEFAULT_BREAKING,
  tagOf,
  parseMarkerLine,
  parseDiff,
  componentFor,
  semver,
  compareSemver,
  selectReleases,
  sectionsOf,
  shaOf,
  renderBody,
  mergeBody,
  titleFor,
};
