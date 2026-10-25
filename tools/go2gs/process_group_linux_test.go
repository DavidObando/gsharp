// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func init() {
	if os.Getenv("GO2GS_PROCESS_HELPER") != "zombie-thread-leader" {
		return
	}
	// Initialization runs on the initial thread. Keep another thread alive when that thread exits.
	ready := make(chan struct{})
	go func() {
		close(ready)
		time.Sleep(10 * time.Second)
		os.Exit(0)
	}()
	<-ready
	_, _, err := syscall.RawSyscall(syscall.SYS_EXIT, 0, 0, 0)
	fmt.Fprintf(os.Stderr, "exit helper's leader thread: %v\n", err)
	os.Exit(2)
}

func TestProcessGroupTerminationAcceptsUnreapedZombies(t *testing.T) {
	worker := startTestProcessGroup(t, 0, "sleep")
	if err := worker.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitForLinuxZombie(t, worker.Process.Pid)
	if err := terminateProcessTree(worker.Process); err != nil {
		t.Fatalf("dead group required an external reaper: %v", err)
	}
	if state := linuxTestProcessState(t, worker.Process.Pid); state != 'Z' {
		t.Fatalf("fixture was reaped before verification: %c", state)
	}
}

func TestProcessGroupTerminationRejectsLiveMemberBesideZombie(t *testing.T) {
	worker := startTestProcessGroup(t, 0, "sleep")
	live := startTestProcessGroup(t, worker.Process.Pid, "sleep")
	if err := worker.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitForLinuxZombie(t, worker.Process.Pid)
	original := signalProcessGroup
	t.Cleanup(func() { signalProcessGroup = original })
	signalProcessGroup = func(int, syscall.Signal) error { return nil }
	if err := terminateProcessTree(worker.Process); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("live group member was waived beside a zombie: %v", err)
	}
	if state := linuxTestProcessState(t, live.Process.Pid); state == 'Z' || state == 'X' {
		t.Fatalf("live-member control was not alive: %c", state)
	}
}

func TestProcessGroupRejectsZombieLeaderWithLiveThreads(t *testing.T) {
	worker := startTestProcessGroup(t, 0, "zombie-thread-leader")
	waitForLinuxZombie(t, worker.Process.Pid)
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", worker.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	threads := 0
	for _, line := range strings.Split(string(status), "\n") {
		if strings.HasPrefix(line, "Threads:") {
			threads, err = strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "Threads:")))
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	if threads <= 1 {
		t.Fatalf("fixture lacks live threads beside its zombie leader: %d", threads)
	}
	if exited, err := processGroupMembersExited(worker.Process.Pid); err != nil || exited {
		t.Fatalf("live threads were waived behind a zombie leader: exited=%v error=%v", exited, err)
	}
}

func TestProcessGroupRejectsIncompleteProcView(t *testing.T) {
	for _, mounts := range []string{
		"proc /proc proc rw,hidepid=2 0 0\n",
		"tmpfs /proc tmpfs rw 0 0\n",
		"proc /hidden proc rw 0 0\n",
		"broken\n",
	} {
		if err := validateProcessGroupProcView([]byte(mounts), strconv.Itoa(os.Getpid())); err == nil {
			t.Fatalf("incomplete process visibility was accepted: %q", mounts)
		}
	}
	if err := validateProcessGroupProcView([]byte("proc /proc proc rw 0 0\n"), "0"); err == nil {
		t.Fatal("a different PID namespace was accepted")
	}
}

func waitForLinuxZombie(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if linuxTestProcessState(t, pid) == 'Z' {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("killed fixture did not become an unreaped zombie")
}

func linuxTestProcessState(t *testing.T, pid int) byte {
	t.Helper()
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		t.Fatal(err)
	}
	end := strings.LastIndex(string(data), ") ")
	if end < 0 || end+2 >= len(data) {
		t.Fatalf("invalid kernel process state for %d", pid)
	}
	return data[end+2]
}
