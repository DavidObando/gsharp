// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"runtime/debug"
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
		CCompilerHelpers:   []CompilerHelper{},
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
			CCompilerHelpers:     []CompilerHelperIdentity{},
			ArchitectureFeatures: []string{}, BuildTags: []string{}, GOFLAGS: []string{},
			GODEBUG: map[string]string{}, ModuleMode: "readonly", WorkspaceMode: "off",
			Offline: true, TrustBoundary: "test", Limits: testProfile().Limits,
		},
		Toolchain: ToolchainProvenance{
			RequestedVersion: "1.0", ActualVersion: "1.0",
			HelperSemanticVersion: "1.0", GOROOTVersion: "1.0", ExecutableSHA256: hash,
			ExecutableName:      "go",
			GOROOTIdentity:      stableID("goroot", "1.0\x001.0\x001.0\x00"+hash+"\x00"+hash),
			GOROOTVersionSHA256: hash, GOROOTSource: "test",
			CCompilerHelpers: []CompilerHelperIdentity{},
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
	refreshSourceIdentity(&analysis)
	return analysis
}

func refreshSourceIdentity(analysis *Analysis) {
	analysis.Profile.SourceRootIdentity = sourceIdentity(analysis.Profile.ActualSourceCommit, analysis.Manifests)
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

func TestGoPackageInputClassifierMatchesGo127(t *testing.T) {
	for _, extension := range []string{
		".go", ".c", ".cc", ".cpp", ".cxx", ".m",
		".h", ".hh", ".hpp", ".hxx",
		".f", ".F", ".for", ".f90",
		".s", ".S", ".sx", ".swig", ".swigcxx", ".syso",
	} {
		if !recognizedGoPackageInput("input" + extension) {
			t.Errorf("Go 1.27 package input %s was not recognized", extension)
		}
	}
	for _, extension := range []string{".C", ".H", ".mm", ".txt", ""} {
		if recognizedGoPackageInput("input" + extension) {
			t.Errorf("non-Go 1.27 package input %s was recognized", extension)
		}
	}
}

func TestDefensiveNativeMutationDoesNotCreateDrift(t *testing.T) {
	for _, name := range []string{"native.c", "inactive.S", "inactive.sx"} {
		t.Run(name, func(t *testing.T) {
			root := copyFixture(t, "cgo")
			path := filepath.Join(root, name)
			if name != "native.c" {
				if err := os.WriteFile(path, []byte("#include \"native.h\"\n"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
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
			index := slices.IndexFunc(analysis.Files, func(file FileRecord) bool { return file.Path == "source://"+name })
			if index < 0 || analysis.Files[index].Role != "ignored" {
				t.Fatalf("defensive input was not retained as ignored: %#v", analysis.Files)
			}
			data, err := base64.StdEncoding.DecodeString(analysis.Files[index].ContentBase64)
			if err != nil || !bytes.Equal(data, original) {
				t.Fatalf("defensive input did not use captured bytes: %q, %v", data, err)
			}
		})
	}
}

func TestCgoInventoryUsesSourceWithoutNativeToolchain(t *testing.T) {
	profile := testProfile()
	profile.CGOEnabled = true
	analysis, complete, err := analyze(t.Context(), copyFixture(t, "cgo"), t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "cgo") ||
		!hasBlockerCategory(analysis, "native") {
		t.Fatalf("CGo source was not fail-closed: %#v", analysis.Blockers)
	}
	for _, name := range []string{"cgo.go", "native.h", "native.c"} {
		path := "source://" + name
		if !slices.ContainsFunc(analysis.Files, func(file FileRecord) bool {
			if file.Path != path {
				return false
			}
			if name == "cgo.go" {
				return file.Role == "active"
			}
			return file.Role == "native"
		}) {
			t.Fatalf("captured CGo input %s missing: %#v", path, analysis.Files)
		}
	}
	if analysis.Toolchain.CCompilerName != "" || analysis.Toolchain.CCompilerSHA256 != "" ||
		len(analysis.Toolchain.CCompilerHelpers) != 0 {
		t.Fatalf("obsolete compiler provenance was emitted: %#v", analysis.Toolchain)
	}
}

func TestCgoInventoryHonorsNativeAndTestBuildConstraints(t *testing.T) {
	root := copyFixture(t, "cgo")
	for name, content := range map[string]string{
		"native.s":            "//go:build windows\n\nTEXT ·ignored(SB),$0\n",
		"cgo_windows_test.go": "package cgofixture\n\n/* int ignored(void); */\nimport \"C\"\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	profile := testProfile()
	profile.CGOEnabled = true
	profile.GOOS = "linux"
	analysis, _, err := analyze(t.Context(), root, t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"native.s", "cgo_windows_test.go"} {
		path := "source://" + name
		index := slices.IndexFunc(analysis.Files, func(file FileRecord) bool { return file.Path == path })
		if index < 0 || analysis.Files[index].Role != "ignored" || analysis.Files[index].Native {
			t.Fatalf("build-rejected input %s was selected: %#v", path, analysis.Files)
		}
	}
}

func TestProfileRejectsObsoleteCompilerConfiguration(t *testing.T) {
	for name, mutate := range map[string]func(*Profile){
		"compiler": func(profile *Profile) { profile.CCompiler = "/usr/bin/cc" },
		"helper": func(profile *Profile) {
			profile.CCompilerHelpers = []CompilerHelper{{Name: "cc1", Path: "/usr/bin/cc1", SHA256: strings.Repeat("0", 64)}}
		},
	} {
		t.Run(name, func(t *testing.T) {
			profile := testProfile()
			mutate(&profile)
			path := filepath.Join(t.TempDir(), "profile.json")
			data, err := json.Marshal(profile)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := readProfile(path); err == nil || !strings.Contains(err.Error(), "obsolete") {
				t.Fatalf("obsolete compiler configuration was accepted: %v", err)
			}
		})
	}
}

func TestProfileRejectsUnsupportedSemanticSettings(t *testing.T) {
	for name, mutate := range map[string]func(*Profile){
		"goexperiment": func(profile *Profile) { profile.GOEXPERIMENT = "boringcrypto" },
		"gotypesalias": func(profile *Profile) { profile.GODEBUG = map[string]string{"gotypesalias": "0"} },
		"case-variant": func(profile *Profile) { profile.GODEBUG = map[string]string{"GOTYPESALIAS": "0"} },
		"malformed":    func(profile *Profile) { profile.GODEBUG = map[string]string{"gotypesalias": "maybe"} },
	} {
		t.Run(name, func(t *testing.T) {
			profile := testProfile()
			mutate(&profile)
			path := writeTestProfile(t, profile)
			if _, err := readProfile(path); err == nil ||
				(!strings.Contains(err.Error(), "goExperiment") && !strings.Contains(err.Error(), "goDebug")) {
				t.Fatalf("unsupported semantic setting was accepted: %v", err)
			}
		})
	}

	profileBytes, err := json.Marshal(testProfile())
	if err != nil {
		t.Fatal(err)
	}
	duplicate := bytes.Replace(profileBytes, []byte(`"moduleMode"`),
		[]byte(`"goDebug":{"gotypesalias":"0","gotypesalias":"1"},"moduleMode"`), 1)
	path := filepath.Join(t.TempDir(), "profile.json")
	if err := os.WriteFile(path, duplicate, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readProfile(path); err == nil || !strings.Contains(err.Error(), "goDebug") {
		t.Fatalf("duplicate semantic debug setting was accepted: %v", err)
	}
}

func TestOfficialGoVersionNormalization(t *testing.T) {
	for _, test := range []struct {
		value         string
		requirePrefix bool
		want          string
	}{
		{"1.27", false, "1.27"},
		{"1.27.1", false, "1.27.1"},
		{"go1.27", true, "1.27"},
		{"go1.27.1", true, "1.27.1"},
	} {
		if got, err := normalizeOfficialGoVersion(test.value, test.requirePrefix); err != nil || got != test.want {
			t.Fatalf("normalize %q = %q, %v; want %q", test.value, got, err, test.want)
		}
	}
	for _, value := range []string{
		"go1.27rc1", "go1.27beta1", "devel go1.28-abc", "go1.27.1-custom",
		"go1.027.1", "go1.27.01", "1.27.1", "go2.0",
	} {
		if got, err := normalizeOfficialGoVersion(value, true); err == nil {
			t.Fatalf("unsupported Go version %q normalized to %q", value, got)
		}
	}
	for _, data := range [][]byte{
		[]byte("go1.27.1\n"),
		[]byte("go1.27.1\ntime 2026-08-28T16:20:06Z\n"),
	} {
		if got, err := parseGOROOTVersion(data); err != nil || got != "1.27.1" {
			t.Fatalf("parse GOROOT VERSION = %q, %v", got, err)
		}
	}
	for _, data := range [][]byte{
		[]byte("go1.27rc1\n"),
		[]byte("devel go1.28\n"),
		[]byte("go1.27.1\ncustom\n"),
	} {
		if got, err := parseGOROOTVersion(data); err == nil {
			t.Fatalf("unsupported GOROOT VERSION normalized to %q", got)
		}
	}
}

func TestSemanticGoVersionAgreement(t *testing.T) {
	if err := validateSemanticGoVersions("1.27.1", "1.27.1", "1.27.1"); err != nil {
		t.Fatalf("matching semantic versions were rejected: %v", err)
	}
	for _, test := range []struct {
		selected string
		goroot   string
		helper   string
	}{
		{"1.27.1", "1.27.2", "1.27.1"},
		{"1.27.1", "1.27.1", "1.27.2"},
		{"1.27.2", "1.27.1", "1.27.1"},
	} {
		if err := validateSemanticGoVersions(test.selected, test.goroot, test.helper); err == nil {
			t.Fatalf("semantic mismatch was accepted: %#v", test)
		}
	}
}

func TestHelperSemanticBuildSettingsRejectOverrides(t *testing.T) {
	if err := validateHelperBuildSettings(nil); err != nil {
		t.Fatalf("empty helper build settings were rejected: %v", err)
	}
	for _, setting := range []debug.BuildSetting{
		{Key: "GOEXPERIMENT", Value: "boringcrypto"},
		{Key: "DefaultGODEBUG", Value: "gotypesalias=0"},
	} {
		if err := validateHelperBuildSettings([]debug.BuildSetting{setting}); err == nil {
			t.Fatalf("helper semantic build setting was accepted: %#v", setting)
		}
	}
}

func TestSelectedGoGOROOTVersionMismatchFailsBeforePackageLoad(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	goData, err := os.ReadFile(filepath.Join(runtime.GOROOT(), "bin", selectedGoName()))
	if err != nil {
		t.Fatal(err)
	}
	selectedGo := filepath.Join(root, "bin", selectedGoName())
	if err := os.WriteFile(selectedGo, goData, 0o755); err != nil {
		t.Fatal(err)
	}
	actual, err := normalizeOfficialGoVersion(runtime.Version(), true)
	if err != nil {
		t.Fatal(err)
	}
	other := actual + ".1"
	if strings.Count(actual, ".") == 2 {
		parts := strings.Split(actual, ".")
		patch, parseErr := strconv.Atoi(parts[2])
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		other = parts[0] + "." + parts[1] + "." + strconv.Itoa(patch+1)
	}
	if err := os.WriteFile(filepath.Join(root, "VERSION"), []byte("go"+other+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO2GS_SELECTED_GO", selectedGo)
	t.Setenv("GO2GS_SELECTED_GO_SHA256", hashBytes(goData))
	t.Setenv("GO2GS_SELECTED_GOROOT", root)
	loads := 0
	packageLoadTestHook = func(string) { loads++ }
	t.Cleanup(func() { packageLoadTestHook = nil })
	if _, _, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), testProfile()); err == nil ||
		!strings.Contains(err.Error(), "canonical Go version labels differ") {
		t.Fatalf("selected/GOROOT mismatch was accepted: %v", err)
	}
	if loads != 0 {
		t.Fatalf("semantic mismatch reached packages.Load %d times", loads)
	}
}

func TestSelectedGoScriptIsRejectedBeforeDelegateExecution(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("controlled shell executable fixture")
	}
	marker := filepath.Join(t.TempDir(), "selected-go-ran")
	selectedGo := filepath.Join(t.TempDir(), selectedGoName())
	body := "#!/bin/sh\n: > " + strconv.Quote(marker) + "\nexec " +
		strconv.Quote(filepath.Join(runtime.GOROOT(), "bin", "go")) + " \"$@\"\n"
	if err := os.WriteFile(selectedGo, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO2GS_SELECTED_GO", selectedGo)
	t.Setenv("GO2GS_SELECTED_GO_SHA256", hashBytes([]byte(body)))
	_, _, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), testProfile())
	if err == nil {
		t.Fatalf("selected Go script was accepted: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("selected Go delegate executed: %v", err)
	}
}

func TestSelectedPathContainsOnlyPrivateStagedDirectories(t *testing.T) {
	first := filepath.Join(string(filepath.Separator), "private-tools")
	second := filepath.Join(string(filepath.Separator), "private-helpers")
	paths := filepath.SplitList(selectedPath(first, second))
	if !slices.Equal(paths, []string{first, second}) {
		t.Fatalf("PATH contains an unstaged directory: %v", paths)
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

func TestSelectedHXXAndSXIncludesAreCaptured(t *testing.T) {
	root := copyFixture(t, "cgo")
	for name, content := range map[string]string{
		"carrier.hxx":  "#include \"nested_hxx.h\"\n",
		"carrier.sx":   "#include \"nested_sx.h\"\n",
		"nested_hxx.h": "#define HXX_VALUE 1\n",
		"nested_sx.h":  "#define SX_VALUE 2\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	profile := testProfile()
	profile.CGOEnabled = true
	analysis, _, err := analyze(t.Context(), root, t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if hasBlockerCategory(analysis, "native-include") {
		t.Fatalf("valid .hxx/.sx include closure produced a blocker: %#v", analysis.Blockers)
	}
	for _, name := range []string{"carrier.hxx", "carrier.sx", "nested_hxx.h", "nested_sx.h"} {
		if !slices.ContainsFunc(analysis.Files, func(file FileRecord) bool {
			return file.Path == "source://"+name && file.Role == "native"
		}) {
			t.Fatalf("selected native include %s was not captured: %#v", name, analysis.Files)
		}
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
	reachable, unsafe := selectedNativeIncludes(pkg, nil, snapshot)
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
	profile.CCompiler = "cc"
	data, err = json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readProfile(path); err == nil || !strings.Contains(err.Error(), "obsolete") {
		t.Fatalf("expected obsolete C compiler rejection, got %v", err)
	}
	profile.CGOEnabled = false
	profile.CCompiler = ""
	profile.Limits.MaxPackages = 1
	if _, _, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), profile); err == nil || !strings.Contains(err.Error(), "package count") {
		t.Fatalf("expected package limit rejection, got %v", err)
	}
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

func TestProfileRejectsMalformedExpectedSourceCommit(t *testing.T) {
	profile := testProfile()
	profile.ExpectedSourceCommit = "not-a-commit"
	data, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "profile.json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := readProfile(path); err == nil || !strings.Contains(err.Error(), "expectedSourceCommit") {
		t.Fatalf("malformed expected source commit was accepted: %v", err)
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

func TestPublicAnalyzeNeedsNoAmbientGoAfterStaging(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("public analyze requires Linux execution binding")
	}
	requireExecutableNamespaceTest(t)
	binary := buildGo2gsBinary(t)
	toolDir := t.TempDir()
	if err := os.Symlink(filepath.Join(runtime.GOROOT(), "bin", "go"), filepath.Join(toolDir, selectedGoName())); err != nil {
		t.Fatal(err)
	}
	profilePath := writeTestProfile(t, testProfile())
	out, err := secureRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "analyze", "--source", copyFixture(t, "complete"), "--profile", profilePath, "--out", out)
	cmd.Env = replaceEnvironment(os.Environ(), "PATH", toolDir)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("public analyze failed without ambient Go: %v\n%s", err, output)
	}
	analysis, err := readAnalysis(filepath.Join(out, "analysis.json"))
	if err != nil || !analysis.InventoryComplete {
		t.Fatalf("public analysis was incomplete: %v %#v", err, analysis.Blockers)
	}
}

func TestPublicCgoAnalysisExecutesNoNativeTools(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("public analyze requires Linux execution binding")
	}
	requireExecutableNamespaceTest(t)
	binary := buildGo2gsBinary(t)
	ambient := t.TempDir()
	selected := t.TempDir()
	if err := os.Symlink(filepath.Join(runtime.GOROOT(), "bin", "go"), filepath.Join(selected, selectedGoName())); err != nil {
		t.Fatal(err)
	}
	var markers []string
	for _, directory := range []string{ambient, selected} {
		for _, name := range []string{"cc", "gcc", "clang", "pkg-config", "as", "ld", "cc1", "collect2", "gofmt"} {
			marker := filepath.Join(t.TempDir(), name+"-ran")
			markers = append(markers, marker)
			body := "#!/bin/sh\n: > " + strconv.Quote(marker) + "\nexit 99\n"
			if err := os.WriteFile(filepath.Join(directory, name), []byte(body), 0o755); err != nil {
				t.Fatal(err)
			}
		}
	}
	profile := testProfile()
	profile.CGOEnabled = true
	profilePath := writeTestProfile(t, profile)
	out, err := secureRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "analyze", "--source", copyFixture(t, "cgo"), "--profile", profilePath, "--out", out)
	cmd.Env = replaceEnvironment(os.Environ(), "PATH", selectedPath(ambient, selected))
	if output, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("CGo inventory unexpectedly completed:\n%s", output)
	}
	analysis, err := readAnalysis(filepath.Join(out, "analysis.json"))
	if err != nil || !hasBlockerCategory(analysis, "cgo") || !hasBlockerCategory(analysis, "native") {
		t.Fatalf("CGo/native blockers missing: %v %#v", err, analysis.Blockers)
	}
	for _, name := range []string{"cgo.go", "native.h", "native.c"} {
		if !slices.ContainsFunc(analysis.Files, func(file FileRecord) bool { return file.Path == "source://"+name }) {
			t.Fatalf("source-level CGo/native input %s missing", name)
		}
	}
	for _, marker := range markers {
		if _, err := os.Stat(marker); !os.IsNotExist(err) {
			t.Fatalf("hostile native tool executed: %s: %v", marker, err)
		}
	}
}

func buildGo2gsBinary(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "go2gs")
	cmd := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", path, ".")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build go2gs: %v\n%s", err, output)
	}
	return path
}

func writeTestProfile(t *testing.T, profile Profile) string {
	t.Helper()
	data, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "profile.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
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
	output, err := lockAndInvalidateOutput(out)
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
	if err := publishWorkerArtifacts(output, []byte("new analysis"), []byte("new run"), func() {
		if mkdirErr := os.Mkdir(filepath.Join(out, "run.json"), 0o755); mkdirErr != nil {
			t.Fatal(mkdirErr)
		}
	}); err == nil {
		t.Fatal("worker publish unexpectedly succeeded")
	}
	if _, err := os.Lstat(filepath.Join(out, "analysis.json")); !os.IsNotExist(err) {
		t.Fatalf("failed publish retained analysis.json: %v", err)
	}
	if err := output.release(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(out, ".go2gs-lock")); !os.IsNotExist(err) {
		t.Fatalf("output lock was not released: %v", err)
	}
}

func TestStaleInvalidationRejectsObservedIdentityDrift(t *testing.T) {
	out := t.TempDir()
	path := filepath.Join(out, "analysis.json")
	displaced := filepath.Join(out, "displaced-analysis")
	if err := os.WriteFile(path, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	outputBeforeStaleRemoveHook = func(name string) {
		if name != "analysis.json" {
			return
		}
		outputBeforeStaleRemoveHook = nil
		if err := os.Rename(path, displaced); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("replacement"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { outputBeforeStaleRemoveHook = nil })
	if _, err := lockAndInvalidateOutput(out); err == nil {
		t.Fatal("stale invalidation succeeded after observed identity drift")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "replacement" {
		t.Fatalf("mismatched replacement changed: %q, %v", data, err)
	}
}

func TestBoundOutputRootRejectsStaleSymlinks(t *testing.T) {
	out := t.TempDir()
	target := filepath.Join(out, "target")
	path := filepath.Join(out, "analysis.json")
	if err := os.WriteFile(target, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := lockAndInvalidateOutput(out); err == nil {
		t.Fatal("stale symlink was accepted")
	}
	if destination, err := os.Readlink(path); err != nil || destination != target {
		t.Fatalf("stale symlink changed: %q, %v", destination, err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "keep" {
		t.Fatalf("symlink target changed: %q, %v", data, err)
	}
}

func TestArtifactPairRejectsObservedAnalysisReplacement(t *testing.T) {
	out := t.TempDir()
	output, err := lockAndInvalidateOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	defer output.release()
	err = publishWorkerArtifacts(output, []byte("owned analysis"), []byte("owned run"), func() {
		path := filepath.Join(out, "analysis.json")
		if err := os.Rename(path, path+".owned"); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("replacement"), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	if err == nil {
		t.Fatal("publication succeeded after observed analysis identity drift")
	}
	if data, err := os.ReadFile(filepath.Join(out, "analysis.json")); err != nil || string(data) != "replacement" {
		t.Fatalf("mismatched analysis replacement changed: %q, %v", data, err)
	}
	if _, err := os.Lstat(filepath.Join(out, "run.json")); !os.IsNotExist(err) {
		t.Fatalf("run.json was published after analysis drift: %v", err)
	}
}

func TestBoundOutputRootResistsAncestorReplacement(t *testing.T) {
	base := t.TempDir()
	ancestor := filepath.Join(base, "ancestor")
	out := filepath.Join(ancestor, "out")
	displaced := filepath.Join(base, "displaced")
	if err := os.MkdirAll(out, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"analysis.json", "run.json"} {
		if err := os.WriteFile(filepath.Join(out, name), []byte("original stale"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	outputRootBoundHook = func() {
		outputRootBoundHook = nil
		if err := os.Rename(ancestor, displaced); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(out, 0o700); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"analysis.json", "run.json"} {
			if err := os.WriteFile(filepath.Join(out, name), []byte("attacker"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Cleanup(func() { outputRootBoundHook = nil })
	output, err := lockAndInvalidateOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(displaced, "out")
	for _, name := range []string{"analysis.json", "run.json"} {
		if _, err := os.Lstat(filepath.Join(original, name)); !os.IsNotExist(err) {
			t.Fatalf("bound stale output %s remains: %v", name, err)
		}
		if data, err := os.ReadFile(filepath.Join(out, name)); err != nil || string(data) != "attacker" {
			t.Fatalf("replacement output %s changed: %q, %v", name, data, err)
		}
	}
	if err := publishWorkerArtifacts(output, []byte("bound analysis"), []byte("bound run"), nil); err != nil {
		t.Fatal(err)
	}
	if err := output.release(); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"analysis.json": "bound analysis",
		"run.json":      "bound run",
	} {
		if data, err := os.ReadFile(filepath.Join(original, name)); err != nil || string(data) != want {
			t.Fatalf("bound output %s = %q, %v", name, data, err)
		}
		if data, err := os.ReadFile(filepath.Join(out, name)); err != nil || string(data) != "attacker" {
			t.Fatalf("replacement output %s changed after publish: %q, %v", name, data, err)
		}
	}
	if _, err := os.Lstat(filepath.Join(original, ".go2gs-lock")); !os.IsNotExist(err) {
		t.Fatalf("bound lock was not released: %v", err)
	}
}

func TestBoundOutputRootReleaseFailsAfterLockLoss(t *testing.T) {
	for _, test := range []struct {
		name   string
		attack func(string) error
	}{
		{
			name: "removed",
			attack: func(lock string) error {
				return os.Remove(lock)
			},
		},
		{
			name: "replaced",
			attack: func(lock string) error {
				if err := os.Remove(lock); err != nil {
					return err
				}
				return os.Mkdir(lock, 0o700)
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			out := t.TempDir()
			output, err := lockAndInvalidateOutput(out)
			if err != nil {
				t.Fatal(err)
			}
			if err := test.attack(filepath.Join(out, ".go2gs-lock")); err != nil {
				t.Fatal(err)
			}
			if err := output.release(); err == nil {
				t.Fatal("release succeeded after output lock identity loss")
			}
			if test.name == "replaced" {
				if info, err := os.Lstat(filepath.Join(out, ".go2gs-lock")); err != nil || !info.IsDir() {
					t.Fatalf("mismatched replacement lock changed: %v, %v", info, err)
				}
			}
		})
	}
}

func TestOutputReleaseFailureOverridesIncompleteExit(t *testing.T) {
	err := joinOutputReleaseError(
		&exitError{1, errors.New("inventory incomplete")},
		errors.New("output ownership lost"),
	)
	var exitErr *exitError
	if !errors.As(err, &exitErr) || exitErr.code != 2 {
		t.Fatalf("release failure did not take exit-code precedence: %v", err)
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
			var replacementErr error
			previous := tempCleanupPlaceholderCreatedHook
			tempCleanupPlaceholderCreatedHook = func(directoryPath, name, _ string) {
				if name != "1999" || replacementErr != nil {
					return
				}
				target := filepath.Join(directoryPath, name)
				displaced := target + ".owned"
				if replacementErr = os.Rename(target, displaced); replacementErr != nil {
					return
				}
				if replacement == "symlink" {
					outside := filepath.Join(filepath.Dir(directoryPath), "valuable-target")
					if replacementErr = os.WriteFile(outside, []byte("valuable"), 0o600); replacementErr != nil {
						return
					}
					replacementErr = os.Symlink(outside, target)
					return
				}
				replacementErr = os.WriteFile(target, []byte("valuable"), 0o600)
			}
			t.Cleanup(func() { tempCleanupPlaceholderCreatedHook = previous })
			err = directory.cleanupWithHooks(nil, func(path string) {
				tombstone = path
			})
			if replacementErr != nil {
				t.Fatal(replacementErr)
			}
			if err == nil ||
				(!strings.Contains(err.Error(), "remains non-empty") &&
					!strings.Contains(err.Error(), "quarantine identity changed")) {
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
		if runtime.GOOS != "linux" {
			t.Skip("public analyze requires Linux execution binding")
		}
		root := copyFixture(t, "complete")
		hookErr := installFailure(t, ".go2gs-bootstrap-", "bootstrap-probe", nil)
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
		if err == nil || !strings.Contains(err.Error(), "cleanup bootstrap directory") {
			t.Fatalf("bootstrap cleanup failure was not surfaced: %v", err)
		}
	})

	t.Run("worker", func(t *testing.T) {
		if runtime.GOOS != "linux" {
			t.Skip("public analyze requires Linux execution binding")
		}
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
	output, err := lockAndInvalidateOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	defer output.release()
	goExecutable := filepath.Join(runtime.GOROOT(), "bin", selectedGoName())
	goData, err := os.ReadFile(goExecutable)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO2GS_SELECTED_GO", goExecutable)
	t.Setenv("GO2GS_SELECTED_GO_SHA256", hashBytes(goData))
	t.Setenv("GO2GS_SELECTED_GOROOT", runtime.GOROOT())
	analysis, complete, err := analyze(t.Context(), root, out, profile)
	if err != nil || complete {
		t.Fatalf("invalid package should produce an incomplete inventory, complete=%v err=%v", complete, err)
	}
	analysisBytes, err := writeAnalysis(filepath.Join(out, "analysis.json"), analysis, profile.Limits.MaxOutputBytes)
	if err != nil {
		t.Fatal(err)
	}
	run := RunMetadata{SchemaVersion: schemaVersion, AnalysisBytes: int64(analysisBytes)}
	if err := writeJSON(filepath.Join(out, "run.json"), run, profile.Limits.MaxOutputBytes); err != nil {
		t.Fatal(err)
	}
	analysis, err = readAnalysis(filepath.Join(out, "analysis.json"))
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

func TestPackageInputSetDriftCoversAllRecognizedExtensions(t *testing.T) {
	for _, cgoEnabled := range []bool{false, true} {
		for _, operation := range []string{"add", "remove", "rename"} {
			t.Run(fmt.Sprintf("cgo=%t/%s", cgoEnabled, operation), func(t *testing.T) {
				root := copyFixture(t, "complete")
				var mutate func()
				switch operation {
				case "add":
					path := filepath.Join(root, "added.hxx")
					mutate = func() {
						if err := os.WriteFile(path, []byte("#define ADDED 1\n"), 0o644); err != nil {
							t.Fatal(err)
						}
					}
				case "remove":
					path := filepath.Join(root, "removed.sx")
					if err := os.WriteFile(path, []byte("#include \"textflag.h\"\n"), 0o644); err != nil {
						t.Fatal(err)
					}
					mutate = func() {
						if err := os.Remove(path); err != nil {
							t.Fatal(err)
						}
					}
				case "rename":
					path := filepath.Join(root, "renamed.syso")
					if err := os.WriteFile(path, []byte("object"), 0o644); err != nil {
						t.Fatal(err)
					}
					mutate = func() {
						if err := os.Rename(path, filepath.Join(root, "replacement.syso")); err != nil {
							t.Fatal(err)
						}
					}
				}
				profile := testProfile()
				profile.CGOEnabled = cgoEnabled
				analysis, complete, err := analyzeWithSnapshotHook(t.Context(), root, t.TempDir(), profile, mutate)
				if err != nil {
					t.Fatal(err)
				}
				if complete || analysis.InventoryComplete || !hasBlockerCategory(analysis, "input-drift") {
					t.Fatalf("recognized input %s was not detected with CGO_ENABLED=%t: %#v", operation, cgoEnabled, analysis.Blockers)
				}
			})
		}
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
	mismatch.Toolchain.RequestedVersion = "1.1"
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
	for _, owner := range []string{"profile", "toolchain"} {
		var helperRaw map[string]any
		if err := json.Unmarshal(validData, &helperRaw); err != nil {
			t.Fatal(err)
		}
		delete(helperRaw[owner].(map[string]any), "cCompilerHelpers")
		missingHelpers, err := json.Marshal(helperRaw)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, missingHelpers, 0o644); err != nil {
			t.Fatal(err)
		}
		err = runValidate([]string{"--analysis", path})
		if !errors.As(err, &exitErr) || exitErr.code != 2 {
			t.Fatalf("missing %s compiler helper provenance should exit 2, got %v", owner, err)
		}
	}
	for _, field := range []string{"helperSemanticVersion", "gorootVersion"} {
		var provenanceRaw map[string]any
		if err := json.Unmarshal(validData, &provenanceRaw); err != nil {
			t.Fatal(err)
		}
		delete(provenanceRaw["toolchain"].(map[string]any), field)
		missingProvenance, err := json.Marshal(provenanceRaw)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, missingProvenance, 0o644); err != nil {
			t.Fatal(err)
		}
		err = runValidate([]string{"--analysis", path})
		if !errors.As(err, &exitErr) || exitErr.code != 2 {
			t.Fatalf("missing %s should exit 2, got %v", field, err)
		}
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
	complete, loaded, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), testProfile())
	if err != nil || !loaded {
		t.Fatalf("build complete validation fixture: loaded=%v err=%v", loaded, err)
	}
	complete = withBlockers(complete)
	complete.Profile.ExpectedSourceCommit = expected
	complete.Profile.ActualSourceCommit = expected
	refreshSourceIdentity(&complete)
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
				refreshSourceIdentity(&value)
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
				refreshSourceIdentity(&value)
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
				refreshSourceIdentity(&value)
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
				refreshSourceIdentity(&value)
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
		{
			name: "matching malformed commit IDs",
			analysis: func() Analysis {
				value := complete
				value.Profile.ExpectedSourceCommit = "not-a-commit"
				value.Profile.ActualSourceCommit = "not-a-commit"
				return value
			}(),
			want: "source commits",
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
	refreshSourceIdentity(&mismatch)
	if err := validateAnalysis(mismatch); err != nil {
		t.Fatalf("consistent source mismatch was rejected: %v", err)
	}
	missing := withBlockers(validIncompleteAnalysis(), blocker("source-metadata", "inventory"))
	missing.Profile.ExpectedSourceCommit = expected
	missing.Profile.ActualSourceCommit = ""
	refreshSourceIdentity(&missing)
	if err := validateAnalysis(missing); err != nil {
		t.Fatalf("consistent missing actual source commit was rejected: %v", err)
	}
}

func TestValidateAnalysisRejectsForgedCompletePreloadArtifact(t *testing.T) {
	profile := testProfile()
	profile.RequestedGoVersion = "1.26.6"
	if profile.RequestedGoVersion == strings.TrimPrefix(runtime.Version(), "go") {
		profile.RequestedGoVersion = "1.26.7"
	}
	analysis, complete, err := analyzePreload(t.Context(), copyFixture(t, "complete"), t.TempDir(), profile)
	if err != nil || complete || !hasBlockerCategory(analysis, "toolchain") {
		t.Fatalf("build preload artifact: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
	}
	analysis.Toolchain.RequestedVersion = analysis.Toolchain.ActualVersion
	analysis.RecordCounts.Total -= len(analysis.Blockers)
	analysis.RecordCounts.Blockers = 0
	analysis.Blockers = []BlockerRecord{}
	analysis.InventoryComplete = true
	if err := validateAnalysis(analysis); err == nil ||
		!strings.Contains(err.Error(), "loaded modules, packages, and source files") {
		t.Fatalf("forged complete preload artifact was accepted: %v", err)
	}
}

func TestPreloadAnalysisEnforcesFinalRecordLimit(t *testing.T) {
	profile := testProfile()
	profile.RequestedGoVersion = "1.26.6"
	if profile.RequestedGoVersion == strings.TrimPrefix(runtime.Version(), "go") {
		profile.RequestedGoVersion = "1.26.7"
	}
	profile.ExpectedSourceCommit = strings.Repeat("a", 40)
	root := copyFixture(t, "complete")
	analysis, complete, err := analyzePreload(t.Context(), root, t.TempDir(), profile)
	if err != nil || complete || len(analysis.Blockers) < 2 {
		t.Fatalf("expected multiple preload blockers: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
	}
	profile.Limits.MaxRecords = analysis.RecordCounts.Total
	if _, _, err := analyzePreload(t.Context(), root, t.TempDir(), profile); err != nil {
		t.Fatalf("exact preload record limit was rejected: %v", err)
	}
	profile.Limits.MaxRecords--
	rejected, complete, err := analyzePreload(t.Context(), root, t.TempDir(), profile)
	if err == nil || !strings.Contains(err.Error(), "record count exceeds limit") {
		t.Fatalf("over-limit preload analysis was accepted: complete=%v err=%v", complete, err)
	}
	if rejected.Schema.Name != "" || len(rejected.Blockers) != 0 {
		t.Fatalf("over-limit preload analysis returned a publishable artifact: %#v", rejected)
	}
}

func TestValidateAnalysisRejectsSourceRootIdentityMutation(t *testing.T) {
	analysis := validIncompleteAnalysis()
	analysis.Profile.SourceRootIdentity = stableID("source", "forged")
	if err := validateAnalysis(analysis); err == nil || !strings.Contains(err.Error(), "source root identity") {
		t.Fatalf("forged source root identity was accepted: %v", err)
	}
}

func TestValidateAnalysisRejectsUTF8FlagMutation(t *testing.T) {
	root := copyFixture(t, "complete")
	appendInvalidUTF8(t, filepath.Join(root, "ignored_windows.go"))
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil || !complete {
		t.Fatalf("fixture analysis failed: complete=%v err=%v", complete, err)
	}
	for _, valid := range []bool{true, false} {
		index := slices.IndexFunc(analysis.Files, func(file FileRecord) bool { return file.ValidUTF8 == valid })
		if index < 0 {
			t.Fatalf("fixture has no validUtf8=%t file", valid)
		}
		mutated := analysis
		mutated.Files = append([]FileRecord{}, analysis.Files...)
		mutated.Files[index].ValidUTF8 = !valid
		if err := validateAnalysis(mutated); err == nil || !strings.Contains(err.Error(), "content identity") {
			t.Fatalf("validUtf8=%t mutation was accepted: %v", valid, err)
		}
	}
}

func TestValidateAnalysisRejectsSemanticVersionProvenanceMutation(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*Analysis)
	}{
		{"helper", func(analysis *Analysis) { analysis.Toolchain.HelperSemanticVersion = "1.1" }},
		{"goroot", func(analysis *Analysis) { analysis.Toolchain.GOROOTVersion = "1.1" }},
		{"prerelease", func(analysis *Analysis) {
			analysis.Toolchain.ActualVersion = "1.0rc1"
			analysis.Toolchain.HelperSemanticVersion = "1.0rc1"
			analysis.Toolchain.GOROOTVersion = "1.0rc1"
		}},
		{"coordinated-version-forgery", func(analysis *Analysis) {
			analysis.Toolchain.RequestedVersion = "1.1"
			analysis.Toolchain.ActualVersion = "1.1"
			analysis.Toolchain.HelperSemanticVersion = "1.1"
			analysis.Toolchain.GOROOTVersion = "1.1"
		}},
		{"goexperiment", func(analysis *Analysis) { analysis.Profile.GOEXPERIMENT = "boringcrypto" }},
		{"godebug", func(analysis *Analysis) { analysis.Profile.GODEBUG = map[string]string{"gotypesalias": "0"} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			analysis := validIncompleteAnalysis()
			test.mutate(&analysis)
			if err := validateAnalysis(analysis); err == nil {
				t.Fatal("semantic provenance mutation was accepted")
			}
		})
	}
}

func TestValidateAnalysisRequiresCompleteLoadedOwnershipGraph(t *testing.T) {
	analysis, complete, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), testProfile())
	if err != nil || !complete {
		t.Fatalf("build complete artifact: complete=%v err=%v", complete, err)
	}
	tests := []struct {
		name   string
		mutate func(*Analysis)
		want   string
	}{
		{"modules", func(value *Analysis) {
			value.Modules = []ModuleRecord{}
			value.RecordCounts.Total -= value.RecordCounts.Modules
			value.RecordCounts.Modules = 0
		}, ""},
		{"packages", func(value *Analysis) {
			value.Packages = []PackageRecord{}
			value.RecordCounts.Total -= value.RecordCounts.Packages
			value.RecordCounts.Packages = 0
		}, ""},
		{"files", func(value *Analysis) {
			value.Files = []FileRecord{}
			value.RecordCounts.Total -= value.RecordCounts.Files
			value.RecordCounts.Files = 0
		}, ""},
		{"main-module", func(value *Analysis) {
			value.Modules = append([]ModuleRecord{}, value.Modules...)
			for index := range value.Modules {
				value.Modules[index].Main = false
			}
		}, "main module"},
		{"compiled-ownership", func(value *Analysis) {
			mainModules := map[string]bool{}
			for _, module := range value.Modules {
				if module.Main {
					mainModules[module.ID] = true
				}
			}
			value.Packages = append([]PackageRecord{}, value.Packages...)
			for index := range value.Packages {
				if mainModules[value.Packages[index].ModuleID] {
					value.Packages[index].CompiledFileIDs = []string{}
				}
			}
		}, "owned source and compiled files"},
		{"typed-file-root", func(value *Analysis) {
			for index := range value.Packages {
				value.Packages[index].InitializationOrder = []InitializationRecord{}
			}
			value.RecordCounts.Total -= value.RecordCounts.Types + value.RecordCounts.Symbols +
				value.RecordCounts.Nodes + value.RecordCounts.Constants + value.RecordCounts.Scopes +
				value.RecordCounts.Selections + value.RecordCounts.Calls + value.RecordCounts.MethodSets +
				value.RecordCounts.Instances + value.RecordCounts.FeatureSites
			value.RecordCounts.Types = 0
			value.RecordCounts.Symbols = 0
			value.RecordCounts.Nodes = 0
			value.RecordCounts.Constants = 0
			value.RecordCounts.Scopes = 0
			value.RecordCounts.Selections = 0
			value.RecordCounts.Calls = 0
			value.RecordCounts.MethodSets = 0
			value.RecordCounts.Instances = 0
			value.RecordCounts.FeatureSites = 0
			value.Types = []TypeRecord{}
			value.Symbols = []SymbolRecord{}
			value.Nodes = []NodeRecord{}
			value.Constants = []ConstantRecord{}
			value.Scopes = []ScopeRecord{}
			value.Selections = []SelectionRecord{}
			value.Calls = []CallRecord{}
			value.MethodSets = []MethodSetRecord{}
			value.Instances = []InstanceRecord{}
			value.FeatureSites = []FeatureSite{}
		}, "*ast.File node"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mutated := analysis
			test.mutate(&mutated)
			if err := validateAnalysis(mutated); err == nil ||
				(test.want != "" && !strings.Contains(err.Error(), test.want)) {
				t.Fatalf("invalid complete artifact was accepted: %v", err)
			}
		})
	}
}

func TestValidateAnalysisAllowsMinimalLoadedEmptyPackage(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module example.com/empty\n\ngo 1.27\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "empty.go"), []byte("package empty\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), testProfile())
	if err != nil || !complete {
		t.Fatalf("minimal empty package did not load: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
	}
	if err := validateAnalysis(analysis); err != nil {
		t.Fatalf("minimal empty package artifact was rejected: %v", err)
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

func TestScopeParentValidationCompletesLargeChainWithinLinearBudget(t *testing.T) {
	const count = 100_000
	scopes := make([]ScopeRecord, count)
	byID := make(map[string]ScopeRecord, count)
	for index := range scopes {
		scopes[index] = ScopeRecord{ID: strconv.Itoa(index), PackageID: "package:test"}
		if index > 0 {
			scopes[index].ParentID = strconv.Itoa(index - 1)
		}
		byID[scopes[index].ID] = scopes[index]
	}
	start := time.Now()
	if err := validateScopeParents(scopes, byID); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("scope parent validation took %s for %d scopes; indexed validation must remain near-linear", elapsed, count)
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
		{"line-directive-display-path", func(root map[string]any) bool {
			span := directiveSpan(root)
			if span == nil {
				return false
			}
			span["displayPath"] = "line://forged.go"
			return true
		}},
		{"line-directive-display-line", func(root map[string]any) bool {
			span := directiveSpan(root)
			if span == nil {
				return false
			}
			span["displayLine"] = span["displayLine"].(float64) + 1
			return true
		}},
		{"line-directive-display-column", func(root map[string]any) bool {
			span := directiveSpan(root)
			if span == nil {
				return false
			}
			span["displayColumn"] = span["displayColumn"].(float64) + 1
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
	env, err := sanitizedEnvironment(testProfile(), t.TempDir(), runtime.GOROOT(), filepath.Dir(goExecutable))
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

func TestSourceCoordinateCountsBytes(t *testing.T) {
	positions, err := newSourcePositionMap("source://main.go", []byte("é\nx"))
	if err != nil {
		t.Fatal(err)
	}
	raw, _, _, _, _, _ := positions.span(len("é"), len("é"))
	if raw.Line != 1 || raw.Column != 3 {
		t.Fatalf("UTF-8 byte coordinate mismatch: line=%d column=%d", raw.Line, raw.Column)
	}
}

func TestSourcePositionMapHandlesLineDirectiveGrammar(t *testing.T) {
	tests := []struct {
		name      string
		source    string
		marker    string
		path      string
		line      int
		column    int
		directive bool
	}{
		{
			name: "line-crlf", source: "package p\r\n//line logical/generated.go:40\r\nvar X int\r\n",
			marker: "var X", path: "line://dir/logical/generated.go", line: 40, column: 0, directive: true,
		},
		{
			name: "block-column", source: "package p\nvar _ = /*line block.go:7:9*/ 1\n",
			marker: " 1", path: "line://dir/block.go", line: 7, column: 9, directive: true,
		},
		{
			name: "default", source: "package p\nvar X int\n",
			marker: "var X", path: "source://dir/main.go", line: 2, column: 1, directive: false,
		},
		{
			name: "module-relative", source: "package p\n//line logical/generated.go:12\nvar X int\n",
			marker: "var X", path: "line://dir/logical/generated.go", line: 12, column: 0, directive: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			portable := "source://dir/main.go"
			if test.name == "module-relative" {
				portable = "module://example.com/replacement@local/dir/main.go"
			}
			positions, err := newSourcePositionMap(portable, []byte(test.source))
			if err != nil {
				t.Fatal(err)
			}
			offset := strings.Index(test.source, test.marker)
			if offset < 0 {
				t.Fatal("marker not found")
			}
			_, _, path, line, column, directive := positions.span(offset, offset)
			if path != test.path || line != test.line || column != test.column || directive != test.directive {
				t.Fatalf("display position = %s:%d:%d directive=%v", path, line, column, directive)
			}
		})
	}
}

func TestArchitectureFeatureTagsMatchGoCommand(t *testing.T) {
	tests := []struct {
		name, goos, goarch string
		features           []string
		tag                string
		selected           bool
	}{
		{"amd64-cumulative", "linux", "amd64", []string{"v3"}, "amd64.v2", true},
		{"amd64-future", "linux", "amd64", []string{"v3"}, "amd64.v4", false},
		{"arm-cumulative", "linux", "arm", []string{"7"}, "arm.6", true},
		{"arm64-v9-correspondence", "linux", "arm64", []string{"v9.1"}, "arm64.v8.6", true},
		{"arm64-too-new", "linux", "arm64", []string{"v9.1"}, "arm64.v8.7", false},
		{"ppc64-cumulative", "linux", "ppc64le", []string{"power10"}, "ppc64le.power9", true},
		{"riscv64-cumulative", "linux", "riscv64", []string{"rva23u64"}, "riscv64.rva22u64", true},
		{"386-exact", "linux", "386", []string{"softfloat"}, "386.sse2", false},
		{"wasm-always-enabled", "js", "wasm", nil, "wasm.signext", true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			settings, err := resolveArchitectureSettings(test.goarch, test.features)
			if err != nil {
				t.Fatal(err)
			}
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module example.com/featuretest\n\ngo 1.27.0\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "base.go"), []byte("package featuretest\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			const featureFile = "feature.go"
			source := "//go:build " + test.tag + "\n\npackage featuretest\n"
			if err := os.WriteFile(filepath.Join(root, featureFile), []byte(source), 0o644); err != nil {
				t.Fatal(err)
			}
			context := build.Default
			context.GOOS, context.GOARCH = test.goos, test.goarch
			context.ToolTags = settings.toolTags
			matched, err := context.MatchFile(root, featureFile)
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(filepath.Join(runtime.GOROOT(), "bin", selectedGoName()), "list", "-json", ".")
			cmd.Dir = root
			cmd.Env = os.Environ()
			for _, setting := range [][2]string{
				{"GOOS", test.goos},
				{"GOARCH", test.goarch},
				{"CGO_ENABLED", "0"},
				{"GOTOOLCHAIN", "local"},
				{settings.variable, settings.value},
			} {
				cmd.Env = replaceEnvironment(cmd.Env, setting[0], setting[1])
			}
			output, err := cmd.Output()
			if err != nil {
				t.Fatalf("go list: %v", err)
			}
			var listed struct {
				GoFiles []string
			}
			if err := json.Unmarshal(output, &listed); err != nil {
				t.Fatal(err)
			}
			commandSelected := slices.Contains(listed.GoFiles, featureFile)
			if matched != test.selected || commandSelected != test.selected {
				t.Fatalf("selection: go/build=%v cmd/go=%v want=%v tags=%v", matched, commandSelected, test.selected, settings.toolTags)
			}
		})
	}
}

func TestArchitectureFeatureValidationRejectsInvalidValues(t *testing.T) {
	tests := []struct {
		goarch   string
		features []string
	}{
		{"amd64", []string{"v5"}},
		{"amd64", []string{"v2", "v3"}},
		{"arm64", []string{"v9.6"}},
		{"arm64", []string{"v8.1", "v9.0"}},
		{"arm", []string{"8"}},
		{"ppc64", []string{"power11"}},
		{"wasm", []string{"simd"}},
		{"loong64", []string{"v1"}},
	}
	for _, test := range tests {
		if _, err := resolveArchitectureSettings(test.goarch, test.features); err == nil {
			t.Errorf("accepted GOARCH=%s features=%v", test.goarch, test.features)
		}
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

func TestEffectiveBuildTagsMergeProfileAndGOFLAGS(t *testing.T) {
	profile := testProfile()
	profile.BuildTags = []string{"profile_tag", "duplicate"}
	profile.GOFLAGS = []string{"-tags=flag_tag,duplicate", "-trimpath", "-tags", "second_flag"}
	tags, err := effectiveBuildTags(profile)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"duplicate", "flag_tag", "profile_tag", "second_flag"}; !slices.Equal(tags, want) {
		t.Fatalf("effective tags = %v, want %v", tags, want)
	}
	remaining, _, err := splitGOFLAGS(profile.GOFLAGS)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"-trimpath"}; !slices.Equal(remaining, want) {
		t.Fatalf("non-tag GOFLAGS = %v, want %v", remaining, want)
	}
	for _, flags := range [][]string{{"-tags", "two words"}, {"-tags=x,,y"}, {"-tags="}, {"-tags"}} {
		if _, _, err := splitGOFLAGS(flags); err == nil {
			t.Fatalf("malformed tag flags accepted: %v", flags)
		}
	}
}

func TestGOFLAGSTagsSelectPackagesAndInProcessSyntaxConsistently(t *testing.T) {
	root := t.TempDir()
	for name, content := range map[string]string{
		"go.mod":     "module example.com/tags\n\ngo 1.27\n",
		"base.go":    "package tags\n",
		"profile.go": "//go:build profile_tag\n\npackage tags\n\nvar Profile = 1\n",
		"flag.go":    "//go:build flag_tag\n\npackage tags\n\nvar Flag = 1\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	profile := testProfile()
	profile.BuildTags = []string{"profile_tag"}
	profile.GOFLAGS = []string{"-tags", "flag_tag,profile_tag"}
	analysis, complete, err := analyze(t.Context(), root, t.TempDir(), profile)
	if err != nil || !complete {
		t.Fatalf("tagged analysis failed: complete=%v err=%v blockers=%#v", complete, err, analysis.Blockers)
	}
	for _, name := range []string{"profile.go", "flag.go"} {
		path := "source://" + name
		fileIndex := slices.IndexFunc(analysis.Files, func(file FileRecord) bool {
			return file.Path == path && file.Role == "compiled"
		})
		if fileIndex < 0 {
			t.Fatalf("effective tag did not compile %s: %#v", path, analysis.Files)
		}
		fileID := analysis.Files[fileIndex].ID
		if !slices.ContainsFunc(analysis.Nodes, func(node NodeRecord) bool {
			return node.FileID == fileID && node.Kind == "*ast.File"
		}) {
			t.Fatalf("compiled tagged file %s lacks typed syntax", path)
		}
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

func directiveSpan(root map[string]any) map[string]any {
	for _, raw := range root["nodes"].([]any) {
		span := raw.(map[string]any)["span"].(map[string]any)
		if directive, _ := span["lineDirective"].(bool); directive {
			return span
		}
	}
	return nil
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
	result, err := runProcessWithMode(t.Context(), 5*time.Second, 1024, "", executable,
		[]string{"-test.run=TestProcessHelper"}, []string{"GO2GS_PROCESS_HELPER=output"}, processGroupOwn)
	if err != nil || !result.StdoutTruncated || !result.StderrTruncated {
		t.Fatalf("worker logs were not bounded: result=%#v err=%v", result, err)
	}
	if runtime.GOOS == "windows" {
		return
	}
	stateDir := t.TempDir()
	marker := filepath.Join(stateDir, "descendant-survived")
	_, err = runProcessWithMode(t.Context(), 50*time.Millisecond, 1024, "", executable,
		[]string{"-test.run=TestProcessHelper"}, []string{
			"GO2GS_PROCESS_HELPER=tree",
			"GO2GS_CHILD_MARKER=" + marker,
			"GO2GS_CHILD_PID=" + filepath.Join(stateDir, "child.pid"),
		}, processGroupOwn)
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
	env, err := sanitizedEnvironment(testProfile(), t.TempDir(), runtime.GOROOT(), filepath.Dir(executable))
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
