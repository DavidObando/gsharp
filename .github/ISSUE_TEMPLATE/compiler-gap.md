---
name: G# compiler gap (cs2gs)
about: A correct C#→G# translation that fails to compile, IL-verify, or reach behavioral parity
labels: ["Oats", "bug"]
---

## Summary

<!-- <diagnostic id> — <message>   (stage: translate | compile | ilverify | test-parity) -->

## Minimal repro (fails)

```gs
// smallest .gs that reproduces <diagnostic id>
```

## Contrasting control (passes)

```gs
// nearest sibling construct that compiles/verifies/runs today
```

## Provenance

- Fingerprint: `sha256:…`
- Corpus fixture: `tools/cs2gs/corpus/…`
- Emitted G#: `<runDir>/<app>/<File>.gs:<line>:<col>`
- Offending C# construct: `<SyntaxKind>` — `<snippet>`
- gsc version: `<version>`

## Definition of done

- [ ] Fix + `Issue<N>*.cs` regression test
- [ ] `tools/cs2gs/triage/gaps.json` entry flipped to `resolved` (`cs2gs triage sync --write`)
- [ ] Corpus re-run confirms the fingerprint no longer reproduces
