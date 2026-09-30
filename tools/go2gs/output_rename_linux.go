// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import "golang.org/x/sys/unix"

func atomicRenameNoReplace(oldParent int, oldName string, newParent int, newName string) error {
	return unix.Renameat2(oldParent, oldName, newParent, newName, unix.RENAME_NOREPLACE)
}
