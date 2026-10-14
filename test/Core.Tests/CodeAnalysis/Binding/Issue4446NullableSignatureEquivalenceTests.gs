// <copyright file="Issue4446NullableSignatureEquivalenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import Xunit
import GSharp.Core.Tests

/// Issue #4446: signature identity ignores reference nullability, but a
/// value-type `T?` is the distinct CLR type `Nullable<T>`.
/// The pre-fix mutant is deleting the asymmetric-nullable guard in
/// `TypeSignaturesEquivalent`; the shared-comparer, source override and
/// interface, imported override, and hierarchy-projection tests then fail.
/// The partial-method and overload tests pin adjacent fallback/control paths.
class Issue4446NullableSignatureEquivalenceTests {
    @Fact
    func SharedComparer_DistinguishesValueNullableAtEveryNestedPosition() {
        let nullableInt = NullableTypeSymbol.Get(TypeSymbol.Int32)
        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(nullableInt, TypeSymbol.Int32))
        Assert.False(
            DeclarationBinder.TypeSignaturesEquivalent(
                ArrayTypeSymbol.Get(nullableInt, 2),
                ArrayTypeSymbol.Get(TypeSymbol.Int32, 2)
            )
        )
        Assert.False(
            DeclarationBinder.TypeSignaturesEquivalent(
                TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](TypeSymbol.String, nullableInt)),
                TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](TypeSymbol.String, TypeSymbol.Int32))
            )
        )
        Assert.False(
            DeclarationBinder.TypeSignaturesEquivalent(
                ImportedTypeSymbol.GetConstructed(
                    typeof(List[int32?]),
                    typeof(List[_]),
                    ImmutableArray.Create[TypeSymbol](nullableInt)
                ),
                ImportedTypeSymbol.GetConstructed(
                    typeof(List[int32]),
                    typeof(List[_]),
                    ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
                )
            )
        )
        let enumType = TypeSymbol.FromClrType(typeof(DayOfWeek))
        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(NullableTypeSymbol.Get(enumType), enumType))
        let structParameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None){
            HasValueTypeConstraint = true
        }
        Assert.False(
            DeclarationBinder.TypeSignaturesEquivalent(NullableTypeSymbol.Get(structParameter), structParameter)
        )
        let userCompilation = Compilation(SyntaxTree.Parse(SourceText.From("struct Token { }\nclass Node { }")))
        let userStruct = Assert.Single(
            userCompilation.GlobalScope.Structs,
            (symbol StructSymbol) -> symbol.Name == "Token"
        )
        let userClass = Assert.Single(
            userCompilation.GlobalScope.Structs,
            (symbol StructSymbol) -> symbol.Name == "Node"
        )
        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(NullableTypeSymbol.Get(userStruct), userStruct))
        Assert.False(
            DeclarationBinder.TypeSignaturesEquivalent(
                ImportedTypeSymbol.GetConstructed(
                    typeof(List[object]),
                    typeof(List[_]),
                    ImmutableArray.Create[TypeSymbol](NullableTypeSymbol.Get(userStruct))
                ),
                ImportedTypeSymbol.GetConstructed(
                    typeof(List[object]),
                    typeof(List[_]),
                    ImmutableArray.Create[TypeSymbol](userStruct)
                )
            )
        )
        Assert.True(
            DeclarationBinder.TypeSignaturesEquivalent(
                ImportedTypeSymbol.GetConstructed(
                    typeof(List[object]),
                    typeof(List[_]),
                    ImmutableArray.Create[TypeSymbol](NullableTypeSymbol.Get(userClass))
                ),
                ImportedTypeSymbol.GetConstructed(
                    typeof(List[object]),
                    typeof(List[_]),
                    ImmutableArray.Create[TypeSymbol](userClass)
                )
            )
        )
        Assert.False(
            DeclarationBinder.TypeSignaturesEquivalent(
                ImportedTypeSymbol.GetConstructed(
                    typeof(List[object]),
                    typeof(List[_]),
                    ImmutableArray.Create(PlatformTypeSymbol.Get(userClass))
                ),
                ImportedTypeSymbol.GetConstructed(
                    typeof(List[object]),
                    typeof(List[_]),
                    ImmutableArray.Create[TypeSymbol](userClass)
                )
            )
        )
        Assert.True(DeclarationBinder.TypeSignaturesEquivalent(NullableTypeSymbol.Get(userClass), userClass))
        Assert.True(
            DeclarationBinder.TypeSignaturesEquivalent(NullableTypeSymbol.Get(TypeSymbol.String), TypeSymbol.String)
        )
        let exactUnderlyingA = ImportedTypeSymbol.GetConstructed(
            typeof(ValueTuple[int32]),
            typeof(ValueTuple[_]),
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        )
        let exactUnderlyingB = ImportedTypeSymbol.GetConstructed(
            typeof(ValueTuple[int32]),
            typeof(ValueTuple[_]),
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32)
        )
        let exactNullableA = NullableTypeSymbol.Get(exactUnderlyingA)
        let exactNullableB = NullableTypeSymbol.Get(exactUnderlyingB)
        Assert.NotSame(exactNullableA, exactNullableB)
        Assert.True(DeclarationBinder.TypeSignaturesEquivalent(exactNullableA, exactNullableB))
    }

    @Fact
    func Override_ValueNullableMismatchIsRejected_ReferenceNullableAndExactValueNullableMatch() {
        let diagnostics = Compile(`class Node { }

open class Base {
    open func Bad(x int32) int32 { return x }
    open func Ref(x string) string { return x }
    open func UserRef(x Node) Node { return x }
    open func Exact(x int32?) int32 { return x ?? 0 }
}

class Derived : Base {
    override func Bad(x int32?) int32 { return x ?? 0 }
    override func Ref(x string?) string { return x ?? "" }
    override func UserRef(x Node?) Node? { return x }
    override func Exact(x int32?) int32 { return x ?? 0 }
}`)
        AssertErrorIds(diagnostics, "GS0185")
    }

    @Fact
    func Interface_ValueNullableMismatchIsRejected_ReferenceNullableAndExactValueNullableMatch() {
        let diagnostics = Compile(`class Node { }

interface IContract {
    func Bad(x int32) int32;
    func Ref(x string) string;
    func UserRef(x Node) Node;
    func Exact(x int32?) int32;
}

class Implementation : IContract {
    func Bad(x int32?) int32 { return x ?? 0 }
    func Ref(x string?) string { return x ?? "" }
    func UserRef(x Node?) Node? { return x }
    func Exact(x int32?) int32 { return x ?? 0 }
}`)
        AssertErrorIds(diagnostics, "GS0187")
    }

    @Fact
    func PartialMethod_ValueNullableFallbackPairReportsMismatch() {
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(`partial class C {
    partial func Bad() int32;
    partial func Exact() int32?;
}

partial class C {
    partial func Bad() int32? { return nil }
    partial func Exact() int32? { return nil }
}`))){IsLibrary = true}
        using let pe = MemoryStream()
        let diagnostics = compilation.Emit(pe).Diagnostics
        AssertErrorIds(diagnostics, "GS0611")
    }

    @Fact
    func ValueNullableHierarchyProjectionsRemainAmbiguous() {
        using let library = CSharpFixture(`#nullable enable
namespace Issue4446.Library;

public interface IBox<T> { }
public sealed class Ambiguous : IBox<int>, IBox<int?> { }
public static class Api
{
    public static Ambiguous Make() => new();
    public static T Pick<T>(IBox<T> value) => default!;
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
        let compilation = Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From("import Issue4446.Library\nlet value = Api.Pick(Api.Make())"))
        )
        let error = Assert.Single(compilation.GlobalScope.Diagnostics, (diagnostic Diagnostic) -> diagnostic.IsError)
        Assert.True((error.Id is "GS0151" or "GS0159"), error.Id + ": " + error.Message)
    }

    @Fact
    func ValueNullableArgumentUsesTheNullableOverload() {
        let result = EmittedOracle.Evaluate(`func Pick(value int32) string -> "plain"
func Pick(value int32?) string -> "nullable"

let value int32? = 1
Pick(value)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("nullable", result.Value)
    }

    @Fact
    func ImportedOverrideAndInterfaceSlotsRejectValueNullableImplementations() {
        using let library = CSharpFixture(`namespace Issue4446.Imported;

public class Base
{
    public virtual int M(int value) => value;
}

public interface IContract
{
    int M(int value);
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
        let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`import Issue4446.Imported

class Derived : Base {
    override func M(value int32?) int32 { return value ?? 0 }
}

class Implementation : IContract {
    func M(value int32?) int32 { return value ?? 0 }
}`)))
        AssertErrorIds(compilation.GlobalScope.Diagnostics, "GS0185", "GS0187")
    }

    shared {
        private func Compile(source string) ImmutableArray[Diagnostic] {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            return compilation.GlobalScope.Diagnostics
        }

        private func AssertErrorIds(diagnostics ImmutableArray[Diagnostic], expected ...string) -> Assert.Equal(
            expected.OrderBy((id string) -> id, StringComparer.Ordinal),
            diagnostics
                .Where((diagnostic Diagnostic) -> diagnostic.IsError)
                .Select((diagnostic Diagnostic) -> diagnostic.Id)
                .OrderBy((id string) -> id, StringComparer.Ordinal)
        )
    }
}
