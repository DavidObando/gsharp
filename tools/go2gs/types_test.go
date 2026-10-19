// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"go/token"
	"go/types"
	"strings"
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

func TestTypeIdentityMatchesGoStructuralEquivalence(t *testing.T) {
	field := func(name string, typ types.Type) *types.Var {
		return types.NewField(token.NoPos, nil, name, typ, false)
	}
	leaf := func(typ types.Type) types.Type {
		return types.NewStruct([]*types.Var{field("Value", typ)}, nil)
	}
	sharedLeaf := leaf(types.Typ[types.Int])
	shared := types.NewStruct([]*types.Var{
		field("Left", sharedLeaf),
		field("Right", sharedLeaf),
	}, nil)
	duplicated := types.NewStruct([]*types.Var{
		field("Left", leaf(types.Typ[types.Int])),
		field("Right", leaf(types.Typ[types.Int])),
	}, nil)
	differentGraph := types.NewStruct([]*types.Var{
		field("Left", leaf(types.Typ[types.Int])),
		field("Right", leaf(types.Typ[types.String])),
	}, nil)

	union := func(reverse bool, second types.Type) types.Type {
		terms := []*types.Term{
			types.NewTerm(true, types.Typ[types.Int]),
			types.NewTerm(false, second),
		}
		if reverse {
			terms[0], terms[1] = terms[1], terms[0]
		}
		return types.NewUnion(terms)
	}

	method := func(name string) *types.Func {
		return types.NewFunc(token.NoPos, nil, name,
			types.NewSignatureType(nil, nil, nil, nil, nil, false))
	}
	embedded := func(name string) types.Type {
		return types.NewInterfaceType([]*types.Func{method(name)}, nil).Complete()
	}
	firstEmbed, secondEmbed := embedded("First"), embedded("Second")
	embedding := func(reverse bool, second types.Type) types.Type {
		embeds := []types.Type{firstEmbed, second}
		if reverse {
			embeds[0], embeds[1] = embeds[1], embeds[0]
		}
		return types.NewInterfaceType(nil, embeds).Complete()
	}

	signature := func(receiver, parameter types.Type) types.Type {
		return types.NewSignatureType(
			types.NewVar(token.NoPos, nil, "receiver", receiver),
			nil, nil,
			types.NewTuple(types.NewVar(token.NoPos, nil, "value", parameter)),
			types.NewTuple(types.NewVar(token.NoPos, nil, "result", types.Typ[types.Bool])),
			false)
	}

	for _, test := range []struct {
		name                   string
		first, second, control types.Type
	}{
		{"shared-versus-duplicated", shared, duplicated, differentGraph},
		{"union-order", union(false, types.Typ[types.String]), union(true, types.Typ[types.String]),
			union(false, types.Typ[types.Bool])},
		{"interface-embed-order", embedding(false, secondEmbed), embedding(true, secondEmbed),
			embedding(false, embedded("Different"))},
		{"signature-receiver", signature(types.Typ[types.Int], types.Typ[types.String]),
			signature(types.Typ[types.Bool], types.Typ[types.String]),
			signature(types.Typ[types.Bool], types.Typ[types.Int])},
	} {
		t.Run(test.name, func(t *testing.T) {
			if !types.Identical(test.first, test.second) {
				t.Fatal("go/types unexpectedly considers equivalent fixture types distinct")
			}
			if types.Identical(test.first, test.control) {
				t.Fatal("go/types unexpectedly considers the non-identical control equivalent")
			}
			if canonicalTypeIdentity(test.first) != canonicalTypeIdentity(test.second) {
				t.Fatalf("equivalent types received different identities:\nfirst:  %s\nsecond: %s",
					canonicalTypeIdentity(test.first), canonicalTypeIdentity(test.second))
			}
			if canonicalTypeIdentity(test.first) == canonicalTypeIdentity(test.control) {
				t.Fatal("non-identical control received the same identity")
			}
		})
	}
}

