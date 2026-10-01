// Copyright (C) GSharp Authors. All rights reserved.

//go:build !darwin && !linux && !windows

package main

func validateSelectedGoPlatform(_ []byte) error { return nil }
