// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"bufio"
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestWorkerPublicationCancellationUsesProductionBoundary(t *testing.T) {
	if !enterExecutableNamespaceTest(t) {
		return
	}
	configureWorkerTestGo(t)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	publicationBoundaryTestHook = func(stage string) {
		if stage == "worker" {
			cancel()
		}
	}
	t.Cleanup(func() { publicationBoundaryTestHook = nil })
	out := t.TempDir()
	err := runAnalyzeWorker(ctx, []string{
		"--source", copyFixture(t, "complete"),
		"--profile", writeTestProfile(t, testProfile()),
		"--out", out,
	})
	assertCanceledExitTwoWithoutArtifacts(t, err, out)
}

func TestWorkerEncodingCancellationUsesProductionContext(t *testing.T) {
	if !enterExecutableNamespaceTest(t) {
		return
	}
	configureWorkerTestGo(t)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	publicationEntered := false
	artifactEncodingTestHook = func(stage string) {
		if stage == "start" {
			cancel()
		}
	}
	t.Cleanup(func() { artifactEncodingTestHook = nil })
	publicationBoundaryTestHook = func(string) { publicationEntered = true }
	t.Cleanup(func() { publicationBoundaryTestHook = nil })
	out := t.TempDir()
	err := runAnalyzeWorker(ctx, []string{
		"--source", copyFixture(t, "complete"),
		"--profile", writeTestProfile(t, testProfile()),
		"--out", out,
	})
	assertCanceledExitTwoWithoutArtifacts(t, err, out)
	if publicationEntered {
		t.Fatal("worker publication entered after encoding cancellation")
	}
}

func configureWorkerTestGo(t *testing.T) {
	t.Helper()
	realGo := filepath.Join(runtime.GOROOT(), "bin", selectedGoName())
	data, err := os.ReadFile(realGo)
	if err != nil {
		t.Fatal(err)
	}
	selectedGo := filepath.Join(t.TempDir(), selectedGoName())
	if err := os.WriteFile(selectedGo, data, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO2GS_SELECTED_GO", selectedGo)
	t.Setenv("GO2GS_SELECTED_GO_SHA256", hashBytes(data))
	t.Setenv("GO2GS_SELECTED_GOROOT", runtime.GOROOT())
}

func TestParentWorkerArtifactCancellationUsesProductionPath(t *testing.T) {
	requireExecutableNamespaceTest(t)
	for _, phase := range []string{"analysis-read", "run-read", "parent"} {
		t.Run(phase, func(t *testing.T) {
			runAnalysisWorkerProcessTestHook = func(
				_ context.Context,
				_ time.Duration,
				_ int,
				_ string,
				_ string,
				args []string,
				_ []string,
			) (processResult, error) {
				_, _, out, err := parseAnalyzeArgs(args[1:])
				if err != nil {
					return processResult{}, err
				}
				analysisBytes, runBytes, err := encodeAnalysisArtifacts(
					validIncompleteAnalysis(),
					RunMetadata{SchemaVersion: schemaVersion},
					1<<20,
				)
				if err != nil {
					return processResult{}, err
				}
				if err := os.WriteFile(filepath.Join(out, "analysis.json"), analysisBytes, 0o600); err != nil {
					return processResult{}, err
				}
				if err := os.WriteFile(filepath.Join(out, "run.json"), runBytes, 0o600); err != nil {
					return processResult{}, err
				}
				return processResult{ExitCode: 1}, nil
			}
			t.Cleanup(func() { runAnalysisWorkerProcessTestHook = nil })
			ctx, cancel := context.WithCancel(t.Context())
			t.Cleanup(cancel)
			targetEntered := false
			laterEntered := false
			readChunks := 0
			readArmed := false
			if phase != "parent" {
				boundedReadChunkHook = func() {
					readChunks++
					if readArmed {
						readArmed = false
						cancel()
					}
				}
				t.Cleanup(func() { boundedReadChunkHook = nil })
			}
			if phase == "parent" {
				publicationBoundaryTestHook = func(stage string) {
					if stage == phase {
						targetEntered = true
						cancel()
					}
				}
				t.Cleanup(func() { publicationBoundaryTestHook = nil })
			} else {
				workerArtifactReadTestHook = func(stage string) {
					if stage == phase {
						targetEntered = true
						readChunks = 0
						readArmed = true
					} else if targetEntered {
						laterEntered = true
					}
				}
				t.Cleanup(func() { workerArtifactReadTestHook = nil })
				publicationBoundaryTestHook = func(string) {
					if targetEntered {
						laterEntered = true
					}
				}
				t.Cleanup(func() { publicationBoundaryTestHook = nil })
			}
			out := t.TempDir()
			err := runAnalyze(ctx, []string{
				"--source", copyFixture(t, "complete"),
				"--profile", writeTestProfile(t, testProfile()),
				"--out", out,
			})
			assertCanceledExitTwoWithoutArtifacts(t, err, out)
			if !targetEntered {
				t.Fatalf("%s production hook was not reached", phase)
			}
			if laterEntered {
				t.Fatalf("production path advanced after cancellation in %s", phase)
			}
			if phase == "analysis-read" && readChunks != 1 {
				t.Fatalf("analysis read processed %d chunks after cancellation", readChunks)
			}
			if phase == "run-read" && readChunks != 1 {
				t.Fatalf("run read processed %d chunks after cancellation", readChunks)
			}
		})
	}
}

func assertCanceledExitTwoWithoutArtifacts(t *testing.T, err error, out string) {
	t.Helper()
	var exitErr *exitError
	if !errors.As(err, &exitErr) || exitErr.code != 2 || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation returned %v", err)
	}
	for _, name := range []string{"analysis.json", "run.json"} {
		if _, statErr := os.Lstat(filepath.Join(out, name)); !os.IsNotExist(statErr) {
			t.Fatalf("cancelled production path retained %s: %v", name, statErr)
		}
	}
}

