// <copyright file="Issue3522ImportedNullableFieldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Text.RegularExpressions
import Xunit

class Issue3522ImportedNullableFieldEmitTests {
    @Fact
    func NullableReferenceField_LiteralAndWith_RunAndVerifyAcrossProjectReference() {
        using let artifacts = Issue3522ImportedNullableFieldEmitTests.TestArtifacts()
        const source = `package Issue3522.App

import Issue3522.Library

func Main() int32 {
  let first = Badge{ Content:nil }
  let second = first with{ Content = nil }
  return second.Content == nil ? 0 : 1
}`
        let result = Compile(artifacts.Directory, "Issue3522.App", source, target: "exe", artifacts.LibraryPath)
        Assert.True(result.ExitCode == 0, result.Diagnostics)
        IlVerifier.Verify(result.OutputPath, []string{artifacts.LibraryPath})
        Assert.Equal(0, Run(result.OutputPath))
    }

    @Fact
    func SemanticAggregate_DecodesDirectContextValueGenericAndArrayFieldShapes() {
        using let artifacts = Issue3522ImportedNullableFieldEmitTests.TestArtifacts()
        using let resolver = ReferenceResolver.WithReferences([]string{artifacts.LibraryPath})
        resolver.CurrentAssemblyName = "Issue3522.Consumer"
        Assert.True(resolver.TryResolveType("Issue3522.Library.Badge", out var badgeType))
        Assert.True(resolver.TryResolveType("Issue3522.Library.RequiredBadge", out var requiredBadgeType))
        Assert.True(resolver.TryResolveType("Issue3522.Library.FieldShapes", out var shapesType))
        Assert.Equal([]uint8{2}, GetNullableFlags(badgeType.GetField("Content")!!))
        Assert.Empty(GetNullableFlags(requiredBadgeType.GetField("Content")!!))
        Assert.Equal(uint8(1), GetNullableContext(requiredBadgeType))
        Assert.Equal([]uint8{1, 1, 2, 2}, GetNullableFlags(shapesType.GetField("Nested")!!))
        Assert.Equal([]uint8{1, 2}, GetNullableFlags(shapesType.GetField("Values")!!))
        Assert.True(ImportedTypeSymbol.TryCreateSemanticAggregate(badgeType, resolver, out var badge))
        Assert.True(ImportedTypeSymbol.TryCreateSemanticAggregate(requiredBadgeType, resolver, out var requiredBadge))
        Assert.True(ImportedTypeSymbol.TryCreateSemanticAggregate(shapesType, resolver, out var shapes))
        let optionalContent = Assert.IsType[NullableTypeSymbol](badge.Fields.Single().Type)
        Assert.Same(TypeSymbol.String, optionalContent.UnderlyingType)
        Assert.Same(TypeSymbol.String, requiredBadge.Fields.Single().Type)
        let optionalCount = Assert.IsType[NullableTypeSymbol](
            shapes.Fields.Single((field FieldSymbol) -> field.Name == "OptionalCount").Type
        )
        Assert.Same(TypeSymbol.Int32, optionalCount.UnderlyingType)
        let nested = Assert.IsType[NullabilityAnnotatedTypeSymbol](
            shapes.Fields.Single((field FieldSymbol) -> field.Name == "Nested").Type
        )
        Assert.Same(TypeSymbol.String, nested.GetTypeArgumentSymbol(0))
        let nullableList = Assert.IsType[NullableTypeSymbol](nested.GetTypeArgumentSymbol(1))
        let list = Assert.IsType[NullabilityAnnotatedTypeSymbol](nullableList.UnderlyingType)
        let nullableListItem = Assert.IsType[NullableTypeSymbol](list.GetTypeArgumentSymbol(0))
        Assert.Same(TypeSymbol.String, nullableListItem.UnderlyingType)
        let values = Assert.IsType[NullabilityAnnotatedTypeSymbol](
            shapes.Fields.Single((field FieldSymbol) -> field.Name == "Values").Type
        )
        let nullableElement = Assert.IsType[NullableTypeSymbol](
            values.GetTypeArgumentSymbolForClrType(values.ClrType!!.GetElementType())
        )
        Assert.Same(TypeSymbol.String, nullableElement.UnderlyingType)
    }

