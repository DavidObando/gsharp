// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"bufio"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

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
