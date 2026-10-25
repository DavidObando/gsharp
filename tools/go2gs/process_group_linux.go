// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func processGroupMembersExited(group int) (bool, error) {
	// Require matching process identities across two complete zombie-only observations.
	first, err := exitedProcessGroupMembers(group)
	if err != nil || len(first) == 0 {
		return false, err
	}
	second, err := exitedProcessGroupMembers(group)
	if err != nil || !maps.Equal(first, second) {
		return false, err
	}
	// Require a complete process view before accepting a zombie-only group.
	mounts, err := os.ReadFile("/proc/self/mounts")
	if err != nil {
		return false, err
	}
	if err := validateProcessGroupProcView(mounts); err != nil {
		return false, err
	}
	return true, nil
}

func validateProcessGroupProcView(mounts []byte) error {
	found := false
	for _, line := range strings.Split(string(mounts), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if len(fields) < 4 {
			return errors.New("invalid procfs mount information")
		}
		if fields[1] != "/proc" {
			continue
		}
		if fields[2] != "proc" {
			return errors.New("/proc is not a procfs mount")
		}
		found = true
		for _, option := range strings.Split(fields[3], ",") {
			if strings.HasPrefix(option, "hidepid=") && option != "hidepid=0" && option != "hidepid=off" {
				return errors.New("/proc hides processes; cannot verify process-group cleanup")
			}
		}
	}
	if !found {
		return errors.New("cannot verify the /proc mount")
	}
	return nil
}

func exitedProcessGroupMembers(group int) (map[int]uint64, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	exited := make(map[int]uint64)
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 {
			continue
		}
		currentGroup, err := syscall.Getpgid(pid)
		if errors.Is(err, syscall.ESRCH) {
			// A vanished PID makes this observation incomplete.
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if currentGroup != group {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if os.IsNotExist(err) || errors.Is(err, syscall.ESRCH) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		end := strings.LastIndexByte(string(data), ')')
		if end < 0 {
			return nil, fmt.Errorf("invalid process state for %d", pid)
		}
		fields := strings.Fields(string(data[end+1:]))
		if len(fields) < 20 || len(fields[0]) != 1 {
			return nil, fmt.Errorf("incomplete process state for %d", pid)
		}
		currentGroup, err = strconv.Atoi(fields[2])
		if err != nil {
			return nil, fmt.Errorf("invalid process group for %d: %w", pid, err)
		}
		if currentGroup != group {
			return nil, nil
		}
		if fields[0] != "Z" && fields[0] != "X" {
			return nil, nil
		}
		threads, err := strconv.Atoi(fields[17])
		if err != nil {
			return nil, fmt.Errorf("invalid thread count for %d: %w", pid, err)
		}
		if threads != 1 {
			return nil, nil
		}
		started, err := strconv.ParseUint(fields[19], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid process start time for %d: %w", pid, err)
		}
		exited[pid] = started
	}
	return exited, nil
}
