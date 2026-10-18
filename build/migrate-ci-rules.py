#!/usr/bin/env python3
"""Split Lock Main without changing the C# branch family's protections.

Run only after the rollout PR's full CI and current-head review pass.
Default: print the two proposed rulesets. --apply creates main's aggregate
protection before restricting the original ruleset to the C# branch family.
"""

import argparse
import copy
import json
import subprocess

REPO = "DavidObando/gsharp"


def split_rules(original):
    fields = ("name", "target", "enforcement", "bypass_actors", "conditions", "rules")
    csharp = {key: copy.deepcopy(original[key]) for key in fields}
    includes = csharp["conditions"]["ref_name"]["include"]
    if set(includes) != {"~DEFAULT_BRANCH", "refs/heads/cs2gs/csharp*"}:
        raise ValueError(f"unexpected ruleset scope: {includes}")
    main = copy.deepcopy(csharp)
    main["name"] = "Main CI aggregates"
    main["conditions"]["ref_name"]["include"] = ["~DEFAULT_BRANCH"]
    csharp["conditions"]["ref_name"]["include"] = ["refs/heads/cs2gs/csharp*"]
    status = [r for r in main["rules"] if r["type"] == "required_status_checks"]
    if len(status) != 1:
        raise ValueError("expected one required-status-check rule")
    status[0]["parameters"]["required_status_checks"] = [
        {"context": name, "integration_id": 15368} for name in ("ci", "docs-ci")]
    return main, csharp


def api(path, method=None, payload=None):
    args = ["gh", "api", f"repos/{REPO}/{path}"]
    if method:
        args += ["--method", method, "--input", "-"]
    result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ruleset", type=int, default=17277774)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    original = api(f"rulesets/{args.ruleset}")
    main_rules, csharp_rules = split_rules(original)
    if not args.apply:
        print(json.dumps({"main": main_rules, "csharp": csharp_rules}, indent=2))
        return
    existing = api("rulesets")
    if any(r["name"] == main_rules["name"] for r in existing):
        raise ValueError("aggregate ruleset already exists; inspect it before retrying")
    created = api("rulesets", "POST", main_rules)
    updated = api(f"rulesets/{args.ruleset}", "PUT", csharp_rules)
    print(json.dumps({"main_id": created["id"], "csharp_id": updated["id"]}))


if __name__ == "__main__":
    main()
