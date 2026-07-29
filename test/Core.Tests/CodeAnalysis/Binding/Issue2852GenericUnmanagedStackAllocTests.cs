// <copyright file="Issue2852GenericUnmanagedStackAllocTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2852: <c>stackalloc [n]T</c> accepts an
/// <c>unmanaged</c>-constrained type parameter without admitting type
/// parameters or structs that may contain managed references.
/// </summary>
public class Issue2852GenericUnmanagedStackAllocTests
{
    [Fact]
    public void StackAlloc_UnmanagedTypeParameter_Binds()
    {
        const string source = """
            package p
            func F[T unmanaged](value T) T {
                var values = stackalloc [4]T
                values[3] = value
                return values[3]
            }
            """;

        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StackAlloc_StructConstrainedTypeParameter_ReportsGS0399()
    {
        const string source = """
            package p
            func F[T struct]() {
                var values = stackalloc [4]T
            }
            """;

        Assert.Contains(GetDiagnostics(source), d => d.Id == "GS0399");
    }

    [Fact]
    public void StackAlloc_UnconstrainedTypeParameter_ReportsGS0399()
    {
        const string source = """
            package p
            func F[T any]() {
                var values = stackalloc [4]T
            }
            """;

        Assert.Contains(GetDiagnostics(source), d => d.Id == "GS0399");
    }

    [Fact]
    public void StackAlloc_StructContainingReference_ReportsGS0399()
    {
        const string source = """
            package p
            struct Bad {
                var Text string
            }
            func F() {
                var values = stackalloc [4]Bad
            }
            """;

        Assert.Contains(GetDiagnostics(source), d => d.Id == "GS0399");
    }

    [Fact]
    public void StackAlloc_ImportedStructContainingReference_ReportsGS0399()
    {
        const string source = """
            package p
            import GSharp.Core.Tests.CodeAnalysis.Binding
            func F() {
                var values = stackalloc [4]Issue2852ImportedManagedStruct
            }
            """;

        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0399");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void StackAlloc_ImportedNestedStructContainingReference_ReportsGS0399()
    {
        const string source = """
            package p
            import GSharp.Core.Tests.CodeAnalysis.Binding
            func F() {
                var values = stackalloc [4]Issue2852ImportedNestedManagedStruct
            }
            """;

        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0399");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void StackAlloc_ImportedRefStruct_ReportsGS0399()
    {
        const string source = """
            package p
            import GSharp.Core.Tests.CodeAnalysis.Binding
            func F() {
                var values = stackalloc [4]Issue2852ImportedRefStruct
            }
            """;

        var diagnostics = GetDiagnostics(source);
        Assert.Contains(diagnostics, d => d.Id == "GS0399");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9998");
    }

    [Fact]
    public void StackAlloc_ImportedNestedUnmanagedStruct_Binds()
    {
        const string source = """
            package p
            import GSharp.Core.Tests.CodeAnalysis.Binding
            func F() {
                var values = stackalloc [4]Issue2852ImportedUnmanagedOuter
            }
            """;

        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StackAlloc_ImportedStructContainingPointerAndFunctionPointerFields_Binds()
    {
        const string source = """
            package p
            import GSharp.Core.Tests.CodeAnalysis.Binding
            func F() {
                var values = stackalloc [4]Issue2852ImportedPointerFields
            }
            """;

        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StackAlloc_ImportedStructContainingNullableField_Binds()
    {
        const string source = """
            package p
            import GSharp.Core.Tests.CodeAnalysis.Binding
            func F() {
                var values = stackalloc [4]Issue2852ImportedNullableFieldStruct
            }
            """;

        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void StackAlloc_TopLevelNullable_ReportsGS0399()
    {
        const string source = """
            package p
            import System
            func F() {
                var values = stackalloc [4]Nullable[int32]
            }
            """;

        Assert.Contains(GetDiagnostics(source), d => d.Id == "GS0399");
    }

    private static ImmutableArray<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(d => d.IsError)
            .ToImmutableArray();
    }
}

public struct Issue2852ImportedManagedStruct
{
    public string Text { get; set; }
}

public struct Issue2852ImportedNestedManagedStruct
{
    public Issue2852ImportedManagedStruct Inner { get; set; }
}

public ref struct Issue2852ImportedRefStruct
{
    public Span<int> Values { get; set; }
}

public struct Issue2852ImportedUnmanagedInner
{
    public int Value { get; set; }
}

public struct Issue2852ImportedUnmanagedOuter
{
    public Issue2852ImportedUnmanagedInner Inner { get; set; }
}

public unsafe struct Issue2852ImportedPointerFields
{
    public int* Pointer { get; set; }

    public delegate* unmanaged<int, int> FunctionPointer { get; set; }
}

public struct Issue2852ImportedNullableFieldStruct
{
    public int? Value { get; set; }
}
