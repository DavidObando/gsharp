// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"fmt"
	"go/ast"
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
		file, parseErr := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly|parser.ParseComments)
		if parseErr != nil {
			return false, fmt.Errorf("inspect selected package CGo imports in %s: %w", filepath.Base(path), parseErr)
		}
		for _, declaration := range file.Decls {
			group, ok := declaration.(*ast.GenDecl)
			if !ok || group.Tok != token.IMPORT {
				continue
			}
			for _, raw := range group.Specs {
				spec := raw.(*ast.ImportSpec)
				value, unquoteErr := strconv.Unquote(spec.Path.Value)
				if unquoteErr != nil || value != "C" {
					continue
				}
				return true, nil
			}
		}
	}
	return false, nil
}
