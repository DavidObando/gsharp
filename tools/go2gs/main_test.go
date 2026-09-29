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
			ExpectedSourceCommit: strings.Repeat("a", 40), ActualSourceCommit: strings.Repeat("a", 40),
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

func TestCgoDisabledIgnoresDefensivelyDiscoveredInputs(t *testing.T) {
	root := copyFixture(t, "cgo")
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if !complete || !analysis.InventoryComplete {
		t.Fatalf("ignored CGo inputs made inventory incomplete: %#v", analysis.Blockers)
	}
	if hasBlockerCategory(analysis, "cgo") || hasBlockerCategory(analysis, "native") {
		t.Fatalf("ignored CGo/native inputs created blockers: %#v", analysis.Blockers)
	}
	for path, role := range map[string]string{
		"source://base.go":        "compiled",
		"source://cgo.go":         "ignored",
		"source://cgo_tagged.go":  "ignored",
		"source://cgo_windows.go": "ignored",
		"source://native.c":       "ignored",
		"source://native.h":       "ignored",
	} {
		index := slices.IndexFunc(analysis.Files, func(file FileRecord) bool { return file.Path == path })
		if index < 0 || analysis.Files[index].Role != role {
			t.Fatalf("%s role: got %#v, want %s", path, analysis.Files, role)
		}
	}
}

