// Copyright (C) GSharp Authors. All rights reserved.

//go:build darwin

package main

import "golang.org/x/sys/unix"

func atomicExchange(parentFD int, left, right string) error {
	return unix.RenameatxNp(parentFD, left, parentFD, right, unix.RENAME_SWAP)
}
