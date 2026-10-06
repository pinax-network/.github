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

test('renderBody truncates release bodies past the limit but keeps links', () => {
  const release = (tag) => ({ tag_name: tag, html_url: `https://x/${tag}`, published_at: '2026-10-05T00:00:00Z', body: 'x'.repeat(400) });
  const entry = {
    change: { from: 'v1.0.0', to: 'v1.2.0', files: ['f.yaml'] },
    comp: { id: 'app' },
    releases: [release('v1.2.0'), release('v1.1.0')],
    deploy: [],
    breaking: [],
    notes: [],
  };
  const body = lib.renderBody([entry], { head: 'prod/app-updates', bodyLimit: 900 });
  assert.match(body, /<b>v1\.2\.0<\/b>/);
  assert.match(body, /- \[v1\.1\.0\]\(https:\/\/x\/v1\.1\.0\)/);
  assert.match(body, /too long for the PR body/);
  assert.ok(body.startsWith(lib.BEGIN) && body.endsWith(lib.END));
});
