// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"go/token"
	"go/types"
	"testing"
)

func TestStructuralTypeIdentityIncludesPositionalUnexportedOwnership(t *testing.T) {
	first := types.NewPackage("example.com/first", "first")
	second := types.NewPackage("example.com/second", "second")
	field := func(owner *types.Package) *types.Var {
		return types.NewField(token.NoPos, owner, "x", types.Typ[types.Int], false)
	}
	structure := func(left, right *types.Package) types.Type {
		return types.NewStruct([]*types.Var{
			types.NewField(token.NoPos, nil, "Left", types.NewStruct([]*types.Var{field(left)}, nil), false),
			types.NewField(token.NoPos, nil, "Right", types.NewStruct([]*types.Var{field(right)}, nil), false),
		}, nil)
	}
	left := structure(first, second)
	right := structure(second, first)
	if types.Identical(left, right) {
		t.Fatal("go/types unexpectedly considers swapped unexported field owners identical")
	}
	if canonicalType(left) != canonicalType(right) {
		t.Fatal("display identity unexpectedly distinguishes unexported field ownership")
	}
	if canonicalTypeIdentity(left) == canonicalTypeIdentity(right) {
		t.Fatal("structural identity omitted positional unexported field ownership")
	}

	parameter := types.NewTypeParam(types.NewTypeName(token.NoPos, nil, "T", nil),
		types.NewInterfaceType(nil, nil))
	generic := types.NewNamed(types.NewTypeName(token.NoPos,
		types.NewPackage("example.com/generic", "generic"), "Box", nil),
		types.NewStruct([]*types.Var{
			types.NewField(token.NoPos, nil, "Value", parameter, false),
		}, nil), nil)
	generic.SetTypeParams([]*types.TypeParam{parameter})
	firstInstance, err := types.Instantiate(nil, generic,
		[]types.Type{types.NewStruct([]*types.Var{field(first)}, nil)}, true)
	if err != nil {
		t.Fatal(err)
	}
	secondInstance, err := types.Instantiate(nil, generic,
		[]types.Type{types.NewStruct([]*types.Var{field(second)}, nil)}, true)
	if err != nil {
		t.Fatal(err)
	}
	if canonicalTypeIdentity(firstInstance) == canonicalTypeIdentity(secondInstance) {
		t.Fatal("instantiated type identity omitted structural argument ownership")
	}

	method := func(owner *types.Package) *types.Func {
		return types.NewFunc(token.NoPos, owner, "m",
			types.NewSignatureType(nil, nil, nil, nil, nil, false))
	}
	firstInterface := types.NewInterfaceType([]*types.Func{method(first)}, nil).Complete()
	secondInterface := types.NewInterfaceType([]*types.Func{method(second)}, nil).Complete()
	if types.Identical(firstInterface, secondInterface) {
		t.Fatal("go/types unexpectedly considers unexported methods from different packages identical")
	}
	if canonicalTypeIdentity(firstInterface) == canonicalTypeIdentity(secondInterface) {
		t.Fatal("structural identity omitted unexported method ownership")
	}
}
