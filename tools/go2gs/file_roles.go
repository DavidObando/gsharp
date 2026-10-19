// Copyright (C) GSharp Authors. All rights reserved.

package main

func fileRoleFlags(role string) (native, embed, valid bool) {
	switch role {
	case "compiled", "active", "test", "ignored", "method-authority":
		return false, false, true
	case "native":
		return true, false, true
	case "embed":
		return false, true, true
	default:
		return false, false, false
	}
}
