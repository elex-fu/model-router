"""Pure wiring and no-execution checks. Never invokes Docker/services."""
import contextlib
import io
import json
import subprocess
import tempfile
import time
from pathlib import Path
import unittest
from unittest.mock import patch
import fixed_cpu_quota_runner as runner


class RunnerContractTests(unittest.TestCase):
    def test_default_plan_has_no_execution(self):
        args, plan = runner.parse_args([])
        self.assertFalse(args.execute)
        self.assertEqual(len(plan), 8)
        self.assertEqual([p['arm'] for p in plan[:4]], ['single', 'bounded', 'bounded', 'single'])

    def test_execute_needs_both_explicit_inputs(self):
        for arguments in [['--execute'], ['--execute', '--authorization', runner.TOKEN], ['--execute', '--native-correctness-sha', 'a' * 40]]:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                runner.parse_args(arguments)

    def test_fixed_protocol_rejects_duration_overrides(self):
        for value in ['0', '9', '61', '999999']:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                runner.parse_args(['--seconds', value])

    def test_plan_main_does_not_create_runner_or_subprocess(self):
        with patch('sys.argv', ['runner']), patch.object(runner, 'Runner') as instance, patch.object(runner.subprocess, 'run') as process, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.main(), 0)
        instance.assert_not_called()
        process.assert_not_called()

    def test_workflow_is_explicit_opt_in_and_gates_exact_source(self):
        workflow = (runner.ROOT / '.github/workflows/fixed-cpu-quota-diagnostic.yml').read_text()
        gate = (runner.ROOT / 'scripts/performance/fixed-cpu/workflow-gate.cjs').read_text()
        self.assertIn('  workflow_dispatch:', workflow)
        self.assertIn('  push:', workflow)
        self.assertIn('branches: [perf/db-hotpath-20261026]', workflow)
        self.assertIn("github.repository == 'elex-fu/model-router'", workflow)
        self.assertIn("github.event.head_commit.message == '[run-fixed-cpu-quota]'", workflow)
        for trigger in ['  pull_request:', '  schedule:', '  workflow_run:']:
            self.assertNotIn(trigger, workflow)
        self.assertIn("['ci.yml', 'fast-gateway-required.yml']", gate)
        self.assertIn('head_sha: context.sha', gate)
        self.assertIn("for (const pg of ['15', '18'])", gate)
        self.assertIn('timeout-minutes: 135', workflow)
        self.assertEqual(runner.MAX_SECONDS, 110 * 60)
        self.assertIn('contents: read', workflow)
        self.assertNotIn('contents: write', workflow)
        self.assertIn('if: always()', workflow)
        self.assertIn("inputs.profiles || 'both'", workflow)
        self.assertIn("inputs.protocols || 'both'", workflow)
        self.assertNotIn('QUOTA_SECONDS', workflow)
        ci = (runner.ROOT / '.github/workflows/ci.yml').read_text()
        self.assertIn('actions/setup-go@v5', ci)
        self.assertIn('go-version: "1.24.4"', ci)
        self.assertIn('cache: false', ci)
        self.assertIn('GOTOOLCHAIN: local', ci)
        self.assertIn('go test scripts/performance/fixed-cpu/mock.go scripts/performance/fixed-cpu/mock_test.go', ci)

    def test_runtime_uses_owned_isolated_namespace_not_host_network(self):
        instance = runner.Runner.__new__(runner.Runner)
        instance.containers = []
        instance.container_ids = {'owned-app': 'app-id', 'owned-network-holder': 'network-id'}
        instance.run_token = 'test-run-token'
        instance.network_name = 'owned-network-holder'
        instance.image_id = 'sha256:app'
        with patch.object(instance, 'docker') as docker, patch.object(instance, 'inspect'):
            instance.launch('owned-app', instance.image_id, ['node', 'dist/cli/index.js'], app=True)
        command = docker.call_args.args
        self.assertIn('--network=container:owned-network-holder', command)
        self.assertIn('--cpus=2', command)
        self.assertIn('--memory=2g', command)
        self.assertIn('--memory-swap=2g', command)
        self.assertIn('--user', command)
        self.assertNotIn('--network=host', command)
        with patch.object(instance, 'docker') as docker, patch.object(instance, 'inspect'):
            instance.launch('owned-network-holder', instance.image_id, ['sleep', '7200'], network='none')
        self.assertIn('--network=none', docker.call_args.args)

    def test_comparison_never_uses_incomplete_or_failed_arms(self):
        _, plan = runner.parse_args(['--profiles', 'c32', '--protocols', 'json'])
        results = [{'label': entry['label'], 'validDiagnostic': True,
                    'metrics': {'successRps': 100 if entry['arm'] == 'single' else 120,
                                'cpuMillisecondsPerSuccess': 10 if entry['arm'] == 'single' else 8}}
                   for entry in plan]
        report = runner.comparison_report(plan, results)
        self.assertFalse(report['performanceAcceptance'])
        self.assertTrue(report['cohortComplete'])
        self.assertTrue(report['validDiagnostic'])
        self.assertEqual(runner.comparison_report(plan, results[:-1])['conclusion'], 'inconclusive')
        self.assertEqual(report['groups'][0]['descriptiveRatiosOfArmMeans'],
                         {'boundedOverSingleThroughput': 1.2, 'boundedOverSingleCpuPerSuccess': .8})
        self.assertIsNone(runner.comparison_report(plan, results[:-1])['groups'][0]['descriptiveRatiosOfArmMeans'])
        results[1]['validDiagnostic'] = False
        self.assertEqual(runner.comparison_report(plan, results)['conclusion'], 'inconclusive')
        self.assertIsNone(runner.comparison_report(plan, results)['groups'][0]['descriptiveRatiosOfArmMeans'])

    def test_unowned_name_conflict_never_deletes_a_container(self):
        instance = runner.Runner.__new__(runner.Runner)
        instance.run_token = 'current-token'
        instance.container_ids = {}
        unowned = [{'Id': 'unrelated-id', 'Config': {'Labels': None}}]
        with patch.object(runner.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(unowned), '')) as process:
            self.assertFalse(instance.remove_owned('colliding-name'))
        self.assertEqual(len(process.call_args_list), 1)
        self.assertEqual(process.call_args.args[0][:2], ['docker', 'inspect'])
        self.assertEqual(instance.container_ids, {})

    def test_cleanup_deletes_verified_id_not_a_reused_name(self):
        instance = runner.Runner.__new__(runner.Runner)
        instance.run_token = 'current-token'
        instance.container_ids = {'known-name': 'owned-id'}
        owned = [{'Id': 'owned-id', 'Config': {'Labels': {runner.OWNER_LABEL: 'current-token'}}}]
        with patch.object(runner.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], 0, json.dumps(owned), ''), subprocess.CompletedProcess([], 0, '', '')]) as process:
            self.assertTrue(instance.remove_owned('known-name'))
        self.assertEqual(process.call_args.args[0], ['docker', 'rm', '-f', '-v', 'owned-id'])
        self.assertEqual(instance.container_ids, {})
        instance.container_ids['known-name'] = 'owned-id'
        owned[0]['Id'] = 'replacement-id'
        with patch.object(runner.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(owned), '')) as process:
            self.assertFalse(instance.remove_owned('known-name'))
        self.assertEqual(process.call_count, 1)

    def test_owned_remove_allows_fresh_recreation_without_stale_identity(self):
        instance = runner.Runner.__new__(runner.Runner)
        instance.run_token = 'current-token'
        instance.container_ids = {'same-name': 'old-id'}
        def inspected(identifier):
            return subprocess.CompletedProcess([], 0, json.dumps([{'Id': identifier, 'Config': {'Labels': {runner.OWNER_LABEL: 'current-token'}}}]), '')
        with patch.object(runner.subprocess, 'run', side_effect=[inspected('old-id'), subprocess.CompletedProcess([], 0, '', ''), inspected('new-id'), subprocess.CompletedProcess([], 0, '', '')]) as process:
            self.assertTrue(instance.remove_owned('same-name'))
            self.assertTrue(instance.remove_owned('same-name'))
        self.assertEqual([call.args[0][-1] for call in process.call_args_list if call.args[0][1] == 'rm'], ['old-id', 'new-id'])
        self.assertEqual(instance.container_ids, {})

    def test_failed_build_retains_sanitized_compiler_output(self):
        with tempfile.TemporaryDirectory() as directory:
            instance = runner.Runner.__new__(runner.Runner)
            instance.output = Path(directory)
            instance.image = 'owned-build'
            instance.deadline = time.monotonic() + 900
            archive = Path(directory) / 'source.tar'
            archive.write_bytes(b'fixture archive')
            result = subprocess.CompletedProcess([], 1, b'compile output', b'client.go:9: syntax error\npassword=do-not-retain')
            with patch.object(runner.subprocess, 'run', return_value=result), self.assertRaises(RuntimeError):
                instance.build_image(archive)
            proof = json.loads((Path(directory) / 'build-output.json').read_text())
            self.assertEqual(proof['exitCode'], 1)
            self.assertIn('client.go:9: syntax error', proof['stderr']['text'])
            self.assertNotIn('do-not-retain', proof['stderr']['text'])
            self.assertFalse(archive.exists())

    def test_required_audit_missing_or_malformed_is_not_a_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'source.json', Path(directory) / 'retained.json'
            with self.assertRaisesRegex(ValueError, 'REQUIRED_EVIDENCE_MISSING'):
                runner.copy_required_json(source, target)
            source.write_text('not valid json')
            with self.assertRaises(ValueError):
                runner.copy_required_json(source, target)
            self.assertEqual(target.read_text(), 'not valid json')

    def test_partial_attempt_journal_survives_without_aggregate_after_driver_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture, out = Path(directory) / 'private', Path(directory) / 'retained'
            fixture.mkdir(); out.mkdir()
            partial = '{"attempt":1,"event":"admitted"}\n'
            (fixture / 'measured.json.attempts.jsonl').write_text(partial)
            runner.retain_driver_files(fixture, out, 'measured')
            self.assertEqual((out / 'measured-attempts.jsonl').read_text(), partial)
            self.assertFalse((out / 'measured-raw.json').exists())

    def test_portable_assets_and_pinned_build(self):
        folder = runner.ROOT / 'scripts/performance/fixed-cpu'
        dockerfile = (folder / 'Dockerfile').read_text()
        self.assertIn('golang:1.24.4-bookworm', dockerfile)
        self.assertIn('node:22.16.0-bookworm', dockerfile)
        self.assertIn('npm ci', dockerfile)
        self.assertNotIn('COPY dist', dockerfile)
        self.assertIn('fmt.Sprintf("HTTP %d: %s", resp.StatusCode, all)', (folder / 'client.go').read_text())
        for name in ['fixture.cjs', 'compile-fixtures.cjs', 'client.go', 'mock.go', 'Dockerfile']:
            text = (folder / name).read_text()
            for forbidden in ['/workspace/', '/tmp/sub2api', 'NODE_TLS_REJECT_UNAUTHORIZED', 'InsecureSkipVerify']:
                self.assertNotIn(forbidden, text, name)


if __name__ == '__main__':
    unittest.main()
