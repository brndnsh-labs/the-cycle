const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
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
const issue = {
    number: 1,
    title: scenario.issue.title,
    state: 'OPEN',
    url: 'https://example.invalid/cycle-eval/issues/1',
    labels: [{ name: scenario.issue.status }],
    milestone: null,
    body: scenario.issue.body,
};

if (scenario.tracker_outage) {
    console.error('simulated tracker outage');
    process.exit(1);
}
if (args[0] === 'issue' && args[1] === 'view') {
    console.log(JSON.stringify(issue));
} else if (args[0] === 'issue' && args[1] === 'list') {
    console.log(JSON.stringify([issue]));
} else if (args[0] === 'issue' && args[1] === 'edit') {
    console.log(issue.url);
} else {
    console.error(`unsupported fake gh command: ${args.join(' ')}`);
    process.exit(2);
}
