// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSourceMetadataBlockerIsRootIndependentAndBounded(t *testing.T) {
	analyzeFailure := func(t *testing.T) BlockerRecord {
		t.Helper()
		root, err := secureRoot(copyFixture(t, "complete"))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(filepath.Join(root, ".git"), 0o700); err != nil {
			t.Fatal(err)
		}
		profile := testProfile()
		profile.ExpectedSourceCommit = strings.Repeat("a", 40)
		profile.Limits.MaxStringBytes = 96
		analysis, complete, err := analyze(t.Context(), root, t.TempDir(), profile)
		if err != nil {
			t.Fatal(err)
		}
		if complete {
			t.Fatal("missing repository HEAD completed inventory")
		}
		for _, blocker := range analysis.Blockers {
			if blocker.Category == "source-metadata" &&
				strings.Contains(blocker.Message, "repository HEAD") {
				if strings.Contains(blocker.Message, root) {
					t.Fatalf("source root leaked in blocker: %q", blocker.Message)
				}
				assertPublishedBlocker(t, blocker, profile.Limits.MaxStringBytes)
				return blocker
			}
		}
		t.Fatalf("source metadata blocker missing: %#v", analysis.Blockers)
		return BlockerRecord{}
	}

	first := analyzeFailure(t)
	second := analyzeFailure(t)
	if first.Message != second.Message || first.ID != second.ID {
		t.Fatalf("checkout-dependent source blocker:\n%#v\n%#v", first, second)
	}
	if !strings.Contains(first.Message, ".git") || !strings.Contains(first.Message, "HEAD") ||
		!strings.Contains(first.Message, "<private-path>") {
		t.Fatalf("source blocker lost actionable relative context: %q", first.Message)
	}
}

func TestBlockerFinalizationBoundsEveryConstructionAPI(t *testing.T) {
	const max = 11
	for _, test := range []struct {
		name string
		add  func(*inventoryBuilder, string)
	}{
		{"inventory", func(builder *inventoryBuilder, message string) {
			builder.block("test-inventory", message, []string{"unit-b", "unit-a"}, nil)
		}},
		{"migration", func(builder *inventoryBuilder, message string) {
			builder.migrationBlock("test-migration", message, []string{"unit-b", "unit-a"})
		}},
		{"raw", func(builder *inventoryBuilder, message string) {
			builder.addBlocker("inventory", "test-raw", message, []string{"unit-b", "unit-a"}, []string{"diagnostic-b", "diagnostic-a"})
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			profile := testProfile()
			profile.Limits.MaxStringBytes = max
			analysis := Analysis{Blockers: []BlockerRecord{}}
			builder := newInventoryBuilder(&analysis, "/private/source-mirror", "/private/goroot", profile)
			builder.diagnosticRedactions = []string{"/checkout/source", "/private/work", "/output/root"}
			message := test.name + "-\xff-/checkout/source-/private/source-mirror-/private/work-/output/root-" +
				strings.Repeat("界", 32)
			test.add(builder, message)
			if len(analysis.Blockers) != 1 {
				t.Fatalf("blocker count = %d", len(analysis.Blockers))
			}
			assertPublishedBlocker(t, analysis.Blockers[0], max)
			for _, root := range []string{"/checkout/source", "/private/source-mirror", "/private/work", "/output/root"} {
				if strings.Contains(analysis.Blockers[0].Message, root) {
					t.Fatalf("private root %q leaked in %q", root, analysis.Blockers[0].Message)
				}
			}
		})
	}
}

