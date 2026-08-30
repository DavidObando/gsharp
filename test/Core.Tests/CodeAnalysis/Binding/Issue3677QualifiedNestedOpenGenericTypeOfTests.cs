// <copyright file="Issue3677QualifiedNestedOpenGenericTypeOfTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3677: the deferred remainder of #3678. The UNQUALIFIED explicit-arity
/// open-generic spelling (<c>typeof(Slot[_])</c>) now consults the declaration
/// table, but the QUALIFIED (<c>typeof(Fixtures.IQuery[_])</c>) and NESTED
/// (<c>typeof(Outer[_].Inner[_])</c>) spellings still resolved through
/// reflection names against the reference set alone, so a generic declared in
/// the compilation being built reported GS0113 "Type 'Fixtures.IQuery`1'
/// doesn't exist". Both spellings now fall back to a SOURCE walk — the head
/// segment through the ordinary source-type lookup, every later segment as a
/// nested type of the previously-resolved container — after the imported walks
/// miss, so an imported match still wins exactly as before.
/// <para>
/// As in #3678 the tests EXECUTE the emitted program, so the second half of
/// that fix (an <c>ldtoken</c> of an open user generic definition must take its
/// TypeDef row, not an unbound <c>Name&lt;!0&gt;</c> TypeSpec that fails to
/// load) is covered for the new spellings too.
/// </para>
/// </summary>
public class Issue3677QualifiedNestedOpenGenericTypeOfTests
{
    private const string Fixtures = @"
class Fixtures {
    interface IQuery[T] {}
    interface IChain[A, B, C, D] {}
    class Plain {}
}

class Outer[T] {
    class Inner[U] {}
    class PlainInner {}
}

class Slot[T] {
    prop Value int32
}
";

    [Fact]
    public void QualifiedSourceGeneric_SingleArity_BindsAndEmitsOpenDefinition()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\ntypeof(Fixtures.IQuery[_]).Name\n");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("IQuery`1", result.Value);
    }

    [Fact]
    public void QualifiedSourceGeneric_MultiArity_BindsAndEmitsOpenDefinition()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\ntypeof(Fixtures.IChain[_, _, _, _]).Name\n");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("IChain`4", result.Value);
    }

    [Fact]
    public void QualifiedSourceGeneric_IsGenericTypeDefinition()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\ntypeof(Fixtures.IQuery[_]).IsGenericTypeDefinition\n");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void QualifiedSourceGeneric_MakeGenericType_Constructs()
    {
        var result = EmittedOracle.Evaluate(
            Fixtures + "\ntypeof(Fixtures.IQuery[_]).MakeGenericType(typeof(int32)).GetGenericArguments()[0].Name\n");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Int32", result.Value);
    }

    [Fact]
    public void NestedSourceGenericInsideGeneric_BindsAndEmitsOpenDefinition()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\ntypeof(Outer[_].Inner[_]).Name\n");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Inner`1", result.Value);
    }

    [Fact]
    public void NestedSourceGenericInsideGeneric_CarriesEnclosingTypeParameters()
    {
        // The CLR gives a type nested in a generic its enclosing type's
        // parameters too, so `Outer`1+Inner`1` is an arity-2 definition —
        // exactly what C#'s `typeof(Outer<>.Inner<>)` yields.
        var result = EmittedOracle.Evaluate(Fixtures + "\ntypeof(Outer[_].Inner[_]).GetGenericArguments().Length\n");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(2, result.Value);
    }

    [Fact]
    public void NonGenericNestedInsideSourceGeneric_BindsAndEmitsOpenDefinition()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\ntypeof(Outer[_].PlainInner).IsGenericTypeDefinition\n");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void NonGenericNestedInsideSourceGeneric_NamesTheNestedType()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\ntypeof(Outer[_].PlainInner).Name\n");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("PlainInner", result.Value);
    }

    [Fact]
    public void QualifiedSourceGeneric_WrongArity_StillReportsUndefinedTypeGS0113()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\nlet t = typeof(Fixtures.IQuery[_, _])\n");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0113");
    }

    [Fact]
    public void QualifiedNonGenericSourceType_WithArity_StillReportsUndefinedTypeGS0113()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\nlet t = typeof(Fixtures.Plain[_])\n");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0113");
    }

    [Fact]
    public void QualifiedSourceGeneric_BogusQualifier_StillReportsUndefinedTypeGS0113()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\nlet t = typeof(Nonsense.Fixtures.IQuery[_])\n");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0113");
    }

    [Fact]
    public void NestedSourceGeneric_WrongOuterArity_StillReportsUndefinedTypeGS0113()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\nlet t = typeof(Outer[_, _].Inner[_])\n");
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0113");
    }

    [Fact]
    public void UnqualifiedSourceGeneric_StillBinds()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\ntypeof(Slot[_]).Name\n");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Slot`1", result.Value);
    }

    [Fact]
    public void BareSourceGeneric_StillBinds()
    {
        var result = EmittedOracle.Evaluate(Fixtures + "\ntypeof(Slot).Name\n");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("Slot`1", result.Value);
    }

    [Fact]
    public void PackageQualifiedSourceGeneric_BindsThroughRelativeQualifier()
    {
        // The shape migrated code actually has: the C# `typeof(Fixtures.IQuery<>)`
        // qualifier is a NAMESPACE, spelled relative to the referencing package.
        var result = EmittedOracle.Evaluate(new[]
        {
            @"
package Demo.Fixtures3677

interface IQuery3677[T] {}
",
            "\ntypeof(Fixtures3677.IQuery3677[_]).Name\n",
        });
        Assert.Empty(result.Diagnostics);
        Assert.Equal("IQuery3677`1", result.Value);
    }

    [Fact]
    public void QualifiedImportedGeneric_StillWins()
    {
        // The imported reflection-name walk runs first and is unchanged: a
        // fully-qualified BCL generic keeps resolving from the reference set.
        var result = EmittedOracle.Evaluate(
            Fixtures + "\ntypeof(System.Collections.Generic.List[_]).Name\n");
        Assert.Empty(result.Diagnostics);
        Assert.Equal("List`1", result.Value);
    }
}
