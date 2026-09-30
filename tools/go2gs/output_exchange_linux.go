// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import "golang.org/x/sys/unix"

func atomicExchangeBetween(leftParent int, left string, rightParent int, right string) error {
	return unix.Renameat2(leftParent, left, rightParent, right, unix.RENAME_EXCHANGE)
}
