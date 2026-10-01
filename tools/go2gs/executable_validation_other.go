// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux && !windows

package main

func validateSelectedGoPlatform(_ []byte) error { return nil }
