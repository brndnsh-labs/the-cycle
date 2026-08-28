const { spawnSync } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
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
const createdIssue = {
    ...issue,
    number: 2,
    title: 'generated evaluation issue',
    url: 'https://example.invalid/cycle-eval/issues/2',
    labels: [{ name: 'status:ready' }],
};

if (scenario.tracker_outage) {
    console.error('simulated tracker outage');
    finish(1);
}
let exitCode = 0;
if (args[0] === 'issue' && args[1] === 'view') {
    console.log(JSON.stringify(args[2] === '2' ? createdIssue : issue));
} else if (args[0] === 'issue' && args[1] === 'list') {
    console.log(JSON.stringify([issue]));
} else if (args[0] === 'issue' && args[1] === 'create') {
    console.log('https://example.invalid/cycle-eval/issues/2');
} else if (args[0] === 'issue' && args[1] === 'edit') {
    console.log(args[2] === '2' ? createdIssue.url : issue.url);
} else if (args[0] === 'issue' && args[1] === 'comment') {
    console.log(issue.url);
} else if (args[0] === 'pr' && args[1] === 'create') {
    console.log('https://example.invalid/cycle-eval/pull/2');
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
} else if (args[0] === 'pr' && args[1] === 'merge') {
    console.log('https://example.invalid/cycle-eval/pull/2');
} else {
    console.error(`unsupported fake gh command: ${args.join(' ')}`);
    exitCode = 2;
}
finish(exitCode);
