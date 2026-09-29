// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"fmt"
	"go/parser"
	"go/token"
	"path/filepath"
	"strconv"

	"golang.org/x/tools/go/packages"
)

func selectedPackageImportsC(pkg *packages.Package) (bool, error) {
	files := append([]string{}, pkg.GoFiles...)
	files = append(files, pkg.CompiledGoFiles...)
	for _, path := range uniqueSorted(files) {
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return false, fmt.Errorf("inspect selected package CGo imports in %s: %w", filepath.Base(path), err)
		}
		for _, spec := range file.Imports {
			value, err := strconv.Unquote(spec.Path.Value)
			if err == nil && value == "C" {
				return true, nil
			}
		}
	}
	return false, nil
}
