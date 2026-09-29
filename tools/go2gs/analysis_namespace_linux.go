// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

func configureAnalysisWorkerNamespace(cmd *exec.Cmd, enabled bool) error {
	if !enabled {
		return nil
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Cloneflags |= unix.CLONE_NEWUSER | unix.CLONE_NEWNS
	cmd.SysProcAttr.Credential = &syscall.Credential{Uid: 0, Gid: 0}
	cmd.SysProcAttr.UidMappings = []syscall.SysProcIDMap{{
		ContainerID: 0,
		HostID:      os.Getuid(),
		Size:        1,
	}}
	cmd.SysProcAttr.GidMappings = []syscall.SysProcIDMap{{
		ContainerID: 0,
		HostID:      os.Getgid(),
		Size:        1,
	}}
	cmd.SysProcAttr.GidMappingsEnableSetgroups = false
	return nil
}
