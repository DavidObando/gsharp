// <copyright file="Issue1212NullableElementArrayIndexTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1212: the two array nullability spellings.
/// <list type="bullet">
/// <item><c>[]T?</c> is a (non-nil) array whose ELEMENTS are nullable. It is
/// indexable as ordinary element access yielding <c>T?</c> (read) and accepting
/// <c>T?</c> (write).</item>
/// <item><c>[]?T</c> is a nullable ARRAY reference (the whole array may be nil).
/// Indexing it directly is rejected with GS0116; a null-forgiving <c>!!</c>
/// (or the null-conditional <c>?[</c>) is required first.</item>
/// <item><c>[]?T?</c> is a nullable array of nullable elements.</item>
/// </list>
/// </summary>
public class Issue1212NullableElementArrayIndexTests
{
    [Fact]
    public void NullableReferenceElementSlice_IsIndexable_ForRead()
    {
        var diagnostics = Bind("""
            package p
            func F(a []object?) object? { return a[0] }
            """);
        Assert.Empty(diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void NullableValueElementSlice_IsIndexable_ForRead()
    {
        var diagnostics = Bind("""
            package p
            func G(a []int32?) int32? { return a[0] }
            """);
        Assert.Empty(diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void NonNullableElementSlice_StillIndexable()
    {
        var diagnostics = Bind("""
            package p
            func H(a []object) object { return a[0] }
            """);
        Assert.Empty(diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void NullableElementSlice_IndexResult_IsNullableElementType()
    {
        // `a[0]` on `[]int32?` yields `int32?`; assigning it to a non-nullable
        // `int32` return must be rejected, proving the read result is nullable.
        var diagnostics = Bind("""
            package p
            func F(a []int32?) int32 { return a[0] }
            """);
        Assert.Contains(diagnostics, d => d.IsError);
    }

    [Fact]
    public void NullableElementSlice_IndexedWrite_AcceptsNullableElement()
    {
        var diagnostics = Bind("""
            package p
            func W(a []object?, x object?) { a[0] = x }
            func V(a []int32?, x int32?) { a[0] = x }
            """);
        Assert.Empty(diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void NullableElementFixedArray_IsIndexable()
    {
        var diagnostics = Bind("""
            package p
            func F(a [3]int32?) int32? { return a[0] }
            """);
        Assert.Empty(diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void WholeNullableArray_RequiresNullCheck_BeforeIndexing()
    {
        // `[]?int32` is a nullable array *reference*; indexing it directly is
        // rejected with GS0116 (the array may be nil).
        var diagnostics = Bind("""
            package p
            func F(a []?int32) int32 { return a[0] }
            """);
        Assert.Contains(diagnostics, d => d.Id == "GS0116");
    }

    [Fact]
    public void WholeNullableArray_IsIndexable_AfterNullForgiving()
    {
        var diagnostics = Bind("""
            package p
            func F(a []?int32) int32 { return a!![0] }
            """);
        Assert.Empty(diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void NullableArrayOfNullableElements_IndexAfterForgiving_YieldsNullableElement()
    {
        var diagnostics = Bind("""
            package p
            func F(a []?int32?) int32? { return a!![0] }
            """);
        Assert.Empty(diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void NullableArray_DisplayName_BindsQuestionToArray_NotElement()
    {
        // Issue #1212: the GS0116 message must render the whole-array nullable
        // spelling `[]?int32`, NOT `[]int32?` (which now means nullable elements).
        var diagnostics = Bind("""
            package p
            func N(a []?int32) int32 { return a[0] }
            """);
        var gs0116 = Assert.Single(diagnostics, d => d.Id == "GS0116");
        Assert.Contains("[]?int32", gs0116.Message);
        Assert.DoesNotContain("[]int32?", gs0116.Message);
    }

    [Fact]
    public void NullableElementSlice_DisplayName_BindsQuestionToElement()
    {
        // The element-nullable spelling renders `[]int32?` (no conversion to string).
        var diagnostics = Bind("""
            package p
            func F(a []int32?) string { return a }
            """);
        var gs0156 = Assert.Single(diagnostics, d => d.Id == "GS0156");
        Assert.Contains("[]int32?", gs0156.Message);
        Assert.DoesNotContain("[]?int32", gs0156.Message);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any(d => d.IsError))
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any(d => d.IsError))
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
