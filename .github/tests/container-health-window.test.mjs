import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const workflow = fs.readFileSync(new URL('../workflows/project-container-service.yml', import.meta.url), 'utf8');
const script = workflow.split("node - <<'NODE'\n")[1].split('          NODE')[0].replace(/^          /gm, '');
test('container workflow waits through bounded cold starts and rejects unbounded inputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-health-window-'));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    fs.writeFileSync('.dockerignore', '.git\n'); fs.writeFileSync('Dockerfile', 'FROM scratch\n');
    for (const [startup, replicas, expected] of [[150, 2, 114], [3600, 4, 1548], [3601, 4, null], [1, 2, null], [150, 5, null], [150.5, 2, null]]) {
      fs.writeFileSync('output', '');
      fs.writeFileSync('ntanis.project.json', JSON.stringify({schemaVersion: 3, project: {id: 'example'}, hosting: {components: [{id: 'web', deployment: 'automatic', imageRepository: 'ghcr.io/ntanis-dev/example/web', startupTimeoutSeconds: startup, maxReplicas: replicas}]}}));
      const run = () => vm.runInNewContext(script, {require: (name) => name === 'node:fs' ? fs : path, Buffer,
        process: {env: {BUILD_CONTEXT: '.', DOCKERFILE: 'Dockerfile', PROJECT: 'example', COMPONENT: 'web', GITHUB_REPOSITORY: 'ntanis-dev/example', GITHUB_OUTPUT: path.join(root,'output')}}});
      if (expected === null) assert.throws(run, /Invalid startup health budget/);
      else { run(); assert.match(fs.readFileSync('output','utf8'), new RegExp('health-poll-count=' + expected + '\\n')); }
    }
  } finally {process.chdir(cwd); fs.rmSync(root, {recursive: true, force: true});}
});
