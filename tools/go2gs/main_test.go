// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/tools/go/packages"
)

func testProfile() Profile {
	return Profile{
		Schema:             SchemaHandshake{Name: profileName, Version: profileVersion},
		ID:                 "test",
		EntryPatterns:      []string{"./..."},
		RequestedGoVersion: strings.TrimPrefix(runtime.Version(), "go"),
		LoadTests:          true,
		GOOS:               runtime.GOOS,
		GOARCH:             runtime.GOARCH,
		CGOEnabled:         false,
		ModuleMode:         "readonly",
		WorkspaceMode:      "off",
		Offline:            true,
		Limits: Limits{
			MaxDurationSeconds: 120, MaxPackages: 500, MaxFiles: 200,
			MaxRecords: 100000, MaxStringBytes: 65536, MaxLogBytes: 1 << 20,
			MaxOutputBytes: 64 << 20, MaxLocalHashBytes: 64 << 20,
		},
	}
}

func validIncompleteAnalysis() Analysis {
	hash := strings.Repeat("0", 64)
	analysis := Analysis{
		Schema: SchemaHandshake{
			Name: schemaName, Version: schemaVersion,
			RequiredRecordKinds: append([]string{}, requiredRecordKinds...),
		},
		Tool:   VersionIdentity{Version: toolVersion, SHA256: hash},
		Helper: VersionIdentity{Version: helperVersion, SHA256: hash},
		Profile: ProfileSnapshot{
			ID: "test", SHA256: hash, SourceRootIdentity: "source:test",
			EntryPatterns: []string{"./..."}, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH,
			ArchitectureFeatures: []string{}, BuildTags: []string{}, GOFLAGS: []string{},
			GODEBUG: map[string]string{}, ModuleMode: "readonly", WorkspaceMode: "off",
			Offline: true, TrustBoundary: "test", Limits: testProfile().Limits,
		},
		Toolchain: ToolchainProvenance{
			RequestedVersion: "1.0", ActualVersion: "1.0", ExecutableSHA256: hash,
			ExecutableName: "go", GOROOTIdentity: "goroot:test", GOROOTVersionSHA256: hash, GOROOTSource: "test",
		},
		Manifests: []ManifestRecord{}, Modules: []ModuleRecord{}, Packages: []PackageRecord{},
		Files: []FileRecord{}, Types: []TypeRecord{}, Symbols: []SymbolRecord{}, Nodes: []NodeRecord{},
		Constants: []ConstantRecord{}, Scopes: []ScopeRecord{}, Selections: []SelectionRecord{},
		Calls: []CallRecord{}, MethodSets: []MethodSetRecord{}, Instances: []InstanceRecord{},
		Embeds: []EmbedRecord{}, GenerateDirectives: []GenerateRecord{}, Dependencies: []DependencyRecord{},
		FeatureSites: []FeatureSite{}, Diagnostics: []DiagnosticRecord{},
		Blockers: []BlockerRecord{{
			ID: "blocker:test", Blocks: "inventory", Category: "test", Message: "incomplete",
			AffectedUnits: []string{}, DiagnosticIDs: []string{},
		}},
		RecordCounts: RecordCounts{Blockers: 1, Total: 1},
	}
	return analysis
}

func TestAnalyzeCompleteFixtureIsDeterministicAndTyped(t *testing.T) {
	root := copyFixture(t, "complete")
	appendInvalidUTF8(t, filepath.Join(root, "ignored_windows.go"))
	first := filepath.Join(t.TempDir(), "first")
	secondRoot := filepath.Join(t.TempDir(), "different-root")
	copyTree(t, root, secondRoot)
	second := filepath.Join(t.TempDir(), "second")
	profile := testProfile()

	a1, complete, err := analyze(t.Context(), root, first, profile)
	if err != nil {
		t.Fatal(err)
	}
	if !complete || !a1.InventoryComplete {
		t.Fatalf("expected complete inventory, blockers: %#v", a1.Blockers)
	}
	a2, complete, err := analyze(t.Context(), secondRoot, second, profile)
	if err != nil {
		t.Fatal(err)
	}
	if !complete {
		t.Fatal("second inventory incomplete")
	}
	b1, err := marshalCanonical(a1)
	if err != nil {
		t.Fatal(err)
	}
	b2, err := marshalCanonical(a2)
	if err != nil {
		t.Fatal(err)
	}
	if string(b1) != string(b2) {
		t.Fatalf("analysis differs by checkout root near: %s", firstDifference(string(b1), string(b2)))
	}
	if err := validateAnalysis(a1); err != nil {
		t.Fatal(err)
	}

	if a1.MigrationReady {
		t.Fatal("M0 inventory must not claim migration readiness")
	}

	var variants []string
	for _, pkg := range a1.Packages {
		if strings.HasPrefix(pkg.ImportPath, "example.com/go2gsfixture") {
			variants = append(variants, pkg.Variant)
		}
	}
	for _, want := range []string{"ordinary", "in-package-test", "external-test"} {
		if !slices.Contains(variants, want) {
			t.Fatalf("missing package variant %q in %v", want, variants)
		}
	}
	foundImports, foundInitialization, foundTestFile := false, false, false
	for _, pkg := range a1.Packages {
		if strings.HasPrefix(pkg.ImportPath, "example.com/go2gsfixture") {
			foundImports = foundImports || len(pkg.ImportPackageIDs) > 0
			foundInitialization = foundInitialization || len(pkg.InitializationOrder) > 0
		}
	}
	for _, file := range a1.Files {
		foundTestFile = foundTestFile || file.Role == "test"
	}
	if !foundImports || !foundInitialization || !foundTestFile {
		t.Fatalf("package graph facts missing: imports=%v initialization=%v test-file=%v", foundImports, foundInitialization, foundTestFile)
	}
	assertInitializationOrder(t, a1)
	if len(a1.Embeds) == 0 || len(a1.GenerateDirectives) == 0 {
		t.Fatal("embed and go:generate provenance were not recorded")
	}
	if a1.GenerateDirectives[0].Executed {
		t.Fatal("go:generate directive was executed")
	}

	foundLarge, foundRational, foundComplex, foundArrayLength := false, false, false, false
	declaredConstants := map[string]ConstantRecord{}
	symbolNames := map[string]string{}
	for _, symbol := range a1.Symbols {
		symbolNames[symbol.ID] = symbol.Name
	}
	for _, value := range a1.Constants {
		foundLarge = foundLarge || strings.Contains(value.Exact, "1234567890123456789012345678901234567890")
		foundRational = foundRational || value.Exact == "1/3"
		foundComplex = foundComplex || (value.RealExact != "" && value.ImaginaryExact != "")
		foundArrayLength = foundArrayLength || value.ArrayLength
		if value.SymbolID != "" {
			declaredConstants[symbolNames[value.SymbolID]] = value
		}
	}
	if !foundLarge || !foundRational || !foundComplex || !foundArrayLength {
		t.Fatalf("lossless constants missing: large=%v rational=%v complex=%v array-length=%v", foundLarge, foundRational, foundComplex, foundArrayLength)
	}
	for name, exact := range map[string]string{
		"HugeInteger": "1234567890123456789012345678901234567890",
		"ExactThird":  "1/3",
		"IotaZero":    "3",
		"IotaOne":     "4",
	} {
		value, ok := declaredConstants[name]
		if !ok || value.Exact != exact {
			t.Fatalf("declared constant %s was not recorded exactly: %#v", name, value)
		}
	}
	if !declaredConstants["IotaOne"].Iota || !declaredConstants["MixedIota"].Iota ||
		declaredConstants["MixedZero"].Iota || declaredConstants["ExactComplex"].ImaginaryExact == "" {
		t.Fatalf("inherited iota or complex declaration provenance missing: %#v", declaredConstants)
	}
	nodes := map[string]NodeRecord{}
	typesByID := map[string]string{}
	for _, value := range a1.Types {
		typesByID[value.ID] = value.Canonical
	}
	for _, node := range a1.Nodes {
		nodes[node.ID] = node
	}
	if !slices.ContainsFunc(a1.Constants, func(value ConstantRecord) bool {
		node := nodes[value.NodeID]
		return value.Exact == "7" && value.ContextTypeID != "" &&
			node.OriginalTypeID != "" && node.OriginalTypeID != node.EffectiveTypeID &&
			node.ConversionTypeID == node.EffectiveTypeID && value.ContextTypeID == node.EffectiveTypeID
	}) {
		t.Fatal("untyped contextual conversion facts missing")
	}
	if !slices.ContainsFunc(a1.Calls, func(call CallRecord) bool {
		node := nodes[call.NodeID]
		return call.Kind == "conversion" && typesByID[node.OriginalTypeID] == "untyped int" &&
			typesByID[node.EffectiveTypeID] == "int64" && node.ConversionTypeID == node.EffectiveTypeID
	}) {
		t.Fatal("explicit conversion did not preserve its untyped operand type")
	}
	if !hasLineDirective(a1) {
		t.Fatal("//line display provenance missing")
	}
	if !hasInvalidUTF8(a1) {
		t.Fatal("invalid UTF-8 source bytes were not preserved")
	}
	if len(a1.Selections) == 0 || len(a1.Instances) == 0 || len(a1.MethodSets) == 0 {
		t.Fatal("selection, generic instance, or method-set facts missing")
	}
	if !slices.ContainsFunc(a1.Calls, func(call CallRecord) bool { return call.Kind == "conversion" }) {
		t.Fatal("conversion call fact missing")
	}
	for _, name := range []string{"Add", "Identity", "Sprint"} {
		if !slices.ContainsFunc(a1.Calls, func(call CallRecord) bool {
			return call.CalleeSymbolID != "" && symbolNames[call.CalleeSymbolID] == name
		}) {
			t.Fatalf("callee symbol %q missing from selector or generic call", name)
		}
	}
	assertEmbedMatches(t, a1)
	for _, want := range []string{
		"nil-value", "interface-value", "byte-string", "map-value",
		"panic", "defer", "recover", "fixed-value-array",
		"goroutine", "channel-type", "channel-send", "channel-receive", "channel-close",
	} {
		if !slices.ContainsFunc(a1.FeatureSites, func(site FeatureSite) bool {
			return site.Feature == want && site.NodeID != "" && site.Disposition == "m1-prerequisite"
		}) {
			t.Fatalf("missing M1 prerequisite feature %q", want)
		}
	}
	for _, category := range []string{
		"m1-typed-nil-interface", "m1-byte-strings-maps",
		"m1-panic-defer-recover", "m1-fixed-value-arrays", "m1-concurrency",
	} {
		if !slices.ContainsFunc(a1.Blockers, func(blocker BlockerRecord) bool {
			return blocker.Category == category && blocker.Blocks == "migration"
		}) {
			t.Fatalf("missing migration blocker %q", category)
		}
	}
	if !slices.ContainsFunc(a1.Nodes, func(node NodeRecord) bool { return node.ParentID != "" }) {
		t.Fatal("typed syntax parent relationships missing")
	}
}

