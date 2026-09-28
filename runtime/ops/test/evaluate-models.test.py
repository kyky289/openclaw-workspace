"""Offline evaluator guardrail tests. Never starts Claude or makes requests."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('evaluate_models', Path(__file__).resolve().parents[1] / 'evaluate-models.py')
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


def envelope(model='claude-opus-5', cost=0.01, answer=None, **extra):
    return {'total_cost_usd': cost, 'modelUsage': {model: {}},
            'result': json.dumps(answer if answer is not None else evaluation.CASES[0]['expected']), **extra}


class Guardrails(unittest.TestCase):
    def test_root_identity_switch_uses_absolute_runuser_path(self):
        with patch.object(evaluation.os, 'getuid', return_value=0):
            self.assertEqual(evaluation.execution_prefix(), ['/usr/sbin/runuser', '-u', 'openclaw', '--'])
        with patch.object(evaluation.os, 'getuid', return_value=1000):
            self.assertEqual(evaluation.execution_prefix(), [])

    def test_missing_auth_command_creates_no_report_directory_or_model_calls(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'new-report'
            args = ['evaluate-models.py', '--run', '--budget-usd', '10', '--output', str(output)]
            with patch.object(sys, 'argv', args), patch.object(evaluation, 'run_bounded', side_effect=FileNotFoundError()) as run:
                with self.assertRaisesRegex(SystemExit, 'executable not found'):
                    evaluation.main()
            self.assertFalse(output.exists())
            self.assertEqual(run.call_count, 1)

    def test_minor_release_cannot_verify_baseline(self):
        self.assertTrue(evaluation.model_matches('claude-opus-5', 'claude-opus-5-20260901'))
        for name in ['claude-opus-5-5', 'claude-opus-5-5-20260922', 'claude-opus-5-extra']:
            self.assertFalse(evaluation.model_matches('claude-opus-5', name), name)
        result = evaluation.call_result(envelope(model='claude-opus-5-5'), 0, 'claude-opus-5', evaluation.CASES[0], .25)
        self.assertFalse(result['passed'])
        self.assertFalse(result['modelVerified'])

    def test_multiple_model_usage_is_not_verified(self):
        raw = envelope()
        raw['modelUsage']['claude-haiku-4-5'] = {}
        self.assertFalse(evaluation.call_result(raw, 0, 'claude-opus-5', evaluation.CASES[0], .25)['modelVerified'])

    def test_invalid_envelopes_and_costs_stop_run(self):
        for raw in [[], None, {'total_cost_usd': True}, {'total_cost_usd': float('inf')}, {'total_cost_usd': -1}]:
            row = evaluation.call_result(raw, 0, 'claude-opus-5', evaluation.CASES[0], .25)
            self.assertIsNone(row['reportedCostUsd'])
            self.assertTrue(evaluation.must_stop_run(row))

    def test_reported_cost_over_cap_stops(self):
        row = evaluation.call_result(envelope(cost=.26), 0, 'claude-opus-5', evaluation.CASES[0], .25)
        self.assertEqual(row['status'], 'reported-cost-exceeded-cap')
        self.assertTrue(evaluation.must_stop_run(row))
        self.assertFalse(row['passed'])

    def test_untrusted_diagnostics_are_not_saved(self):
        secret = 'credential-sentinel-never-save'
        raw = envelope(model=secret, answer={'profit': secret}, is_error=True, subtype=secret, duration_ms=secret)
        row = evaluation.call_result(raw, 1, 'claude-opus-5', evaluation.CASES[0], .25)
        self.assertNotIn(secret, json.dumps(row))
        raw = envelope(answer={'profit': secret, 'unit': 'USD million', 'evidence': 'provided'})
        row = evaluation.call_result(raw, 0, 'claude-opus-5', evaluation.CASES[0], .25)
        self.assertNotIn(secret, json.dumps(row))

    def test_list_schema_rejects_unhashable_and_discards_extra_values(self):
        case = evaluation.CASES[-1]
        self.assertFalse(evaluation.grade(case, {'executeTrade': False, 'decision': 'wait-for-inputs', 'missing': [{}]}))
        answer = dict(case['expected'], missing=['price', 'balance', 'authorization', 'secret-sentinel'])
        row = evaluation.call_result(envelope(answer=answer), 0, 'claude-opus-5', case, .25)
        self.assertTrue(row['passed'])
        self.assertNotIn('secret-sentinel', json.dumps(row))

    def test_grade_diagnostics_identify_fields_without_values(self):
        secret = 'private-value-and-field-sentinel'
        raw = envelope(answer={'profit': secret, 'unit': 'wrong unit', secret: secret})
        row = evaluation.call_result(raw, 0, 'claude-opus-5', evaluation.CASES[0], .25)
        self.assertEqual(row['gradeFailures'], [
            {'field': 'profit', 'code': 'wrong-type'},
            {'field': 'unit', 'code': 'wrong-value'},
            {'field': 'evidence', 'code': 'missing-field'},
        ])
        self.assertFalse(row['passed'])
        self.assertNotIn(secret, json.dumps(row))
        for answer, code in [({}, 'missing-field'), ({'missing': [{}]}, 'wrong-type'),
                             ({'missing': ['price']}, 'missing-required-items')]:
            answer.update(evaluation.CASES[-1]['expected'])
            failures = evaluation.grade_failures(evaluation.CASES[-1], answer)
            self.assertEqual(failures, [{'field': 'missing', 'code': code}])
        self.assertEqual(evaluation.grade_failures(evaluation.CASES[0], []),
                         [{'field': '$answer', 'code': 'wrong-type'}])

    def test_invalid_answers_have_fixed_parse_codes_without_raw_text(self):
        for result, code in [('private-invalid-output', 'invalid-json'), (None, 'invalid-result-type'),
                             ({'private': 'output'}, 'invalid-result-type')]:
            raw = envelope(); raw['result'] = result
            row = evaluation.call_result(raw, 0, 'claude-opus-5', evaluation.CASES[0], .25)
            self.assertEqual(row['status'], 'invalid-answer')
            self.assertEqual(row['gradeFailures'], [{'field': '$answer', 'code': code}])
            self.assertNotIn('private', json.dumps(row))

    def test_provider_failure_classes_are_fixed_sanitized_labels(self):
        examples = [
            ('model-unavailable', 'There is an issue with the selected model.'),
            ('model-unavailable', 'model claude-fixture does not exist'),
            ('model-unavailable', 'model_not_found_error'),
            ('access-denied', 'Your account does not have access'),
            ('access-denied', 'authentication_error'),
            ('access-denied', 'HTTP 403 forbidden'),
            ('rate-limit', 'rate_limit_error'),
            ('rate-limit', 'HTTP 429 too many requests'),
            ('budget-limit', 'Insufficient credits'),
            ('budget-limit', 'Maximum budget exceeded'),
            ('unknown', 'An unexpected internal condition occurred'),
        ]
        secret = 'diagnostic-secret-sentinel'
        for expected, diagnostic in examples:
            with self.subTest(expected=expected, diagnostic=diagnostic):
                for carrier in ['stderr', 'result', 'errors', 'error']:
                    raw = envelope(is_error=True, subtype='success')
                    kwargs = {}
                    value = f'{diagnostic} {secret}'
                    if carrier == 'stderr':
                        kwargs['stderr'] = value
                    else:
                        raw[carrier] = [{'message': value}] if carrier == 'errors' else value
                    row = evaluation.call_result(raw, 1, 'claude-opus-5', evaluation.CASES[0], .25, **kwargs)
                    self.assertEqual(row['status'], 'model-call-failed')
                    self.assertEqual(row['providerFailureClass'], expected)
                    self.assertEqual(row['errorCode'], 'CLI_FAILURE')
                    self.assertNotIn(secret, json.dumps(row))
                    self.assertNotIn(diagnostic, json.dumps(row))

    def test_budget_subtype_is_classified_without_diagnostic_text(self):
        row = evaluation.call_result(envelope(is_error=True, subtype='error_max_budget_usd'),
                                     1, 'claude-opus-5', evaluation.CASES[0], .25)
        self.assertEqual(row['providerFailureClass'], 'budget-limit')
        self.assertEqual(row['errorCode'], 'error_max_budget_usd')

    def test_unrecognized_fixture_fields_never_leak_into_diagnostics(self):
        case = {'expected': {'private-key-sentinel': True}}
        self.assertEqual(evaluation.grade_failures(case, {}),
                         [{'field': '$unknown-field', 'code': 'missing-field'}])

    def test_diagnostic_text_is_bounded_and_never_authoritative(self):
        row = evaluation.call_result(envelope(is_error=True, errors=['x' * 20000, 'forbidden']),
                                     1, 'claude-opus-5', evaluation.CASES[0], .25)
        self.assertEqual(row['providerFailureClass'], 'unknown')
        self.assertFalse(row['passed'])

    def test_timeout_terminates_process_group_not_only_wrapper(self):
        process = MagicMock()
        process.pid = 12345
        process.communicate.side_effect = [subprocess.TimeoutExpired(['fake'], 1, output='secret-output'), ('', '')]
        process.__enter__.return_value = process
        with patch.object(evaluation.subprocess, 'Popen', return_value=process) as popen, patch.object(evaluation.os, 'killpg') as killpg:
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                evaluation.run_bounded(['fake'], env={}, cwd='/tmp', timeout=1)
        killpg.assert_called_once_with(12345, signal.SIGKILL)
        self.assertTrue(popen.call_args.kwargs['start_new_session'])
        self.assertIsNone(raised.exception.output)

    def test_cancellation_terminates_process_group(self):
        process = MagicMock()
        process.pid = 12345
        process.communicate.side_effect = [KeyboardInterrupt(), ('', '')]
        process.__enter__.return_value = process
        with patch.object(evaluation.subprocess, 'Popen', return_value=process), patch.object(evaluation.os, 'killpg') as killpg:
            with self.assertRaises(KeyboardInterrupt):
                evaluation.run_bounded(['fake'], env={}, cwd='/tmp', timeout=1)
        killpg.assert_called_once_with(12345, signal.SIGKILL)

    def invoke_main(self, responses, models=None, budget='10'):
        calls = []
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'new-report'
            def fake(command, **kwargs):
                calls.append((command, kwargs))
                if 'auth' in command:
                    return subprocess.CompletedProcess(command, 0, json.dumps({'loggedIn': True, 'authMethod': 'claude.ai', 'subscriptionType': 'pro'}), '')
                response = next(responses)
                if isinstance(response, Exception):
                    raise response
                if isinstance(response, subprocess.CompletedProcess):
                    return response
                return subprocess.CompletedProcess(command, 0, json.dumps(response), '')
            args = ['evaluate-models.py', '--run', '--budget-usd', budget, '--output', str(output)]
            if models:
                args += ['--models', *models]
            with patch.object(sys, 'argv', args), patch.object(evaluation, 'run_bounded', side_effect=fake), contextlib.redirect_stdout(io.StringIO()):
                evaluation.main()
            return json.loads((output / 'report.json').read_text()), calls

    def test_unknown_cost_stops_before_next_model(self):
        report, calls = self.invoke_main(iter([{}]))
        self.assertEqual(len(calls), 2, 'auth check + one model call only')
        self.assertEqual(report['status'], 'cost-uncertain-stop')
        self.assertEqual(report['calls'], 1)
        self.assertEqual(report['unknownCostCalls'], 1)
        self.assertEqual(report['accountedUsd'], .25)

    def test_timeout_stops_all_models(self):
        report, calls = self.invoke_main(iter([subprocess.TimeoutExpired(['fake'], 80)]))
        self.assertEqual(len(calls), 2)
        self.assertEqual(report['status'], 'cost-uncertain-stop')
        self.assertFalse(report['results'][0]['passed'])

    def test_cap_exceedance_stops_all_models(self):
        report, calls = self.invoke_main(iter([envelope(model='claude-opus-5-5', cost=.3)]))
        self.assertEqual(len(calls), 2)
        self.assertEqual(report['status'], 'reported-cap-exceeded-stop')

    def test_minimum_remaining_budget_prevents_calls(self):
        report, calls = self.invoke_main(iter([]), budget='.5')
        self.assertEqual(len(calls), 1)
        self.assertEqual(report['calls'], 0)
        self.assertEqual(report['status'], 'budget-stop')

    def test_stderr_diagnosis_reaches_report_without_raw_provider_text(self):
        response = subprocess.CompletedProcess(['fixture'], 1,
            json.dumps(envelope(model='claude-opus-5-5', cost=0, is_error=True, subtype='success')),
            'unknown model diagnostic-secret-sentinel')
        report, calls = self.invoke_main(iter([response]), models=['claude-opus-5-5'])
        self.assertEqual(len(calls), 2)
        self.assertEqual(report['results'][0]['providerFailureClass'], 'model-unavailable')
        self.assertNotIn('diagnostic-secret-sentinel', json.dumps(report))
        self.assertIn('Per invocation', report['plan']['budgetLimitMeaning'])
        self.assertIn('all reports', report['plan']['budgetLimitMeaning'])
        self.assertIn('not an account-wide', report['plan']['budgetLimitMeaning'])

    def test_restrictions_and_env_do_not_inherit_api_billing(self):
        with patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'never-inherit', 'ANTHROPIC_BASE_URL': 'https://invalid.test'}):
            _, calls = self.invoke_main(iter([{}]))
        command, kwargs = calls[1]
        for flag in ['--print', '--safe-mode', '--restricted', '--strict-mcp-config', '--no-chrome', '--no-session-persistence']:
            self.assertIn(flag, command)
        for flag, value in [('--tools', ''), ('--setting-sources', ''), ('--permission-mode', 'dontAsk'), ('--permission-prompts', 'none'), ('--mcp-config', '{"mcpServers":{}}'), ('--max-budget-usd', '0.25')]:
            self.assertEqual(command[command.index(flag)+1], value)
        self.assertNotIn('ANTHROPIC_API_KEY', kwargs['env'])
        self.assertNotIn('ANTHROPIC_BASE_URL', kwargs['env'])
        self.assertEqual(kwargs['env']['CLAUDE_CODE_MAX_OUTPUT_TOKENS'], '1024')
        self.assertEqual(kwargs['timeout'], 80)


if __name__ == '__main__':
    unittest.main()