func TestTypeIdentityAlphaNormalizesBoundTypeParameters(t *testing.T) {
	emptyConstraint := func() types.Type {
		return types.NewInterfaceType(nil, nil).Complete()
	}
	recursiveConstraint := func(parameter *types.TypeParam) types.Type {
		term := types.NewTerm(true, types.NewSlice(parameter))
		return types.NewInterfaceType(nil,
			[]types.Type{types.NewUnion([]*types.Term{term})}).Complete()
	}
	signature := func(name string, constraint func(*types.TypeParam) types.Type) *types.Signature {
		parameter := types.NewTypeParam(types.NewTypeName(token.NoPos, nil, name, nil), nil)
		parameter.SetConstraint(constraint(parameter))
		parameters := types.NewTuple(types.NewVar(token.NoPos, nil, "value", parameter))
		results := types.NewTuple(types.NewVar(token.NoPos, nil, "result", parameter))
		return types.NewSignatureType(nil, nil, []*types.TypeParam{parameter},
			parameters, results, false)
	}
	receiverPackage := types.NewPackage("example.com/receiver", "receiver")
	receiverParameter := types.NewTypeParam(
		types.NewTypeName(token.NoPos, receiverPackage, "R", nil), emptyConstraint())
	receiverType := types.NewNamed(
		types.NewTypeName(token.NoPos, receiverPackage, "Box", nil),
		types.NewStruct(nil, nil), nil)
	receiverType.SetTypeParams([]*types.TypeParam{receiverParameter})
	receiverSignature := func(name string) *types.Signature {
		parameter := types.NewTypeParam(types.NewTypeName(token.NoPos, nil, name, nil), nil)
		parameter.SetConstraint(recursiveConstraint(parameter))
		instance, err := types.Instantiate(nil, receiverType, []types.Type{parameter}, true)
		if err != nil {
			t.Fatal(err)
		}
		recv := types.NewVar(token.NoPos, nil, "receiver", instance)
		parameters := types.NewTuple(types.NewVar(token.NoPos, nil, "value", parameter))
		results := types.NewTuple(types.NewVar(token.NoPos, nil, "result", parameter))
		return types.NewSignatureType(recv, []*types.TypeParam{parameter}, nil,
			parameters, results, false)
	}
	empty := func(*types.TypeParam) types.Type { return emptyConstraint() }
	for _, test := range []struct {
		name          string
		first, second types.Type
		goIdentical   bool
	}{
		{
			name:        "direct",
			first:       signature("T", empty),
			second:      signature("U", empty),
			goIdentical: true,
		},
		{
			name: "nested",
			first: types.NewMap(types.Typ[types.String],
				types.NewStruct([]*types.Var{
					types.NewField(token.NoPos, nil, "Handler",
						signature("T", recursiveConstraint), false),
				}, nil)),
			second: types.NewMap(types.Typ[types.String],
				types.NewStruct([]*types.Var{
					types.NewField(token.NoPos, nil, "Handler",
						signature("U", recursiveConstraint), false),
				}, nil)),
			goIdentical: true,
		},
		{
			name:   "receiver",
			first:  receiverSignature("T"),
			second: receiverSignature("U"),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.goIdentical && !types.Identical(test.first, test.second) {
				t.Fatal("go/types unexpectedly considers renamed bound parameters distinct")
			}
			if canonicalTypeIdentity(test.first) != canonicalTypeIdentity(test.second) {
				t.Fatalf("bound parameter name changed identity:\nfirst:  %s\nsecond: %s",
					canonicalTypeIdentity(test.first), canonicalTypeIdentity(test.second))
			}
		})
	}
}

func TestTypeIdentityPreservesReceiverBinderConstraints(t *testing.T) {
	constraint := func(parameter *types.TypeParam, element types.Type) types.Type {
		if element == parameter {
			element = types.NewSlice(parameter)
		}
		return types.NewInterfaceType(nil, []types.Type{
			types.NewUnion([]*types.Term{types.NewTerm(true, element)}),
		}).Complete()
	}
	signature := func(name string, element func(*types.TypeParam) types.Type) *types.Signature {
		parameter := types.NewTypeParam(types.NewTypeName(token.NoPos, nil, name, nil), nil)
		parameter.SetConstraint(constraint(parameter, element(parameter)))
		receiver := types.NewVar(token.NoPos, nil, "receiver", types.Typ[types.Int])
		values := types.NewTuple(types.NewVar(token.NoPos, nil, "value", parameter))
		return types.NewSignatureType(receiver, []*types.TypeParam{parameter}, nil, values, values, false)
	}
	direct := func(typ types.Type) func(*types.TypeParam) types.Type {
		return func(*types.TypeParam) types.Type { return typ }
	}
	recursiveSlice := func(parameter *types.TypeParam) types.Type { return parameter }
	recursivePointer := func(parameter *types.TypeParam) types.Type {
		return types.NewPointer(parameter)
	}
	for _, test := range []struct {
		name                  string
		first, renamed, other types.Type
	}{
		{
			name:    "direct",
			first:   signature("T", direct(types.Typ[types.Int])),
			renamed: signature("U", direct(types.Typ[types.Int])),
			other:   signature("V", direct(types.Typ[types.String])),
		},
		{
			name:    "recursive",
			first:   signature("T", recursiveSlice),
			renamed: signature("U", recursiveSlice),
			other:   signature("V", recursivePointer),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if types.Identical(test.first, test.other) {
				t.Fatal("go/types unexpectedly ignored unequal receiver binder constraints")
			}
			if canonicalTypeIdentity(test.first) != canonicalTypeIdentity(test.renamed) {
				t.Fatal("receiver binder names changed identity")
			}
			if canonicalTypeIdentity(test.first) == canonicalTypeIdentity(test.other) {
				t.Fatal("receiver binder constraints were omitted from identity")
			}
		})
	}
}

