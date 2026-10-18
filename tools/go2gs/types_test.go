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

	typeParameter := func(name string, owner *types.Package) *types.TypeParam {
		return types.NewTypeParam(types.NewTypeName(token.NoPos, nil, name, nil),
			types.NewInterfaceType([]*types.Func{method(owner)}, nil).Complete())
	}
	signature := func(owners ...*types.Package) *types.Signature {
		parameters := make([]*types.TypeParam, len(owners))
		for i, owner := range owners {
			parameters[i] = typeParameter(string(rune('T'+i)), owner)
		}
		return types.NewSignatureType(nil, nil, parameters, nil, nil, false)
	}
	firstSignature := signature(first)
	secondSignature := signature(second)
	if types.Identical(firstSignature, secondSignature) {
		t.Fatal("go/types unexpectedly considers generic constraints from different packages identical")
	}
	if canonicalType(firstSignature) != canonicalType(secondSignature) {
		t.Fatal("display identity unexpectedly distinguishes generic constraint ownership")
	}
	if canonicalTypeIdentity(firstSignature) == canonicalTypeIdentity(secondSignature) {
		t.Fatal("structural identity omitted generic constraint ownership")
	}
	if canonicalTypeIdentity(signature(first, second)) == canonicalTypeIdentity(signature(second, first)) {
		t.Fatal("structural identity omitted positional generic constraint ownership")
	}
}

func TestTypeIdentityPreservesDeclarationArgumentOrder(t *testing.T) {
	pkg := types.NewPackage("example.com/shadowed", "shadowed")
	parameter := func(name string) *types.TypeParam {
		return types.NewTypeParam(types.NewTypeName(token.NoPos, nil, name, nil),
			types.NewInterfaceType(nil, nil))
	}
	leftParameter, rightParameter := parameter("A"), parameter("B")
	pairObject := types.NewTypeName(token.NoPos, pkg, "Pair", nil)
	pair := types.NewNamed(pairObject, types.NewStruct(nil, nil), nil)
	pair.SetTypeParams([]*types.TypeParam{leftParameter, rightParameter})
	local := func() *types.Named {
		local := types.NewNamed(types.NewTypeName(token.NoPos, pkg, "T", nil), nil, nil)
		local.SetUnderlying(types.NewStruct([]*types.Var{
			types.NewField(token.NoPos, pkg, "next", types.NewPointer(local), false),
		}, nil))
		return local
	}
	outer, inner := local(), local()
	left, err := types.Instantiate(nil, pair, []types.Type{outer, inner}, true)
	if err != nil {
		t.Fatal(err)
	}
	right, err := types.Instantiate(nil, pair, []types.Type{inner, outer}, true)
	if err != nil {
		t.Fatal(err)
	}
	if canonicalType(left) != canonicalType(right) {
		t.Fatal("display identity unexpectedly distinguishes swapped shadowed declarations")
	}
	identify := func(object *types.TypeName) string {
		switch object {
		case pairObject:
			return "pair"
		case outer.Obj():
			return "outerT"
		case inner.Obj():
			return "innerT"
		default:
			return typeObjectIdentity(object)
		}
	}
	if canonicalTypeIdentityWith(left, identify) == canonicalTypeIdentityWith(right, identify) {
		t.Fatal("type identity collected declaration identities without structural positions")
	}
}

func TestTypeIdentityOmitsSignatureParameterAndResultNames(t *testing.T) {
	signature := func(parameter, result string) *types.Signature {
		return types.NewSignatureType(nil, nil, nil,
			types.NewTuple(types.NewVar(token.NoPos, nil, parameter, types.Typ[types.Int])),
			types.NewTuple(types.NewVar(token.NoPos, nil, result, types.Typ[types.String])), false)
	}
	first, second := signature("left", "first"), signature("right", "second")
	nested := func(value *types.Signature) types.Type {
		return types.NewMap(types.Typ[types.String], types.NewStruct([]*types.Var{
			types.NewField(token.NoPos, nil, "Handler", value, false),
		}, nil))
	}
	firstNested, secondNested := nested(first), nested(second)
	for _, test := range []struct {
		name          string
		first, second types.Type
	}{
		{"direct", first, second},
		{"nested", firstNested, secondNested},
	} {
		t.Run(test.name, func(t *testing.T) {
			if !types.Identical(test.first, test.second) {
				t.Fatal("go/types unexpectedly considers parameter names part of type identity")
			}
			if canonicalType(test.first) == canonicalType(test.second) {
				t.Fatal("display text did not retain signature parameter names")
			}
			if canonicalTypeIdentity(test.first) != canonicalTypeIdentity(test.second) {
				t.Fatal("semantic identity retained signature parameter or result names")
			}
		})
	}
}
