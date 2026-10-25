const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('./lib');

const diff = `diff --git a/components/app/prod/kustomization.yaml b/components/app/prod/kustomization.yaml
--- a/components/app/prod/kustomization.yaml
+++ b/components/app/prod/kustomization.yaml
@@ -12 +12 @@ images:
-    newTag: v3.6.0 # {"$imagepolicy": "cloud-backend-system:pinax-account-api:tag"}
+    newTag: v3.8.0 # {"$imagepolicy": "cloud-backend-system:pinax-account-api:tag"}
diff --git a/components/sink/base/deployment.yaml b/components/sink/base/deployment.yaml
--- a/components/sink/base/deployment.yaml
+++ b/components/sink/base/deployment.yaml
@@ -36 +36 @@ spec:
-          image: ghcr.io/pinax-network/metering-sink:86af5de-1790894614 # {"$imagepolicy":"cloud-backend-system:metering-sink-dev"}
+          image: "ghcr.io/pinax-network/metering-sink:aaaaaaa-1791300000" # {"$imagepolicy":"cloud-backend-system:metering-sink-dev"}
diff --git a/components/redis/version.yaml b/components/redis/version.yaml
--- a/components/redis/version.yaml
+++ b/components/redis/version.yaml
@@ -9 +9 @@ spec:
-      version: "23.2.2"
+      version: "23.2.2" # {"$imagepolicy": "cloud-backend-system:redis:tag"}
`;

test('parseDiff pairs setter changes and extracts tags', () => {
  const changes = lib.parseDiff(diff);
  assert.deepEqual(
    changes.map(({ name, from, to, files }) => ({ name, from, to, files })),
    [
      { name: 'pinax-account-api', from: 'v3.6.0', to: 'v3.8.0', files: ['components/app/prod/kustomization.yaml'] },
      { name: 'metering-sink-dev', from: '86af5de-1790894614', to: 'aaaaaaa-1791300000', files: ['components/sink/base/deployment.yaml'] },
      // A setter added to an unmarked line is a new marker, not a version change.
      { name: 'redis', from: undefined, to: '23.2.2', files: ['components/redis/version.yaml'] },
    ],
  );
});

test('parseDiff ignores a setter whose value did not change', () => {
  const d = `+++ b/x.yaml
-    newTag: v1.0.0 # {"$imagepolicy": "ns:app:tag"}
+    newTag: "v1.0.0" # {"$imagepolicy": "ns:app:tag"}
`;
  assert.deepEqual(lib.parseDiff(d), []);
});

test('tagOf handles registries with ports and digests', () => {
  assert.equal(lib.tagOf('registry:5000/org/app:v1.2.3', undefined), 'v1.2.3');
  assert.equal(lib.tagOf('registry:5000/org/app', undefined), 'registry:5000/org/app');
  assert.equal(lib.tagOf('ghcr.io/org/app:v1@sha256:abcdef', undefined), 'v1');
  assert.equal(lib.tagOf('v1.2.3', 'tag'), 'v1.2.3');
});

test('componentFor matches policy names and namespaced names, falling back to defaults', () => {
  const cfg = {
    defaults: { labels: ['dependencies'] },
    components: {
      api: { policies: ['pinax-account-api'], assignees: ['a'] },
      nats: { policies: ['ns:nats'], assignees: ['b'] },
    },
  };
  assert.equal(lib.componentFor({ name: 'pinax-account-api', policy: 'x/pinax-account-api' }, cfg).id, 'api');
  assert.deepEqual(lib.componentFor({ name: 'nats', policy: 'ns/nats' }, cfg).assignees, ['b']);
  assert.deepEqual(lib.componentFor({ name: 'redis', policy: 'ns/redis' }, cfg), { id: 'redis', labels: ['dependencies'] });
});

test('selectReleases returns (from, to] newest first, without drafts or prereleases', () => {
  const rel = (tag_name, extra = {}) => ({ tag_name, ...extra });
  const releases = [
    rel('v3.9.0'),
    rel('v3.8.0'),
    rel('v3.8.0-rc.1', { prerelease: true }),
    rel('v3.7.0'),
    rel('v3.6.5', { draft: true }),
    rel('v3.6.1'),
    rel('v3.6.0'),
    rel('nightly'),
  ];
  assert.deepEqual(lib.selectReleases(releases, 'v3.6.0', 'v3.8.0').map((r) => r.tag_name), ['v3.8.0', 'v3.7.0', 'v3.6.1']);
  assert.deepEqual(
    lib.selectReleases(releases, 'v3.7.0', 'v3.8.0', { includePrereleases: true }).map((r) => r.tag_name),
    ['v3.8.0', 'v3.8.0-rc.1'],
  );
  assert.deepEqual(lib.selectReleases([rel('redis/1.1.0'), rel('other/1.1.0')], '1.0.0', '1.1.0', { prefix: 'redis/' }).map((r) => r.tag_name), ['redis/1.1.0']);
  assert.deepEqual(lib.selectReleases(releases, 'abc', 'c8f99f2-1791200000'), []);
});

