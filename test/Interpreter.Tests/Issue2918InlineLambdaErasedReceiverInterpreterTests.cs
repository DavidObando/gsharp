// <copyright file="Issue2918InlineLambdaErasedReceiverInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2918: evaluate-mode binding preserves inline lambda targets through
/// erased imported-generic receivers before the evaluator runs.
/// </summary>
public class Issue2918InlineLambdaErasedReceiverInterpreterTests
{
    [Fact]
    public void ImportedGenericReceiverInlineLambdas_BindWithoutErrors()
    {
        var tree = SyntaxTree.Parse("""
            package Issue2918Interpreter
            import System
            import System.Collections.Generic

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let callbacks = List[Action[Src]]()
                callbacks.Add((item Src) -> Console.WriteLine(item.N))

                let nested = List[Action[List[Src]]]()
                nested.Add((items List[Src]) -> Console.WriteLine(items[0].N))
            }
            """);
        var compilation = new Compilation(tree);
        var diagnostics = tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics);

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }
}