    @Fact
    func MetadataFixture_CoversScalarContextObliviousValueTupleAndOuterNullableShapes() {
        using let artifacts = Issue3522ImportedNullableFieldEmitTests.TestArtifacts()
        using let resolver = ReferenceResolver.WithReferences([]string{artifacts.MetadataPath})
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.DirectFields", out var direct))
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.GenericMethods", out var genericMethods))
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.GenericNullableBase`1", out var nullableBase))
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.GenericNestedBase`1", out var nestedBase))
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.ContextFields", out var context))
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.ObliviousFields", out var oblivious))
        Assert.Equal(uint8(1), GetNullableContext(direct))
        Assert.Equal([]uint8{2}, GetNullableFlags(direct.GetField("ScalarNullableArray")!!))
        Assert.Equal([]uint8{2}, GetNullableFlags(direct.GetField("ScalarNullableGeneric")!!))
        Assert.Equal([]uint8{2, 1}, GetNullableFlags(direct.GetField("NullableOuterArray")!!))
        Assert.Equal([]uint8{2, 1}, GetNullableFlags(direct.GetField("NullableOuterGeneric")!!))
        Assert.Equal([]uint8{1, 0, 2, 1}, GetNullableFlags(direct.GetField("ValueTupleKey")!!))
        Assert.Equal([]uint8{0, 1, 2}, GetNullableFlags(direct.GetField("NullableTuple")!!))
        Assert.Equal([]uint8{1, 0, 2, 1, 1}, GetNullableFlags(direct.GetField("NullablePairContainer")!!))
        Assert.Equal([]uint8{0, 2, 2, 1}, GetNullableFlags(direct.GetField("NestedScalarTuple")!!))
        Assert.Equal(Tuple8Flags, GetNullableFlags(direct.GetField("Tuple8")!!))
        Assert.Equal(Tuple15Flags, GetNullableFlags(direct.GetField("Tuple15")!!))
        Assert.Empty(GetNullableFlags(direct.GetField("NonNullArray")!!))
        let nullableValueField = nullableBase.GetField("Value")!!
        Assert.Empty(GetNullableFlags(nullableValueField))
        Assert.Equal([]uint8{2}, ClrNullability.ReadNullableFlags(nullableValueField, nullableBase).ToArray())
        Assert.Equal([]uint8{1, 2}, GetNullableFlags(nestedBase.GetField("Values")!!))
        let pairMethod = genericMethods.GetMethod("MakeStructPair")!!
        Assert.Equal([]uint8{1, 0, 2}, GetNullableFlags(pairMethod.ReturnParameter))
        Assert.Equal(
            []uint8{1, 0, 1},
            GetNullableFlags(genericMethods.GetMethod("MakeRequiredStructPair")!!.ReturnParameter)
        )
        let metadataInt = resolver.MapClrTypeToReferences(typeof(int32))
        let closedOptionalPair = Assert.IsType[NullabilityAnnotatedTypeSymbol](
            ClrNullability.GetReturnTypeSymbol(pairMethod.MakeGenericMethod(metadataInt))
        )
        Assert.IsType[NullableTypeSymbol](closedOptionalPair.GetTypeArgumentSymbol(1))
        let closedRequiredPair = Assert.IsType[NullabilityAnnotatedTypeSymbol](
            ClrNullability.GetReturnTypeSymbol(
                genericMethods.GetMethod("MakeRequiredStructPair")!!.MakeGenericMethod(metadataInt)
            )
        )
        Assert.IsNotType[NullableTypeSymbol](closedRequiredPair.GetTypeArgumentSymbol(1))
        let valueMethod = genericMethods.GetMethod("MakeStructValue")!!
        Assert.Empty(GetNullableFlags(valueMethod.ReturnParameter))
        Assert.Equal(2, ClrNullability.CountNullabilityBytes(valueMethod.ReturnType))
        let valueSymbol = Assert.IsType[NullabilityAnnotatedTypeSymbol](ClrNullability.GetReturnTypeSymbol(valueMethod))
        Assert.Equal([]uint8{0, 0}, NullableFlagsBuilder.Build(valueSymbol).ToArray())
        Assert.Equal(uint8(2), GetNullableContext(context))
        Assert.Empty(GetNullableFlags(context.GetField("Values")!!))
        Assert.Null(TryGetNullableContext(oblivious))
        Assert.Empty(GetNullableFlags(oblivious.GetField("Values")!!))
    }

