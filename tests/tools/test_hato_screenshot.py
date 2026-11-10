import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hato_screenshot', Path(__file__).parents[2] / 'tools/hato-screenshot.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class CaptureTest(unittest.TestCase):
    def args(self, path, crop=None):
        return argparse.Namespace(app='hato', window_id=7, title=None, list=False, output=str(path), crop=crop, label='test-panel')

    def commands(self, windows):
        calls = []
        def run(args):
            calls.append(args)
            if args[0] == 'swift':
                return json.dumps(windows)
            if args[0].endswith('screencapture'):
                Path(args[-1]).write_bytes(b'fixture')
                return ''
            if args[:3] == ['sips', '-g', 'pixelWidth']:
                return 'pixelWidth: 200\npixelHeight: 100\n'
            if args[:2] == ['sips', '--cropToHeightWidth']:
                Path(args[-1]).write_bytes(b'cropped-fixture')
                return ''
            raise AssertionError(args)
        return calls, run

    def window(self):
        return {'id': 7, 'owner': 'hato', 'title': 'Hato', 'bounds': {'Width': 100, 'Height': 50, 'X': 0, 'Y': 0}}

    def test_retina_panel_crop_and_sidecar(self):
        calls, run = self.commands([self.window()])
        with tempfile.TemporaryDirectory() as directory, patch.object(helper.platform, 'system', return_value='Darwin'), patch.object(helper, 'run', side_effect=run), contextlib.redirect_stdout(io.StringIO()):
            output = Path(directory) / 'panel.png'
            helper.capture(self.args(output, (10, 5, 20, 10)))
            crop = next(call for call in calls if '--cropToHeightWidth' in call)
            self.assertEqual(crop[2:7], ['20', '40', '--cropOffset', '10', '20'])
            self.assertEqual(output.read_bytes(), b'cropped-fixture')
            metadata = json.loads(output.with_suffix('.json').read_text())
            self.assertEqual(metadata['cropPoints'], [10, 5, 20, 10])
            self.assertEqual(metadata['windowPixels'], [200, 100])
            with self.assertRaisesRegex(RuntimeError, 'already exists'):
                helper.capture(self.args(output))

    def test_out_of_bounds_crop_is_not_written(self):
        _, run = self.commands([self.window()])
        with tempfile.TemporaryDirectory() as directory, patch.object(helper.platform, 'system', return_value='Darwin'), patch.object(helper, 'run', side_effect=run):
            output = Path(directory) / 'panel.png'
            with self.assertRaisesRegex(RuntimeError, 'outside'):
                helper.capture(self.args(output, (90, 0, 20, 10)))
            self.assertFalse(output.exists())

    def test_ambiguous_windows_require_an_explicit_choice(self):
        _, run = self.commands([self.window(), {**self.window(), 'id': 8}])
        with patch.object(helper.platform, 'system', return_value='Darwin'), patch.object(helper, 'run', side_effect=run):
            args = self.args(Path('/tmp/not-created-by-test.png'))
            args.window_id = None
            with self.assertRaisesRegex(RuntimeError, 'Multiple matching windows'):
                helper.capture(args)


if __name__ == '__main__':
    unittest.main()