func TestOfflineMissingDependencyIsIncomplete(t *testing.T) {
	root := copyFixture(t, "missing")
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if complete || analysis.InventoryComplete || len(analysis.Blockers) == 0 || len(analysis.Diagnostics) == 0 {
		t.Fatalf("missing dependency must be incomplete with provenance: %#v", analysis)
	}
}

func TestCgoRequirementIsIncomplete(t *testing.T) {
	root := copyFixture(t, "cgo")
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if complete || analysis.InventoryComplete {
		t.Fatal("CGo requirement must make inventory incomplete")
	}
	if !hasBlockerCategory(analysis, "cgo") {
		t.Fatalf("missing CGo/native blocker: %#v", analysis.Blockers)
	}
}

func TestCgoEnabledUsesOnlyApprovedCompiler(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process-tree isolation intentionally fails closed on Windows")
	}
	compiler := approvedCompiler(t)
	fakeDir := t.TempDir()
	marker := filepath.Join(t.TempDir(), "ambient-cc-ran")
	fakeCC := filepath.Join(fakeDir, "cc")
	if err := os.WriteFile(fakeCC, []byte("#!/bin/sh\n: > "+strconv.Quote(marker)+"\nexit 99\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fakeDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	profile := testProfile()
	profile.CGOEnabled = true
	profile.CCompiler = compiler
	analysis, complete, err := analyze(t.Context(), copyFixture(t, "cgo"), t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if !complete || !analysis.InventoryComplete {
		t.Fatalf("approved C compiler did not complete inventory: %#v", analysis.Blockers)
	}
	if err := validateAnalysis(analysis); err != nil {
		t.Fatal(err)
	}
	hash, _, err := hashFile(compiler)
	if err != nil {
		t.Fatal(err)
	}
	if analysis.Toolchain.CCompilerName != filepath.Base(compiler) || analysis.Toolchain.CCompilerSHA256 != hash {
		t.Fatalf("C compiler provenance mismatch: %#v", analysis.Toolchain)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("ambient C compiler ran or marker check failed: %v", err)
	}
	data, err := marshalCanonical(analysis)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte(compiler)) || bytes.Contains(data, []byte(fakeDir)) {
		t.Fatal("analysis leaked an absolute compiler path")
	}
}

func TestPkgConfigDirectiveFailsClosedWithoutExecutingSibling(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("controlled executable fixture")
	}
	dir := t.TempDir()
	compiler := filepath.Join(dir, "cc")
	if err := os.Symlink(approvedCompiler(t), compiler); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "pkg-config-ran")
	if err := os.WriteFile(filepath.Join(dir, "pkg-config"), []byte("#!/bin/sh\n: > "+strconv.Quote(marker)+"\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	profile := testProfile()
	profile.CGOEnabled = true
	profile.CCompiler = compiler
	analysis, complete, err := analyze(t.Context(), copyFixture(t, "pkgconfig"), t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "pkg-config") {
		t.Fatalf("pkg-config requirement did not fail closed: %#v", analysis.Blockers)
	}
	if !slices.ContainsFunc(analysis.Diagnostics, func(diagnostic DiagnosticRecord) bool {
		return strings.Contains(diagnostic.Message, "<disabled-pkg-config>")
	}) {
		t.Fatalf("pkg-config loader failure was not recorded safely: %#v", analysis.Diagnostics)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("unapproved sibling pkg-config ran or marker check failed: %v", err)
	}
	data, err := marshalCanonical(analysis)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte(".go2gs-work")) || bytes.Contains(data, []byte("blocked-tools")) {
		t.Fatal("pkg-config sentinel path leaked into the semantic artifact")
	}
}

func TestInactivePkgConfigDirectiveDoesNotBlock(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process-tree isolation intentionally fails closed on Windows")
	}
	root := copyFixture(t, "pkgconfig")
	path := filepath.Join(root, "pkgconfig.go")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = bytes.Replace(data, []byte("#cgo pkg-config:"), []byte("#cgo windows pkg-config:"), 1)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	profile := testProfile()
	profile.CGOEnabled = true
	profile.CCompiler = approvedCompiler(t)
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if !complete || !analysis.InventoryComplete || hasBlockerCategory(analysis, "pkg-config") {
		t.Fatalf("inactive pkg-config directive blocked inventory: %#v", analysis.Blockers)
	}
}

func TestCgoPkgConfigConstraintsUseSelectedGo(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process-tree isolation intentionally fails closed on Windows")
	}
	active := []string{"unix", runtime.GOOS, runtime.GOARCH, "gc", "go2gs_selected", currentReleaseTag()}
	switch runtime.GOARCH {
	case "amd64":
		active = append(active, "amd64.v1")
	case "arm64":
		active = append(active, "arm64.v8.0")
	}
	for _, constraint := range active {
		t.Run("active-"+constraint, func(t *testing.T) {
			analysis, complete := analyzePkgConfigConstraint(t, constraint)
			if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "pkg-config") {
				t.Fatalf("selected Go did not activate %q: %#v", constraint, analysis.Blockers)
			}
		})
	}
	for _, constraint := range []string{"!unix", "gccgo", "go2gs_unselected"} {
		t.Run("inactive-"+constraint, func(t *testing.T) {
			analysis, complete := analyzePkgConfigConstraint(t, constraint)
			if !complete || !analysis.InventoryComplete || hasBlockerCategory(analysis, "pkg-config") {
				t.Fatalf("selected Go unexpectedly activated %q: %#v", constraint, analysis.Blockers)
			}
		})
	}
}

func TestUnselectedAndBuildIgnoredCgoOrNativeDoNotBlock(t *testing.T) {
	root := copyFixture(t, "complete")
	if err := os.MkdirAll(filepath.Join(root, "unselected"), 0o755); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		filepath.Join(root, "unselected", "cgo.go"):   "package unselected\nimport \"C\"\n",
		filepath.Join(root, "unselected", "native.s"): "TEXT ·unused(SB),$0\n",
		filepath.Join(root, "ignored_cgo.go"):         "//go:build go2gs_never\n\npackage fixture\nimport \"C\"\n",
	} {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	profile := testProfile()
	profile.EntryPatterns = []string{"."}
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if !complete || hasBlockerCategory(analysis, "cgo") || hasBlockerCategory(analysis, "native") {
		t.Fatalf("unselected or build-ignored CGo/native input blocked selected package: %#v", analysis.Blockers)
	}
}