    @Fact
    func MetadataFields_DecodeScalarContextObliviousAndValueTuplePositions() {
        using let artifacts = Issue3522ImportedNullableFieldEmitTests.TestArtifacts()
        using let resolver = ReferenceResolver.WithReferences([]string{artifacts.MetadataPath})
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.DirectFields", out var direct))
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.ContextFields", out var context))
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.ObliviousFields", out var oblivious))
        AssertArray(direct.GetField("ScalarNullableArray")!!, outerNullable: true, elementNullable: true)
        AssertArray(context.GetField("Values")!!, outerNullable: true, elementNullable: true)
        // ADR-0186 step 3: the OBLIVIOUS row is the one cell the flip moves.
        // `Issue3522.Metadata.ObliviousFields` has no nullable metadata at
        // all, so both its array position and its element now read as the
        // platform type `T!` rather than `T?`. The two annotated rows above
        // and the non-null rows below are untouched, which is what keeps this
        // an amendment to one cell rather than a weakening of the fixture.
        AssertArray(oblivious.GetField("Values")!!, outerNullable: true, elementNullable: true, oblivious: true)
        AssertArray(direct.GetField("NonNullArray")!!, outerNullable: false, elementNullable: false)
        let dictionary = Assert.IsType[NullabilityAnnotatedTypeSymbol](
            ClrNullability.GetFieldTypeSymbol(direct.GetField("ValueTupleKey")!!)
        )
        let tuple = Assert.IsType[NullabilityAnnotatedTypeSymbol](dictionary.GetTypeArgumentSymbol(0))
        let nullableTupleItem = Assert.IsType[NullableTypeSymbol](tuple.GetTypeArgumentSymbol(0))
        Assert.Same(TypeSymbol.String, nullableTupleItem.UnderlyingType)
        Assert.Same(TypeSymbol.Object, dictionary.GetTypeArgumentSymbol(1))
        let nullableTuple = Assert.IsType[NullableTypeSymbol](
            ClrNullability.GetFieldTypeSymbol(direct.GetField("NullableTuple")!!)
        )
        let tupleValue = Assert.IsType[TupleTypeSymbol](nullableTuple.UnderlyingType)
        Assert.Same(TypeSymbol.Object, tupleValue.ElementTypes[0])
        Assert.IsType[NullableTypeSymbol](tupleValue.ElementTypes[1])
        let pairContainer = Assert.IsType[NullabilityAnnotatedTypeSymbol](
            ClrNullability.GetFieldTypeSymbol(direct.GetField("NullablePairContainer")!!)
        )
        let nullablePair = Assert.IsType[NullableTypeSymbol](pairContainer.GetTypeArgumentSymbol(0))
        let pair = Assert.IsType[NullabilityAnnotatedTypeSymbol](nullablePair.UnderlyingType)
        Assert.IsType[NullableTypeSymbol](pair.GetTypeArgumentSymbol(0))
        Assert.Same(TypeSymbol.Object, pair.GetTypeArgumentSymbol(1))
        Assert.Same(TypeSymbol.String, pairContainer.GetTypeArgumentSymbol(1))
        let nestedScalarTuple = AssertTupleField(direct.GetField("NestedScalarTuple")!!, 2, 0)
        let nestedList = Assert.IsType[NullabilityAnnotatedTypeSymbol](
            Assert.IsType[NullableTypeSymbol](nestedScalarTuple.ElementTypes[0]).UnderlyingType
        )
        Assert.IsType[NullableTypeSymbol](nestedList.GetTypeArgumentSymbol(0))
        AssertTupleField(direct.GetField("Tuple8")!!, 8, 0, 7)
        AssertTupleField(direct.GetField("Tuple15")!!, 15, 0, 7, 14)
    }

    @Fact
    func MetadataArrayFields_AcceptNilAtNullableOuterAndElementPositions() {
        using let artifacts = Issue3522ImportedNullableFieldEmitTests.TestArtifacts()
        const source = `package Issue3522.MetadataConsumer

import System.Collections.Generic
import Issue3522.Metadata

func Main() int32 {
  let values = []string?{nil}
  let items = List[string?]{nil}
  let platformValues = ObliviousFields.Values
  let platformItems = ObliviousFields.Items

  DirectFields.ScalarNullableArray = nil
  DirectFields.ScalarNullableArray = values
  DirectFields.ScalarNullableArray!![0] = nil

  DirectFields.ScalarNullableGeneric = nil
  DirectFields.ScalarNullableGeneric = items
  DirectFields.ScalarNullableGeneric!![0] = nil

  ContextFields.Values = nil
  ContextFields.Values = values
  ContextFields.Values!![0] = nil

  ObliviousFields.Values = nil
  ObliviousFields.Values = platformValues
  ObliviousFields.Values!![0] = nil

  ObliviousFields.Items = nil
  ObliviousFields.Items = platformItems
  ObliviousFields.Items!![0] = nil

  return object.ReferenceEquals(DirectFields.ScalarNullableArray, values)
    && object.ReferenceEquals(DirectFields.ScalarNullableGeneric, items)
    && object.ReferenceEquals(ContextFields.Values, values)
    && object.ReferenceEquals(ObliviousFields.Values, platformValues)
    && object.ReferenceEquals(ObliviousFields.Items, platformItems)
    && DirectFields.ScalarNullableArray!![0] == nil
    && DirectFields.ScalarNullableGeneric!![0] == nil
    && ContextFields.Values!![0] == nil
    && ObliviousFields.Values!![0] == nil
    && ObliviousFields.Items!![0] == nil ? 0 : 1
}`
        let result = Compile(
            artifacts.Directory,
            "Issue3522.MetadataConsumer",
            source,
            target: "exe",
            artifacts.MetadataPath
        )
        Assert.True(result.ExitCode == 0, result.Diagnostics)
        IlVerifier.Verify(result.OutputPath, []string{artifacts.MetadataPath})
        Assert.Equal(0, Run(result.OutputPath))
    }

