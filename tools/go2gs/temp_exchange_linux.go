// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import "golang.org/x/sys/unix"

func atomicExchange(parentFD int, left, right string) error {
	return unix.Renameat2(parentFD, left, parentFD, right, unix.RENAME_EXCHANGE)
}