func TestDefensiveNativeMutationDoesNotCreateDrift(t *testing.T) {
	root := copyFixture(t, "cgo")
	path := filepath.Join(root, "native.c")
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	analysis, complete, err := analyzeWithSnapshotHook(t.Context(), root, t.TempDir(), testProfile(), func() {
		if writeErr := os.WriteFile(path, []byte("changed defensive input"), 0o644); writeErr != nil {
			t.Fatal(writeErr)
		}
	})
	if err != nil || !complete || !analysis.InventoryComplete || hasBlockerCategory(analysis, "input-drift") {
		t.Fatalf("defensive-only mutation affected completeness: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
	}
	index := slices.IndexFunc(analysis.Files, func(file FileRecord) bool { return file.Path == "source://native.c" })
	if index < 0 || analysis.Files[index].Role != "ignored" {
		t.Fatalf("defensive C input was not retained as ignored: %#v", analysis.Files)
	}
	data, err := base64.StdEncoding.DecodeString(analysis.Files[index].ContentBase64)
	if err != nil || !bytes.Equal(data, original) {
		t.Fatalf("defensive input did not use captured bytes: %q, %v", data, err)
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
	if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "cgo") {
		t.Fatalf("CGo transformed source was not fail-closed: %#v", analysis.Blockers)
	}
	if err := validateAnalysis(analysis); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"cgo.go", "native.h"} {
		path := "source://" + name
		if !slices.ContainsFunc(analysis.Files, func(file FileRecord) bool { return file.Path == path }) {
			t.Fatalf("captured CGo input %s missing: %#v", path, analysis.Files)
		}
	}
	if slices.ContainsFunc(analysis.Files, func(file FileRecord) bool {
		return strings.Contains(file.Path, "gocommand-") || strings.Contains(file.Path, "go-build")
	}) {
		t.Fatalf("generated CGo work path escaped into files: %#v", analysis.Files)
	}
	if len(analysis.Files) == 0 || len(analysis.Packages) == 0 {
		t.Fatal("selected CGo package disappeared from inventory")
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
	if complete || analysis.InventoryComplete || hasBlockerCategory(analysis, "pkg-config") || !hasBlockerCategory(analysis, "cgo") {
		t.Fatalf("inactive pkg-config directive did not defer solely to the CGo inventory blocker: %#v", analysis.Blockers)
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
			if complete || analysis.InventoryComplete || hasBlockerCategory(analysis, "pkg-config") || !hasBlockerCategory(analysis, "cgo") {
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
	profile := testProfile()
	profile.ExpectedSourceCommit = strings.Repeat("a", 40)
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if complete || analysis.InventoryComplete || analysis.Profile.ActualSourceCommit != "" ||
		!hasBlockerCategory(analysis, "source-metadata") || len(analysis.Packages) != 0 {
		t.Fatalf("malformed Git metadata did not fail closed: %#v", analysis)
	}
	if err := validateAnalysis(analysis); err != nil {
		t.Fatalf("pinned source-metadata failure produced an invalid artifact: %v", err)
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
	platformAssembly := "platform_" + runtime.GOOS + ".s"
	if err := os.WriteFile(filepath.Join(root, platformAssembly), []byte("//go:build "+runtime.GOOS+"\n\n#include \"textflag.h\"\n#include \"constants.h\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "native") {
		t.Fatalf("native requirement was not reported as incomplete: %#v", analysis.Blockers)
	}
	for _, name := range []string{"native.s", "constants.h", "cycle.h", platformAssembly} {
		path := "source://" + name
		if !slices.ContainsFunc(analysis.Files, func(file FileRecord) bool {
			return file.Path == path && file.Native && file.Role == "native"
		}) {
			t.Fatalf("selected native input %s was not recorded as native: %#v", path, analysis.Files)
		}
	}
	unused := slices.IndexFunc(analysis.Files, func(file FileRecord) bool { return file.Path == "source://unused.h" })
	if unused < 0 || analysis.Files[unused].Role != "ignored" || analysis.Files[unused].Native {
		t.Fatalf("unreachable header was not ignored: %#v", analysis.Files)
	}
}

func TestUnsafeNativeIncludeFailsClosed(t *testing.T) {
	root := copyFixture(t, "native")
	if err := os.WriteFile(filepath.Join(filepath.Dir(root), "outside.h"), []byte("#define OUTSIDE 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "native.s"), []byte("#include \"../outside.h\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "native-include") {
		t.Fatalf("unsafe native include did not fail closed: %#v", analysis.Blockers)
	}
}

func TestNativeIncludeGraphHandlesNestedCycle(t *testing.T) {
	root := t.TempDir()
	paths := map[string][]byte{
		"native.s":               []byte("#include \"include/constants.h\"\n"),
		"include/constants.h":    []byte("#include \"nested/cycle.h\"\n"),
		"include/nested/cycle.h": []byte("#include \"../constants.h\"\n"),
	}
	snapshot := map[string][]byte{}
	var otherFiles []string
	for name, data := range paths {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		snapshot[path] = data
		otherFiles = append(otherFiles, path)
	}
	pkg := &packages.Package{Dir: root, OtherFiles: otherFiles}
	reachable, unsafe := selectedNativeIncludes(pkg, snapshot)
	if unsafe || len(reachable) != 2 {
		t.Fatalf("nested cyclic include graph mismatch: reachable=%v unsafe=%v", reachable, unsafe)
	}
}

func TestLocalQuotedIncludesUsesPreprocessorLexing(t *testing.T) {
	source := []byte("#include /* gap */ \"constants.h\"\n" +
		"#inc\\\nlude \"spliced.h\"\n" +
		"#inc\\\r\nlude \"crlf.h\"\r\n" +
		"# /* before */ include/* after */\"comments.h\"\n" +
		"// #include \"line-comment.h\"\n" +
		"/* #include \"block-comment.h\" */\n" +
		"/* multiline\n#include \"multiline-comment.h\"\n*/\n" +
		"\"#include \\\"string.h\\\"\"\n" +
		"'#'; #include \"character.h\"\n" +
		"#include <system.h>\n" +
		"#include_next \"next.h\"\n")
	want := []string{"comments.h", "constants.h", "crlf.h", "spliced.h"}
	got, malformed := localQuotedIncludes(source)
	if malformed || !slices.Equal(got, want) {
		t.Fatalf("quoted include tokens mismatch:\ngot  %q\nwant %q", got, want)
	}
}

func TestLocalQuotedIncludesSkipsCXXRawStrings(t *testing.T) {
	source := []byte(`const char* exact = R"tag(
#include "fake-exact.h"
)ta"
)tag";
const char* empty = u8R"(
#include "fake-empty.h"
)";
const char* utf16 = uR"x(#include "fake-u.h")x";
const char* utf32 = UR"xx(#include "fake-U.h")xx";
const char* wide = LR"custom(
// #include "fake-L.h"
/* "#include fake-comment.h" */
)custom";
const char* preserved = R"raw(backslash\
#include "fake-preserved.h"
)raw";
const char* ordinary = "R\"tag(#include fake-string.h)tag\"";
#include "real.h"
`)
	got, malformed := localQuotedIncludes(source)
	if malformed || !slices.Equal(got, []string{"real.h"}) {
		t.Fatalf("raw strings affected quoted includes: got=%q malformed=%v", got, malformed)
	}
}

func TestLocalQuotedIncludesRejectsMalformedCXXRawStrings(t *testing.T) {
	for name, source := range map[string][]byte{
		"unterminated":   []byte("R\"tag(\n#include \"fake.h\"\n"),
		"space":          []byte("R\"bad tag(content)bad tag\""),
		"control":        []byte("R\"bad\x01tag(content)bad\x01tag\""),
		"parenthesis":    []byte("R\"bad)(content)bad)\""),
		"backslash":      []byte("R\"bad\\tag(content)bad\\tag\""),
		"long-delimiter": []byte("R\"12345678901234567(content)12345678901234567\""),
		"split-lf":       []byte("R\"tag(body)ta\\\ng\""),
		"split-crlf":     []byte("R\"tag(body)ta\\\r\ng\""),
	} {
		t.Run(name, func(t *testing.T) {
			includes, malformed := localQuotedIncludes(source)
			if !malformed || len(includes) != 0 {
				t.Fatalf("malformed raw string was accepted: includes=%q malformed=%v", includes, malformed)
			}
		})
	}
}

func TestMalformedNativeRawStringFailsClosed(t *testing.T) {
	root := copyFixture(t, "native")
	if err := os.WriteFile(filepath.Join(root, "native.s"), []byte("R\"tag(\n#include \"fake.h\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil {
		t.Fatal(err)
	}
	if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "native-include") {
		t.Fatalf("malformed native raw string did not fail closed: %#v", analysis.Blockers)
	}
}

func TestSelectedNativeHeaderMutationCreatesDrift(t *testing.T) {
	root := copyFixture(t, "native")
	path := filepath.Join(root, "constants.h")
	analysis, complete, err := analyzeWithSnapshotHook(t.Context(), root, t.TempDir(), testProfile(), func() {
		if writeErr := os.WriteFile(path, []byte("#define NATIVE_VALUE 8\n"), 0o644); writeErr != nil {
			t.Fatal(writeErr)
		}
	})
	if err != nil || complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "input-drift") {
		t.Fatalf("selected native header mutation was not detected: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
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

func TestInvalidGoVersionBootstrapRemovesStaleArtifacts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("controlled shell toolchain fixture")
	}
	for name, body := range map[string]string{
		"nonzero":   "#!/bin/sh\necho broken >&2\nexit 7\n",
		"malformed": "#!/bin/sh\necho not-a-go-version\n",
		"empty":     "#!/bin/sh\nexit 0\n",
	} {
		t.Run(name, func(t *testing.T) {
			root := copyFixture(t, "complete")
			dir := t.TempDir()
			logPath := filepath.Join(dir, "go.log")
			script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + strconv.Quote(logPath) + "\n" + strings.TrimPrefix(body, "#!/bin/sh\n")
			if err := os.WriteFile(filepath.Join(dir, "go"), []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			profilePath := filepath.Join(dir, "profile.json")
			data, err := json.Marshal(testProfile())
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(profilePath, data, 0o644); err != nil {
				t.Fatal(err)
			}
			out := filepath.Join(dir, "out")
			if err := os.Mkdir(out, 0o755); err != nil {
				t.Fatal(err)
			}
			out, err = secureRoot(out)
			if err != nil {
				t.Fatal(err)
			}
			for _, artifact := range []string{"analysis.json", "run.json"} {
				if err := os.WriteFile(filepath.Join(out, artifact), []byte("stale"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("PATH", dir)
			err = runAnalyze(t.Context(), []string{"--source", root, "--profile", profilePath, "--out", out})
			var exitErr *exitError
			if !errors.As(err, &exitErr) || exitErr.code != 2 {
				t.Fatalf("invalid Go version should exit 2, got %v", err)
			}
			for _, artifact := range []string{"analysis.json", "run.json"} {
				if _, statErr := os.Lstat(filepath.Join(out, artifact)); !os.IsNotExist(statErr) {
					t.Fatalf("bootstrap failure retained stale %s: %v", artifact, statErr)
				}
			}
			log, err := os.ReadFile(logPath)
			if err != nil || strings.TrimSpace(string(log)) != "version" {
				t.Fatalf("bootstrap continued past invalid go version: %q, %v", log, err)
			}
		})
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
	t.Run("staged symlink", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "analysis.json")
		outside := filepath.Join(t.TempDir(), "outside")
		if err := os.WriteFile(outside, []byte("safe"), 0o644); err != nil {
			t.Fatal(err)
		}
		var displaced string
		err := atomicWriteWithHooks(path, bytes.Repeat([]byte("x"), 1<<20), 0o644, func(staged string) {
			displaced = staged + ".attacker-moved"
			if renameErr := os.Rename(staged, displaced); renameErr != nil {
				t.Fatal(renameErr)
			}
			if symlinkErr := os.Symlink(outside, staged); symlinkErr != nil {
				t.Fatal(symlinkErr)
			}
		}, nil)
		if err == nil {
			t.Fatal("staged pathname replacement was accepted")
		}
		if data, readErr := os.ReadFile(outside); readErr != nil || string(data) != "safe" {
			t.Fatalf("outside target changed: %q, %v", data, readErr)
		}
		_ = os.Remove(displaced)
	})

	t.Run("unrelated final replacement", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "analysis.json")
		var displaced string
		err := atomicWriteWithHooks(path, []byte("writer1"), 0o644, nil, func(final string) {
			displaced = final + ".writer1"
			if renameErr := os.Rename(final, displaced); renameErr != nil {
				t.Fatal(renameErr)
			}
			if writeErr := os.WriteFile(final, []byte("replacement"), 0o644); writeErr != nil {
				t.Fatal(writeErr)
			}
		})
		if err == nil {
			t.Fatal("unrelated final replacement was accepted")
		}
		if data, readErr := os.ReadFile(path); readErr != nil || string(data) != "replacement" {
			t.Fatalf("failed writer removed unrelated output: %q, %v", data, readErr)
		}
		_ = os.Remove(displaced)
	})
}

func TestAtomicWriteFailurePreservesConcurrentSuccessfulOutput(t *testing.T) {
	path := filepath.Join(t.TempDir(), "analysis.json")
	renamed := make(chan struct{})
	resume := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- atomicWriteWithHooks(path, []byte("writer1"), 0o644, nil, func(string) {
			close(renamed)
			<-resume
		})
	}()
	<-renamed
	if err := atomicWrite(path, []byte("writer2"), 0o644); err != nil {
		close(resume)
		t.Fatal(err)
	}
	close(resume)
	if err := <-firstDone; err == nil {
		t.Fatal("superseded writer unexpectedly succeeded")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "writer2" {
		t.Fatalf("failed writer removed concurrent successful output: %q, %v", data, err)
	}
}

func TestOutputInvalidationAndFailedPublishLeaveNoStaleArtifacts(t *testing.T) {
	out := t.TempDir()
	unrelated := filepath.Join(out, "keep.txt")
	userData := filepath.Join(out, ".go2gs-worker-user-data", "valuable.txt")
	for name, content := range map[string]string{
		"analysis.json":                 "stale analysis",
		"run.json":                      "stale run",
		".analysis.json.staged-crashed": "staged",
		"keep.txt":                      "keep",
	} {
		if err := os.WriteFile(filepath.Join(out, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(userData), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userData, []byte("valuable"), 0o600); err != nil {
		t.Fatal(err)
	}
	release, err := lockAndInvalidateOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lockAndInvalidateOutput(out); err == nil {
		t.Fatal("concurrent output writer acquired the same lock")
	}
	for _, name := range []string{"analysis.json", "run.json"} {
		if _, err := os.Lstat(filepath.Join(out, name)); !os.IsNotExist(err) {
			t.Fatalf("owned stale output %s remains: %v", name, err)
		}
	}
	if data, err := os.ReadFile(unrelated); err != nil || string(data) != "keep" {
		t.Fatalf("unrelated output was changed: %q, %v", data, err)
	}
	for path, want := range map[string]string{
		filepath.Join(out, ".analysis.json.staged-crashed"): "staged",
		userData: "valuable",
	} {
		if data, err := os.ReadFile(path); err != nil || string(data) != want {
			t.Fatalf("unowned prefixed data was changed: %s: %q, %v", path, data, err)
		}
	}
	if err := publishWorkerArtifacts(out, []byte("new analysis"), []byte("new run"), func() {
		if mkdirErr := os.Mkdir(filepath.Join(out, "run.json"), 0o755); mkdirErr != nil {
			t.Fatal(mkdirErr)
		}
	}); err == nil {
		t.Fatal("worker publish unexpectedly succeeded")
	}
	if _, err := os.Lstat(filepath.Join(out, "analysis.json")); !os.IsNotExist(err) {
		t.Fatalf("failed publish retained analysis.json: %v", err)
	}
	release()
	if _, err := os.Lstat(filepath.Join(out, ".go2gs-lock")); !os.IsNotExist(err) {
		t.Fatalf("output lock was not released: %v", err)
	}
}

func TestOwnedTemporaryDirectoryCleanupIsIdentitySafe(t *testing.T) {
	for _, pattern := range []string{".go2gs-bootstrap-*", ".go2gs-worker-*", ".go2gs-work-*"} {
		t.Run("ordinary-"+pattern, func(t *testing.T) {
			directory, err := createOwnedTempDir(t.TempDir(), pattern)
			if err != nil {
				t.Fatal(err)
			}
			nested := filepath.Join(directory.path, "nested")
			if err := os.Mkdir(nested, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(nested, "artifact"), []byte("owned"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := directory.cleanup(); err != nil {
				t.Fatal(err)
			}
			if !secureTempCleanupSupported() {
				if _, err := os.Lstat(directory.path); err != nil {
					t.Fatalf("fallback cleanup removed private directory: %v", err)
				}
				return
			}
			if _, err := os.Lstat(directory.path); !os.IsNotExist(err) {
				t.Fatalf("ordinary owned directory remains: %v", err)
			}
		})
	}

	t.Run("symlink child retained", func(t *testing.T) {
		if !secureTempCleanupSupported() {
			t.Skip("descriptor-relative cleanup is unavailable")
		}
		directory, err := createOwnedTempDir(t.TempDir(), ".go2gs-worker-*")
		if err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(t.TempDir(), "outside")
		if err := os.WriteFile(outside, []byte("safe"), 0o600); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(directory.path, "link")
		if err := os.Symlink(outside, link); err != nil {
			t.Fatal(err)
		}
		var tombstone string
		if err := directory.cleanupWithHooks(nil, func(path string) { tombstone = path }); err == nil ||
			!strings.Contains(err.Error(), "remains non-empty") {
			t.Fatalf("retained symlink should report incomplete cleanup, got %v", err)
		}
		if info, err := os.Lstat(filepath.Join(tombstone, "link")); err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("unbound symlink was not safely retained: %v, %v", info, err)
		}
		if data, err := os.ReadFile(outside); err != nil || string(data) != "safe" {
			t.Fatalf("symlink target was changed: %q, %v", data, err)
		}
	})

	t.Run("pathname replacement", func(t *testing.T) {
		parent := t.TempDir()
		directory, err := createOwnedTempDir(parent, ".go2gs-worker-*")
		if err != nil {
			t.Fatal(err)
		}
		displaced := directory.path + ".displaced"
		err = directory.cleanupWithHook(func() {
			if renameErr := os.Rename(directory.path, displaced); renameErr != nil {
				t.Fatal(renameErr)
			}
			if mkdirErr := os.Mkdir(directory.path, 0o700); mkdirErr != nil {
				t.Fatal(mkdirErr)
			}
			if writeErr := os.WriteFile(filepath.Join(directory.path, "valuable.txt"), []byte("valuable"), 0o600); writeErr != nil {
				t.Fatal(writeErr)
			}
		})
		if err == nil || !strings.Contains(err.Error(), "changed during cleanup") {
			t.Fatalf("pathname replacement should report cleanup failure, got %v", err)
		}
		data, err := os.ReadFile(filepath.Join(directory.path, "valuable.txt"))
		if err != nil || string(data) != "valuable" {
			t.Fatalf("replacement directory was deleted: %q, %v", data, err)
		}
		if _, err := os.Lstat(displaced); err != nil {
			t.Fatalf("displaced owned directory was unexpectedly removed: %v", err)
		}
	})

	t.Run("post-tombstone identity replacement", func(t *testing.T) {
		if !secureTempCleanupSupported() {
			t.Skip("descriptor-relative cleanup is unavailable")
		}
		parent := t.TempDir()
		directory, err := createOwnedTempDir(parent, ".go2gs-worker-*")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory.path, "owned.txt"), []byte("owned"), 0o600); err != nil {
			t.Fatal(err)
		}
		var tombstone, displaced string
		err = directory.cleanupWithHooks(nil, func(path string) {
			tombstone = path
			displaced = path + ".displaced"
			if renameErr := os.Rename(path, displaced); renameErr != nil {
				t.Fatal(renameErr)
			}
			if mkdirErr := os.Mkdir(path, 0o700); mkdirErr != nil {
				t.Fatal(mkdirErr)
			}
			if writeErr := os.WriteFile(filepath.Join(path, "valuable.txt"), []byte("valuable"), 0o600); writeErr != nil {
				t.Fatal(writeErr)
			}
		})
		if err == nil || !strings.Contains(err.Error(), "tombstone was replaced") {
			t.Fatalf("tombstone replacement should report cleanup failure, got %v", err)
		}
		if data, err := os.ReadFile(filepath.Join(tombstone, "valuable.txt")); err != nil || string(data) != "valuable" {
			t.Fatalf("post-check replacement was deleted: %q, %v", data, err)
		}
		if _, err := os.Lstat(displaced); err != nil {
			t.Fatalf("descriptor-owned directory was unexpectedly removed by pathname: %v", err)
		}
	})
}

func TestOwnedTemporaryDirectoryLateFileReplacementSurvives(t *testing.T) {
	if !secureTempCleanupSupported() {
		t.Skip("atomic exchange cleanup is unavailable")
	}
	for _, replacement := range []string{"file", "symlink"} {
		t.Run(replacement, func(t *testing.T) {
			directory, err := createOwnedTempDir(t.TempDir(), ".go2gs-worker-*")
			if err != nil {
				t.Fatal(err)
			}
			const fileCount = 2000
			for index := 0; index < fileCount; index++ {
				name := filepath.Join(directory.path, fmt.Sprintf("%04d", index))
				if err := os.WriteFile(name, []byte("owned"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			var tombstone string
			done := make(chan error, 1)
			err = directory.cleanupWithHooks(nil, func(path string) {
				tombstone = path
				go func() {
					trigger := filepath.Join(path, "0500")
					target := filepath.Join(path, "1999")
					deadline := time.Now().Add(10 * time.Second)
					for {
						if _, statErr := os.Lstat(trigger); os.IsNotExist(statErr) {
							break
						}
						if time.Now().After(deadline) {
							done <- errors.New("cleanup did not reach replacement trigger")
							return
						}
						time.Sleep(time.Millisecond)
					}
					displaced := target + ".owned"
					if renameErr := os.Rename(target, displaced); renameErr != nil {
						done <- renameErr
						return
					}
					if replacement == "symlink" {
						outside := filepath.Join(filepath.Dir(path), "valuable-target")
						if writeErr := os.WriteFile(outside, []byte("valuable"), 0o600); writeErr != nil {
							done <- writeErr
							return
						}
						done <- os.Symlink(outside, target)
						return
					}
					done <- os.WriteFile(target, []byte("valuable"), 0o600)
				}()
			})
			if watcherErr := <-done; watcherErr != nil {
				t.Fatal(watcherErr)
			}
			if err == nil || !strings.Contains(err.Error(), "remains non-empty") {
				t.Fatalf("retained replacement should report cleanup failure, got %v", err)
			}
			target := filepath.Join(tombstone, "1999")
			if replacement == "symlink" {
				info, statErr := os.Lstat(target)
				if statErr != nil || info.Mode()&os.ModeSymlink == 0 {
					t.Fatalf("replacement symlink was deleted: %v, %v", info, statErr)
				}
			} else if data, readErr := os.ReadFile(target); readErr != nil || string(data) != "valuable" {
				t.Fatalf("replacement file was deleted: %q, %v", data, readErr)
			}
		})
	}
}

func TestOwnedTemporaryDirectoryExchangeFailureIsSafeAndReported(t *testing.T) {
	if !secureTempCleanupSupported() {
		t.Skip("atomic exchange cleanup is unavailable")
	}
	for _, swappedPlaceholder := range []bool{false, true} {
		name := "placeholder-removed"
		if swappedPlaceholder {
			name = "placeholder-swapped"
		}
		t.Run(name, func(t *testing.T) {
			directory, err := createOwnedTempDir(t.TempDir(), ".go2gs-worker-*")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(directory.path, "owned"), []byte("owned"), 0o600); err != nil {
				t.Fatal(err)
			}
			var hookErr error
			var tombstone, placeholder, displaced string
			previous := tempCleanupPlaceholderCreatedHook
			tempCleanupPlaceholderCreatedHook = func(path, entry, created string) {
				if entry != "owned" {
					return
				}
				placeholder = filepath.Join(path, created)
				hookErr = os.Remove(filepath.Join(path, entry))
				if hookErr != nil || !swappedPlaceholder {
					return
				}
				displaced = placeholder + ".owned"
				if hookErr = os.Rename(placeholder, displaced); hookErr == nil {
					hookErr = os.WriteFile(placeholder, []byte("valuable"), 0o600)
				}
			}
			t.Cleanup(func() { tempCleanupPlaceholderCreatedHook = previous })

			err = directory.cleanupWithHooks(nil, func(path string) { tombstone = path })
			if hookErr != nil {
				t.Fatal(hookErr)
			}
			if err == nil || !strings.Contains(err.Error(), "atomically exchange") {
				t.Fatalf("exchange failure was not reported: %v", err)
			}
			if swappedPlaceholder {
				if data, readErr := os.ReadFile(placeholder); readErr != nil || string(data) != "valuable" {
					t.Fatalf("swapped placeholder was deleted: %q, %v", data, readErr)
				}
				if _, statErr := os.Lstat(displaced); statErr != nil {
					t.Fatalf("displaced known placeholder was deleted: %v", statErr)
				}
				return
			}
			entries, readErr := os.ReadDir(tombstone)
			if readErr != nil {
				t.Fatal(readErr)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".go2gs-entry-") {
					t.Fatalf("known placeholder leaked after exchange failure: %s", entry.Name())
				}
			}
		})
	}
}

func TestOwnedTemporaryDirectoryCleanupErrorsReachOwners(t *testing.T) {
	if !secureTempCleanupSupported() {
		t.Skip("atomic exchange cleanup is unavailable")
	}
	writeProfile := func(t *testing.T) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), "profile.json")
		data, err := marshalCanonical(testProfile())
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	installFailure := func(t *testing.T, prefix, probe string, prepare func(ownedTempDir)) *error {
		t.Helper()
		previousCreated := tempDirectoryCreatedHook
		previousPlaceholder := tempCleanupPlaceholderCreatedHook
		var hookErr error
		tempDirectoryCreatedHook = func(directory ownedTempDir) {
			if !strings.HasPrefix(filepath.Base(directory.path), prefix) {
				return
			}
			hookErr = os.WriteFile(filepath.Join(directory.path, probe), []byte("owned"), 0o600)
			if hookErr == nil && prepare != nil {
				prepare(directory)
			}
		}
		tempCleanupPlaceholderCreatedHook = func(path, entry, _ string) {
			if hookErr == nil && entry == probe {
				hookErr = os.Remove(filepath.Join(path, entry))
			}
		}
		t.Cleanup(func() {
			tempDirectoryCreatedHook = previousCreated
			tempCleanupPlaceholderCreatedHook = previousPlaceholder
		})
		return &hookErr
	}

	t.Run("bootstrap", func(t *testing.T) {
		root := copyFixture(t, "complete")
		hookErr := installFailure(t, ".go2gs-bootstrap-", "bootstrap-probe", nil)
		bin := t.TempDir()
		if err := os.WriteFile(filepath.Join(bin, "go"), []byte("#!/bin/sh\necho broken >&2\nexit 7\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", bin)
		out, err := secureRoot(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		err = runAnalyze(t.Context(), []string{
			"--source", root, "--profile", writeProfile(t), "--out", out,
		})
		if *hookErr != nil {
			t.Fatal(*hookErr)
		}
		if err == nil || !strings.Contains(err.Error(), "resolve selected Go version") ||
			!strings.Contains(err.Error(), "cleanup bootstrap directory") {
			t.Fatalf("bootstrap cleanup failure did not preserve both errors: %v", err)
		}
	})

	t.Run("worker", func(t *testing.T) {
		root := copyFixture(t, "complete")
		var prepareErr error
		hookErr := installFailure(t, ".go2gs-worker-", "worker-probe", func(directory ownedTempDir) {
			prepareErr = os.Mkdir(filepath.Join(directory.path, "profile.json"), 0o700)
		})
		out, err := secureRoot(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		err = runAnalyze(t.Context(), []string{
			"--source", root, "--profile", writeProfile(t), "--out", out,
		})
		if *hookErr != nil {
			t.Fatal(*hookErr)
		}
		if prepareErr != nil {
			t.Fatal(prepareErr)
		}
		if err == nil || !strings.Contains(err.Error(), "cleanup worker directory") {
			t.Fatalf("worker cleanup failure was not surfaced: %v", err)
		}
	})

	t.Run("analysis work", func(t *testing.T) {
		root := copyFixture(t, "complete")
		hookErr := installFailure(t, ".go2gs-work-", "work-probe", nil)
		analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
		if *hookErr != nil {
			t.Fatal(*hookErr)
		}
		if !complete || !analysis.InventoryComplete {
			t.Fatalf("fixture did not complete before cleanup: %#v", analysis.Blockers)
		}
		if err == nil || !strings.Contains(err.Error(), "cleanup analysis work directory") {
			t.Fatalf("work cleanup failure was not surfaced: %v", err)
		}
	})
}

func TestLoadFailureReplacesStaleSuccessfulArtifacts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("controlled CGo loader failure fixture")
	}
	root := copyFixture(t, "pkgconfig")
	out := t.TempDir()
	out, err := secureRoot(out)
	if err != nil {
		t.Fatal(err)
	}
	profilePath := filepath.Join(t.TempDir(), "profile.json")
	profile := testProfile()
	profile.CGOEnabled = true
	profile.CCompiler = approvedCompiler(t)
	profileBytes, err := marshalCanonical(profile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(profilePath, profileBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"analysis.json", "run.json"} {
		if err := os.WriteFile(filepath.Join(out, name), []byte("stale-success"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	release, err := lockAndInvalidateOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	err = runAnalyzeWorker(t.Context(), []string{"--source", root, "--profile", profilePath, "--out", out})
	var exitErr *exitError
	if !errors.As(err, &exitErr) || exitErr.code != 1 {
		t.Fatalf("invalid package should produce an incomplete inventory, got %v", err)
	}
	analysis, err := readAnalysis(filepath.Join(out, "analysis.json"))
	if err != nil {
		t.Fatal(err)
	}
	if analysis.InventoryComplete || !hasBlockerCategory(analysis, "pkg-config") {
		t.Fatalf("load failure did not replace stale success: %#v", analysis.Blockers)
	}
	if data, err := os.ReadFile(filepath.Join(out, "run.json")); err != nil || bytes.Equal(data, []byte("stale-success")) {
		t.Fatalf("run metadata was not replaced: %q, %v", data, err)
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

func TestManifestSnapshotRejectsSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("controlled symlink fixture")
	}
	for _, name := range []string{"go.mod", "go.sum", filepath.Join("vendor", "modules.txt")} {
		t.Run(filepath.ToSlash(name), func(t *testing.T) {
			root := copyFixture(t, "complete")
			path := filepath.Join(root, name)
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			_ = os.Remove(path)
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.WriteFile(outside, []byte("module outside\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, path); err != nil {
				t.Fatal(err)
			}
			if _, err := snapshotManifests(root, testProfile().Limits.MaxLocalHashBytes); err == nil {
				t.Fatalf("symlinked manifest %s was accepted", name)
			}
		})
	}
}

func TestManifestSnapshotDetectsLoadTimeDrift(t *testing.T) {
	for _, test := range []struct {
		name   string
		path   string
		create string
		mutate func(*testing.T, string)
	}{
		{"change-go-mod", "go.mod", "", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("module example.com/changed\n\ngo 1.27.0\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"delete-go-sum", "go.sum", "example.com/module v1.0.0 h1:test\n", func(t *testing.T, path string) {
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}},
		{"replace-vendor-manifest", filepath.Join("vendor", "modules.txt"), "# captured\n", func(t *testing.T, path string) {
			replacement := path + ".replacement"
			if err := os.WriteFile(replacement, []byte("# captured\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(replacement, path); err != nil {
				t.Fatal(err)
			}
		}},
		{"add-go-sum", "go.sum", "", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("added\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := copyFixture(t, "complete")
			path := filepath.Join(root, test.path)
			if test.create != "" {
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(test.create), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			analysis, complete, err := analyzeWithSnapshotHook(t.Context(), root, t.TempDir(), testProfile(), func() {
				test.mutate(t, path)
			})
			if err != nil {
				t.Fatal(err)
			}
			if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "input-drift") {
				t.Fatalf("manifest drift was not fail-closed: complete=%v blockers=%#v", complete, analysis.Blockers)
			}
		})
	}
}

func TestTransientManifestMutationCannotAffectLoader(t *testing.T) {
	baselineRoot := copyFixture(t, "complete")
	baseline, complete, err := analyze(t.Context(), baselineRoot, t.TempDir(), testProfile())
	if err != nil || !complete {
		t.Fatalf("baseline analysis failed: complete=%v err=%v", complete, err)
	}
	want, err := marshalCanonical(baseline)
	if err != nil {
		t.Fatal(err)
	}
	for name, test := range map[string]struct {
		path   string
		mutate func([]byte) []byte
	}{
		"manifest": {"go.mod", func(data []byte) []byte {
			return bytes.Replace(data, []byte("module example.com/go2gsfixture"), []byte("module example.com/transient"), 1)
		}},
		"source": {"main.go", func(data []byte) []byte {
			return bytes.Replace(data, []byte("return int(int64(Identity(outer.Add(3))))"), []byte("return 999"), 1)
		}},
	} {
		t.Run(name, func(t *testing.T) {
			root := copyFixture(t, "complete")
			path := filepath.Join(root, test.path)
			original, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			analysis, complete, err := analyzeWithSnapshotHooks(t.Context(), root, t.TempDir(), testProfile(), func() {
				if writeErr := os.WriteFile(path, test.mutate(original), 0o644); writeErr != nil {
					t.Fatal(writeErr)
				}
			}, func() {
				if writeErr := os.WriteFile(path, original, 0o644); writeErr != nil {
					t.Fatal(writeErr)
				}
			})
			if err != nil || !complete {
				t.Fatalf("transient mutation affected completeness: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
			}
			got, err := marshalCanonical(analysis)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("loader observed transient live %s mutation near: %s", name, firstDifference(string(got), string(want)))
			}
		})
	}
}

func TestExternalReplacementManifestDriftFailsClosed(t *testing.T) {
	for _, test := range []struct {
		name   string
		path   string
		mutate func(*testing.T, string)
	}{
		{"go-mod-change", "go.mod", func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("module example.com/changed\n\ngo 1.23\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"go-sum-delete", "go.sum", func(t *testing.T, path string) {
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}},
		{"vendor-manifest-replace", filepath.Join("vendor", "modules.txt"), func(t *testing.T, path string) {
			replacement := path + ".replacement"
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(replacement, data, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(replacement, path); err != nil {
				t.Fatal(err)
			}
		}},
		{"go-sum-symlink", "go.sum", func(t *testing.T, path string) {
			if runtime.GOOS == "windows" {
				t.Skip("controlled symlink fixture")
			}
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.WriteFile(outside, []byte("outside"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, path); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			root, dependency := externalReplacementFixture(t)
			path := filepath.Join(dependency, test.path)
			original, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			analysis, complete, err := analyzeWithSnapshotHook(t.Context(), root, t.TempDir(), testProfile(), func() {
				test.mutate(t, path)
			})
			if err != nil {
				t.Fatal(err)
			}
			if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "input-drift") {
				t.Fatalf("external manifest drift was not fail-closed: complete=%v blockers=%#v", complete, analysis.Blockers)
			}
			wantPath := "module://example.com/replacement@local/" + filepath.ToSlash(test.path)
			if !slices.ContainsFunc(analysis.Manifests, func(manifest ManifestRecord) bool {
				return manifest.Path == wantPath && manifest.SHA256 == hashBytes(original)
			}) {
				t.Fatalf("captured external manifest missing: %s in %#v", wantPath, analysis.Manifests)
			}
		})
	}
}

func TestTransientExternalReplacementManifestCannotAffectLoader(t *testing.T) {
	root, dependency := externalReplacementFixture(t)
	baseline, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil || !complete {
		t.Fatalf("baseline external replacement failed: complete=%v err=%v", complete, err)
	}
	path := filepath.Join(dependency, "go.mod")
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	analysis, complete, err := analyzeWithSnapshotHooks(t.Context(), root, t.TempDir(), testProfile(), func() {
		if writeErr := os.WriteFile(path, []byte("module example.com/transient\n\ngo 1.23\n"), 0o644); writeErr != nil {
			t.Fatal(writeErr)
		}
	}, func() {
		if writeErr := os.WriteFile(path, original, 0o644); writeErr != nil {
			t.Fatal(writeErr)
		}
	})
	if err != nil || !complete {
		t.Fatalf("transient external manifest affected completeness: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
	}
	want, _ := marshalCanonical(baseline)
	got, _ := marshalCanonical(analysis)
	if !bytes.Equal(got, want) {
		t.Fatalf("loader observed transient external manifest near: %s", firstDifference(string(got), string(want)))
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

func TestGenericMemberIdentityUsesOriginDeclaration(t *testing.T) {
	analyzeFixture := func(withAliasEmbedding bool) map[string][]string {
		t.Helper()
		root := t.TempDir()
		dependency := `package dep
type A[T any] struct{ X T }
func (A[T]) M() {}
func (*A[T]) P() {}
`
		consumer := `package members
import "example.com/genericmembers/dep"
func use(a dep.A[int]) { _ = a.X; a.M(); (&a).P() }
`
		if withAliasEmbedding {
			dependency += "type Alias = A[string]\ntype Z struct{ Alias }\n"
			consumer = `package members
import "example.com/genericmembers/dep"
func use(a dep.A[int], z dep.Z) { _, _ = a.X, z.X; a.M(); z.M(); (&a).P(); (&z).P() }
`
		}
		for name, content := range map[string]string{
			"go.mod":     "module example.com/genericmembers\n\ngo 1.27.0\n",
			"dep/dep.go": dependency,
			"main.go":    consumer,
		} {
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
			t.Fatalf("generic member fixture failed: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
		}
		names := map[string]string{}
		for _, symbol := range analysis.Symbols {
			if symbol.Name == "X" || symbol.Name == "M" || symbol.Name == "P" {
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
	baseline := analyzeFixture(false)
	withAlias := analyzeFixture(true)
	if !reflect.DeepEqual(baseline, withAlias) {
		t.Fatalf("generic instantiation changed canonical member IDs: baseline=%v withAlias=%v", baseline, withAlias)
	}
	for _, name := range []string{"X", "M", "P"} {
		if len(baseline[name]) != 1 {
			t.Fatalf("generic member %s did not have one declaration identity: %v", name, baseline)
		}
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

func TestSchemaV1RejectsMigrationReady(t *testing.T) {
	analysis := validIncompleteAnalysis()
	analysis.Blockers = []BlockerRecord{}
	analysis.RecordCounts = RecordCounts{}
	analysis.InventoryComplete = true
	analysis.MigrationReady = true
	if err := validateAnalysis(analysis); err == nil || !strings.Contains(err.Error(), "migrationReady") {
		t.Fatalf("schema v1 accepted migrationReady=true: %v", err)
	}
}

func TestValidateAnalysisSourceCommitBlockerConsistency(t *testing.T) {
	const expected = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const actual = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	blocker := func(category, blocks string) BlockerRecord {
		return BlockerRecord{
			ID: "blocker:" + category + ":" + blocks, Blocks: blocks, Category: category,
			Message: "test", AffectedUnits: []string{}, DiagnosticIDs: []string{},
		}
	}
	withBlockers := func(analysis Analysis, blockers ...BlockerRecord) Analysis {
		if blockers == nil {
			blockers = []BlockerRecord{}
		}
		analysis.RecordCounts.Total += len(blockers) - len(analysis.Blockers)
		analysis.RecordCounts.Blockers = len(blockers)
		analysis.Blockers = blockers
		return analysis
	}
	complete := withBlockers(validIncompleteAnalysis())
	complete.InventoryComplete = true
	if err := validateAnalysis(complete); err != nil {
		t.Fatalf("matching complete provenance was rejected: %v", err)
	}

	tests := []struct {
		name     string
		analysis Analysis
		want     string
	}{
		{
			name: "complete mismatch without blocker",
			analysis: func() Analysis {
				value := complete
				value.Profile.ExpectedSourceCommit = expected
				value.Profile.ActualSourceCommit = actual
				return value
			}(),
			want: "source commit mismatch",
		},
		{
			name: "incomplete mismatch missing source blocker",
			analysis: func() Analysis {
				value := validIncompleteAnalysis()
				value.Profile.ExpectedSourceCommit = expected
				value.Profile.ActualSourceCommit = actual
				return value
			}(),
			want: "source commit mismatch",
		},
		{
			name: "matching provenance with unexpected source blocker",
			analysis: withBlockers(
				validIncompleteAnalysis(),
				blocker("source", "inventory"),
			),
			want: "source commit mismatch",
		},
		{
			name: "mismatch with migration-only source blocker",
			analysis: func() Analysis {
				value := withBlockers(validIncompleteAnalysis(), blocker("source", "migration"))
				value.Profile.ExpectedSourceCommit = expected
				value.Profile.ActualSourceCommit = actual
				return value
			}(),
			want: "source commit mismatch",
		},
		{
			name: "missing actual commit without source blocker",
			analysis: func() Analysis {
				value := validIncompleteAnalysis()
				value.Profile.ExpectedSourceCommit = expected
				value.Profile.ActualSourceCommit = ""
				return value
			}(),
			want: "missing actual source commit",
		},
		{
			name: "present actual commit with unexpected metadata blocker",
			analysis: withBlockers(
				validIncompleteAnalysis(),
				blocker("source-metadata", "inventory"),
			),
			want: "source-metadata blocker",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := validateAnalysis(test.analysis); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("contradictory source provenance was accepted: %v", err)
			}
		})
	}

	mismatch := withBlockers(validIncompleteAnalysis(), blocker("source", "inventory"))
	mismatch.Profile.ExpectedSourceCommit = expected
	mismatch.Profile.ActualSourceCommit = actual
	if err := validateAnalysis(mismatch); err != nil {
		t.Fatalf("consistent source mismatch was rejected: %v", err)
	}
	missing := withBlockers(validIncompleteAnalysis(), blocker("source-metadata", "inventory"))
	missing.Profile.ExpectedSourceCommit = expected
	missing.Profile.ActualSourceCommit = ""
	if err := validateAnalysis(missing); err != nil {
		t.Fatalf("consistent missing actual source commit was rejected: %v", err)
	}
}

func TestScopeIndexReturnsInnermostContainingScope(t *testing.T) {
	index := newScopeIndex([]scopeRange{
		{start: 1, end: 100, id: "outer"},
		{start: 10, end: 90, id: "middle"},
		{start: 20, end: 30, id: "inner"},
		{start: 25, end: 60, id: "overlap"},
		{start: 110, end: 120, id: "separate"},
	})
	for _, test := range []struct {
		pos  token.Pos
		want string
	}{
		{0, ""},
		{1, "outer"},
		{15, "middle"},
		{20, "inner"},
		{25, "inner"},
		{45, "overlap"},
		{95, "outer"},
		{110, "separate"},
		{120, "separate"},
		{121, ""},
	} {
		if got := index.lookup(test.pos, nil).id; got != test.want {
			t.Errorf("scope at %d = %q, want %q", test.pos, got, test.want)
		}
	}
}

func TestScopeIndexLookupWorkIsSublinear(t *testing.T) {
	const count = 16_384
	ranges := make([]scopeRange, count)
	for index := range ranges {
		start := token.Pos(index*4 + 1)
		ranges[index] = scopeRange{start: start, end: start + 1, id: strconv.Itoa(index)}
	}
	index := newScopeIndex(ranges)
	steps := 0
	for expected, candidate := range ranges {
		if got := index.lookup(candidate.start, &steps).id; got != strconv.Itoa(expected) {
			t.Fatalf("scope lookup %d returned %q", expected, got)
		}
	}
	if steps >= count*40 {
		t.Fatalf("scope lookup performed %d indexed comparisons for %d scopes", steps, count)
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
	for name, absolute := range map[string]bool{"relative": false, "absolute": true} {
		t.Run("operational-"+name, func(t *testing.T) {
			root := copyFixture(t, "replacement")
			if absolute {
				modPath := filepath.Join(root, "go.mod")
				data, err := os.ReadFile(modPath)
				if err != nil {
					t.Fatal(err)
				}
				data = bytes.Replace(data, []byte("./dep"), []byte(filepath.ToSlash(filepath.Join(root, "dep"))), 1)
				if err := os.WriteFile(modPath, data, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			out := t.TempDir()
			work := filepath.Join(out, "work")
			if err := os.Mkdir(work, 0o700); err != nil {
				t.Fatal(err)
			}
			mirror, err := createSourceMirror(root, out, work, testProfile().Limits)
			if err != nil {
				t.Fatal(err)
			}
			operational, err := os.ReadFile(filepath.Join(mirror.root, "go.mod"))
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(operational, []byte(root)) ||
				!bytes.Contains(operational, []byte(filepath.ToSlash(filepath.Join(mirror.root, "dep")))) {
				t.Fatalf("%s in-tree replacement was not rebound to mirror: %s", name, operational)
			}
			analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
			if err != nil || !complete {
				t.Fatalf("%s in-tree replacement failed: complete=%v err=%v blockers=%#v", name, complete, err, analysis.Blockers)
			}
		})
	}
	for _, root := range []string{firstRoot, secondRoot} {
		parent := filepath.Dir(root)
		dependency := filepath.Join(parent, "dep-external")
		if err := os.Rename(filepath.Join(root, "dep"), dependency); err != nil {
			t.Fatal(err)
		}
		modPath := filepath.Join(root, "go.mod")
		data, err := os.ReadFile(modPath)
		if err != nil {
			t.Fatal(err)
		}
		data = bytes.Replace(data, []byte("=> ./dep"), []byte("=> ../dep-external"), 1)
		if err := os.WriteFile(modPath, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	externalFirst, complete, err := analyze(t.Context(), firstRoot, t.TempDir(), testProfile())
	if err != nil || !complete {
		t.Fatalf("external replacement inventory failed: complete=%v err=%v blockers=%#v", complete, err, externalFirst.Blockers)
	}
	externalSecond, complete, err := analyze(t.Context(), secondRoot, t.TempDir(), testProfile())
	if err != nil || !complete {
		t.Fatalf("second external replacement inventory failed: complete=%v err=%v", complete, err)
	}
	externalLeft, _ := marshalCanonical(externalFirst)
	externalRight, _ := marshalCanonical(externalSecond)
	if !bytes.Equal(externalLeft, externalRight) || bytes.Contains(externalLeft, []byte(".go2gs-work-")) {
		t.Fatalf("external replacement mirror affected deterministic output near: %s", firstDifference(string(externalLeft), string(externalRight)))
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

func externalReplacementFixture(t *testing.T) (string, string) {
	t.Helper()
	parent := t.TempDir()
	root := filepath.Join(parent, "source")
	copyTree(t, filepath.Join("testdata", "replacement"), root)
	dependency := filepath.Join(parent, "dep")
	if err := os.Rename(filepath.Join(root, "dep"), dependency); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dependency, "go.sum"), []byte("example.com/test v1.0.0 h1:test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dependency, "vendor"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dependency, "vendor", "modules.txt"), []byte("# captured\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	modPath := filepath.Join(root, "go.mod")
	data, err := os.ReadFile(modPath)
	if err != nil {
		t.Fatal(err)
	}
	data = bytes.Replace(data, []byte("=> ./dep"), []byte("=> ../dep"), 1)
	if err := os.WriteFile(modPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return root, dependency
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

func TestAnalysisWorkerRunnerBoundsLogsAndKillsDescendants(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	result, err := runAnalysisWorkerProcess(t.Context(), 5*time.Second, 1024, "", executable,
		[]string{"-test.run=TestProcessHelper"}, []string{"GO2GS_PROCESS_HELPER=output"})
	if err != nil || !result.StdoutTruncated || !result.StderrTruncated {
		t.Fatalf("worker logs were not bounded: result=%#v err=%v", result, err)
	}
	if runtime.GOOS == "windows" {
		return
	}
	stateDir := t.TempDir()
	marker := filepath.Join(stateDir, "descendant-survived")
	_, err = runAnalysisWorkerProcess(t.Context(), 50*time.Millisecond, 1024, "", executable,
		[]string{"-test.run=TestProcessHelper"}, []string{
			"GO2GS_PROCESS_HELPER=tree",
			"GO2GS_CHILD_MARKER=" + marker,
			"GO2GS_CHILD_PID=" + filepath.Join(stateDir, "child.pid"),
		})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("worker tree was not cancelled: %v", err)
	}
	time.Sleep(700 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("worker descendant survived cancellation: %v", err)
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
		child.Env = []string{
			"GO2GS_PROCESS_HELPER=child-marker",
			"GO2GS_CHILD_MARKER=" + os.Getenv("GO2GS_CHILD_MARKER"),
			"GO2GS_CHILD_DELAY=" + os.Getenv("GO2GS_CHILD_DELAY"),
		}
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(os.Getenv("GO2GS_CHILD_PID"), []byte(strconv.Itoa(child.Process.Pid)), 0o600); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Second)
	case "nested-timeout-worker":
		_, _ = runProcess(inheritProcessGroup(t.Context()), 50*time.Millisecond, 1024, "", os.Args[0],
			[]string{"-test.run=TestProcessHelper"}, []string{
				"GO2GS_PROCESS_HELPER=tree",
				"GO2GS_CHILD_MARKER=" + os.Getenv("GO2GS_CHILD_MARKER"),
				"GO2GS_CHILD_PID=" + os.Getenv("GO2GS_CHILD_PID"),
				"GO2GS_CHILD_DELAY=" + os.Getenv("GO2GS_CHILD_DELAY"),
			})
	case "nested-early-failure-worker":
		child := exec.Command(os.Args[0], "-test.run=TestProcessHelper")
		child.Env = []string{
			"GO2GS_PROCESS_HELPER=tree",
			"GO2GS_CHILD_MARKER=" + os.Getenv("GO2GS_CHILD_MARKER"),
			"GO2GS_CHILD_PID=" + os.Getenv("GO2GS_CHILD_PID"),
			"GO2GS_CHILD_DELAY=" + os.Getenv("GO2GS_CHILD_DELAY"),
		}
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(time.Second)
		for {
			if _, err := os.Stat(os.Getenv("GO2GS_CHILD_PID")); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("nested child did not start")
			}
			time.Sleep(time.Millisecond)
		}
		os.Exit(7)
	case "child-marker":
		delay := 500 * time.Millisecond
		if value := os.Getenv("GO2GS_CHILD_DELAY"); value != "" {
			if parsed, err := time.ParseDuration(value); err == nil {
				delay = parsed
			}
		}
		time.Sleep(delay)
		_ = os.WriteFile(os.Getenv("GO2GS_CHILD_MARKER"), []byte("survived"), 0o600)
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
