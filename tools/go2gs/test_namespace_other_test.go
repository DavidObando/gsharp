// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux

package main

import "testing"

func requireExecutableNamespaceTest(t *testing.T) {
	t.Helper()
	t.Skip("immutable executable namespaces require Linux")
}