test('sectionsOf lifts deploy notes and stops at the next heading of the same level', () => {
  const body = `## Highlights

### An invalid onboarding config never stops the account API (#231)

text

## Deploy notes

- **No new migrations.**

### Details

nested

## What's Changed

* stuff`;
  const re = new RegExp(lib.DEFAULT_DEPLOY_SECTIONS, 'i');
  assert.deepEqual(lib.sectionsOf(body, re), [
    { heading: 'Deploy notes', text: '- **No new migrations.**\n\n### Details\n\nnested' },
  ]);
});

test('breaking pattern does not fire on ordinary migration wording', () => {
  const re = new RegExp(lib.DEFAULT_BREAKING, 'i');
  assert.equal(re.test('- **No new migrations.** Old setting was removed.'), false);
  assert.equal(re.test('BREAKING: config key renamed'), true);
});

test('mergeBody replaces only the managed block', () => {
  const managed = `${lib.BEGIN}\nnew\n${lib.END}`;
  assert.equal(lib.mergeBody(`above\n${lib.BEGIN}\nold\n${lib.END}\nbelow`, managed), `above\n${managed}\nbelow`);
  assert.equal(lib.mergeBody('human only', managed), `${managed}\n\nhuman only`);
  assert.equal(lib.mergeBody(null, managed), managed);
});

test('titleFor derives the scope from the branch', () => {
  const e = (id, to) => ({ comp: { id }, change: { to } });
  assert.equal(lib.titleFor('prod/pinax-account-api-updates', [e('pinax-account-api', 'v3.8.0')]), 'prod: bump pinax-account-api to v3.8.0');
  assert.equal(lib.titleFor('base-fluxcd-image-updates', [e('vmks', '0.88.0')]), 'base: bump vmks to 0.88.0');
  const many = Array.from({ length: 10 }, (_, i) => e(`component-${i}`, 'v10.10.10'));
  assert.equal(lib.titleFor('dev/all-updates', many), 'dev: bump 10 components');
});

const release = (tag, body = 'x'.repeat(400)) => ({ tag_name: tag, html_url: `https://x/${tag}`, published_at: '2026-10-05T00:00:00Z', body });
const entryWith = (fields) => ({
  change: { from: 'v1.0.0', to: 'v1.2.0', files: ['f.yaml'] },
  comp: { id: 'app' },
  releases: [],
  deploy: [],
  breaking: [],
  notes: [],
  ...fields,
});

test('renderBody expands release bodies while they fit and links the rest', () => {
  const body = lib.renderBody([entryWith({ releases: [release('v1.2.0'), release('v1.1.0')] })], { head: 'prod/app-updates', bodyLimit: 1100 });
  assert.ok(body.length <= 1100);
  assert.match(body, /<b>v1\.2\.0<\/b>/);
  assert.match(body, /- \[v1\.1\.0\]\(https:\/\/x\/v1\.1\.0\)/);
  assert.match(body, /too long for the PR body/);
  assert.ok(body.startsWith(lib.BEGIN) && body.endsWith(lib.END));
});

