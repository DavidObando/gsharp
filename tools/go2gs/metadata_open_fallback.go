// Copyright (C) GSharp Authors. All rights reserved.

//go:build !unix

package main

import "os"

func openMetadataFile(path string) (*os.File, error) {
	return os.Open(path)
}