func TestImmutableExecutableCapsuleFailsClosedWithoutMountCapability(t *testing.T) {
	if os.Getenv("GO2GS_NAMESPACE_FAIL_CLOSED_CONTROL") == t.Name() {
		return
	}
	if os.Getenv("GO2GS_NAMESPACE_FAIL_CLOSED_TEST") != t.Name() {
		args := []string{"-test.run=^" + regexp.QuoteMeta(t.Name()) + "$"}
		cmd := exec.Command(os.Args[0], args...)
		cmd.Env = append(os.Environ(), "GO2GS_NAMESPACE_FAIL_CLOSED_TEST="+t.Name(), "GO2GS_EXEC_NAMESPACE=1")
		if err := configureAnalysisWorkerNamespace(cmd); err != nil {
			t.Fatal(err)
		}
		var output strings.Builder
		cmd.Stdout = &output
		cmd.Stderr = &output
		if err := cmd.Start(); err != nil {
			control := exec.Command(os.Args[0], args...)
			control.Env = append(os.Environ(), "GO2GS_NAMESPACE_FAIL_CLOSED_CONTROL="+t.Name())
			unavailable, controlErr := confirmNamespaceStartUnavailable(err, control)
			if unavailable {
				t.Setenv("GO2GS_EXEC_NAMESPACE", "")
				assertImmutableCapsuleFailsBeforeStaging(t, "analysis requires the private executable mount namespace")
				return
			}
			t.Fatalf("start fail-closed namespace child: %v; control: %v", err, controlErr)
		}
		err := cmd.Wait()
		if err == nil {
			return
		}
		t.Fatalf("fail-closed namespace child failed unexpectedly: %v\n%s", err, output.String())
	}
	header := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	data := [2]unix.CapUserData{}
	if err := unix.Capset(&header, &data[0]); err != nil {
		t.Fatal(err)
	}
	assertImmutableCapsuleFailsBeforeStaging(t, "make executable mount namespace private")
}

func assertImmutableCapsuleFailsBeforeStaging(t *testing.T, wantError string) {
	t.Helper()
	root, err := secureRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	capsule, err := createExecutableCapsule(root, []capturedExecutable{{
		name: "helper", data: []byte("#!/bin/sh\nexit 0\n"), mode: 0o755,
	}}, true)
	if err == nil {
		_ = capsule.close()
		t.Fatal("immutable capsule silently bypassed unavailable mount isolation")
	}
	if !strings.Contains(err.Error(), wantError) {
		t.Fatalf("unexpected fail-closed diagnostic: %v", err)
	}
	if _, statErr := os.Lstat(filepath.Join(root, "toolchain", "helper")); !os.IsNotExist(statErr) {
		t.Fatalf("failed capsule staged an executable: %v", statErr)
	}
}

func TestImmutableExecutableCapsuleResistsPathAttacks(t *testing.T) {
	if !enterExecutableNamespaceTest(t) {
		return
	}
	root, err := secureRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "helper")
	approved := []byte("#!/bin/sh\nexit 0\n")
	if err := os.WriteFile(source, approved, 0o755); err != nil {
		t.Fatal(err)
	}
	captured, _, err := captureSelectedExecutable("helper", source, hashBytes(approved), 1<<20, false)
	if err != nil {
		t.Fatal(err)
	}
	capsule, err := createExecutableCapsule(root, []capturedExecutable{captured}, true)
	if err != nil {
		t.Fatal(err)
	}
	defer capsule.close()
	staged := capsule.path("helper")
	if !strings.HasPrefix(staged, "/proc/") || !strings.Contains(staged, "/fd/") {
		t.Fatalf("execution path is not descriptor-bound: %s", staged)
	}
	marker := filepath.Join(root, "malicious-ran")
	connection, err := net.Dial("unix", os.Getenv("GO2GS_TEST_ATTACK_SOCKET"))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	reader := bufio.NewReader(connection)
	hostPath := filepath.Join(root, "toolchain", "helper")
	attackHostPath(t, connection, reader, "swap\t"+hostPath+"\t"+marker)
	defer attackHostPath(t, connection, reader, "restore")

	for range 100 {
		result, err := runProcess(t.Context(), 5*time.Second, 1024, root, staged, nil, []string{})
		if err != nil || result.ExitCode != 0 {
			t.Fatalf("descriptor-bound execution changed: result=%#v err=%v", result, err)
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("host replacement executed: %v", err)
	}
	for name, operation := range map[string]func() error{
		"write":     func() error { return os.WriteFile(staged, []byte("bad"), 0o755) },
		"symlink":   func() error { return os.Symlink(source, staged+".link") },
		"hardlink":  func() error { return os.Link(source, staged+".hard") },
		"directory": func() error { return os.Mkdir(staged+".dir", 0o700) },
	} {
		if err := operation(); err == nil {
			t.Fatalf("%s attack succeeded", name)
		} else if !errors.Is(err, syscall.EROFS) && !errors.Is(err, syscall.EXDEV) {
			t.Fatalf("%s attack failed for unexpected reason: %v", name, err)
		}
	}
}

