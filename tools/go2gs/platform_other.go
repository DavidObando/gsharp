// Copyright (C) GSharp Authors. All rights reserved.

//go:build !unix

package main

func peakRSS() int64 { return 0 }
