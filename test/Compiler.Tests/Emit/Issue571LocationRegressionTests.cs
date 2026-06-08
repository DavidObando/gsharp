// <copyright file="Issue571LocationRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #571 regression guard: verifies that programs involving nullable
/// value-type implicit lifts compile cleanly. If the underlying emit path
/// fails in the future, the invariant ensures a structured <c>GS9998</c>
/// diagnostic anchored at the call site (tested separately in
/// <c>SilentEmitFailureInvariantTests</c>).
/// </summary>
public class Issue571LocationRegressionTests
{
    [Fact]
    public void NullableValueTypeLift_CompilesSuccessfully()
    {
        // This pattern exercises nullable value-type operations that
        // previously risked silent emit failures (issue #571).
        var source = """
            package Test
            import System

            var x int32? = 42
            var y int32? = nil
            var v int32 = x ?: 0
            Console.WriteLine(v)
            Console.WriteLine(y)
            """;

        var sourceText = SourceText.From(source, "issue571_location_test.gs");
        var tree = SyntaxTree.Parse(sourceText);
        var compilation = new Compilation(tree);

        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream, refStream: null);

        Assert.True(
            result.Success,
            "Expected successful compilation; got: " + string.Join("; ", result.Diagnostics.Select(d => $"[{d.Id}] {d.Message}")));
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS9998");
    }
}