func TestTypeIdentityPreservesGenericBinderShape(t *testing.T) {
	parameter := func(name string, constraint types.Type) *types.TypeParam {
		return types.NewTypeParam(types.NewTypeName(token.NoPos, nil, name, nil), constraint)
	}
	signature := func(constraints []types.Type, parameterOrder, resultOrder []int) *types.Signature {
		parameters := make([]*types.TypeParam, len(constraints))
		for i, constraint := range constraints {
			parameters[i] = parameter(string(rune('A'+i)), constraint)
		}
		tuple := func(order []int) *types.Tuple {
			values := make([]*types.Var, len(order))
			for i, index := range order {
				values[i] = types.NewVar(token.NoPos, nil, "", parameters[index])
			}
			return types.NewTuple(values...)
		}
		return types.NewSignatureType(nil, nil, parameters,
			tuple(parameterOrder), tuple(resultOrder), false)
	}
	any := types.NewInterfaceType(nil, nil).Complete()
	integer := types.NewInterfaceType(nil,
		[]types.Type{types.NewUnion([]*types.Term{
			types.NewTerm(true, types.Typ[types.Int]),
		})}).Complete()
	baseline := signature([]types.Type{any, any}, []int{0}, []int{1})
	if canonicalTypeIdentity(baseline) == canonicalTypeIdentity(
		signature([]types.Type{any, any}, []int{1}, []int{0})) {
		t.Fatal("type identity omitted bound parameter positions")
	}
	if canonicalTypeIdentity(baseline) == canonicalTypeIdentity(
		signature([]types.Type{any, integer}, []int{0}, []int{1})) {
		t.Fatal("type identity omitted positional constraints")
	}
}

func TestTypeIdentityRetainsFreeTypeParameterDeclaration(t *testing.T) {
	constraint := types.NewInterfaceType(nil, nil).Complete()
	first := types.NewTypeParam(types.NewTypeName(token.NoPos, nil, "T", nil), constraint)
	second := types.NewTypeParam(types.NewTypeName(token.NoPos, nil, "U", nil), constraint)
	if canonicalTypeIdentity(first) == canonicalTypeIdentity(second) {
		t.Fatal("free type parameter declarations collapsed")
	}
}