    /// ADR-0186 rejects `C[T?] -> C[T!]`: a reader of the oblivious container can
    /// take a nil element as non-null. Arrays obey the same rule as `List` (#5413).
    @Fact
    func ObliviousContainerFields_RejectNullableElementContainers() {
        using let artifacts = Issue3522ImportedNullableFieldEmitTests.TestArtifacts()
        const source = `package Issue3522.ObliviousNegative

import System.Collections.Generic
import Issue3522.Metadata

func Break(values []string?, items List[string?]) {
  ObliviousFields.Values = values
  ObliviousFields.Items = items
}`
        let result = Compile(
            artifacts.Directory,
            "Issue3522.ObliviousNegative",
            source,
            target: "library",
            artifacts.MetadataPath
        )
        Assert.NotEqual(0, result.ExitCode)
        let errors = Regex.Matches(result.Diagnostics, "\\berror GS[0-9]+:")
        Assert.True(errors.Count == 2, result.Diagnostics)
        let sourcePath = Path.Combine(artifacts.Directory, "Issue3522.ObliviousNegative.gs")
        Assert.Contains(
            sourcePath + "(7,28,7,34): error GS0155: Cannot convert type '[]string?' to '[]!string!'.",
            result.Diagnostics,
            StringComparison.Ordinal
        )
        Assert.Contains(
            sourcePath + "(8,27,8,32): error GS0155: Cannot convert type 'System.Collections.Generic.List[string?]' to "
            + "'System.Collections.Generic.List[string!]!'.",
            result.Diagnostics,
            StringComparison.Ordinal
        )
        Assert.Equal([]string{sourcePath}, Directory.GetFiles(artifacts.Directory, "Issue3522.ObliviousNegative*"))
    }

    @Fact
    func InheritedGenericFields_ProjectDeclaringTypeArguments() {
        using let artifacts = Issue3522ImportedNullableFieldEmitTests.TestArtifacts()
        const source = `package Issue3522.InheritedFields

import System.Collections.Generic
import Issue3522.Metadata

func AddSymbolicNested[T class](
    holder GenericNestedDerived[T],
    value T?) {
  holder.Values.Add(value)
}

func SetSymbolicDictionary[T class](
    holder GenericDictionaryDerived[T],
    key T,
    value string?) {
  holder.Values[key] = value
}

func EchoCount[T class](
    holder GenericCountDerived[string, T])
    GenericCountDerived[string, T] -> holder

func MutateCount[T class](
    holder GenericCountDerived[string, T]) int32 {
  holder.Count = 40
  holder.Count += 2
  return holder.Count
}

func MutateCountExpression[T class](
    holder GenericCountDerived[string, T]) int32 {
  EchoCount(holder).Count = 20
  EchoCount(holder).Count += 2
  return holder.Count
}

func MutateLeafCount[T class](
    holder GenericCountLeaf[string, T]) int32 {
  holder.Count = 6
  holder.Count *= 7
  return holder.Count
}

func Main() int32 {
  DirectFields.DerivedSecondNonNull.Value = "derived"
  let derived string = DirectFields.DerivedSecondNonNull.Value
  DirectFields.DerivedSecondNullable.Value = nil
  let derivedNullable string? = DirectFields.DerivedSecondNullable.Value

  DirectFields.LeafSecondNonNull.Value = "leaf"
  let leaf string = DirectFields.LeafSecondNonNull.Value
  DirectFields.LeafSecondNullable.Value = nil
  let leafNullable string? = DirectFields.LeafSecondNullable.Value

  DirectFields.NullableDeclared.Value = nil
  let declaredNullable string? = DirectFields.NullableDeclared.Value
  DirectFields.NullableDeclaredLeaf.Value = nil
  let leafDeclaredNullable string? = DirectFields.NullableDeclaredLeaf.Value

  DirectFields.NestedNullableDeclared.Values.Add(nil)
  let nestedNullable string? = DirectFields.NestedNullableDeclared.Values[0]

  DirectFields.NullableListDeclared.Value = nil
  DirectFields.NullableListDeclared.Value = List[string]()
  DirectFields.NullableListDeclared.Value!!.Add("item")
  let listItem string = DirectFields.NullableListDeclared.Value!![0]

  let symbolicNested = GenericNestedDerived[string]()
  AddSymbolicNested(symbolicNested, nil)
  let symbolicNestedValue string? = symbolicNested.Values[0]

  let symbolicDictionary = GenericDictionaryDerived[string]()
  SetSymbolicDictionary(symbolicDictionary, "key", nil)
  let symbolicDictionaryValue string? = symbolicDictionary.Values["key"]

  DirectFields.ConcreteNullableDeclared.Values.Add(nil)
  let concreteNullable string? =
    DirectFields.ConcreteNullableDeclared.Values[0]

  let count = MutateCount(GenericCountDerived[string, string]())
  let expressionCount = MutateCountExpression(
    GenericCountDerived[string, string]())
  let leafCount = MutateLeafCount(GenericCountLeaf[string, string]())

  return derived == "derived"
    && derivedNullable == nil
    && leaf == "leaf"
    && leafNullable == nil
    && declaredNullable == nil
    && leafDeclaredNullable == nil
    && nestedNullable == nil
    && listItem == "item"
    && symbolicNestedValue == nil
    && symbolicDictionaryValue == nil
    && concreteNullable == nil
    && count == 42
    && expressionCount == 22
    && leafCount == 42 ? 0 : 1
}`
        let result = Compile(
            artifacts.Directory,
            "Issue3522.InheritedFields",
            source,
            target: "exe",
            artifacts.MetadataPath
        )
        Assert.True(result.ExitCode == 0, result.Diagnostics)
        IlVerifier.Verify(result.OutputPath, []string{artifacts.MetadataPath})
        Assert.Equal(0, Run(result.OutputPath))
    }

