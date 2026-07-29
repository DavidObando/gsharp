// <copyright file="Issue2852GenericUnmanagedStackAllocTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
