// Copyright (C) GSharp Authors. All rights reserved.

//go:build darwin

package main

import "golang.org/x/sys/unix"

func atomicExchangeBetween(leftParent int, left string, rightParent int, right string) error {
	return unix.RenameatxNp(leftParent, left, rightParent, right, unix.RENAME_SWAP)
}
