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
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestImmutableExecutableCapsuleRejectsTransientReplacement(t *testing.T) {
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
	defer func() {
		if err := capsule.close(); err != nil {
			t.Error(err)
		}
	}()
	staged := capsule.path("helper")
	maliciousMarker := filepath.Join(root, "malicious-ran")
	connection, err := net.Dial("unix", os.Getenv("GO2GS_TEST_ATTACK_SOCKET"))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	reader := bufio.NewReader(connection)
	hostVisiblePath := filepath.Join(root, "toolchain", "helper")
	if _, err := connection.Write([]byte("swap\t" + hostVisiblePath + "\t" + maliciousMarker + "\n")); err != nil {
		t.Fatal(err)
	}
	if response, err := reader.ReadString('\n'); err != nil || response != "ok\n" {
		t.Fatalf("parent namespace did not install transient replacement: %q, %v", response, err)
	}
	result, err := runProcess(t.Context(), 5*time.Second, 1024, root, staged, nil, []string{})
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("host-path replacement changed descriptor-bound execution: result=%#v err=%v", result, err)
	}
	if _, err := os.Stat(maliciousMarker); !os.IsNotExist(err) {
		t.Fatalf("host-path replacement executed: %v", err)
	}
	if _, err := connection.Write([]byte("restore\n")); err != nil {
		t.Fatal(err)
	}
	if response, err := reader.ReadString('\n'); err != nil || response != "ok\n" {
		t.Fatalf("parent namespace did not restore pathname: %q, %v", response, err)
	}
	for range 100 {
		err := os.WriteFile(staged, []byte("#!/bin/sh\nexit 91\n"), 0o755)
		if err == nil {
			t.Fatal("read-only executable capsule accepted pathname replacement")
		}
		if !errors.Is(err, syscall.EROFS) {
			t.Fatalf("pathname replacement failed for an unexpected reason: %v", err)
		}
	}
	result, err = runProcess(t.Context(), 5*time.Second, 1024, root, staged, nil, []string{})
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("captured helper did not retain its identity: result=%#v err=%v", result, err)
	}
}

func TestSelectedGoSiblingExecutablesNeverEnterCompilerPATH(t *testing.T) {
	realGo := filepath.Join(runtime.GOROOT(), "bin", "go")
	realCompiler := approvedCompiler(t)
	compilerHelpers := platformCompilerHelpers(t, realCompiler)
	goDir := t.TempDir()
	goWrapper := filepath.Join(goDir, "go")
	if err := os.WriteFile(goWrapper, []byte("#!/bin/sh\nexec "+strconv.Quote(realGo)+" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	var markers []string
	for _, name := range []string{"gofmt", "goimports", "gcc", "clang"} {
		marker := filepath.Join(t.TempDir(), name+"-ran")
		markers = append(markers, marker)
		body := "#!/bin/sh\n: > " + strconv.Quote(marker) + "\nexit 0\n"
		if err := os.WriteFile(filepath.Join(goDir, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	compilerDir := t.TempDir()
	compiler := filepath.Join(compilerDir, "cc")
	var probes strings.Builder
	probes.WriteString("#!/bin/sh\n")
	for _, name := range []string{"gofmt", "goimports", "gcc", "clang"} {
		probes.WriteString("command -v " + name + " >/dev/null 2>&1 && " + name + "\n")
	}
	probes.WriteString("exec " + strconv.Quote(realCompiler) + " \"$@\"\n")
	if err := os.WriteFile(compiler, []byte(probes.String()), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", goDir)
	profile := testProfile()
	enableCgo(t, &profile, compiler, compilerHelpers...)
	analysis, _, err := analyze(t.Context(), copyFixture(t, "cgo"), t.TempDir(), profile)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateAnalysis(analysis); err != nil {
		t.Fatal(err)
	}
	for index, marker := range markers {
		if _, err := os.Stat(marker); !os.IsNotExist(err) {
			t.Fatalf("unmanifested selected-Go sibling %d executed: %v", index, err)
		}
	}

}

func TestCompilerLauncherEnvironmentIsPrivate(t *testing.T) {
	t.Setenv(compilerTargetEnvironment, "/private/target")
	t.Setenv(compilerArgv0Environment, "/private/compiler")
	t.Setenv(compilerPrefixEnvironment, "/private/prefix")
	t.Setenv("GO2GS_KEEP", "value")
	environment := compilerEnvironment()
	for _, entry := range environment {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case compilerTargetEnvironment, compilerArgv0Environment, compilerPrefixEnvironment:
			t.Fatalf("launcher-only variable reached compiler: %s", key)
		}
	}
	if !slices.Contains(environment, "GO2GS_KEEP=value") {
		t.Fatal("compiler environment dropped an unrelated allowlisted value")
	}
}