    @Fact
    func InheritedGenericFields_RejectNilInProjectedNonNullableSlots() {
        using let artifacts = Issue3522ImportedNullableFieldEmitTests.TestArtifacts()
        const source = `package Issue3522.InheritedFieldsNegative

import System.Collections.Generic
import Issue3522.Metadata

func RequireSymbolicNested[T class](
    holder GenericNestedDerived[T]) T {
  return holder.Values[0]
}

func RequireSymbolicDictionary[T class](
    holder GenericDictionaryDerived[T],
    key T) string {
  return holder.Values[key]
}

func Break() {
  DirectFields.DerivedSecondNonNull.Value = nil
  let derived string = DirectFields.DerivedSecondNullable.Value
  DirectFields.LeafSecondNonNull.Value = nil
  let leaf string = DirectFields.LeafSecondNullable.Value

  let declared string = DirectFields.NullableDeclared.Value
  let leafDeclared string = DirectFields.NullableDeclaredLeaf.Value
  DirectFields.NestedNullableDeclared.Values.Add(nil)
  let nested string = DirectFields.NestedNullableDeclared.Values[0]

  let list List[string] = DirectFields.NullableListDeclared.Value
  DirectFields.NullableListDeclared.Value = List[string]()
  DirectFields.NullableListDeclared.Value!![0] = nil

  DirectFields.ConcreteNullableDeclared.Values.Add(nil)
  let concrete string =
    DirectFields.ConcreteNullableDeclared.Values[0]
}`
        let result = Compile(
            artifacts.Directory,
            "Issue3522.InheritedFieldsNegative",
            source,
            target: "library",
            artifacts.MetadataPath
        )
        Assert.NotEqual(0, result.ExitCode)
        Assert.True(Regex.Matches(result.Diagnostics, "\\berror GS0155:").Count == 12, result.Diagnostics)
        Assert.DoesNotContain("GS9998", result.Diagnostics, StringComparison.Ordinal)
    }

    @Fact
    func MetadataNonNullablePositions_RejectNil() {
        using let artifacts = Issue3522ImportedNullableFieldEmitTests.TestArtifacts()
        const source = `package Issue3522.MetadataNegative

import Issue3522.Metadata

func Break() {
  DirectFields.NonNullArray = nil
  DirectFields.NonNullArray[0] = nil

  DirectFields.NullablePairContainer.First = nil
  DirectFields.NullablePairContainer.Second = nil

  var optionalPair = GenericMethods.MakeStructPair[int32]()
  optionalPair.Second = nil
  var requiredPair = GenericMethods.MakeRequiredStructPair[int32]()
  requiredPair.Second = nil
}`
        let result = Compile(
            artifacts.Directory,
            "Issue3522.MetadataNegative",
            source,
            target: "library",
            artifacts.MetadataPath
        )
        Assert.NotEqual(0, result.ExitCode)
        Assert.True(Regex.Matches(result.Diagnostics, "\\berror GS0155:").Count == 4, result.Diagnostics)
        Assert.Contains("Cannot convert type 'nil' to '[]string'.", result.Diagnostics, StringComparison.Ordinal)
        Assert.Contains("Cannot convert type 'nil' to 'string'.", result.Diagnostics, StringComparison.Ordinal)
    }

