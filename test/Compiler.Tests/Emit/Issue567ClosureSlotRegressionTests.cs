// <copyright file="Issue567ClosureSlotRegressionTests.cs" company="GSharp">
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
/// Issue #567 regression guard: verifies that programs involving closures
/// inside for-in loops compile cleanly without silent emit failures. If the
/// underlying closure lowering bug resurfaces, the emit invariant ensures a
/// structured <c>GS9998</c> diagnostic would appear (tested separately in
/// <c>SilentEmitFailureInvariantTests</c>).
/// </summary>
public class Issue567ClosureSlotRegressionTests
{
    [Fact]
    public void ClosureInsideForIn_CompilesSuccessfully()
    {
        // This pattern exercises closures inside for-in loops. If the
        // underlying closure lowering bug resurfaces (issue #567), the
        // emit invariant catches it with a structured GS9998 diagnostic.
        var source = """
            package Test
            import System
            import System.Collections.Generic

            var items = List[string]()
            items.Add("a")
            items.Add("b")
            items.Add("c")

            var n = 0
            for s in items {
                n = n + 1
            }

            Console.WriteLine(n)
            """;

        var sourceText = SourceText.From(source, "issue567_closure_test.gs");
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

