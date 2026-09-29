// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

type linuxExecutableDirectory struct {
	path      string
	fd        int
	immutable bool
}

func prepareExecutableDirectory(path string, immutable bool, size int64) (executableDirectory, error) {
	if err := os.Mkdir(path, 0o700); err != nil {
		return nil, err
	}
	directory := &linuxExecutableDirectory{path: path, fd: -1, immutable: immutable}
	if !immutable {
		return directory, nil
	}
	if os.Getenv("GO2GS_EXEC_NAMESPACE") != "1" {
		return nil, errors.New("CGo requires the private executable mount namespace")
	}
	if err := unix.Mount("", "/", "", unix.MS_REC|unix.MS_PRIVATE, ""); err != nil {
		return nil, fmt.Errorf("make executable mount namespace private: %w", err)
	}
	options := fmt.Sprintf("mode=0700,size=%d", size)
	if err := unix.Mount("tmpfs", path, "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, options); err != nil {
		return nil, fmt.Errorf("mount private executable tmpfs: %w", err)
	}
	return directory, nil
}

func (d *linuxExecutableDirectory) writePath() string { return d.path }

func (d *linuxExecutableDirectory) executionPath() string {
	if d.fd >= 0 {
		return fmt.Sprintf("/proc/%d/fd/%d", os.Getpid(), d.fd)
	}
	return d.path
}

func (d *linuxExecutableDirectory) seal() error {
	if !d.immutable {
		return nil
	}
	if err := os.Chmod(d.path, 0o555); err != nil {
		return err
	}
	if err := unix.Mount("", d.path, "", unix.MS_REMOUNT|unix.MS_RDONLY|unix.MS_NOSUID|unix.MS_NODEV, ""); err != nil {
		return fmt.Errorf("seal private executable tmpfs: %w", err)
	}
	fd, err := unix.Open(d.path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open sealed executable directory: %w", err)
	}
	d.fd = fd
	return nil
}

func (d *linuxExecutableDirectory) close() error {
	var result error
	if d.immutable {
		result = errors.Join(result, unix.Unmount(d.path, unix.MNT_DETACH))
	}
	if d.fd >= 0 {
		result = errors.Join(result, unix.Close(d.fd))
		d.fd = -1
	}
	return result
}
