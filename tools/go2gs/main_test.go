// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
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
	if len(a1.Embeds) == 0 || len(a1.GenerateDirectives) == 0 {
		t.Fatal("embed and go:generate provenance were not recorded")
	}
	if a1.GenerateDirectives[0].Executed {
		t.Fatal("go:generate directive was executed")
	}

	foundLarge, foundRational, foundComplex, foundArrayLength := false, false, false, false
	for _, value := range a1.Constants {
		foundLarge = foundLarge || strings.Contains(value.Exact, "1234567890123456789012345678901234567890")
		foundRational = foundRational || value.Exact == "1/3"
		foundComplex = foundComplex || (value.RealExact != "" && value.ImaginaryExact != "")
		foundArrayLength = foundArrayLength || value.ArrayLength
	}
	if !foundLarge || !foundRational || !foundComplex || !foundArrayLength {
		t.Fatalf("lossless constants missing: large=%v rational=%v complex=%v array-length=%v", foundLarge, foundRational, foundComplex, foundArrayLength)
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
	analysis := Analysis{Schema: SchemaHandshake{Name: schemaName, Version: schemaVersion, RequiredRecordKinds: []string{"future-required"}}}
	if err := validateAnalysis(analysis); err == nil || !strings.Contains(err.Error(), "unknown required") {
		t.Fatalf("expected unknown required kind rejection, got %v", err)
	}
	analysis = Analysis{
		Schema:   SchemaHandshake{Name: schemaName, Version: schemaVersion},
		Packages: []PackageRecord{{ID: "package:1", ImportPackageIDs: []string{"package:missing"}}},
	}
	if err := validateAnalysis(analysis); err == nil || !strings.Contains(err.Error(), "dangling") {
		t.Fatalf("expected dangling id rejection, got %v", err)
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

func TestProcessHelper(t *testing.T) {
	switch os.Getenv("GO2GS_PROCESS_HELPER") {
	case "output":
		chunk := strings.Repeat("x", 10000)
		_, _ = os.Stdout.WriteString(chunk)
		_, _ = os.Stderr.WriteString(chunk)
	case "sleep":
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
