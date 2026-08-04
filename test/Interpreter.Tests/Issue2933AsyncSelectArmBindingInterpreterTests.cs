// <copyright file="Issue2933AsyncSelectArmBindingInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2933: interpreter and emitted async select receive bindings agree.
/// </summary>
public class Issue2933AsyncSelectArmBindingInterpreterTests
{
    [Fact]
    public void InterpreterPreservesAsyncSelectReceiveBinding()
    {
        const string Source = """
            import Gsharp.Extensions.Go

            async func Run() int32 {
                let ch = make(chan int32, 1)
                ch <- 3
                var result = 0
                select {
                    case let value = <-ch { result = 7 + value }
                }
                return result
            }

            Run().GetAwaiter().GetResult()
            """;

        var result = EmittedOracle.Evaluate(Source);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(10, result.Value);
    }
}
