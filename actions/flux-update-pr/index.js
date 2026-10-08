// Entry point, run by actions/github-script from action.yml with its github, context and core.
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// An AI summary of the release notes by the Copilot CLI, or null when summarizing is off or fails for
// any reason; the PR then quotes the deploy notes in its Before merging section instead.
//
// The CLI runs non-interactively with no tool pre-approved, so every tool call is denied: the release
// notes are untrusted input and the summary needs nothing but the prompt. It runs in an empty
// directory without custom instructions or MCP servers, so it sees only what is passed in.
function summarize(entries, core) {
  if (process.env.SUMMARIZE !== 'true') return null;
  const input = lib.summaryInput(entries, { maxChars: Number(process.env.SUMMARY_MAX_INPUT_CHARS) || undefined });
  if (!input) {
    core.info('No release notes to summarize, or too long even as deploy notes; using Before merging.');
    return null;
  }
  const model = process.env.MODEL || '';
  const args = [
    '-p',
    `${lib.SUMMARY_SYSTEM_PROMPT}\n\n<release-notes>\n${input}\n</release-notes>`,
    '-s',
    '--no-custom-instructions',
    '--disable-builtin-mcps',
    '--no-ask-user',
    '--no-auto-update',
    ...(model ? ['--model', model] : []),
  ];
  // The CLI reads COPILOT_GITHUB_TOKEN, GH_TOKEN, then GITHUB_TOKEN; pass only the one meant for it.
  const env = { ...process.env, GITHUB_TOKEN: process.env.COPILOT_TOKEN };
  delete env.COPILOT_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.COPILOT_TOKEN;
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-update-pr-'));
    const out = execFileSync('copilot', args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
    const text = lib.sanitizeSummary(out);
    if (!text) throw new Error('empty answer');
    core.info(`AI summary by Copilot CLI${model ? ` (${model})` : ''}: ${text.length} characters`);
    return { text, model: model ? `Copilot CLI, ${model}` : 'Copilot CLI' };
  } catch (err) {
    const detail = (err.stderr || err.stdout || '').toString().trim().split('\n').slice(0, 3).join(' ');
    // err.message repeats the whole command line, prompt included; report how it ended instead.
    const reason =
      err.code === 'ENOENT' ? 'copilot CLI not installed'
      : err.signal ? `copilot CLI stopped by ${err.signal}${err.signal === 'SIGTERM' ? ' (timeout)' : ''}`
      : err.status != null ? `copilot CLI exited with ${err.status}`
      : err.message;
    core.warning(`AI summary failed, using Before merging instead: ${reason}${detail ? `: ${detail}` : ''}`);
    return null;
  }
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
    // All of them: the API lists by creation date, so a backport can sit after any number of newer releases.
    const all = await notesClient.paginate(notesClient.rest.repos.listReleases, { owner: o, repo: r, per_page: 100 });
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
      const releases = await listReleases(comp.repo);
      entry.releases = lib.selectReleases(releases, from, to, {
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
      const fromTag = lib.releaseTag(releases, from, prefix);
      const toTag = lib.releaseTag(releases, to, prefix);
      if (fromTag && toTag) {
        entry.notes.push(`[Full diff ${fromTag}...${toTag}](https://github.com/${comp.repo}/compare/${fromTag}...${toTag})`);
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

  const title = lib.titleFor(head, entries);
  const { data: open } = await github.rest.pulls.list({ owner, repo, head: `${owner}:${head}`, base, state: 'open' });
  let pr = open[0];
  // Leave room for what people wrote around the managed block, plus some slack.
  const kept = pr ? lib.mergeBody(pr.body, '').length : 0;
  const summary = summarize(entries, core);
  const managed = lib.renderBody(entries, { head, summary, bodyLimit: Math.max(5000, lib.MAX_BODY - kept - 1000) });
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
