// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPublicAnalyzeMatchingProfileInvalidatesBeforeUnsupportedBinding(t *testing.T) {
	root := copyFixture(t, "complete")
	out := secureTestRoot(t)
	keep := filepath.Join(out, "keep.txt")
	for name, content := range map[string]string{
		"analysis.json": "stale analysis",
		"run.json":      "stale run",
		"keep.txt":      "keep",
	} {
		if err := os.WriteFile(filepath.Join(out, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	loads := 0
	packageLoadTestHook = func(string) { loads++ }
	t.Cleanup(func() { packageLoadTestHook = nil })

	err := runAnalyze(t.Context(), []string{
		"--source", root,
		"--profile", writeTestProfile(t, testProfile()),
		"--out", out,
	})
	var exitErr *exitError
	if !errors.As(err, &exitErr) || exitErr.code != 2 ||
		!strings.Contains(err.Error(), unsupportedExecutionBinding) {
		t.Fatalf("public analyze did not report unsupported execution binding: %v", err)
	}
	if loads != 0 {
		t.Fatalf("unsupported preload called packages.Load %d times", loads)
	}
	for _, name := range []string{"analysis.json", "run.json"} {
		if _, statErr := os.Lstat(filepath.Join(out, name)); !os.IsNotExist(statErr) {
			t.Fatalf("unsupported matching analysis retained %s: %v", name, statErr)
		}
	}
	if data, readErr := os.ReadFile(keep); readErr != nil || string(data) != "keep" {
		t.Fatalf("unrelated output changed: %q, %v", data, readErr)
	}
}

func TestPublicAnalyzeVersionMismatchPublishesDeterministicPreloadArtifacts(t *testing.T) {
	root := copyFixture(t, "complete")
	profile := testProfile()
	profile.RequestedGoVersion = "1.26.6"
	if profile.RequestedGoVersion == strings.TrimPrefix(runtime.Version(), "go") {
		profile.RequestedGoVersion = "1.26.7"
	}
	firstAnalysis, firstRun := runPreloadMismatch(t, root, profile)
	secondAnalysis, secondRun := runPreloadMismatch(t, root, profile)
	if string(firstAnalysis) != string(secondAnalysis) || string(firstRun) != string(secondRun) {
		t.Fatal("preload mismatch artifacts are not deterministic")
	}
	analysis, err := decodeAnalysis(firstAnalysis)
	if err != nil || analysis.InventoryComplete || !hasBlockerCategory(analysis, "toolchain") ||
		len(analysis.Packages) != 0 {
		t.Fatalf("invalid toolchain mismatch artifact: %v %#v", err, analysis.Blockers)
	}
}

func TestPublicAnalyzeSourceMismatchPublishesConsistentBlocker(t *testing.T) {
	root := copyFixture(t, "complete")
	actual := strings.Repeat("a", 40)
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte(actual+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	profile := testProfile()
	profile.ExpectedSourceCommit = strings.Repeat("b", 40)
	analysisBytes, _ := runPreloadMismatch(t, root, profile)
	analysis, err := decodeAnalysis(analysisBytes)
	if err != nil || analysis.Profile.ActualSourceCommit != actual ||
		!hasBlockerCategory(analysis, "source") || hasBlockerCategory(analysis, "toolchain") {
		t.Fatalf("invalid source mismatch artifact: %v %#v", err, analysis.Blockers)
	}
}

func TestCliampProfileMismatchDoesNotExecuteNativeToolsOrLoadPackages(t *testing.T) {
	root := copyFixture(t, "complete")
	marker := filepath.Join(secureTestRoot(t), "native-ran")
	toolDir := secureTestRoot(t)
	sourceGo := filepath.Join(runtime.GOROOT(), "bin", selectedGoName())
	selectedGo := filepath.Join(toolDir, selectedGoName())
	var stageErr error
	if runtime.GOOS == "windows" {
		var data []byte
		data, stageErr = os.ReadFile(sourceGo)
		if stageErr == nil {
			stageErr = os.WriteFile(selectedGo, data, 0o755)
		}
	} else {
		stageErr = os.Symlink(sourceGo, selectedGo)
	}
	if stageErr != nil {
		t.Fatal(stageErr)
	}
	for _, name := range []string{"cc", "gcc", "clang", "pkg-config", "as", "ld"} {
		if err := os.WriteFile(filepath.Join(toolDir, name), []byte("#!/bin/sh\n: > \""+marker+"\"\nexit 99\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", toolDir)
	loads := 0
	packageLoadTestHook = func(string) { loads++ }
	t.Cleanup(func() { packageLoadTestHook = nil })

	var artifacts [2][2][]byte
	for index := range artifacts {
		out := secureTestRoot(t)
		err := runAnalyze(t.Context(), []string{
			"--source", root,
			"--profile", filepath.Join("profiles", "cliamp-m0.json"),
			"--out", out,
		})
		var exitErr *exitError
		if !errors.As(err, &exitErr) || exitErr.code != 1 {
			t.Fatalf("cliamp mismatch should exit 1, got %v", err)
		}
		for artifactIndex, name := range []string{"analysis.json", "run.json"} {
			artifacts[index][artifactIndex], err = os.ReadFile(filepath.Join(out, name))
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	if string(artifacts[0][0]) != string(artifacts[1][0]) ||
		string(artifacts[0][1]) != string(artifacts[1][1]) {
		t.Fatal("cliamp preload mismatch artifacts are not deterministic")
	}
	analysis, readErr := decodeAnalysis(artifacts[0][0])
	if readErr != nil || validateAnalysis(analysis) != nil || !hasBlockerCategory(analysis, "toolchain") {
		t.Fatalf("cliamp toolchain blocker missing or invalid: %v %#v", readErr, analysis.Blockers)
	}
	if loads != 0 {
		t.Fatalf("cliamp preload called packages.Load %d times", loads)
	}
	if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
		t.Fatalf("native tool executed: %v", statErr)
	}
}

func runPreloadMismatch(t *testing.T, root string, profile Profile) ([]byte, []byte) {
	t.Helper()
	out := secureTestRoot(t)
	keep := filepath.Join(out, "keep.txt")
	if err := os.WriteFile(keep, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"analysis.json", "run.json"} {
		if err := os.WriteFile(filepath.Join(out, name), []byte("stale"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	err := runAnalyze(t.Context(), []string{
		"--source", root,
		"--profile", writeTestProfile(t, profile),
		"--out", out,
	})
	var exitErr *exitError
	if !errors.As(err, &exitErr) || exitErr.code != 1 {
		t.Fatalf("preload mismatch should exit 1, got %v", err)
	}
	analysis, err := os.ReadFile(filepath.Join(out, "analysis.json"))
	if err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(keep); err != nil || string(data) != "keep" {
		t.Fatalf("unrelated output changed: %q, %v", data, err)
	}
	run, err := os.ReadFile(filepath.Join(out, "run.json"))
	if err != nil {
		t.Fatal(err)
	}
	var metadata RunMetadata
	if err := json.Unmarshal(run, &metadata); err != nil || metadata.ColdLoadNanoseconds != 0 ||
		metadata.PeakRSSBytes != 0 || metadata.AnalysisBytes != int64(len(analysis)) {
		t.Fatalf("invalid deterministic preload run metadata: %v %#v", err, metadata)
	}
	return analysis, run
}

func secureTestRoot(t *testing.T) string {
	t.Helper()
	root, err := secureRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}