    @Fact
    func ImportedNullableOuterArrayAndGeneric_ReemitExactInnerFlags() {
        using let artifacts = Issue3522ImportedNullableFieldEmitTests.TestArtifacts()
        const source = `package Issue3522.Reemit

import Issue3522.Metadata

public func ReemitStructPair[T struct]() PairContainer[T, string?] ->
  GenericMethods.MakeStructPair[T]()
public func ReemitRequiredStructPair[T struct]() PairContainer[T, string] ->
  GenericMethods.MakeRequiredStructPair[T]()
public func ReemitStructValue[T struct]() ValueContainer[T] ->
  GenericMethods.MakeStructValue[T]()

public var OuterArray = DirectFields.NullableOuterArray
public var OuterGeneric = DirectFields.NullableOuterGeneric
public var ScalarArray = DirectFields.ScalarNullableArray
public var ScalarGeneric = DirectFields.ScalarNullableGeneric
public var NullableTuple = DirectFields.NullableTuple
public var NullablePairContainer = DirectFields.NullablePairContainer
public var NestedScalarTuple = (DirectFields.ScalarNullableGeneric, "")
public var Tuple8 = DirectFields.Tuple8
public var Tuple15 = DirectFields.Tuple15

NestedScalarTuple.Item1!!.Add(nil)`
        let result = Compile(artifacts.Directory, "Issue3522.Reemit", source, target: "exe", artifacts.MetadataPath)
        Assert.True(result.ExitCode == 0, result.Diagnostics)
        IlVerifier.Verify(result.OutputPath, []string{artifacts.MetadataPath})
        let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
        let metadataResolver = PathAssemblyResolver(
            Directory.GetFiles(runtimeDirectory, "*.dll").Concat([]string{artifacts.MetadataPath, result.OutputPath})
        )
        {
            using let metadataContext = MetadataLoadContext(metadataResolver, "System.Private.CoreLib")
            let assembly = metadataContext.LoadFromAssemblyPath(result.OutputPath)
            let program = assembly.GetTypes().Single((type Type) -> type.Name == "<Program>")
            Assert.Equal([]uint8{2, 1}, GetNullableFlags(program.GetField("OuterArray")!!))
            Assert.Equal([]uint8{2, 1}, GetNullableFlags(program.GetField("OuterGeneric")!!))
            Assert.Equal([]uint8{2}, GetNullableFlags(program.GetField("ScalarArray")!!))
            Assert.Equal([]uint8{2}, GetNullableFlags(program.GetField("ScalarGeneric")!!))
            Assert.Equal([]uint8{0, 1, 2}, GetNullableFlags(program.GetField("NullableTuple")!!))
            Assert.Equal([]uint8{1, 0, 2, 1, 1}, GetNullableFlags(program.GetField("NullablePairContainer")!!))
            Assert.Equal([]uint8{0, 2, 2, 1}, GetNullableFlags(program.GetField("NestedScalarTuple")!!))
            Assert.Equal(Tuple8Flags, GetNullableFlags(program.GetField("Tuple8")!!))
            Assert.Equal(Tuple15Flags, GetNullableFlags(program.GetField("Tuple15")!!))
            Assert.Equal([]uint8{1, 0, 2}, GetNullableFlags(program.GetMethod("ReemitStructPair")!!.ReturnParameter))
            Assert.Equal(
                []uint8{1, 0, 1},
                GetNullableFlags(program.GetMethod("ReemitRequiredStructPair")!!.ReturnParameter)
            )
            // Issue #4988: every byte of `ValueContainer[T]` is `0`, so, as csc
            // compacts it, the method's [NullableContext(0)] carries them and the
            // return row has no [Nullable] of its own.
            let reemitStructValue = program.GetMethod("ReemitStructValue")!!
            Assert.Equal(
                []uint8{0, 0},
                ClrNullability.ExpandNullableFlags(
                    reemitStructValue.ReturnType,
                    ClrNullability.ReadNullableFlags(reemitStructValue.ReturnParameter, reemitStructValue)
                )
                    .ToArray()
            )
        }
        Assert.Equal(0, Run(result.OutputPath))
    }

