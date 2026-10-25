// Copyright (C) GSharp Authors. All rights reserved.

//go:build unix

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestProcessGroupTerminationDrainsMissedDescendants(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	state := t.TempDir()
	pidPath := filepath.Join(state, "child.pid")
	parent := exec.Command(executable, "-test.run=^TestProcessHelper$")
	parent.Env = []string{
		"GO2GS_PROCESS_HELPER=tree",
		"GO2GS_CHILD_PID=" + pidPath,
		"GO2GS_CHILD_MARKER=" + filepath.Join(state, "survived"),
		"GO2GS_CHILD_DELAY=5s",
	}
	if err := configureProcessTree(parent, processGroupOwn); err != nil {
		t.Fatal(err)
	}
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		_ = parent.Wait()
		close(done)
	}()
	original := signalProcessGroup
	drained := false
	t.Cleanup(func() {
		signalProcessGroup = original
		if !drained {
			_ = syscall.Kill(-parent.Process.Pid, syscall.SIGKILL)
		}
		<-done
	})
	childPID := waitForTestChildPID(t, pidPath)
	first := true
	signalProcessGroup = func(pid int, signal syscall.Signal) error {
		if first {
			first = false
			return syscall.Kill(parent.Process.Pid, signal)
		}
		return original(pid, signal)
	}
	if err := terminateProcessTree(parent.Process); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(childPID, 0); errors.Is(err, syscall.ESRCH) {
			drained = true
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("descendant %d survived process-group termination", childPID)
}

func TestProcessGroupTerminationFailsWhenGroupDoesNotDrain(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
	}{{"successful-signal", nil}, {"permission-error", syscall.EPERM}} {
		t.Run(test.name, func(t *testing.T) {
			worker := startTestProcessGroup(t, 0, "sleep")
			original := signalProcessGroup
			t.Cleanup(func() { signalProcessGroup = original })
			signalProcessGroup = func(int, syscall.Signal) error { return test.err }
			err := cleanupProcessTree(worker.Process)
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("persistent process group did not report a termination deadline: %v", err)
			}
			if test.err != nil && !errors.Is(err, test.err) {
				t.Fatalf("termination failure was not preserved: %v", err)
			}
		})
	}
}

func TestProcessRunnerCancellationDoesNotWaitAfterTerminationFailure(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	original := signalProcessGroup
	var command *exec.Cmd
	t.Cleanup(func() {
		signalProcessGroup = original
		if command != nil && command.Process != nil {
			_ = command.Process.Kill()
		}
	})
	signalProcessGroup = func(int, syscall.Signal) error { return syscall.EIO }
	started := time.Now()
	_, err = runProcessConfigured(
		t.Context(), 20*time.Millisecond, 1024, "", executable,
		[]string{"-test.run=^TestProcessHelper$"}, []string{"GO2GS_PROCESS_HELPER=sleep"},
		processGroupOwn, func(cmd *exec.Cmd) error {
			command = cmd
			return nil
		},
	)
	if !errors.Is(err, syscall.EIO) {
		t.Fatalf("termination failure was not preserved: %v", err)
	}
	if elapsed := time.Since(started); elapsed >= 2*time.Second {
		t.Fatalf("termination failure waited for the unkillable worker: %v", elapsed)
	}
}

func startTestProcessGroup(t *testing.T, group int, helper string) *exec.Cmd {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestProcessHelper$")
	cmd.Env = []string{"GO2GS_PROCESS_HELPER=" + helper}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: group}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return cmd
}

func waitForTestChildPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if len(data) != 0 {
			pid, err := strconv.Atoi(string(data))
			if err != nil || pid <= 0 {
				t.Fatalf("invalid child PID %q: %v", data, err)
			}
			return pid
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("worker descendant did not become ready")
	return 0
}

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
			result, err := runProcessWithMode(t.Context(), 5*time.Second, 4096, "", executable,
				[]string{"-test.run=TestProcessHelper"}, []string{
					"GO2GS_PROCESS_HELPER=" + mode,
					"GO2GS_CHILD_PID=" + pidPath,
					"GO2GS_CHILD_MARKER=" + marker,
					"GO2GS_CHILD_DELAY=5s",
				}, processGroupOwn)
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
