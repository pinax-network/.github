// Entry point, run by actions/github-script from action.yml with its github, context and core.
const fs = require('fs');
const { execFileSync } = require('child_process');
const lib = require('./lib');

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });

// The version that matters to operators is often not the image/chart tag itself: a chart's
// appVersion tracks the server release that carries the changelog.
function appVersion(comp, tag) {
  if (comp.version !== 'appVersion') return tag;
  if (!comp.chart) throw new Error(`${comp.id}: version: appVersion needs a chart reference`);
  const chart = run('helm', ['show', 'chart', comp.chart, '--version', tag]);
  const m = /^appVersion:\s*["']?([^"'\s]+)/m.exec(chart);
  if (!m) throw new Error(`${comp.id}: no appVersion in ${comp.chart}@${tag}`);
  return m[1];
}

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const base = process.env.BASE;
  const head = context.ref.replace(/^refs\/heads\//, '');
  const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG_JSON, 'utf8')) || {};
  const defaults = cfg.defaults || {};
  const deploySections = new RegExp(defaults['deploy-sections'] || lib.DEFAULT_DEPLOY_SECTIONS, 'i');
  const breaking = new RegExp(defaults['breaking-pattern'] || lib.DEFAULT_BREAKING, 'i');
  // Same Octokit class (with paginate/rest plugins) as `github`, authenticated with the notes token.
  const notesClient = process.env.RELEASE_NOTES_TOKEN
    ? new github.constructor({ auth: process.env.RELEASE_NOTES_TOKEN })
    : github;

  // ---- 1. What did Flux change?

  const mergeBase = run('git', ['merge-base', `origin/${base}`, 'HEAD']).trim();
  const changes = lib.parseDiff(run('git', ['diff', '--unified=0', '--no-color', mergeBase, 'HEAD']));
  if (changes.length === 0) {
    core.notice(`No $imagepolicy changes between ${base} and ${head}; nothing to do.`);
    return;
  }

  // ---- 2. Release notes per change.

  const releasesCache = new Map();
  const listReleases = async (fullName) => {
    if (releasesCache.has(fullName)) return releasesCache.get(fullName);
    const [o, r] = fullName.split('/');
    const all = [];
    const pages = notesClient.paginate.iterator(notesClient.rest.repos.listReleases, { owner: o, repo: r, per_page: 100 });
    for await (const page of pages) {
      all.push(...page.data);
      if (all.length >= 500) break;
    }
    releasesCache.set(fullName, all);
    return all;
  };

  const entries = [];
  for (const change of changes) {
    const comp = lib.componentFor(change, cfg);
    const entry = { change, comp, releases: [], notes: [], deploy: [], breaking: [] };
    entries.push(entry);
    if (!comp.repo) {
      entry.notes.push('_No upstream repository configured for this component._');
      continue;
    }
    try {
      const from = change.from && appVersion(comp, change.from);
      const to = appVersion(comp, change.to);
      entry.fromVersion = from;
      entry.toVersion = to;
      const prefix = comp['tag-prefix'] || '';
      if (!lib.semver(to)) {
        const [a, b] = [lib.shaOf(from), lib.shaOf(to)];
        entry.notes.push(
          a && b
            ? `[Commits ${a}...${b}](https://github.com/${comp.repo}/compare/${a}...${b})`
            : `_\`${to}\` is not a semantic version; no release notes looked up._`,
        );
        continue;
      }
      entry.releases = lib.selectReleases(await listReleases(comp.repo), from, to, {
        prefix,
        includePrereleases: comp['include-prereleases'],
      });
      for (const r of entry.releases) {
        for (const sec of lib.sectionsOf(r.body, deploySections)) entry.deploy.push({ release: r, ...sec });
        if (breaking.test(r.body || '')) entry.breaking.push(r.tag_name);
      }
      if (entry.releases.length === 0) {
        entry.notes.push(`_No GitHub releases found in ${comp.repo} between \`${from ?? '?'}\` and \`${to}\`._`);
      }
      if (lib.semver(from)) {
        entry.notes.push(
          `[Full diff ${prefix}${from}...${prefix}${to}](https://github.com/${comp.repo}/compare/${prefix}${from}...${prefix}${to})`,
        );
      }
    } catch (err) {
      const status = err.status ? ` (HTTP ${err.status})` : '';
      core.warning(`${comp.id}: release notes unavailable${status}: ${err.message}`);
      entry.notes.push(
        err.status === 404
          ? `_Release notes unavailable: no read access to \`${comp.repo}\`. Pass a token that can read it as \`release-notes-token\`._`
          : `_Release notes unavailable: ${err.message}_`,
      );
    }
  }

  // ---- 3. Create or update the pull request, then assign it.

  const managed = lib.renderBody(entries, { head });
  const title = lib.titleFor(head, entries);
  const { data: open } = await github.rest.pulls.list({ owner, repo, head: `${owner}:${head}`, base, state: 'open' });
  let pr = open[0];
  if (pr) {
    ({ data: pr } = await github.rest.pulls.update({ owner, repo, pull_number: pr.number, title, body: lib.mergeBody(pr.body, managed) }));
    core.info(`Updated #${pr.number}`);
  } else {
    ({ data: pr } = await github.rest.pulls.create({ owner, repo, head, base, title, body: managed }));
    core.info(`Created #${pr.number}`);
  }

  const union = (key) => [...new Set(entries.flatMap((e) => e.comp[key] || []))];
  const assignees = union('assignees');
  const reviewers = union('reviewers').filter((r) => r !== pr.user.login);
  const labels = union('labels');
  const tryApi = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      core.warning(`Could not ${what}: ${err.message}`);
    }
  };
  if (assignees.length) {
    await tryApi(`assign ${assignees}`, () => github.rest.issues.addAssignees({ owner, repo, issue_number: pr.number, assignees }));
  }
  if (reviewers.length) {
    await tryApi(`request review from ${reviewers}`, () => github.rest.pulls.requestReviewers({ owner, repo, pull_number: pr.number, reviewers }));
  }
  if (labels.length) {
    await tryApi(`label ${labels}`, () => github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels }));
  }

  core.setOutput('pull-request-number', pr.number);
  core.setOutput('pull-request-url', pr.html_url);
  await core.summary
    .addHeading(`#${pr.number}: ${title}`, 3)
    .addLink(pr.html_url, pr.html_url)
    .addRaw(`\n\nAssignees: ${assignees.join(', ') || 'none'}; reviewers: ${reviewers.join(', ') || 'none'}`)
    .write();
};