func TestTypeIdentityUsesCompletedInterfaceTypeSet(t *testing.T) {
	method := func(name string, parameter types.Type) *types.Func {
		return types.NewFunc(token.NoPos, nil, name,
			types.NewSignatureType(nil, nil, nil,
				types.NewTuple(types.NewVar(token.NoPos, nil, "value", parameter)),
				nil, false))
	}
	direct := types.NewInterfaceType([]*types.Func{method("M", types.Typ[types.Int])}, nil).Complete()
	embedded := types.NewInterfaceType(nil, []types.Type{direct}).Complete()
	nested := types.NewInterfaceType(nil, []types.Type{embedded}).Complete()
	differentMethod := types.NewInterfaceType(
		[]*types.Func{method("M", types.Typ[types.String])}, nil).Complete()
	if !types.Identical(direct, embedded) || !types.Identical(direct, nested) {
		t.Fatal("go/types unexpectedly retained equivalent interface embed topology")
	}
	if canonicalTypeIdentity(direct) != canonicalTypeIdentity(embedded) ||
		canonicalTypeIdentity(direct) != canonicalTypeIdentity(nested) {
		t.Fatalf("equivalent completed interface type sets differ:\ndirect:   %s\nembedded: %s\nnested:   %s",
			canonicalTypeIdentity(direct), canonicalTypeIdentity(embedded), canonicalTypeIdentity(nested))
	}
	if types.Identical(direct, differentMethod) ||
		canonicalTypeIdentity(direct) == canonicalTypeIdentity(differentMethod) {
		t.Fatal("different completed method signatures collapsed")
	}

	restricted := func(typ types.Type) types.Type {
		return types.NewInterfaceType(nil, []types.Type{
			types.NewUnion([]*types.Term{types.NewTerm(true, typ)}),
		}).Complete()
	}
	ints, strings := restricted(types.Typ[types.Int]), restricted(types.Typ[types.String])
	if types.Identical(ints, strings) || canonicalTypeIdentity(ints) == canonicalTypeIdentity(strings) {
		t.Fatal("different interface type terms collapsed")
	}
	empty := types.NewInterfaceType(nil, nil).Complete()
	comparable := types.Universe.Lookup("comparable").Type()
	if types.Identical(empty, comparable) || canonicalTypeIdentity(empty) == canonicalTypeIdentity(comparable) {
		t.Fatal("interface comparability restriction was omitted")
	}
}

func TestTypeIdentityMemoizesCompletedDAGNodes(t *testing.T) {
	build := func(depth int) types.Type {
		var current types.Type = types.Typ[types.Int]
		for i := 0; i < depth; i++ {
			current = types.NewStruct([]*types.Var{
				types.NewField(token.NoPos, nil, "Left", current, false),
				types.NewField(token.NoPos, nil, "Right", current, false),
			}, nil)
		}
		return current
	}
	depth13, nodes13 := canonicalTypeIdentityWithStats(build(13), typeObjectIdentity)
	depth14, nodes14 := canonicalTypeIdentityWithStats(build(14), typeObjectIdentity)
	if len(depth14) >= testProfile().Limits.MaxStringBytes {
		t.Fatalf("shared type DAG expanded beyond the record limit: %d bytes", len(depth14))
	}
	if growth := len(depth14) - len(depth13); growth >= 1024 {
		t.Fatalf("shared type DAG grew non-linearly: depth13=%d depth14=%d growth=%d",
			len(depth13), len(depth14), growth)
	}
	if nodes := strings.Count(depth14, ";@"); nodes != 15 {
		t.Fatalf("shared type DAG emitted %d nodes, want 15", nodes)
	}
	if nodes13 != 14 || nodes14 != 15 {
		t.Fatalf("graph builder revisited completed DAG nodes: depth13=%d depth14=%d", nodes13, nodes14)
	}
}

func TestTypeIdentityDistinguishesRecursiveReferenceTargets(t *testing.T) {
	graph := func(backToRoot bool) (types.Type, func(*types.TypeName) string) {
		root := types.NewNamed(types.NewTypeName(token.NoPos, nil, "A", nil), nil, nil)
		child := types.NewNamed(types.NewTypeName(token.NoPos, nil, "B", nil), nil, nil)
		root.SetUnderlying(types.NewStruct([]*types.Var{
			types.NewField(token.NoPos, nil, "Next", types.NewPointer(child), false),
		}, nil))
		target := types.Type(child)
		if backToRoot {
			target = root
		}
		child.SetUnderlying(types.NewStruct([]*types.Var{
			types.NewField(token.NoPos, nil, "Next", types.NewPointer(target), false),
		}, nil))
		identify := func(object *types.TypeName) string {
			if object == root.Obj() {
				return "A"
			}
			if object == child.Obj() {
				return "B"
			}
			return typeObjectIdentity(object)
		}
		return root, identify
	}
	first, identifyFirst := graph(true)
	second, identifySecond := graph(false)
	firstIdentity := canonicalTypeIdentityWith(first, identifyFirst)
	secondIdentity := canonicalTypeIdentityWith(second, identifySecond)
	if firstIdentity == secondIdentity {
		t.Fatal("type identity collapsed distinct recursive reference targets")
	}
	if !strings.Contains(firstIdentity, "element=@0") ||
		!strings.Contains(secondIdentity, "element=@3") {
		t.Fatalf("recursive references did not target the exact ancestor:\nfirst:  %s\nsecond: %s",
			firstIdentity, secondIdentity)
	}
}
