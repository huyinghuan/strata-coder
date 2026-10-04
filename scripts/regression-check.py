"""Run unchanged evaluation assertions outside the worker's editable workspace."""
import importlib.util
import json
import pathlib
import sys

evaluation = pathlib.Path(sys.argv[1]).resolve()
task = json.loads(pathlib.Path(sys.argv[2]).read_text())
spec = importlib.util.spec_from_file_location('original_eval', evaluation / 'run_eval.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
code = (pathlib.Path.cwd() / 'src' / 'solution.py').read_text()
result = module.check(code, task, trusted='--trusted-reference' in sys.argv[3:])
print(json.dumps(result, ensure_ascii=False))
raise SystemExit(0 if result['passed'] else 1)
