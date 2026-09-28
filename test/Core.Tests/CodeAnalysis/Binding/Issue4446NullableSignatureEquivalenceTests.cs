// <copyright file="Issue4446NullableSignatureEquivalenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4446: signature identity ignores reference nullability, but a
/// value-type <c>T?</c> is the distinct CLR type <c>Nullable&lt;T&gt;</c>.
/// The pre-fix mutant is deleting the asymmetric-nullable guard in
/// <c>TypeSignaturesEquivalent</c>; the shared-comparer, source override and
/// interface, imported override, and hierarchy-projection tests then fail.
/// The partial-method and overload tests pin adjacent fallback/control paths.
/// </summary>
public sealed class Issue4446NullableSignatureEquivalenceTests
{
    [Fact]
    public void SharedComparer_DistinguishesValueNullableAtEveryNestedPosition()
    {
        var nullableInt = NullableTypeSymbol.Get(TypeSymbol.Int32);

        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(nullableInt, TypeSymbol.Int32));
        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(
            ArrayTypeSymbol.Get(nullableInt, 2),
            ArrayTypeSymbol.Get(TypeSymbol.Int32, 2)));
        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(
            TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(TypeSymbol.String, nullableInt)),
            TupleTypeSymbol.Get(ImmutableArray.Create<TypeSymbol>(TypeSymbol.String, TypeSymbol.Int32))));
        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(
            ImportedTypeSymbol.GetConstructed(
                typeof(List<int?>),
                typeof(List<>),
                ImmutableArray.Create<TypeSymbol>(nullableInt)),
            ImportedTypeSymbol.GetConstructed(
                typeof(List<int>),
                typeof(List<>),
                ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32))));

        var enumType = TypeSymbol.FromClrType(typeof(DayOfWeek));
        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(NullableTypeSymbol.Get(enumType), enumType));

        var structParameter = new TypeParameterSymbol(
            "T",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None)
        {
            HasValueTypeConstraint = true,
        };
        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(
            NullableTypeSymbol.Get(structParameter),
            structParameter));

        var userCompilation = new Compilation(SyntaxTree.Parse(SourceText.From("struct Token { }")));
        var userStruct = Assert.Single(userCompilation.GlobalScope.Structs);
        Assert.False(DeclarationBinder.TypeSignaturesEquivalent(
            NullableTypeSymbol.Get(userStruct),
            userStruct));

        Assert.True(DeclarationBinder.TypeSignaturesEquivalent(
            NullableTypeSymbol.Get(TypeSymbol.String),
            TypeSymbol.String));

        var exactUnderlyingA = ImportedTypeSymbol.GetConstructed(
            typeof(ValueTuple<int>),
            typeof(ValueTuple<>),
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        var exactUnderlyingB = ImportedTypeSymbol.GetConstructed(
            typeof(ValueTuple<int>),
            typeof(ValueTuple<>),
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        var exactNullableA = NullableTypeSymbol.Get(exactUnderlyingA);
        var exactNullableB = NullableTypeSymbol.Get(exactUnderlyingB);
        Assert.NotSame(exactNullableA, exactNullableB);
        Assert.True(DeclarationBinder.TypeSignaturesEquivalent(exactNullableA, exactNullableB));
    }

    [Fact]
    public void Override_ValueNullableMismatchIsRejected_ReferenceNullableAndExactValueNullableMatch()
    {
        var diagnostics = Compile("""
            open class Base {
                open func Bad(x int32) int32 { return x }
                open func Ref(x string) string { return x }
                open func Exact(x int32?) int32 { return x ?? 0 }
            }

            class Derived : Base {
                override func Bad(x int32?) int32 { return x ?? 0 }
                override func Ref(x string?) string { return x ?? "" }
                override func Exact(x int32?) int32 { return x ?? 0 }
            }
            """);

        AssertErrorIds(diagnostics, "GS0185");
    }

    [Fact]
    public void Interface_ValueNullableMismatchIsRejected_ReferenceNullableAndExactValueNullableMatch()
    {
        var diagnostics = Compile("""
            interface IContract {
                func Bad(x int32) int32;
                func Ref(x string) string;
                func Exact(x int32?) int32;
            }

            class Implementation : IContract {
                func Bad(x int32?) int32 { return x ?? 0 }
                func Ref(x string?) string { return x ?? "" }
                func Exact(x int32?) int32 { return x ?? 0 }
            }
            """);

        AssertErrorIds(diagnostics, "GS0187");
    }

    [Fact]
    public void PartialMethod_ValueNullableFallbackPairReportsMismatch()
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From("""
            partial class C {
                partial func Bad() int32;
                partial func Exact() int32?;
            }

            partial class C {
                partial func Bad() int32? { return nil }
                partial func Exact() int32? { return nil }
            }
            """)))
            { IsLibrary = true };
        using var pe = new MemoryStream();
        var diagnostics = compilation.Emit(pe).Diagnostics;

        AssertErrorIds(diagnostics, "GS0611");
    }

    [Fact]
    public void ValueNullableHierarchyProjectionsRemainAmbiguous()
    {
        using var library = new CSharpFixture("""
            #nullable enable
            namespace Issue4446.Library;

            public interface IBox<T> { }
            public sealed class Ambiguous : IBox<int>, IBox<int?> { }
            public static class Api
            {
                public static Ambiguous Make() => new();
                public static T Pick<T>(IBox<T> value) => default!;
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });
        var compilation = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From("""
                import Issue4446.Library
                let value = Api.Pick(Api.Make())
                """)));

        var error = Assert.Single(compilation.GlobalScope.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.True(error.Id is "GS0151" or "GS0159", error.Id + ": " + error.Message);
    }

    [Fact]
    public void ValueNullableArgumentUsesTheNullableOverload()
    {
        var result = EmittedOracle.Evaluate("""
            func Pick(value int32) string -> "plain"
            func Pick(value int32?) string -> "nullable"

            let value int32? = 1
            Pick(value)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("nullable", result.Value);
    }

    [Fact]
    public void ImportedOverrideAndInterfaceSlotsRejectValueNullableImplementations()
    {
        using var library = new CSharpFixture("""
            namespace Issue4446.Imported;

            public class Base
            {
                public virtual int M(int value) => value;
            }

            public interface IContract
            {
                int M(int value);
            }
            """);
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });
        var compilation = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From("""
                import Issue4446.Imported

                class Derived : Base {
                    override func M(value int32?) int32 { return value ?? 0 }
                }

                class Implementation : IContract {
                    func M(value int32?) int32 { return value ?? 0 }
                }
                """)));

        AssertErrorIds(compilation.GlobalScope.Diagnostics, "GS0185", "GS0187");
    }

    private static ImmutableArray<Diagnostic> Compile(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        return compilation.GlobalScope.Diagnostics;
    }

    private static void AssertErrorIds(ImmutableArray<Diagnostic> diagnostics, params string[] expected)
        => Assert.Equal(
            expected.OrderBy(id => id, StringComparer.Ordinal),
            diagnostics.Where(diagnostic => diagnostic.IsError)
                .Select(diagnostic => diagnostic.Id)
                .OrderBy(id => id, StringComparer.Ordinal));
}
