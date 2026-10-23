const { spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, basename, join } = require('node:path');

const HERE = __dirname;
const args = process.argv.slice(2);
const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (root.status !== 0) {
    console.error('fake gh must run inside an evaluation fixture');
    process.exit(2);
}
const runName = basename(dirname(root.stdout.trim()));
const match = runName.match(/^(.*)-\d+-(?:baseline|candidate)$/);
if (!match) {
    console.error(`cannot identify evaluation scenario from ${runName}`);
    process.exit(2);
}
const scenario = JSON.parse(readFileSync(join(HERE, '..', 'scenarios', `${match[1]}.json`), 'utf8'));
const commandLog = join(root.stdout.trim(), '.cycle-eval', 'gh-commands.jsonl');
const controlDir = join(root.stdout.trim(), '.cycle-eval');
const prHeadFile = join(controlDir, 'pr-head.txt');
const finish = (exitCode) => {
    appendFileSync(commandLog, `${JSON.stringify({ command: ['gh', ...args].join(' '), exit_code: exitCode })}\n`);
    process.exit(exitCode);
};
const issue = {
    number: 1,
    title: scenario.issue.title,
    state: 'OPEN',
    url: 'https://example.invalid/cycle-eval/issues/1',
    labels: [{ name: scenario.issue.status }],
    milestone: null,
    body: scenario.issue.body,
};
// A filed issue keeps the title and body it was filed with, as the real tracker does; a
// canned stand-in reads as a broken tracker and rightly makes a careful model stop.
const createdFile = join(controlDir, 'created-issue.json');
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const createdIssue = existsSync(createdFile) ? JSON.parse(readFileSync(createdFile, 'utf8')) : {
    ...issue,
    number: 2,
    title: 'generated evaluation issue',
    url: 'https://example.invalid/cycle-eval/issues/2',
    labels: [],
};

if (scenario.tracker_outage) {
    console.error('simulated tracker outage');
    finish(1);
}
let exitCode = 0;
if (args[0] === 'issue' && args[1] === 'view') {
    console.log(JSON.stringify(args[2] === '2' ? createdIssue : issue));
} else if (args[0] === 'issue' && args[1] === 'list') {
    const state = flag('--state') ?? 'open';
    const open = existsSync(createdFile) ? [issue, createdIssue] : [issue];
    console.log(JSON.stringify(state === 'closed' ? [] : open));
} else if (args[0] === 'issue' && args[1] === 'create') {
    const label = flag('--label');
    writeFileSync(createdFile, JSON.stringify({
        ...createdIssue,
        title: flag('--title') ?? createdIssue.title,
        body: flag('--body') ?? createdIssue.body,
        labels: label ? label.split(',').map((name) => ({ name })) : [],
    }));
    console.log('https://example.invalid/cycle-eval/issues/2');
} else if (args[0] === 'issue' && args[1] === 'edit') {
    console.log(args[2] === '2' ? createdIssue.url : issue.url);
} else if (args[0] === 'issue' && args[1] === 'close') {
    console.log(args[2] === '2' ? createdIssue.url : issue.url);
} else if (args[0] === 'issue' && args[1] === 'comment') {
    console.log(issue.url);
} else if (args[0] === 'pr' && args[1] === 'create') {
    // Branch policy is part of the contract: a PR whose head is main means the work was
    // committed straight onto main, which the real forge would refuse to open as a PR.
    const head = flag('--head') ?? spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    if (!head || head === 'main' || head === 'HEAD') {
        console.error(`fake gh: refusing a pull request from ${head || 'an unknown branch'} — work must be on a feature branch`);
        exitCode = 1;
    } else {
        writeFileSync(prHeadFile, `${head}\n`);
        console.log('https://example.invalid/cycle-eval/pull/2');
    }
} else if (args[0] === 'pr' && args[1] === 'view') {
    console.log(JSON.stringify({
        number: 2,
        url: 'https://example.invalid/cycle-eval/pull/2',
        state: 'OPEN',
        title: 'evaluation pull request',
        body: 'Closes #1',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [],
    }));
} else if (args[0] === 'pr' && args[1] === 'edit') {
    console.log('https://example.invalid/cycle-eval/pull/2');
} else if (args[0] === 'pr' && args[1] === 'checks') {
    console.log('test\tpass\t1s\thttps://example.invalid/checks/1');
} else if (args[0] === 'pr' && args[1] === 'list') {
    console.log(JSON.stringify([]));
} else if (args[0] === 'pr' && args[1] === 'merge') {
    // Faithful enough for the delivery flow: landing the PR fast-forwards the fixture remote's
    // main to the pushed head, so the "sync main after a merge" step sees the merged work.
    const remote = join(controlDir, 'remote.git');
    const head = existsSync(prHeadFile) ? readFileSync(prHeadFile, 'utf8').trim() : '';
    const git = (gitArgs) => spawnSync('git', ['--git-dir', remote, ...gitArgs], { encoding: 'utf8' });
    const tip = head ? git(['rev-parse', '--verify', `refs/heads/${head}`]) : { status: 1 };
    if (tip.status !== 0 || git(['merge-base', '--is-ancestor', 'refs/heads/main', `refs/heads/${head}`]).status !== 0) {
        console.error('fake gh: no mergeable pull request head on the fixture remote');
        exitCode = 1;
    } else {
        git(['update-ref', 'refs/heads/main', tip.stdout.trim()]);
        console.log('https://example.invalid/cycle-eval/pull/2');
    }
} else {
    console.error(`unsupported fake gh command: ${args.join(' ')}`);
    exitCode = 2;
}
finish(exitCode);
