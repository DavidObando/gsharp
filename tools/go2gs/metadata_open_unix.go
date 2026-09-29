// Copyright (C) GSharp Authors. All rights reserved.

//go:build unix

package main

import (
	"os"
	"syscall"
)

func openMetadataFile(path string) (*os.File, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}
