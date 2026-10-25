// Copyright (C) GSharp Authors. All rights reserved.

//go:build unix && !linux

package main

func processGroupMembersExited(int) (bool, error) {
	return false, nil
}