func TestAnalyzeDoesNotExecuteAmbientGit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("controlled shell executable fixture")
	}
	root, err := secureRoot(copyFixture(t, "complete"))
	if err != nil {
		t.Fatal(err)
	}
	commit := strings.Repeat("a", 40)
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte(commit+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fakeDir := t.TempDir()
	marker := filepath.Join(t.TempDir(), "ambient-git-ran")
	if err := os.WriteFile(filepath.Join(fakeDir, "git"), []byte("#!/bin/sh\n: > "+strconv.Quote(marker)+"\necho "+strings.Repeat("b", 40)+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fakeDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	profile := testProfile()
	profile.ExpectedSourceCommit = commit
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), profile)
	if err != nil || !complete {
		t.Fatalf("analysis failed: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
	}
	if analysis.Profile.ActualSourceCommit != commit {
		t.Fatalf("repository provenance was not read from .git metadata: %q", analysis.Profile.ActualSourceCommit)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("ambient git ran or marker check failed: %v", err)
	}
}

func TestAnalyzeMalformedGitMetadataFailsClosed(t *testing.T) {
	root := copyFixture(t, "complete")
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref: refs/heads/bad name\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if complete || analysis.InventoryComplete || analysis.Profile.ActualSourceCommit != "" ||
		!hasBlockerCategory(analysis, "source-metadata") || len(analysis.Packages) != 0 {
		t.Fatalf("malformed Git metadata did not fail closed: %#v", analysis)
	}
}

func TestGitMetadataReader(t *testing.T) {
	hash := strings.Repeat("a", 40)
	makeRoot := func(t *testing.T) string {
		t.Helper()
		root, err := secureRoot(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		return root
	}
	t.Run("absent", func(t *testing.T) {
		commit, err := sourceCommit(makeRoot(t))
		if err != nil || commit != "" {
			t.Fatalf("absent metadata: commit=%q err=%v", commit, err)
		}
	})
	t.Run("detached", func(t *testing.T) {
		root := makeRoot(t)
		if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte(hash+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		commit, err := sourceCommit(root)
		if err != nil || commit != hash {
			t.Fatalf("detached metadata: commit=%q err=%v", commit, err)
		}
	})
	t.Run("ordinary-ref", func(t *testing.T) {
		root := makeRoot(t)
		if err := os.MkdirAll(filepath.Join(root, ".git", "refs", "heads"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, ".git", "refs", "heads", "main"), []byte(hash+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		commit, err := sourceCommit(root)
		if err != nil || commit != hash {
			t.Fatalf("ordinary metadata: commit=%q err=%v", commit, err)
		}
	})
	t.Run("packed-ref", func(t *testing.T) {
		root := makeRoot(t)
		if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, ".git", "packed-refs"), []byte("# pack-refs with: sorted\n"+hash+" refs/heads/main\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		commit, err := sourceCommit(root)
		if err != nil || commit != hash {
			t.Fatalf("packed metadata: commit=%q err=%v", commit, err)
		}
	})
	t.Run("linked-worktree", func(t *testing.T) {
		container := makeRoot(t)
		root := filepath.Join(container, "source")
		common := filepath.Join(container, "repo.git")
		gitDir := filepath.Join(common, "worktrees", "source")
		if err := os.MkdirAll(filepath.Join(common, "refs", "heads"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(gitDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		gitPath := filepath.Join(root, ".git")
		for path, content := range map[string]string{
			gitPath:                                        "gitdir: " + gitDir + "\n",
			filepath.Join(gitDir, "HEAD"):                  "ref: refs/heads/main\n",
			filepath.Join(gitDir, "commondir"):             "../..\n",
			filepath.Join(gitDir, "gitdir"):                gitPath + "\n",
			filepath.Join(common, "refs", "heads", "main"): hash + "\n",
		} {
			if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		commit, err := sourceCommit(root)
		if err != nil || commit != hash {
			t.Fatalf("worktree metadata: commit=%q err=%v", commit, err)
		}
	})
	for _, test := range []struct {
		name    string
		prepare func(*testing.T, string)
	}{
		{"invalid-ref", func(t *testing.T, root string) {
			if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref: refs/heads/bad name\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"malformed-head", func(t *testing.T, root string) {
			if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("not-a-commit\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"malformed-packed-ref", func(t *testing.T, root string) {
			if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, ".git", "packed-refs"), []byte("not-a-hash refs/heads/main\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"oversized-head", func(t *testing.T, root string) {
			if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), bytes.Repeat([]byte("a"), 4097), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"escaping-gitdir", func(t *testing.T, root string) {
			outside := filepath.Join(filepath.Dir(root), "outside.git")
			if err := os.Mkdir(outside, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: "+outside+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := makeRoot(t)
			test.prepare(t, root)
			if commit, err := sourceCommit(root); err == nil || commit != "" {
				t.Fatalf("malformed metadata accepted: commit=%q err=%v", commit, err)
			}
		})
	}
	if runtime.GOOS != "windows" {
		t.Run("symlink-head", func(t *testing.T) {
			root := makeRoot(t)
			if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(root, "head-target")
			if err := os.WriteFile(target, []byte(hash+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, filepath.Join(root, ".git", "HEAD")); err != nil {
				t.Fatal(err)
			}
			if commit, err := sourceCommit(root); err == nil || commit != "" {
				t.Fatalf("symlinked HEAD accepted: commit=%q err=%v", commit, err)
			}
		})
	}
}

func TestGitRefValidationMatchesSecuritySubset(t *testing.T) {
	for _, value := range []string{"refs/heads/main", "refs/tags/v1.0", "refs/remotes/origin/topic"} {
		if !validGitRef(value) {
			t.Errorf("valid Git ref rejected: %q", value)
		}
	}
	for _, value := range []string{
		"heads/main", "/refs/heads/main", "refs/heads/main/", "refs//heads/main",
		"refs/heads/.hidden", "refs/heads/trailing.", "refs/heads/bad.lock",
		"refs/heads/two..dots", "refs/heads/reflog@{1}", `refs\heads\main`,
		"refs/heads/bad name", "refs/heads/bad\tname", "refs/heads/bad\x7fname",
	} {
		if validGitRef(value) {
			t.Errorf("invalid Git ref accepted: %q", value)
		}
	}
}

func TestPackedGitReferenceValidatesWholeFile(t *testing.T) {
	a := strings.Repeat("a", 40)
	b := strings.Repeat("b", 40)
	c := strings.Repeat("c", 40)
	long := strings.Repeat("d", 64)
	tests := []struct {
		name      string
		content   string
		ref       string
		want      string
		wantError bool
	}{
		{"ordinary", a + " refs/heads/main\n", "refs/heads/main", a, false},
		{"recognized-header", "# pack-refs with: peeled fully-peeled sorted \n" + a + " refs/heads/main\n", "refs/heads/main", a, false},
		{"arbitrary-comment", "# arbitrary\n" + a + " refs/heads/main\n", "refs/heads/main", "", true},
		{"generated-comment", "# generated by git\n" + a + " refs/heads/main\n", "refs/heads/main", "", true},
		{"unknown-header-trait", "# pack-refs with: unknown\n" + a + " refs/heads/main\n", "refs/heads/main", "", true},
		{"empty-header", "# pack-refs with: \n" + a + " refs/heads/main\n", "refs/heads/main", "", true},
		{"multiple-headers", "# pack-refs with: peeled\n# pack-refs with: sorted\n" + a + " refs/heads/main\n", "refs/heads/main", "", true},
		{"annotated-tag-peel", a + " refs/tags/v1\n^" + b + "\n", "refs/tags/v1", a, false},
		{"custom-namespace-peel", a + " refs/custom/release\n^" + b + "\n", "refs/custom/release", a, false},
		{"orphan-peel", "^" + b + "\n" + a + " refs/heads/main\n", "refs/heads/main", "", true},
		{"consecutive-peel", a + " refs/tags/v1\n^" + b + "\n^" + c + "\n", "refs/tags/v1", "", true},
		{"unterminated-record", a + " refs/heads/main", "refs/heads/main", "", true},
		{"mixed-ref-width", a + " refs/heads/main\n" + long + " refs/heads/other\n", "refs/heads/main", "", true},
		{"mixed-peel-width", a + " refs/tags/v1\n^" + long + "\n", "refs/tags/v1", "", true},
		{"crlf-record", a + " refs/heads/main\r\n", "refs/heads/main", "", true},
		{"blank-before-ref", "\n" + a + " refs/heads/main\n", "refs/heads/main", "", true},
		{"blank-after-ref", a + " refs/heads/main\n\n", "refs/heads/main", "", true},
		{"comment-after-ref", a + " refs/heads/main\n# trailing comment\n", "refs/heads/main", "", true},
		{"header-after-ref", a + " refs/heads/main\n# pack-refs with: sorted\n", "refs/heads/main", "", true},
		{"malformed-before-match", "bad\n" + a + " refs/heads/main\n", "refs/heads/main", "", true},
		{"malformed-after-match", a + " refs/heads/main\nbad\n", "refs/heads/main", "", true},
		{"duplicate-ref", a + " refs/heads/main\n" + b + " refs/heads/main\n", "refs/heads/main", "", true},
		{"declared-sorted-order", "# pack-refs with: sorted\n" + b + " refs/heads/z\n" + a + " refs/heads/a\n", "refs/heads/a", "", true},
		{"undeclared-unsorted-order", b + " refs/heads/z\n" + a + " refs/heads/a\n", "refs/heads/a", a, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "packed-refs")
			if err := os.WriteFile(path, []byte(test.content), 0o644); err != nil {
				t.Fatal(err)
			}
			got, found, err := packedGitReference(path, test.ref)
			if test.wantError {
				if err == nil || found || got != "" {
					t.Fatalf("malformed packed refs accepted: got=%q found=%v err=%v", got, found, err)
				}
				return
			}
			if err != nil || !found || got != test.want {
				t.Fatalf("packed ref mismatch: got=%q found=%v err=%v", got, found, err)
			}
		})
	}
}

func analyzePkgConfigConstraint(t *testing.T, constraint string) (Analysis, bool) {
	t.Helper()
	root := copyFixture(t, "pkgconfig")
	path := filepath.Join(root, "pkgconfig.go")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = bytes.Replace(data, []byte("#cgo pkg-config:"), []byte("#cgo "+constraint+" pkg-config:"), 1)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	profile := testProfile()
	profile.CGOEnabled = true
	profile.CCompiler = approvedCompiler(t)
	profile.BuildTags = []string{"go2gs_selected"}
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	return analysis, complete
}

func currentReleaseTag() string {
	version := strings.TrimPrefix(runtime.Version(), "go")
	parts := strings.Split(version, ".")
	if len(parts) < 2 {
		return "go1"
	}
	return "go" + parts[0] + "." + parts[1]
}

func TestReadBoundedRegularFileRejectsGrowthAndReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "HEAD")
	if err := os.WriteFile(path, []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readBoundedRegularFileAfterOpen(path, 2, func() {
		file, openErr := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if openErr != nil {
			t.Fatal(openErr)
		}
		if _, writeErr := file.WriteString("overflow"); writeErr != nil {
			t.Fatal(writeErr)
		}
		if closeErr := file.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
	}); err == nil {
		t.Fatal("file growth beyond the bound was accepted")
	}
	original := filepath.Join(filepath.Dir(path), "original")
	if err := os.WriteFile(path, []byte("same"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readBoundedRegularFileWithHooks(path, 4, func() {
		if renameErr := os.Rename(path, original); renameErr != nil {
			t.Fatal(renameErr)
		}
		if writeErr := os.WriteFile(path, []byte("size"), 0o644); writeErr != nil {
			t.Fatal(writeErr)
		}
	}, nil); err == nil {
		t.Fatal("same-size regular-file replacement before open was accepted")
	}
	if runtime.GOOS == "windows" {
		return
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("inside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readBoundedRegularFileAfterOpen(path, 64, func() {
		if removeErr := os.Remove(path); removeErr != nil {
			t.Fatal(removeErr)
		}
		if symlinkErr := os.Symlink(outside, path); symlinkErr != nil {
			t.Fatal(symlinkErr)
		}
	}); err == nil {
		t.Fatal("path replacement with an outside symlink was accepted")
	}
}

func TestNativeRequirementIsIncomplete(t *testing.T) {
	root := copyFixture(t, "native")
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "native") {
		t.Fatalf("native requirement was not reported as incomplete: %#v", analysis.Blockers)
	}
	if !slices.ContainsFunc(analysis.Files, func(file FileRecord) bool { return file.Native && file.Role == "native" }) {
		t.Fatal("native input provenance was not recorded")
	}
}

func TestToolchainMismatchFailsClosedBeforeLoading(t *testing.T) {
	profile := testProfile()
	profile.RequestedGoVersion = "1.26.6"
	analysis, complete, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if complete || len(analysis.Packages) != 0 || !hasBlockerCategory(analysis, "toolchain") {
		t.Fatalf("toolchain mismatch was not fail-closed: %#v", analysis)
	}
}

func TestSchemaValidationRejectsUnknownRequiredKindAndDanglingID(t *testing.T) {
	analysis := validIncompleteAnalysis()
	analysis.Schema.RequiredRecordKinds = append(analysis.Schema.RequiredRecordKinds, "future-required")
	if err := validateAnalysis(analysis); err == nil || !strings.Contains(err.Error(), "unknown required") {
		t.Fatalf("expected unknown required kind rejection, got %v", err)
	}
	analysis = validIncompleteAnalysis()
	analysis.Packages = []PackageRecord{{
		ID: "package:1", ImportPath: "example.com/test", Name: "test", Variant: "ordinary",
		FileIDs: []string{}, CompiledFileIDs: []string{}, ImportPackageIDs: []string{"package:missing"},
		InitializationOrder: []InitializationRecord{}, DiagnosticIDs: []string{},
	}}
	analysis.RecordCounts.Packages = 1
	analysis.RecordCounts.Total++
	if err := validateAnalysis(analysis); err == nil || !strings.Contains(err.Error(), "dangling") {
		t.Fatalf("expected dangling id rejection, got %v", err)
	}
	analysis = validIncompleteAnalysis()
	analysis.Schema.RequiredRecordKinds = nil
	if err := validateAnalysis(analysis); err == nil || !strings.Contains(err.Error(), "handshake") {
		t.Fatalf("expected exact handshake rejection, got %v", err)
	}
	analysis = validIncompleteAnalysis()
	analysis.Blockers = append(analysis.Blockers, analysis.Blockers[0])
	analysis.RecordCounts.Blockers++
	analysis.RecordCounts.Total++
	if err := validateAnalysis(analysis); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("expected duplicate id rejection, got %v", err)
	}
}

func TestProfileValidationAndResourceLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile.json")
	if err := os.WriteFile(path, []byte(`{"schema":{"name":"go2gs.profile","version":99}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readProfile(path); err == nil || !strings.Contains(err.Error(), "unsupported profile") {
		t.Fatalf("expected profile version rejection, got %v", err)
	}
	profile := testProfile()
	profile.WorkspaceMode = "explicit"
	data, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readProfile(path); err == nil || !strings.Contains(err.Error(), "workspaceMode=off") {
		t.Fatalf("expected unsupported workspace rejection, got %v", err)
	}
	profile.WorkspaceMode = "off"
	profile.CGOEnabled = true
	data, err = json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readProfile(path); err == nil || !strings.Contains(err.Error(), "cCompiler") {
		t.Fatalf("expected missing C compiler rejection, got %v", err)
	}
	profile.CCompiler = "cc"
	data, err = json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readProfile(path); err == nil || !strings.Contains(err.Error(), "absolute cCompiler") {
		t.Fatalf("expected relative C compiler rejection, got %v", err)
	}
	for _, compiler := range []string{
		filepath.Join(t.TempDir(), "bad compiler"),
		filepath.Join(t.TempDir(), `'bad'`),
		filepath.Join(t.TempDir(), "bad\ncompiler"),
	} {
		profile.CCompiler = compiler
		data, err = json.Marshal(profile)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := readProfile(path); err == nil || !strings.Contains(err.Error(), "cCompiler") {
			t.Fatalf("expected ambiguous C compiler %q rejection, got %v", compiler, err)
		}
	}
	profile.CGOEnabled = false
	profile.CCompiler = ""
	profile.Limits.MaxPackages = 1
	if _, _, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), profile); err == nil || !strings.Contains(err.Error(), "package count") {
		t.Fatalf("expected package limit rejection, got %v", err)
	}
}

func approvedCompiler(t *testing.T) string {
	t.Helper()
	for _, candidate := range []string{"/usr/bin/cc", "/usr/bin/clang", "/usr/bin/gcc"} {
		path, _, err := resolveCCompiler(Profile{CGOEnabled: true, CCompiler: candidate})
		if err == nil {
			return path
		}
	}
	t.Skip("no approved compiler found in fixed system locations")
	return ""
}

func TestAnalysisJSONRoundTripRejectsUnknownFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "analysis.json")
	if err := os.WriteFile(path, []byte(`{"schema":{"name":"go2gs.analysis","version":1},"unexpected":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readAnalysis(path); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected unknown field rejection, got %v", err)
	}
}

func TestProfileRejectsTrailingJSONValues(t *testing.T) {
	profile, err := json.Marshal(testProfile())
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{` {}`, ` 1`, "\nnull"} {
		path := filepath.Join(t.TempDir(), "profile.json")
		if err := os.WriteFile(path, append(profile, suffix...), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := readProfile(path); err == nil || !strings.Contains(err.Error(), "trailing") {
			t.Fatalf("trailing JSON %q was accepted: %v", suffix, err)
		}
	}
}

func TestMissingGoBootstrapProducesNoArtifact(t *testing.T) {
	root := copyFixture(t, "complete")
	profilePath := filepath.Join(t.TempDir(), "profile.json")
	data, err := json.Marshal(testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(profilePath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := secureRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "")
	err = runAnalyze(t.Context(), []string{"--source", root, "--profile", profilePath, "--out", out})
	var exitErr *exitError
	if !errors.As(err, &exitErr) || exitErr.code != 2 {
		t.Fatalf("missing Go bootstrap should exit 2, got %v", err)
	}
	for _, name := range []string{"analysis.json", "run.json"} {
		if _, statErr := os.Stat(filepath.Join(out, name)); !os.IsNotExist(statErr) {
			t.Fatalf("bootstrap failure unexpectedly wrote %s: %v", name, statErr)
		}
	}
}

func TestAtomicWriteDoesNotFollowPredictableSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("controlled symlink fixture")
	}
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("safe"), 0o644); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "analysis.json")
	for _, attacker := range []string{
		filepath.Join(dir, ".analysis.json.staged"),
		filepath.Join(dir, ".analysis.json.staged-attacker"),
		path,
	} {
		if err := os.Symlink(outside, attacker); err != nil {
			t.Fatal(err)
		}
	}
	if err := atomicWrite(path, []byte("inventory"), 0o644); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "safe" {
		t.Fatalf("outside symlink target changed: %q, %v", data, err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "inventory" {
		t.Fatalf("atomic output mismatch: %q, %v", data, err)
	}
}

func TestAtomicWriteRejectsStagedAndFinalPathReplacement(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("controlled symlink fixture")
	}
	for _, attack := range []string{"staged", "final"} {
		t.Run(attack, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "analysis.json")
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.WriteFile(outside, []byte("safe"), 0o644); err != nil {
				t.Fatal(err)
			}
			var displaced string
			replace := func(target string) {
				displaced = target + ".attacker-moved"
				if err := os.Rename(target, displaced); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, target); err != nil {
					t.Fatal(err)
				}
			}
			var before, after func(string)
			if attack == "staged" {
				before = replace
			} else {
				after = replace
			}
			err := atomicWriteWithHooks(path, bytes.Repeat([]byte("x"), 1<<20), 0o644, before, after)
			if err == nil {
				t.Fatal("pathname replacement was accepted")
			}
			if info, statErr := os.Lstat(path); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
				t.Fatal("failed atomic write left a final symlink")
			}
			if data, readErr := os.ReadFile(outside); readErr != nil || string(data) != "safe" {
				t.Fatalf("outside target changed: %q, %v", data, readErr)
			}
			_ = os.Remove(displaced)
			if matches, _ := filepath.Glob(filepath.Join(dir, ".analysis.json.staged-*")); len(matches) != 0 {
				t.Fatalf("staged entries were not cleaned up: %v", matches)
			}
		})
	}
}

func TestImmutableInputSnapshotDetectsLoadTimeDrift(t *testing.T) {
	cases := []struct {
		name   string
		path   string
		mutate func(*testing.T, string)
	}{
		{"go-change", "main.go", func(t *testing.T, path string) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			data = bytes.Replace(data, []byte("ContextualInt int64 = 7"), []byte("ContextualInt int64 = 8"), 1)
			if err := os.WriteFile(path, data, 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"embed-change", "assets/visible.txt", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("changed"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"embed-delete", "assets/visible.txt", func(t *testing.T, path string) {
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}},
		{"embed-replace", "assets/visible.txt", func(t *testing.T, path string) {
			replacement := path + ".replacement"
			if err := os.WriteFile(replacement, []byte("replacement"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(replacement, path); err != nil {
				t.Fatal(err)
			}
		}},
		{"go-add", "added.go", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("package fixture\nconst Added = 1\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			root := copyFixture(t, "complete")
			path := filepath.Join(root, filepath.FromSlash(test.path))
			original, readErr := os.ReadFile(path)
			if readErr != nil && test.name != "go-add" {
				t.Fatal(readErr)
			}
			analysis, complete, err := analyzeWithSnapshotHook(t.Context(), root, t.TempDir(), testProfile(), func() {
				test.mutate(t, path)
			})
			if err != nil {
				t.Fatal(err)
			}
			if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "input-drift") {
				t.Fatalf("load-time drift was not fail-closed: complete=%v blockers=%#v", complete, analysis.Blockers)
			}
			if strings.HasPrefix(test.name, "embed-") {
				index := slices.IndexFunc(analysis.Files, func(file FileRecord) bool {
					return file.Path == "source://assets/visible.txt"
				})
				if index < 0 {
					t.Fatal("captured embed input missing")
				}
				data, decodeErr := base64.StdEncoding.DecodeString(analysis.Files[index].ContentBase64)
				if decodeErr != nil || !bytes.Equal(data, original) {
					t.Fatalf("inventory did not use captured embed bytes: %q, %v", data, decodeErr)
				}
			}
			if test.name == "go-add" && slices.ContainsFunc(analysis.Files, func(file FileRecord) bool {
				return file.Path == "source://added.go"
			}) {
				t.Fatal("uncaptured added source was emitted")
			}
		})
	}

	root := copyFixture(t, "native")
	nativePath := filepath.Join(root, "native.s")
	originalNative, err := os.ReadFile(nativePath)
	if err != nil {
		t.Fatal(err)
	}
	profile := testProfile()
	profile.CGOEnabled = true
	profile.CCompiler = approvedCompiler(t)
	analysis, _, err := analyzeWithSnapshotHook(t.Context(), root, t.TempDir(), profile, func() {
		if writeErr := os.WriteFile(nativePath, []byte("changed"), 0o644); writeErr != nil {
			t.Fatal(writeErr)
		}
	})
	if err != nil || !hasBlockerCategory(analysis, "input-drift") {
		t.Fatalf("native input drift was not detected: err=%v blockers=%#v", err, analysis.Blockers)
	}
	index := slices.IndexFunc(analysis.Files, func(file FileRecord) bool { return file.Path == "source://native.s" })
	if index < 0 {
		t.Fatal("captured native input missing")
	}
	nativeData, err := base64.StdEncoding.DecodeString(analysis.Files[index].ContentBase64)
	if err != nil || !bytes.Equal(nativeData, originalNative) {
		t.Fatalf("inventory did not use captured native bytes: %q, %v", nativeData, err)
	}
}

func TestScopedTypeAndMemberIdentitiesAreDistinct(t *testing.T) {
	analyzeRoot := func(root string) Analysis {
		t.Helper()
		path := filepath.Join(root, "main.go")
		file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		_, err = file.WriteString(`
func GenericInt[T ~int](value T) { type Local int; var _ Local }
func GenericString[T ~string](value T) { type Local int; var _ Local }
`)
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			t.Fatal(err)
		}
		analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
		if err != nil || !complete {
			t.Fatalf("identity fixture failed: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
		}
		return analysis
	}
	first := analyzeRoot(copyFixture(t, "complete"))
	second := analyzeRoot(copyFixture(t, "complete"))
	left, _ := marshalCanonical(first)
	right, _ := marshalCanonical(second)
	if !bytes.Equal(left, right) {
		t.Fatalf("scoped type identities differ by root near: %s", firstDifference(string(left), string(right)))
	}
	typeParameters, locals := map[string]bool{}, map[string]bool{}
	for _, record := range first.Types {
		if record.Display == "T" && (record.Constraint == "~int" || record.Constraint == "~string") {
			typeParameters[record.ID] = true
		}
		if record.Name == "Local" {
			locals[record.ID] = true
		}
	}
	if len(typeParameters) != 2 || len(locals) != 2 {
		t.Fatalf("scoped type identities collided: typeParameters=%v locals=%v", typeParameters, locals)
	}

	dependency := types.NewPackage("example.com/dependency", "dependency")
	consumer := &packages.Package{PkgPath: "example.com/consumer", Fset: token.NewFileSet()}
	identityAnalysis := validIncompleteAnalysis()
	builder := newInventoryBuilder(&identityAnalysis, "", "", testProfile())
	builder.packageIDs[consumer] = "package:consumer"
	builder.packagePathIDs[dependency.Path()] = "package:dependency"
	fieldA := types.NewField(token.NoPos, dependency, "X", types.Typ[types.Int], false)
	fieldB := types.NewField(token.NoPos, dependency, "X", types.Typ[types.Int], false)
	fieldIDA := builder.addObjectWithFallback(consumer, fieldA, SourceSpan{}, "selection\x00example.com/dependency.A\x000")
	fieldIDB := builder.addObjectWithFallback(consumer, fieldB, SourceSpan{}, "selection\x00example.com/dependency.B\x000")
	if fieldIDA == fieldIDB {
		t.Fatal("same-name imported fields collided")
	}
	namedA := types.NewNamed(types.NewTypeName(token.NoPos, dependency, "A", nil), types.NewStruct(nil, nil), nil)
	namedB := types.NewNamed(types.NewTypeName(token.NoPos, dependency, "B", nil), types.NewStruct(nil, nil), nil)
	method := func(receiver types.Type) *types.Func {
		signature := types.NewSignatureType(types.NewVar(token.NoPos, dependency, "", receiver), nil, nil, types.NewTuple(), types.NewTuple(), false)
		return types.NewFunc(token.NoPos, dependency, "M", signature)
	}
	methodIDA := builder.addObject(consumer, method(namedA), SourceSpan{})
	methodIDB := builder.addObject(consumer, method(namedB), SourceSpan{})
	if methodIDA == methodIDB {
		t.Fatal("same-name imported methods collided")
	}
}

func TestPromotedMemberIdentityUsesImportedDeclaration(t *testing.T) {
	analyzeFixture := func(reverse bool) Analysis {
		t.Helper()
		root := t.TempDir()
		files := map[string]string{
			"go.mod": "module example.com/members\n\ngo 1.27.0\n",
			"dep/dep.go": `package dep
type A struct{ X int }
func (A) M() {}
type B struct{ X int }
func (B) M() {}
type E struct{ A }
`,
		}
		if reverse {
			files["main.go"] = `package members
import "example.com/members/dep"
type Right struct{ dep.E }
type Left struct{ dep.E }
func use(right Right, left Left, b dep.B) { _, _, _ = right.X, left.X, b.X; right.M(); left.M(); b.M(); _, _ = right.A, left.A }
`
		} else {
			files["main.go"] = `package members
import "example.com/members/dep"
type Left struct{ dep.E }
type Right struct{ dep.E }
func use(left Left, right Right, b dep.B) { _, _, _ = left.X, right.X, b.X; left.M(); right.M(); b.M(); _, _ = left.A, right.A }
`
		}
		for name, content := range files {
			path := filepath.Join(root, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
		if err != nil || !complete {
			t.Fatalf("member fixture failed: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
		}
		return analysis
	}
	memberIDs := func(analysis Analysis) map[string][]string {
		names := map[string]string{}
		for _, symbol := range analysis.Symbols {
			if symbol.Name == "X" || symbol.Name == "M" || symbol.Name == "A" {
				names[symbol.ID] = symbol.Name
			}
		}
		result := map[string][]string{}
		for _, selection := range analysis.Selections {
			if name := names[selection.ObjectID]; name != "" {
				result[name] = append(result[name], selection.ObjectID)
			}
		}
		for name := range result {
			sort.Strings(result[name])
			result[name] = slices.Compact(result[name])
		}
		return result
	}
	first := memberIDs(analyzeFixture(false))
	second := memberIDs(analyzeFixture(true))
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("member identities depend on consumer order: first=%v second=%v", first, second)
	}
	if len(first["X"]) != 2 || len(first["M"]) != 2 || len(first["A"]) != 1 {
		t.Fatalf("declaration identities were not reused or distinguished: %v", first)
	}

	dependency := types.NewPackage("example.com/dependency", "dependency")
	field := types.NewField(token.NoPos, dependency, "X", types.Typ[types.Int], false)
	typeName := types.NewTypeName(token.NoPos, dependency, "A", nil)
	named := types.NewNamed(typeName, types.NewStruct([]*types.Var{field}, nil), nil)
	dependency.Scope().Insert(typeName)
	method := types.NewFunc(token.NoPos, dependency, "M", types.NewSignatureType(
		types.NewVar(token.NoPos, dependency, "", named), nil, nil, types.NewTuple(), types.NewTuple(), false))
	named.AddMethod(method)
	dependencyPackage := &packages.Package{PkgPath: dependency.Path(), Types: dependency, Fset: token.NewFileSet()}
	consumer := &packages.Package{PkgPath: "example.com/consumer", Types: types.NewPackage("example.com/consumer", "consumer"), Fset: token.NewFileSet()}
	traversalIDs := func(declarationFirst bool) []string {
		analysis := validIncompleteAnalysis()
		builder := newInventoryBuilder(&analysis, "", "", testProfile())
		builder.indexPackages([]*packages.Package{consumer, dependencyPackage})
		add := func(object types.Object) string {
			if declarationFirst {
				builder.addObject(dependencyPackage, object, SourceSpan{Path: "module://example.com/dependency@local/dep.go", StartByte: 10})
			}
			id := builder.addObjectWithFallback(consumer, object, SourceSpan{}, "consumer-selection")
			if !declarationFirst {
				builder.addObject(dependencyPackage, object, SourceSpan{Path: "module://example.com/dependency@local/dep.go", StartByte: 10})
			}
			return id
		}
		return []string{add(field), add(method)}
	}
	if early, late := traversalIDs(true), traversalIDs(false); !slices.Equal(early, late) {
		t.Fatalf("member identities depend on package traversal: declaration-first=%v consumer-first=%v", early, late)
	}
}

func TestValidateAnalysisCommandRejectsSchemaOnlyAndAcceptsIncomplete(t *testing.T) {
	path := filepath.Join(t.TempDir(), "analysis.json")
	if err := os.WriteFile(path, []byte(`{"schema":{"name":"go2gs.analysis","version":1}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	var exitErr *exitError
	err := runValidate([]string{"--analysis", path})
	if !errors.As(err, &exitErr) || exitErr.code != 2 {
		t.Fatalf("schema-only artifact should exit 2, got %v", err)
	}
	if err := writeJSON(path, validIncompleteAnalysis(), 1<<20); err != nil {
		t.Fatal(err)
	}
	if err := runValidate([]string{"--analysis", path}); err != nil {
		t.Fatalf("valid incomplete inventory was rejected: %v", err)
	}
	mismatch := validIncompleteAnalysis()
	mismatch.Toolchain.ActualVersion = "different"
	mismatch.Blockers[0].Category = "toolchain"
	if err := writeJSON(path, mismatch, 1<<20); err != nil {
		t.Fatal(err)
	}
	if err := runValidate([]string{"--analysis", path}); err != nil {
		t.Fatalf("valid incomplete toolchain mismatch was rejected: %v", err)
	}
	invalid := validIncompleteAnalysis()
	invalid.RecordCounts.Total = 0
	if err := writeJSON(path, invalid, 1<<20); err != nil {
		t.Fatal(err)
	}
	err = runValidate([]string{"--analysis", path})
	if !errors.As(err, &exitErr) || exitErr.code != 2 {
		t.Fatalf("count mismatch should exit 2, got %v", err)
	}
	invalid = validIncompleteAnalysis()
	invalid.Packages = nil
	if err := writeJSON(path, invalid, 1<<20); err != nil {
		t.Fatal(err)
	}
	err = runValidate([]string{"--analysis", path})
	if !errors.As(err, &exitErr) || exitErr.code != 2 {
		t.Fatalf("null collection should exit 2, got %v", err)
	}
	validData, err := marshalCanonical(validIncompleteAnalysis())
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(validData, &raw); err != nil {
		t.Fatal(err)
	}
	delete(raw["blockers"].([]any)[0].(map[string]any), "diagnosticIds")
	missingField, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, missingField, 0o644); err != nil {
		t.Fatal(err)
	}
	err = runValidate([]string{"--analysis", path})
	if !errors.As(err, &exitErr) || exitErr.code != 2 {
		t.Fatalf("missing record field should exit 2, got %v", err)
	}
}

func TestModuleRecordCountsRejectAddedAndRemovedRecords(t *testing.T) {
	analysis, complete, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), testProfile())
	if err != nil || !complete {
		t.Fatalf("fixture analysis failed: complete=%v err=%v", complete, err)
	}
	added := analysis
	added.Modules = append(append([]ModuleRecord{}, analysis.Modules...), ModuleRecord{
		ID: "module:added", Path: "example.com/added",
	})
	if err := validateAnalysis(added); err == nil || !strings.Contains(err.Error(), "recordCounts") {
		t.Fatalf("adding a module without updating counts was accepted: %v", err)
	}
	removed := analysis
	removedID := analysis.Modules[0].ID
	removed.Modules = append([]ModuleRecord{}, analysis.Modules[1:]...)
	for i := range removed.Packages {
		if removed.Packages[i].ModuleID == removedID {
			removed.Packages[i].ModuleID = ""
		}
	}
	for i := range removed.Modules {
		if removed.Modules[i].ReplacementID == removedID {
			removed.Modules[i].ReplacementID = ""
		}
	}
	if err := validateAnalysis(removed); err == nil || !strings.Contains(err.Error(), "recordCounts") {
		t.Fatalf("removing a module without updating counts was accepted: %v", err)
	}
}

func TestValidateAnalysisCommandRejectsMalformedNestedRecords(t *testing.T) {
	analysis, complete, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if !complete {
		t.Fatal("fixture inventory incomplete")
	}
	valid, err := marshalCanonical(analysis)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(map[string]any) bool
	}{
		{"struct-field-type", func(root map[string]any) bool {
			for _, item := range root["types"].([]any) {
				fields := item.(map[string]any)["fields"].([]any)
				if len(fields) > 0 {
					delete(fields[0].(map[string]any), "typeId")
					return true
				}
			}
			return false
		}},
		{"partial-node-span", func(root map[string]any) bool {
			nodes := root["nodes"].([]any)
			nodes[0].(map[string]any)["span"] = map[string]any{"path": "source://main.go"}
			return true
		}},
		{"init-function-location", func(root map[string]any) bool {
			for _, item := range root["packages"].([]any) {
				for _, raw := range item.(map[string]any)["initializationOrder"].([]any) {
					initialization := raw.(map[string]any)
					if initialization["kind"] == "init-function" {
						delete(initialization, "fileId")
						delete(initialization, "nodeId")
						return true
					}
				}
			}
			return false
		}},
		{"struct-field-export-metadata", func(root map[string]any) bool {
			for _, item := range root["types"].([]any) {
				fields := item.(map[string]any)["fields"].([]any)
				if len(fields) > 0 {
					delete(fields[0].(map[string]any), "exported")
					return true
				}
			}
			return false
		}},
		{"declared-constant-symbol-link", func(root map[string]any) bool {
			for _, item := range root["constants"].([]any) {
				constant := item.(map[string]any)
				if _, ok := constant["symbolId"]; ok {
					delete(constant, "symbolId")
					return true
				}
			}
			return false
		}},
		{"node-span-outside-file", func(root map[string]any) bool {
			root["nodes"].([]any)[0].(map[string]any)["span"].(map[string]any)["endByte"] = 1_000_000_000
			return true
		}},
		{"node-span-wrong-file", func(root map[string]any) bool {
			node := root["nodes"].([]any)[0].(map[string]any)
			fileID := node["fileId"].(string)
			current := node["span"].(map[string]any)["path"].(string)
			for _, raw := range root["files"].([]any) {
				file := raw.(map[string]any)
				if file["id"] != fileID && strings.HasPrefix(file["path"].(string), "source://") &&
					file["path"].(string) != current {
					node["span"].(map[string]any)["path"] = file["path"]
					return true
				}
			}
			return false
		}},
		{"file-package-owner", func(root map[string]any) bool {
			file := root["files"].([]any)[0].(map[string]any)
			owner := file["packageId"].(string)
			for _, raw := range root["packages"].([]any) {
				pkg := raw.(map[string]any)
				if pkg["id"].(string) != owner {
					file["packageId"] = pkg["id"]
					return true
				}
			}
			return false
		}},
		{"absolute-scheme-payload", func(root map[string]any) bool {
			root["nodes"].([]any)[0].(map[string]any)["span"].(map[string]any)["path"] = "source:///etc/passwd"
			return true
		}},
		{"raw-line-coordinate", func(root map[string]any) bool {
			span := root["nodes"].([]any)[0].(map[string]any)["span"].(map[string]any)
			span["startLine"] = span["startLine"].(float64) + 1
			return true
		}},
		{"module-count-add", func(root map[string]any) bool {
			root["modules"] = append(root["modules"].([]any), map[string]any{
				"id": "module:added", "path": "example.com/added", "main": false,
			})
			return true
		}},
		{"module-count-remove", func(root map[string]any) bool {
			modules := root["modules"].([]any)
			if len(modules) == 0 {
				return false
			}
			removedID := modules[0].(map[string]any)["id"]
			root["modules"] = modules[1:]
			for _, raw := range root["packages"].([]any) {
				pkg := raw.(map[string]any)
				if pkg["moduleId"] == removedID {
					delete(pkg, "moduleId")
				}
			}
			for _, raw := range root["modules"].([]any) {
				module := raw.(map[string]any)
				if module["replacementId"] == removedID {
					delete(module, "replacementId")
				}
			}
			return true
		}},
		{"initialization-package-owner", func(root map[string]any) bool {
			files := root["files"].([]any)
			for _, packageValue := range root["packages"].([]any) {
				pkg := packageValue.(map[string]any)
				for _, raw := range pkg["initializationOrder"].([]any) {
					initialization := raw.(map[string]any)
					if initialization["kind"] != "init-function" {
						continue
					}
					for _, fileValue := range files {
						file := fileValue.(map[string]any)
						if file["packageId"] != pkg["id"] {
							initialization["fileId"] = file["id"]
							return true
						}
					}
				}
			}
			return false
		}},
		{"package-lists-foreign-file", func(root map[string]any) bool {
			packages := root["packages"].([]any)
			for _, leftValue := range packages {
				left := leftValue.(map[string]any)
				leftFiles := left["fileIds"].([]any)
				if len(leftFiles) == 0 {
					continue
				}
				for _, rightValue := range packages {
					right := rightValue.(map[string]any)
					rightFiles := right["fileIds"].([]any)
					if right["id"] != left["id"] && len(rightFiles) > 0 {
						left["fileIds"] = append(leftFiles, rightFiles[0])
						return true
					}
				}
			}
			return false
		}},
		{"complete-with-incomplete-package", func(root map[string]any) bool {
			root["packages"].([]any)[0].(map[string]any)["inventoryComplete"] = false
			return true
		}},
		{"module-mode-invalid", func(root map[string]any) bool {
			root["profile"].(map[string]any)["moduleMode"] = "mod"
			return true
		}},
		{"module-mode-empty", func(root map[string]any) bool {
			root["profile"].(map[string]any)["moduleMode"] = ""
			return true
		}},
		{"module-mode-vendor-mismatch", func(root map[string]any) bool {
			profile := root["profile"].(map[string]any)
			profile["moduleMode"] = "readonly"
			profile["vendorMode"] = true
			return true
		}},
		{"complete-toolchain-version-mismatch", func(root map[string]any) bool {
			root["toolchain"].(map[string]any)["actualVersion"] = "different"
			return true
		}},
		{"manifest-absolute-path", func(root map[string]any) bool {
			root["manifests"].([]any)[0].(map[string]any)["path"] = "/etc/passwd"
			return true
		}},
		{"manifest-traversal-path", func(root map[string]any) bool {
			root["manifests"].([]any)[0].(map[string]any)["path"] = "source://../go.mod"
			return true
		}},
		{"manifest-drive-path", func(root map[string]any) bool {
			root["manifests"].([]any)[0].(map[string]any)["path"] = "source://C:/go.mod"
			return true
		}},
		{"manifest-unc-path", func(root map[string]any) bool {
			root["manifests"].([]any)[0].(map[string]any)["path"] = `source://server\share`
			return true
		}},
		{"manifest-scheme-abuse", func(root map[string]any) bool {
			root["manifests"].([]any)[0].(map[string]any)["path"] = "unknown://go.mod"
			return true
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var root map[string]any
			if err := json.Unmarshal(valid, &root); err != nil {
				t.Fatal(err)
			}
			if !test.mutate(root) {
				t.Fatal("fixture did not contain target nested record")
			}
			data, err := json.Marshal(root)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "analysis.json")
			if err := os.WriteFile(path, data, 0o644); err != nil {
				t.Fatal(err)
			}
			err = runValidate([]string{"--analysis", path})
			var exitErr *exitError
			if !errors.As(err, &exitErr) || exitErr.code != 2 {
				t.Fatalf("malformed nested artifact should exit 2, got %v", err)
			}
		})
	}
}

func TestPortableLocationsRejectEscapesAndMalformedPaths(t *testing.T) {
	for _, value := range []string{
		"source://", "source://.", "source://../escape", "source://a/../escape",
		"source:///etc/passwd", `source://C:/Windows/system.ini`, `source://server\share`,
		"unknown://file.go",
	} {
		if validPortableLocation(value) {
			t.Errorf("unsafe portable location accepted: %q", value)
		}
	}
	for _, value := range []string{"source://dir/file.go", "goroot://src/fmt/print.go", "module://example.com/m@v1.0.0/file.go"} {
		if !validPortableLocation(value) {
			t.Errorf("valid portable location rejected: %q", value)
		}
	}
}

func TestGeneratedFileUsesGoPlacementRules(t *testing.T) {
	parse := func(source string) *ast.File {
		t.Helper()
		file, err := parser.ParseFile(token.NewFileSet(), "generated.go", source, parser.ParseComments)
		if err != nil {
			t.Fatal(err)
		}
		return file
	}
	if !generatedFile(parse("// Code generated by fixture. DO NOT EDIT.\npackage fixture\n")) {
		t.Fatal("valid generated marker was not recognized")
	}
	for _, source := range []string{
		"package fixture\n// Code generated by fixture. DO NOT EDIT.\n",
		"// mentions Code generated but omits the required suffix\npackage fixture\n",
	} {
		if generatedFile(parse(source)) {
			t.Fatalf("misplaced or malformed generated marker accepted: %q", source)
		}
	}
}

func TestEmbedInventoryMatchesGoRuntime(t *testing.T) {
	root := copyFixture(t, "complete")
	goExecutable := filepath.Join(runtime.GOROOT(), "bin", "go")
	env, err := sanitizedEnvironment(testProfile(), t.TempDir(), runtime.GOROOT(), goExecutable, "")
	if err != nil {
		t.Fatal(err)
	}
	result, err := runProcess(t.Context(), 60*time.Second, 1<<20, root, goExecutable, []string{"test", "."}, env)
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("runtime embed fixture failed: err=%v result=%#v", err, result)
	}
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil || !complete {
		t.Fatalf("embed inventory failed: complete=%v err=%v", complete, err)
	}
	assertEmbedMatches(t, analysis)
	for _, test := range []struct {
		pattern string
		path    string
		want    bool
	}{
		{"assets/*", "other/file.txt", false},
		{"[", "assets/visible.txt", false},
		{"assets/sub", "assets/sub/.nestedhidden.txt", false},
		{"all:assets/sub", "assets/sub/.nestedhidden.txt", true},
	} {
		if got := embedPatternMatches(test.pattern, test.path); got != test.want {
			t.Errorf("embedPatternMatches(%q, %q)=%v, want %v", test.pattern, test.path, got, test.want)
		}
	}
}

func TestLocalReplacementInventoryIsRootIndependent(t *testing.T) {
	firstRoot := copyFixture(t, "replacement")
	secondRoot := filepath.Join(t.TempDir(), "other-root")
	copyTree(t, firstRoot, secondRoot)
	first, complete, err := analyze(t.Context(), firstRoot, t.TempDir(), testProfile())
	if err != nil || !complete {
		t.Fatalf("first replacement inventory failed: complete=%v err=%v", complete, err)
	}
	second, complete, err := analyze(t.Context(), secondRoot, t.TempDir(), testProfile())
	if err != nil || !complete {
		t.Fatalf("second replacement inventory failed: complete=%v err=%v", complete, err)
	}
	left, _ := marshalCanonical(first)
	right, _ := marshalCanonical(second)
	if string(left) != string(right) {
		t.Fatalf("local replacement inventory differs by root near: %s", firstDifference(string(left), string(right)))
	}
	if bytes.Contains(left, []byte(firstRoot)) || bytes.Contains(left, []byte(secondRoot)) {
		t.Fatal("local replacement artifact contains an absolute checkout root")
	}
	if !slices.ContainsFunc(first.Modules, func(module ModuleRecord) bool {
		return module.Path == "example.com/replacement" && module.LocalContentSHA256 != ""
	}) {
		t.Fatalf("portable local replacement identity missing: %#v", first.Modules)
	}
	profile := testProfile()
	profile.Limits.MaxRecords = first.RecordCounts.Total - first.RecordCounts.Modules
	if _, _, err := analyze(t.Context(), firstRoot, t.TempDir(), profile); err == nil ||
		!strings.Contains(err.Error(), "record count") {
		t.Fatalf("module records were not included in MaxRecords enforcement: %v", err)
	}
}

func TestCompilerLocationDoesNotAffectSemanticArtifact(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process-tree isolation intentionally fails closed on Windows")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	firstCompiler := filepath.Join(t.TempDir(), "cc")
	secondCompiler := filepath.Join(t.TempDir(), "cc")
	for _, path := range []string{firstCompiler, secondCompiler} {
		if err := os.WriteFile(path, data, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	root := copyFixture(t, "complete")
	firstProfile := testProfile()
	firstProfile.CGOEnabled = true
	firstProfile.CCompiler = firstCompiler
	secondProfile := firstProfile
	secondProfile.CCompiler = secondCompiler
	first, complete, err := analyze(t.Context(), root, t.TempDir(), firstProfile)
	if err != nil || !complete {
		t.Fatalf("first compiler-location analysis failed: complete=%v err=%v", complete, err)
	}
	second, complete, err := analyze(t.Context(), root, t.TempDir(), secondProfile)
	if err != nil || !complete {
		t.Fatalf("second compiler-location analysis failed: complete=%v err=%v", complete, err)
	}
	left, _ := marshalCanonical(first)
	right, _ := marshalCanonical(second)
	if !bytes.Equal(left, right) {
		t.Fatalf("compiler location changed semantic artifact near: %s", firstDifference(string(left), string(right)))
	}
}

func TestSourceCoordinateCountsBytes(t *testing.T) {
	line, column := sourceCoordinate([]byte("é\nx"), len("é"))
	if line != 1 || column != 3 {
		t.Fatalf("UTF-8 byte coordinate mismatch: line=%d column=%d", line, column)
	}
}

func TestGOFLAGSAllowlistRejectsExecutionAndPathOverrides(t *testing.T) {
	accepted := [][]string{
		{"-trimpath"}, {"-trimpath=false"}, {"-buildvcs=false"}, {"-buildvcs", "false"},
		{"-tags=safe_tag,go1.27"}, {"-tags", "safe_tag"},
	}
	for _, flags := range accepted {
		if err := validateGOFLAGS(flags); err != nil {
			t.Errorf("safe flags %v rejected: %v", flags, err)
		}
	}
	rejected := [][]string{
		{"-toolexec=payload"}, {"-toolexec", "payload"}, {"-overlay=overlay.json"},
		{"-overlay", "overlay.json"}, {"-modfile=other.mod"}, {"-modfile", "other.mod"},
		{"-tags=-toolexec=payload"}, {"-ldflags=-extld=payload"}, {"-buildvcs=true"},
	}
	for _, flags := range rejected {
		if err := validateGOFLAGS(flags); err == nil {
			t.Errorf("unsafe flags %v accepted", flags)
		}
	}

	root := copyFixture(t, "complete")
	marker := filepath.Join(t.TempDir(), "executed")
	payload := filepath.Join(t.TempDir(), "payload")
	if err := os.WriteFile(payload, []byte("#!/bin/sh\n: > "+strconv.Quote(marker)+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	profile := testProfile()
	profile.GOFLAGS = []string{"-toolexec=" + payload}
	profilePath := filepath.Join(t.TempDir(), "profile.json")
	data, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(profilePath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	err = runAnalyze(t.Context(), []string{"--source", root, "--profile", profilePath, "--out", t.TempDir()})
	var profileErr *exitError
	if !errors.As(err, &profileErr) || profileErr.code != 2 {
		t.Fatalf("unsafe GOFLAGS should fail profile validation: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("toolexec payload ran or marker check failed: %v", err)
	}
}

func TestSelectedToolchainGOROOTIsResolvedBeforeIsolation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("controlled shell toolchain fixture")
	}
	dir := t.TempDir()
	targetRoot := filepath.Join(dir, "target-goroot")
	if err := os.MkdirAll(targetRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(targetRoot, "VERSION"), []byte("go1.99\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	targetRoot, err := secureRoot(targetRoot)
	if err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "go.log")
	script := filepath.Join(dir, "go")
	body := fmt.Sprintf(`#!/bin/sh
printf '%%s|%%s\n' "$*" "${GOROOT-}" >> %s
if [ "$1" = version ]; then echo 'go version go1.99 test'; exit 0; fi
if [ "$1" = env ] && [ "$2" = GOROOT ]; then echo %s; exit 0; fi
echo unsupported >&2
exit 1
`, strconv.Quote(logPath), strconv.Quote(targetRoot))
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	profile := testProfile()
	profile.RequestedGoVersion = "1.99"
	analysis, complete, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if complete || !hasBlockerCategory(analysis, "loader") {
		t.Fatalf("fake toolchain should reach package loading and fail closed: %#v", analysis.Blockers)
	}
	versionHash, _, err := hashFile(filepath.Join(targetRoot, "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	if analysis.Toolchain.GOROOTVersionSHA256 != versionHash {
		t.Fatalf("target GOROOT provenance mismatch: %#v", analysis.Toolchain)
	}
	log, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(log)), "\n")
	if len(lines) < 3 || lines[0] != "version|" || lines[1] != "env GOROOT|" {
		t.Fatalf("bootstrap commands inherited helper GOROOT: %q", lines)
	}
	foundIsolated := false
	for _, line := range lines[2:] {
		foundIsolated = foundIsolated || strings.HasSuffix(line, "|"+targetRoot)
	}
	if !foundIsolated {
		t.Fatalf("subsequent Go commands did not use target GOROOT %q: %q", targetRoot, lines)
	}
}

func TestIncompleteDiagnosticsAreRootIndependent(t *testing.T) {
	firstRoot := copyFixture(t, "invalid")
	secondRoot := filepath.Join(t.TempDir(), "other-root")
	copyTree(t, firstRoot, secondRoot)
	first, complete, err := analyze(t.Context(), firstRoot, t.TempDir(), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if complete {
		t.Fatal("invalid fixture unexpectedly completed")
	}
	second, complete, err := analyze(t.Context(), secondRoot, t.TempDir(), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if complete {
		t.Fatal("second invalid fixture unexpectedly completed")
	}
	left, _ := marshalCanonical(first)
	right, _ := marshalCanonical(second)
	if string(left) != string(right) {
		t.Fatalf("incomplete inventory differs by root near: %s", firstDifference(string(left), string(right)))
	}
	for _, diagnostic := range first.Diagnostics {
		if strings.Contains(diagnostic.Position, firstRoot) || strings.Contains(diagnostic.ID, firstRoot) {
			t.Fatalf("diagnostic retained absolute root: %#v", diagnostic)
		}
	}
}

func copyFixture(t *testing.T, name string) string {
	t.Helper()
	source := filepath.Join("testdata", name)
	target := filepath.Join(t.TempDir(), name)
	copyTree(t, source, target)
	return target
}

func copyTree(t *testing.T, source, target string) {
	t.Helper()
	err := filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(destination, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func appendInvalidUTF8(t *testing.T, path string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Write([]byte{'\n', '/', '/', ' ', 0xff, '\n'}); err != nil {
		t.Fatal(err)
	}
}

func hasInvalidUTF8(analysis Analysis) bool {
	for _, file := range analysis.Files {
		if !file.ValidUTF8 {
			data, err := base64.StdEncoding.DecodeString(file.ContentBase64)
			return err == nil && slices.Contains(data, byte(0xff))
		}
	}
	return false
}

func hasLineDirective(analysis Analysis) bool {
	for _, node := range analysis.Nodes {
		if node.Span.LineDirective && strings.HasPrefix(node.Span.DisplayPath, "line://logical/generated.go") {
			return true
		}
	}
	return false
}

func hasBlockerCategory(analysis Analysis, category string) bool {
	for _, blocker := range analysis.Blockers {
		if blocker.Category == category {
			return true
		}
	}
	return false
}

func assertInitializationOrder(t *testing.T, analysis Analysis) {
	t.Helper()
	files := map[string]string{}
	for _, file := range analysis.Files {
		files[file.ID] = strings.TrimPrefix(file.Path, "source://")
	}
	symbols := map[string]string{}
	for _, symbol := range analysis.Symbols {
		symbols[symbol.ID] = symbol.Name
	}
	for _, pkg := range analysis.Packages {
		if pkg.ImportPath != "example.com/go2gsfixture" || pkg.Variant != "ordinary" {
			continue
		}
		var compiled []string
		for _, id := range pkg.CompiledFileIDs {
			compiled = append(compiled, files[id])
		}
		a := slices.Index(compiled, "a_init.go")
		main := slices.Index(compiled, "main.go")
		z := slices.Index(compiled, "z_init.go")
		if a < 0 || main < 0 || z < 0 || !(a < main && main < z) {
			t.Fatalf("compiled file order was not preserved: %v", compiled)
		}
		firstVariable, lastVariable := -1, -1
		var initFiles []string
		for _, initialization := range pkg.InitializationOrder {
			for _, id := range initialization.SymbolIDs {
				switch symbols[id] {
				case "FirstInitialized":
					firstVariable = initialization.Order
				case "LastInitialized":
					lastVariable = initialization.Order
				}
			}
			if initialization.Kind == "init-function" {
				initFiles = append(initFiles, files[initialization.FileID])
			}
		}
		if firstVariable < 0 || lastVariable < 0 || firstVariable >= lastVariable {
			t.Fatalf("variable initialization order missing or wrong: %#v", pkg.InitializationOrder)
		}
		if !slices.Equal(initFiles, []string{"a_init.go", "z_init.go"}) {
			t.Fatalf("init function order was not preserved: %v", initFiles)
		}
		return
	}
	t.Fatal("ordinary fixture package not found")
}

func assertEmbedMatches(t *testing.T, analysis Analysis) {
	t.Helper()
	packageID := ""
	for _, pkg := range analysis.Packages {
		if pkg.ImportPath == "example.com/go2gsfixture" && pkg.Variant == "ordinary" {
			packageID = pkg.ID
			break
		}
	}
	matches := map[string][]string{}
	for _, record := range analysis.Embeds {
		if record.PackageID != packageID {
			continue
		}
		matches[record.Pattern] = append(matches[record.Pattern], record.LogicalName)
	}
	for pattern := range matches {
		sort.Strings(matches[pattern])
	}
	want := map[string][]string{
		"assets/*": {
			"assets/.hidden.txt", "assets/_hidden.txt", "assets/sub/nested.txt", "assets/visible.txt",
		},
		"all:assets/*": {
			"assets/.hidden.txt", "assets/_hidden.txt", "assets/sub/.nestedhidden.txt",
			"assets/sub/nested.txt", "assets/visible.txt",
		},
		"assets/sub": {"assets/sub/nested.txt"},
	}
	if !reflect.DeepEqual(matches, want) {
		t.Fatalf("embed pattern matches are incorrect: got %#v want %#v", matches, want)
	}
}

func TestCanonicalJSONUsesStringConstants(t *testing.T) {
	value := ConstantRecord{Exact: "123456789012345678901234567890"}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"exact":"123456789012345678901234567890"`) {
		t.Fatalf("constant did not remain a JSON string: %s", data)
	}
}

func TestProcessRunnerDrainsAndBoundsBothStreams(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	result, err := runProcess(t.Context(), 5*time.Second, 4096, "", executable,
		[]string{"-test.run=TestProcessHelper"}, []string{"GO2GS_PROCESS_HELPER=output"})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || !result.StdoutTruncated || !result.StderrTruncated ||
		len(result.Stdout) != 4096 || len(result.Stderr) != 4096 {
		t.Fatalf("unexpected bounded process result: %#v", result)
	}
}

func TestProcessRunnerCancels(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, err = runProcess(t.Context(), 20*time.Millisecond, 4096, "", executable,
		[]string{"-test.run=TestProcessHelper"}, []string{"GO2GS_PROCESS_HELPER=sleep"})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout, got %v", err)
	}
}

func TestSanitizedEnvironmentDoesNotExposeAmbientPATH(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	maliciousDir := t.TempDir()
	name := "go2gs-malicious-helper"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := os.WriteFile(filepath.Join(maliciousDir, name), []byte("not executable content"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", maliciousDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	env, err := sanitizedEnvironment(testProfile(), t.TempDir(), runtime.GOROOT(), executable, "")
	if err != nil {
		t.Fatal(err)
	}
	env = append(env, "GO2GS_PROCESS_HELPER=path", "GO2GS_BAD_NAME="+name)
	result, err := runProcess(t.Context(), 5*time.Second, 4096, "", executable,
		[]string{"-test.run=TestProcessHelper"}, env)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || !strings.HasPrefix(result.Stdout, "missing") {
		t.Fatalf("ambient PATH helper was exposed: %#v", result)
	}
}

func TestProcessRunnerRepeatedShortCommands(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		result, err := runProcess(t.Context(), 5*time.Second, 4096, "", executable,
			[]string{"-test.run=TestProcessHelper"}, []string{"GO2GS_PROCESS_HELPER=short"})
		if err != nil {
			t.Fatalf("iteration %d: %v", i, err)
		}
		if result.ExitCode != 0 || !strings.HasPrefix(result.Stdout, "stdout") || result.Stderr != "stderr" {
			t.Fatalf("iteration %d: unexpected result %#v", i, result)
		}
	}
}

func TestProcessHelper(t *testing.T) {
	switch os.Getenv("GO2GS_PROCESS_HELPER") {
	case "output":
		chunk := strings.Repeat("x", 10000)
		_, _ = os.Stdout.WriteString(chunk)
		_, _ = os.Stderr.WriteString(chunk)
	case "sleep":
		time.Sleep(10 * time.Second)
	case "short":
		_, _ = os.Stdout.WriteString("stdout")
		_, _ = os.Stderr.WriteString("stderr")
	case "path":
		if _, err := exec.LookPath(os.Getenv("GO2GS_BAD_NAME")); err == nil {
			_, _ = os.Stdout.WriteString("found")
		} else {
			_, _ = os.Stdout.WriteString("missing")
		}
	case "tree":
		child := exec.Command(os.Args[0], "-test.run=TestProcessHelper")
		child.Env = []string{"GO2GS_PROCESS_HELPER=child-sleep"}
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(os.Getenv("GO2GS_CHILD_PID"), []byte(strconv.Itoa(child.Process.Pid)), 0o600); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Second)
	case "child-sleep":
		time.Sleep(10 * time.Second)
	default:
		t.Skip("helper only")
	}
}

func firstDifference(left, right string) string {
	limit := min(len(left), len(right))
	for i := 0; i < limit; i++ {
		if left[i] != right[i] {
			start := max(0, i-80)
			endLeft := min(len(left), i+160)
			endRight := min(len(right), i+160)
			return "left=" + strconv.Quote(left[start:endLeft]) + " right=" + strconv.Quote(right[start:endRight])
		}
	}
	return fmt.Sprintf("lengths %d and %d", len(left), len(right))
}
