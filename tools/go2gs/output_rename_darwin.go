// Copyright (C) GSharp Authors. All rights reserved.

//go:build darwin

package main

import "golang.org/x/sys/unix"

func atomicRenameNoReplace(oldParent int, oldName string, newParent int, newName string) error {
	return unix.RenameatxNp(oldParent, oldName, newParent, newName, unix.RENAME_EXCL)
}