func assertImmutableDescriptorPath(t *testing.T, capsule *executableCapsule, source string) {
	t.Helper()
	staged := capsule.path(selectedGoName())
	for name, operation := range map[string]func() error{
		"write":     func() error { return os.WriteFile(staged, []byte("bad"), 0o755) },
		"symlink":   func() error { return os.Symlink(source, staged+".link") },
		"hardlink":  func() error { return os.Link(source, staged+".hard") },
		"directory": func() error { return os.Mkdir(staged+".dir", 0o700) },
	} {
		if err := operation(); err == nil {
			t.Fatalf("%s descriptor-path attack succeeded", name)
		} else if !errors.Is(err, syscall.EROFS) && !errors.Is(err, syscall.EXDEV) {
			t.Fatalf("%s descriptor-path attack failed for unexpected reason: %v", name, err)
		}
	}
}

func TestBothPackageLoadsExecuteWorkerImmutableGo(t *testing.T) {
	if !enterExecutableNamespaceTest(t) {
		return
	}
	realGo := filepath.Join(runtime.GOROOT(), "bin", "go")
	selectedDir := t.TempDir()
	selectedGo := filepath.Join(selectedDir, "go")
	data, err := os.ReadFile(realGo)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(selectedGo, data, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO2GS_SELECTED_GO", selectedGo)
	t.Setenv("GO2GS_SELECTED_GO_SHA256", hashBytes(data))
	t.Setenv("GO2GS_SELECTED_GOROOT", runtime.GOROOT())
	marker := filepath.Join(t.TempDir(), "malicious-go-ran")
	ambient := t.TempDir()
	if err := os.WriteFile(filepath.Join(ambient, "go"),
		[]byte("#!/bin/sh\n: > "+marker+"\nexit 93\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", ambient)

	for iteration := range 3 {
		var capsule *executableCapsule
		executableCapsuleTestHook = func(value *executableCapsule) { capsule = value }
		connection, err := net.Dial("unix", os.Getenv("GO2GS_TEST_ATTACK_SOCKET"))
		if err != nil {
			t.Fatal(err)
		}
		reader := bufio.NewReader(connection)
		var savedOriginal string
		packageLoadTestHook = func(phase string) {
			switch phase {
			case "preflight-before", "typed-before":
				if capsule == nil {
					t.Fatal("worker capsule hook was not called")
				}
				assertImmutableDescriptorPath(t, capsule, selectedGo)
				hostPath := filepath.Join(capsule.directory.writePath(), selectedGoName())
				attackHostPath(t, connection, reader, "swap\t"+hostPath+"\t"+marker)
				savedOriginal = selectedGo + ".approved"
				if err := os.Rename(selectedGo, savedOriginal); err != nil {
					t.Fatal(err)
				}
				if phase == "typed-before" {
					if err := os.WriteFile(selectedGo, []byte("#!/bin/sh\n: > "+marker+"\nexit 92\n"), 0o755); err != nil {
						t.Fatal(err)
					}
				}
			case "preflight-after", "typed-after":
				if phase == "typed-after" {
					if err := os.Remove(selectedGo); err != nil {
						t.Fatal(err)
					}
				}
				if err := os.Rename(savedOriginal, selectedGo); err != nil {
					t.Fatal(err)
				}
				attackHostPath(t, connection, reader, "restore")
			}
		}
		analysis, complete, err := analyze(t.Context(), copyFixture(t, "complete"), t.TempDir(), testProfile())
		_ = connection.Close()
		executableCapsuleTestHook = nil
		packageLoadTestHook = nil
		if err != nil || !complete || !analysis.InventoryComplete {
			t.Fatalf("iteration %d: immutable package loads failed: complete=%v err=%v blockers=%#v",
				iteration, complete, err, analysis.Blockers)
		}
		if _, err := os.Stat(marker); !os.IsNotExist(err) {
			t.Fatalf("iteration %d: mutable Go pathname executed: %v", iteration, err)
		}
	}
}
