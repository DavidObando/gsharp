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
