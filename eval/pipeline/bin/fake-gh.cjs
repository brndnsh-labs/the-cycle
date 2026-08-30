#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');

const args = process.argv.slice(2);

function fail(message) {
    console.error(message);
    process.exit(2);
}

function option(name, fallback = null) {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function labels(value) {
    return String(value ?? '').split(',').map((name) => name.trim()).filter(Boolean)
        .map((name) => ({ id: `fake-${name}`, name, description: '', color: 'ededed' }));
}

function issueBody() {
    const encoded = process.env.CYCLE_PIPELINE_ISSUE_BODY_BASE64 ?? '';
    return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
}

function issueRecord() {
    return {
        number: 1,
        title: process.env.CYCLE_PIPELINE_ISSUE_TITLE ?? 'Frozen pipeline evaluation issue',
        state: 'OPEN',
        url: 'https://example.invalid/pipeline-eval/issues/1',
        labels: labels(process.env.CYCLE_PIPELINE_ISSUE_LABEL ?? 'status:ready'),
        milestone: null,
        body: issueBody(),
    };
}

function selectedJson(record) {
    const requested = option('--json');
    if (!requested) return record;
    const fields = requested.split(',').map((field) => field.trim()).filter(Boolean);
    return Object.fromEntries(fields.map((field) => [field, record[field] ?? null]));
}

if (args[0] === '--version' || args[0] === 'version') {
    console.log('gh version 2.0.0-pipeline-double');
    process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'list') {
    console.log('[]');
    process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
    console.log(JSON.stringify(selectedJson(issueRecord())));
    process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'create') {
    const bodyFile = option('--body-file');
    let body = option('--body', '');
    if (bodyFile) {
        if (!existsSync(bodyFile)) fail(`fake gh body file does not exist: ${bodyFile}`);
        body = readFileSync(bodyFile, 'utf8');
    }
    const title = option('--title', 'Untitled evaluation issue');
    const encoded = Buffer.from(body).toString('base64');
    console.log(`CYCLE_PIPELINE_TRACKER_CREATE:${encoded}`);
    console.log(`CYCLE_PIPELINE_TRACKER_TITLE:${Buffer.from(title).toString('base64')}`);
    console.log('https://example.invalid/pipeline-eval/issues/1');
    process.exit(0);
}

if (args[0] === 'issue' && ['edit', 'comment', 'close'].includes(args[1])) {
    console.log('https://example.invalid/pipeline-eval/issues/1');
    process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'create') {
    console.log('https://example.invalid/pipeline-eval/pull/1');
    process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'list') {
    console.log('[]');
    process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'view') {
    const record = {
        number: 1,
        state: 'OPEN',
        url: 'https://example.invalid/pipeline-eval/pull/1',
        headRefName: option('--head', 'eval/fixture'),
        baseRefName: 'main',
        mergeStateStatus: 'CLEAN',
    };
    console.log(JSON.stringify(selectedJson(record)));
    process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'checks') {
    console.log('local-gates\tpass\t1s\thttps://example.invalid/checks/1');
    process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'merge') {
    const advanced = spawnSync('/usr/bin/git', ['branch', '-f', 'main', 'HEAD'], {
        cwd: process.cwd(),
        encoding: 'utf8',
    });
    if (advanced.status !== 0) fail(`fake gh could not advance local main: ${advanced.stderr}`);
    console.log('https://example.invalid/pipeline-eval/pull/1');
    process.exit(0);
}

if (args[0] === 'pr' && ['edit', 'comment'].includes(args[1])) {
    console.log('https://example.invalid/pipeline-eval/pull/1');
    process.exit(0);
}

fail(`unsupported fake gh command: ${args.join(' ')}`);