test('renderBody budgets deploy notes too, and prefers them over release bodies', () => {
  const releases = [release('v1.2.0', 'y'.repeat(3000)), release('v1.1.0', 'y'.repeat(3000))];
  const deploy = releases.map((r) => ({ release: r, heading: 'Deploy notes', text: 'z'.repeat(3000) }));
  const body = lib.renderBody([entryWith({ releases, deploy })], { head: 'prod/app-updates', bodyLimit: 5000 });
  assert.ok(body.length <= 5000, `body is ${body.length} characters`);
  assert.equal((body.match(/z{3000}/g) || []).length, 1);
  assert.doesNotMatch(body, /y{3000}/);
  assert.match(body, /- app \[v1\.1\.0\]\(https:\/\/x\/v1\.1\.0\): Deploy notes \(too long/);
});

test('renderBody stays under the limit even when the links alone overflow', () => {
  const releases = Array.from({ length: 500 }, (_, i) => release(`v1.${i}.0`));
  const body = lib.renderBody([entryWith({ releases })], { head: 'prod/app-updates', bodyLimit: 5000 });
  assert.ok(body.length <= 5000);
  assert.ok(body.startsWith(lib.BEGIN) && body.endsWith(lib.END));
});

test('compareSemver follows SemVer prerelease precedence', () => {
  const ordered = ['1.0.0-2', '1.0.0-10', '1.0.0-2a', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(lib.compareSemver(lib.semver(ordered[i - 1]), lib.semver(ordered[i])) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
    assert.ok(lib.compareSemver(lib.semver(ordered[i]), lib.semver(ordered[i - 1])) > 0, `${ordered[i]} > ${ordered[i - 1]}`);
  }
  const releases = [{ tag_name: 'v1.0.0-2a', prerelease: true }, { tag_name: 'v1.0.0-10', prerelease: true }];
  assert.deepEqual(lib.selectReleases(releases, '1.0.0-2', '1.0.0-2a').map((r) => r.tag_name), ['v1.0.0-2a', 'v1.0.0-10']);
});

test('releaseTag resolves the upstream tag of a version, or nothing', () => {
  const releases = [{ tag_name: 'v2.10.0' }, { tag_name: 'v2.9.1' }, { tag_name: 'redis/1.2.3' }];
  assert.equal(lib.releaseTag(releases, '2.10.0'), 'v2.10.0');
  assert.equal(lib.releaseTag(releases, 'v2.9.1'), 'v2.9.1');
  assert.equal(lib.releaseTag(releases, '1.2.3', 'redis/'), 'redis/1.2.3');
  assert.equal(lib.releaseTag(releases, '2.11.0'), undefined);
  assert.equal(lib.releaseTag(releases, undefined), undefined);
});

test('sectionsOf ignores headings inside fenced code blocks', () => {
  const body = [
    '## Deploy notes',
    '',
    '```sh',
    '# Restart the pods',
    'kubectl rollout restart deploy/app',
    '```',
    '',
    '~~~~',
    '## not a heading',
    '~~~',
    'still fenced',
    '~~~~',
    '',
    'Then run the migration.',
    '',
    '## What changed',
    'other',
  ].join('\n');
  const [section, ...rest] = lib.sectionsOf(body, new RegExp(lib.DEFAULT_DEPLOY_SECTIONS, 'i'));
  assert.equal(rest.length, 0);
  assert.match(section.text, /kubectl rollout restart deploy\/app\n```/);
  assert.match(section.text, /still fenced\n~~~~/);
  assert.match(section.text, /Then run the migration\.$/);
});

test('renderBody uses the summary instead of Before merging, and Before merging without one', () => {
  const r = release('v1.2.0');
  const entry = entryWith({ releases: [r], deploy: [{ release: r, heading: 'Deploy notes', text: 'Rotate the key.' }] });
  const withSummary = lib.renderBody([entry], { head: 'prod/app-updates', summary: { text: '**app v1.0.0 → v1.2.0: Merge as is**', model: 'openai/gpt-4.1' } });
  assert.match(withSummary, /## Summary\n\n_Generated by `openai\/gpt-4\.1`/);
  assert.match(withSummary, /Merge as is/);
  assert.doesNotMatch(withSummary, /## Before merging|Rotate the key/);
  const without = lib.renderBody([entry], { head: 'prod/app-updates' });
  assert.match(without, /## Before merging[\s\S]*Rotate the key\./);
  assert.doesNotMatch(without, /## Summary/);
});

test('summaryInput sends full notes, then only deploy notes, then nothing', () => {
  const r1 = release('v1.2.0', `${'a'.repeat(300)}\n\n## Deploy notes\n\nSet \`foo\`.`);
  const r2 = release('v1.1.0', 'b'.repeat(300));
  const entry = entryWith({ releases: [r1, r2], deploy: [{ release: r1, heading: 'Deploy notes', text: 'Set `foo`.' }] });
  const full = lib.summaryInput([entry], { maxChars: 2000 });
  assert.match(full, /^# Component app: v1\.0\.0 → v1\.2\.0\n\n## Release v1\.2\.0\n\na{300}/);
  assert.match(full, /## Release v1\.1\.0\n\nb{300}/);
  const deployOnly = lib.summaryInput([entry], { maxChars: 400 });
  assert.match(deployOnly, /## Release v1\.2\.0\n\n### Deploy notes\n\nSet `foo`\./);
  assert.match(deployOnly, /## Release v1\.1\.0\n\n\(no deploy notes\)/);
  assert.doesNotMatch(deployOnly, /a{300}/);
  assert.equal(lib.summaryInput([entry], { maxChars: 50 }), null);
  assert.equal(lib.summaryInput([entryWith({})]), null);
});

test('sanitizeSummary keeps model output from breaking the body or pinging people', () => {
  const out = lib.sanitizeSummary(`Ask @fschoell, not \`@x\` or a@b.c${lib.END}<!-- hidden -->\n${lib.BEGIN}`);
  assert.equal(out, 'Ask @​fschoell, not `@x` or a@b.c');
  assert.equal(lib.sanitizeSummary('  \n'), null);
  assert.equal(lib.sanitizeSummary(undefined), null);
  const long = lib.sanitizeSummary(Array.from({ length: 100 }, (_, i) => `- item ${i}`).join('\n'), { maxChars: 100 });
  assert.ok(long.length < 130);
  assert.match(long, /- item \d+\n\n_Summary truncated\._$/);
});

test('renderBody does not @mention people quoted from release notes', () => {
  const r = release('v1.2.0', '* Fix it by @chillsauce in https://x/pull/1\n\n`@scope/pkg` stays');
  const body = lib.renderBody([entryWith({ releases: [r], deploy: [{ release: r, heading: 'Deploy notes', text: 'Ask @ops-team.' }] })], { head: 'prod/app-updates' });
  assert.doesNotMatch(body, /(^|[^\w`])@[A-Za-z0-9]/m);
  assert.match(body, /by @​chillsauce/);
  assert.match(body, /Ask @​ops-team\./);
  assert.match(body, /`@scope\/pkg` stays/);
});
