// Copyright (C) GSharp Authors. All rights reserved.

//go:build unix

package main

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestProcessRunnerCancellationKillsChildTree(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pidPath := t.TempDir() + "/child.pid"
	_, err = runProcess(t.Context(), 200*time.Millisecond, 4096, "", executable,
		[]string{"-test.run=TestProcessHelper"},
		[]string{"GO2GS_PROCESS_HELPER=tree", "GO2GS_CHILD_PID=" + pidPath})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout, got %v", err)
	}
	data, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		err = syscall.Kill(pid, 0)
		if errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("child process %d survived parent cancellation", pid)
}

func TestAnalysisWorkerCleansNestedProcessTree(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"nested-timeout-worker", "nested-early-failure-worker"} {
		t.Run(mode, func(t *testing.T) {
			state := t.TempDir()
			pidPath := state + "/child.pid"
			marker := state + "/grandchild-survived"
			result, err := runAnalysisWorkerProcess(t.Context(), 5*time.Second, 4096, "", executable,
				[]string{"-test.run=TestProcessHelper"}, []string{
					"GO2GS_PROCESS_HELPER=" + mode,
					"GO2GS_CHILD_PID=" + pidPath,
					"GO2GS_CHILD_MARKER=" + marker,
				})
			if err != nil {
				t.Fatal(err)
			}
			if mode == "nested-early-failure-worker" && result.ExitCode != 7 {
				t.Fatalf("worker exit code = %d, want 7", result.ExitCode)
			}
			data, err := os.ReadFile(pidPath)
			if err != nil {
				t.Fatal(err)
			}
			pid, err := strconv.Atoi(string(data))
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) {
				childErr := syscall.Kill(pid, 0)
				_, markerErr := os.Stat(marker)
				if errors.Is(childErr, syscall.ESRCH) && os.IsNotExist(markerErr) {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
			childErr := syscall.Kill(pid, 0)
			_, markerErr := os.Stat(marker)
			t.Fatalf("nested process tree survived worker exit: pid=%d child=%v marker=%v", pid, childErr, markerErr)
		})
	}
}