func TestLongRequestedGoVersionBlockerUsesPublishedMessageIdentity(t *testing.T) {
	profile := testProfile()
	profile.RequestedGoVersion = "1." + strings.Repeat("9", 512)
	if normalized, err := normalizeOfficialGoVersion(profile.RequestedGoVersion, false); err != nil ||
		normalized != profile.RequestedGoVersion {
		t.Fatalf("long canonical Go version rejected: %q, %v", normalized, err)
	}
	profile.Limits.MaxStringBytes = 17
	analysis, complete, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if complete {
		t.Fatal("toolchain mismatch completed inventory")
	}
	for _, blocker := range analysis.Blockers {
		if blocker.Category == "toolchain" {
			assertPublishedBlocker(t, blocker, profile.Limits.MaxStringBytes)
			return
		}
	}
	t.Fatalf("toolchain blocker missing: %#v", analysis.Blockers)
}

func TestBlockerFinalizationHandlesTinyStringLimits(t *testing.T) {
	for max := 1; max <= 3; max++ {
		t.Run(fmt.Sprintf("max-%d", max), func(t *testing.T) {
			profile := testProfile()
			profile.Limits.MaxStringBytes = max
			analysis := Analysis{Blockers: []BlockerRecord{}}
			builder := newInventoryBuilder(&analysis, "", "", profile)
			builder.block("tiny", strings.Repeat("界", 8), nil, nil)
			if len(analysis.Blockers) != 1 {
				t.Fatalf("blocker count = %d", len(analysis.Blockers))
			}
			assertPublishedBlocker(t, analysis.Blockers[0], max)
		})
	}
}

func TestBlockerDeduplicationUsesBoundedPublishedMessage(t *testing.T) {
	profile := testProfile()
	profile.Limits.MaxStringBytes = 8
	analysis := Analysis{Blockers: []BlockerRecord{}}
	builder := newInventoryBuilder(&analysis, "", "", profile)
	builder.block("dedupe", "shared-prefix-first", nil, nil)
	builder.block("dedupe", "shared-prefix-second", nil, nil)
	if len(analysis.Blockers) != 1 || builder.records != 1 {
		t.Fatalf("bounded-equivalent blockers were not deduplicated before counting: %#v, records=%d",
			analysis.Blockers, builder.records)
	}
	assertPublishedBlocker(t, analysis.Blockers[0], profile.Limits.MaxStringBytes)
}

func TestProductionBlockersUseCentralConstructor(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var constructors []string
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), entry.Name(), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Body == nil {
				continue
			}
			ast.Inspect(function.Body, func(node ast.Node) bool {
				literal, ok := node.(*ast.CompositeLit)
				if !ok {
					return true
				}
				identifier, ok := literal.Type.(*ast.Ident)
				if ok && identifier.Name == "BlockerRecord" {
					constructors = append(constructors, entry.Name()+":"+function.Name.Name)
				}
				return true
			})
		}
	}
	sort.Strings(constructors)
	want := []string{"inventory.go:addBlocker"}
	if fmt.Sprint(constructors) != fmt.Sprint(want) {
		t.Fatalf("production blocker constructors = %v; want %v", constructors, want)
	}
}

func assertPublishedBlocker(t *testing.T, blocker BlockerRecord, max int) {
	t.Helper()
	if !utf8.ValidString(blocker.Message) || len(blocker.Message) == 0 || len(blocker.Message) > max {
		t.Fatalf("published blocker message is invalid or too large: %q", blocker.Message)
	}
	units := append([]string{}, blocker.AffectedUnits...)
	sort.Strings(units)
	wantID := stableID("blocker",
		blocker.Blocks+"\x00"+blocker.Category+"\x00"+blocker.Message+"\x00"+strings.Join(units, "\x00"))
	if blocker.ID != wantID {
		t.Fatalf("blocker ID = %q; want %q for published message %q", blocker.ID, wantID, blocker.Message)
	}
	data, err := json.Marshal(blocker)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip BlockerRecord
	if err := json.Unmarshal(data, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if roundTrip.Message != blocker.Message || roundTrip.ID != blocker.ID ||
		!utf8.ValidString(roundTrip.Message) || len(roundTrip.Message) > max {
		t.Fatalf("blocker JSON round trip changed bounded identity: %#v", roundTrip)
	}
}
