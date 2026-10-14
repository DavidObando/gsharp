// <copyright file="Issue818AnonymousFunctionTypeVariadicEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #818: Emitted-oracle coverage for anonymous function type variadic.
open class Issue818AnonymousFunctionTypeVariadicEmittedOracleTests {
    @Fact
    func AnonymousVariadicLocal_AutoPacks_TrailingArgs() {
        let source = `import System

let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

Console.WriteLine(f(1, "a", "b", "c"))`
        Assert.Equal("4${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func AnonymousVariadicLocal_PassThroughSlice() {
        let source = `import System

let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

Console.WriteLine(f(10, []string{"x", "y"}))`
        Assert.Equal("12${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func AnonymousVariadicLocal_Empty_ProducesEmptySlice() {
        let source = `import System

let f (int32, ...string) -> int32 = (a, args) -> a + args.Length

Console.WriteLine(f(7))`
        Assert.Equal("7${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func AnonymousVariadicLocal_NoFixed_PacksAllArgs() {
        let source = `import System

let g (...int32) -> int32 = (xs) -> xs.Length

Console.WriteLine(g(1, 2, 3, 4, 5))
Console.WriteLine(g())`
        Assert.Equal("5${Environment.NewLine}0${Environment.NewLine}", Evaluate(source))
    }

    shared {
        private func Evaluate(source string) string {
            let result = EmittedOracle.Evaluate(source)
            let errors = result.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError).ToList()
            Assert.True(
                errors.Count == 0,
                "evaluation failed:\n" + string.Join(
                    "\n",
                    errors.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.ToString())
                )
            )
            return result.Output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
