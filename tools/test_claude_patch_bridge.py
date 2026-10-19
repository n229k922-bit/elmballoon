import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("claude_patch_bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ProposalTests(unittest.TestCase):
    def setUp(self):
        self.name = "docs/ai-bridge-pilot/acceptance.txt"
        self.source = {self.name: "before"}
        self.item = {"path": self.name, "old_sha256": hashlib.sha256(b"before").hexdigest(), "content": "after"}

    def test_valid(self):
        bridge.check_proposal({"replacements": [self.item]}, self.source)

    def test_reject_paths(self):
        for name in [".github/workflows/deploy-pages.yml", "../escape.txt", "workers/admin-line-secretary/src/index.js"]:
            with self.assertRaises(ValueError):
                bridge.check_proposal({"replacements": [{**self.item, "path": name}]}, self.source)

    def test_reject_stale_hash(self):
        with self.assertRaises(ValueError):
            bridge.check_proposal({"replacements": [{**self.item, "old_sha256": "bad"}]}, self.source)

    def test_reject_duplicates(self):
        with self.assertRaises(ValueError):
            bridge.check_proposal({"replacements": [self.item, self.item]}, self.source)

    def test_reject_empty_and_extra_fields(self):
        for proposal in [{"replacements": []}, {"replacements": [self.item], "command": "deploy"}]:
            with self.assertRaises(ValueError):
                bridge.check_proposal(proposal, self.source)


if __name__ == "__main__":
    unittest.main()