    @Fact
    func NonNullableReferenceField_StillRejectsNilInLiteralAndWith() {
        using let artifacts = Issue3522ImportedNullableFieldEmitTests.TestArtifacts()
        const source = `package Issue3522.Negative

import Issue3522.Library

func Build() RequiredBadge {
  let first = RequiredBadge{ Content:nil }
  return first with{ Content = nil }
}`
        let result = Compile(
            artifacts.Directory,
            "Issue3522.Negative",
            source,
            target: "library",
            artifacts.LibraryPath
        )
        Assert.NotEqual(0, result.ExitCode)
        Assert.Equal(2, Regex.Matches(result.Diagnostics, "\\berror GS0155:").Count)
        Assert.Contains("Cannot convert type 'nil' to 'string'.", result.Diagnostics, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", result.Diagnostics, StringComparison.Ordinal)
    }

    private class TestArtifacts : IDisposable {
        init() {
            Directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3522ImportedNullableFieldEmitTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(Directory)
            let result = Issue3522ImportedNullableFieldEmitTests.Compile(
                Directory,
                "Issue3522.Library",
                Issue3522ImportedNullableFieldEmitTests.LibrarySource,
                target: "library"
            )
            Assert.True(result.ExitCode == 0, result.Diagnostics)
            LibraryPath = result.OutputPath
            IlVerifier.Verify(LibraryPath)
            MetadataPath = Path.Combine(Directory, "Issue3522.Metadata.dll")
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)).Split(
                Path.PathSeparator
            )
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let compilation = CSharpCompilation.Create(
                "Issue3522.Metadata",
                []SyntaxTree{
                    CSharpSyntaxTree.ParseText(
                        Issue3522ImportedNullableFieldEmitTests.MetadataSource,
                        CSharpParseOptions(LanguageVersion.Latest)
                    )
                },
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable
                )
            )
            let metadataResult = compilation.Emit(MetadataPath)
            Assert.True(metadataResult.Success, string.Join(Environment.NewLine, metadataResult.Diagnostics))
        }

        prop Directory string {
            get;
        }

        prop LibraryPath string {
            get;
        }

        prop MetadataPath string {
            get;
        }

        func Dispose() {
            try {
                Directory.Delete(Directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private let Tuple8Flags[]uint8 = []uint8{0, 2, 1, 1, 1, 1, 1, 1, 0, 2}
        private let Tuple15Flags[]uint8 = []uint8{0, 2, 1, 1, 1, 1, 1, 1, 0, 2, 1, 1, 1, 1, 1, 1, 0, 2}

        private const MetadataSource string = `#nullable enable
using System;
using System.Collections.Generic;

namespace Issue3522.Metadata
{
    public sealed class PairContainer<TFirst, TSecond>
    {
        public TFirst First = default!;
        public TSecond Second = default!;
    }

    public struct ValueContainer<T>
    {
        public T Value;
    }

    public class GenericBase<T>
    {
        public T Value = default!;
    }

    public sealed class GenericDerived<TFirst, TSecond>
        : GenericBase<TSecond>
    {
    }

    public class GenericMiddle<TLeft, TRight>
        : GenericBase<TLeft>
    {
    }

    public sealed class GenericLeaf<TFirst, TSecond>
        : GenericMiddle<TSecond, TFirst>
    {
    }

    public class GenericNullableBase<T>
    {
        public T? Value = default;
    }

    public sealed class GenericNullableDerived<T>
        : GenericNullableBase<T>
    {
    }

    public class GenericNullableMiddle<T>
        : GenericNullableBase<T>
    {
    }

    public sealed class GenericNullableLeaf<T>
        : GenericNullableMiddle<T>
    {
    }

    public class GenericNestedBase<T>
    {
        public List<T?> Values = new();
    }

    public sealed class GenericNestedDerived<T>
        : GenericNestedBase<T>
    {
    }

    public class GenericDictionaryBase<T>
        where T : class
    {
        public Dictionary<T, string?> Values = new();
    }

    public sealed class GenericDictionaryDerived<T>
        : GenericDictionaryBase<T>
        where T : class
    {
    }

    public class GenericConcreteBase<T>
    {
        public List<string?> Values = new();
    }

    public sealed class GenericConcreteDerived<T>
        : GenericConcreteBase<T>
    {
    }

    public class GenericCountBase<T>
    {
        public int Count;
    }

    public sealed class GenericCountDerived<TFirst, TSecond>
        : GenericCountBase<TSecond>
    {
    }

    public class GenericCountMiddle<TLeft, TRight>
        : GenericCountBase<TLeft>
    {
    }

    public sealed class GenericCountLeaf<TFirst, TSecond>
        : GenericCountMiddle<TSecond, TFirst>
    {
    }

    public static class DirectFields
    {
        public static string Required = "";
        public static string?[]? ScalarNullableArray;
        public static List<string?>? ScalarNullableGeneric = new();
        public static string[]? NullableOuterArray;
        public static List<string>? NullableOuterGeneric;
        public static Dictionary<ValueTuple<string?>, object> ValueTupleKey = new();
        public static (object Value, string? Text)? NullableTuple;
        public static PairContainer<KeyValuePair<string?, object>?, string>
            NullablePairContainer = new();
        public static (List<string?>? Values, string Required) NestedScalarTuple =
            (new(), "");
        public static (
            string? E1,
            string E2,
            string E3,
            string E4,
            string E5,
            string E6,
            string E7,
            string? E8) Tuple8 =
            (null, "", "", "", "", "", "", null);
        public static (
            string? E1,
            string E2,
            string E3,
            string E4,
            string E5,
            string E6,
            string E7,
            string? E8,
            string E9,
            string E10,
            string E11,
            string E12,
            string E13,
            string E14,
            string? E15) Tuple15 =
            (null, "", "", "", "", "", "", null, "", "", "", "", "", "", null);
        public static string[] NonNullArray = Array.Empty<string>();
        public static GenericDerived<string?, string>
            DerivedSecondNonNull = new();
        public static GenericDerived<string, string?>
            DerivedSecondNullable = new();
        public static GenericLeaf<string?, string>
            LeafSecondNonNull = new();
        public static GenericLeaf<string, string?>
            LeafSecondNullable = new();
        public static GenericNullableDerived<string>
            NullableDeclared = new();
        public static GenericNullableLeaf<string>
            NullableDeclaredLeaf = new();
        public static GenericNestedDerived<string>
            NestedNullableDeclared = new();
        public static GenericNullableDerived<List<string>>
            NullableListDeclared = new();
        public static GenericDictionaryDerived<string>
            DictionaryNullableDeclared = new();
        public static GenericConcreteDerived<string>
            ConcreteNullableDeclared = new();
    }

    public static class GenericMethods
    {
        public static PairContainer<T, string?> MakeStructPair<T>()
            where T : struct => new();

        public static PairContainer<T, string> MakeRequiredStructPair<T>()
            where T : struct => new();

        public static ValueContainer<T> MakeStructValue<T>()
            where T : struct => default;
    }

    public static class ContextFields
    {
        public static string?[]? Values;
        public static string? Marker;
    }
}

#nullable disable
namespace Issue3522.Metadata
{
    public static class ObliviousFields
    {
        public static string[] Values = new string[] { "oblivious" };
        public static List<string> Items = new List<string> { "oblivious" };
    }
}`

        private const LibrarySource string = `package Issue3522.Library
import System.Collections.Generic

public data struct Badge {
  public var Content string?
}

public data struct RequiredBadge {
  public var Content string
}

public data struct FieldShapes {
  public var OptionalCount int32?
  public var Nested Dictionary[string, List[string?]?]
  public var Values []string?
}`

        private func Compile(directory string, assemblyName string, source string, target string, references ...string)(
            ExitCode int32,
            Diagnostics string,
            OutputPath string
        ) {
            let sourcePath = Path.Combine(directory, assemblyName + ".gs")
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            File.WriteAllText(sourcePath, source)
            let args = List[string]{
                "/out:" + outputPath,
                "/target:" + target,
                "/targetframework:net10.0",
                "/nowarn:GS9100"
            }
            for reference in references {
                args.Add("/reference:" + reference)
            }
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                let exitCode = Program.Main(args.ToArray())
                return (exitCode, stdout.ToString() + stderr.ToString(), outputPath)
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func Run(assemblyPath string) int32 {
            using let process = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = Path.GetDirectoryName(assemblyPath)!!,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            ) ??
                throw InvalidOperationException("Failed to start dotnet exec.")
            let stdout = process.StandardOutput.ReadToEnd()
            let stderr = process.StandardError.ReadToEnd()
            Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
            Assert.True(process.ExitCode >= 0, (`process failed
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return process.ExitCode
        }

        private func GetNullableFlags(provider ICustomAttributeProvider?)[]uint8 {
            let attributes = switch provider {
                case member is MemberInfo: member.GetCustomAttributesData()
                case parameter is ParameterInfo: parameter.GetCustomAttributesData()
                default: throw ArgumentException("Unsupported attribute provider.", "provider")
            }
            let attribute CustomAttributeData? = attributes.SingleOrDefault(
                (data CustomAttributeData) -> data
                    .AttributeType
                    .FullName == "System.Runtime.CompilerServices.NullableAttribute"
            )
            if attribute == nil {
                return Array.Empty[uint8]()
            }
            let value object? = attribute.ConstructorArguments.Single().Value
            if value is uint8 scalar {
                return []uint8{scalar}
            }
            return (cast[IEnumerable[CustomAttributeTypedArgument]](value!!)).Select(
                (argument CustomAttributeTypedArgument) -> uint8(argument.Value!!)
            )
                .ToArray()
        }

        private func GetNullableContext(member MemberInfo?) uint8 -> Assert.IsType[uint8](TryGetNullableContext(member))

        private func TryGetNullableContext(member MemberInfo?) uint8? {
            let attribute CustomAttributeData? = member!!.GetCustomAttributesData().SingleOrDefault(
                (data CustomAttributeData) -> data
                    .AttributeType
                    .FullName == "System.Runtime.CompilerServices.NullableContextAttribute"
            )
            return if attribute == nil {
                nil
            } else {
                uint8(attribute.ConstructorArguments.Single().Value!!)
            }
        }

        /// Asserts the decoded shape of an imported array field.
        /// @param field The imported field.
        /// @param outerNullable Whether the array position admits nil.
        /// @param elementNullable Whether the element position admits nil.
        /// @param oblivious ADR-0186 step 3: whether the declaration says <em>nothing</em> about
        /// these positions, in which case "admits nil" is spelled
        /// (cref:PlatformTypeSymbol) rather than
        /// (cref:NullableTypeSymbol). The distinction is the entire
        /// content of the flip, and it is a parameter rather than a widened
        /// assertion so that an annotated-nullable row cannot go green on a
        /// platform type or the other way round.
        private func AssertArray(field FieldInfo?, outerNullable bool, elementNullable bool, oblivious bool = false) {
            let fieldType = ClrNullability.GetFieldTypeSymbol(field!!)
            let array = if outerNullable {
                Assert.IsType[NullabilityAnnotatedTypeSymbol](
                    if oblivious {
                        Assert.IsType[PlatformTypeSymbol](fieldType).UnderlyingType
                    } else {
                        Assert.IsType[NullableTypeSymbol](fieldType).UnderlyingType
                    }
                )
            } else {
                Assert.IsType[NullabilityAnnotatedTypeSymbol](fieldType)
            }
            let element = array.GetTypeArgumentSymbolForClrType(array.ClrType!!.GetElementType())
            if elementNullable && oblivious {
                Assert.Same(TypeSymbol.String, Assert.IsType[PlatformTypeSymbol](element).UnderlyingType)
            } else if elementNullable {
                let nullable = Assert.IsType[NullableTypeSymbol](element)
                Assert.Same(TypeSymbol.String, nullable.UnderlyingType)
            } else {
                Assert.Same(TypeSymbol.String, element)
            }
        }

        private func AssertTupleField(field FieldInfo?, arity int32, nullableIndices ...int32) TupleTypeSymbol {
            let tuple = Assert.IsType[TupleTypeSymbol](ClrNullability.GetFieldTypeSymbol(field!!))
            Assert.Equal(arity, tuple.Arity)
            for var i = 0; i < tuple.Arity; i++ {
                if nullableIndices.Contains(i) {
                    Assert.IsType[NullableTypeSymbol](tuple.ElementTypes[i])
                } else {
                    Assert.IsNotType[NullableTypeSymbol](tuple.ElementTypes[i])
                }
            }
            return tuple
        }
    }
}
