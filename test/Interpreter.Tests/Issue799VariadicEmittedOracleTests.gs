// <copyright file="Issue799VariadicEmittedOracleTests.cs" company="GSharp">
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

/// Issue #799: Emitted-oracle coverage for variadic.
/// Traceability: ADR-0101.
open class Issue799VariadicEmittedOracleTests {
    @Fact
    func Variadic_PacksTrailingArgs() {
        let source = `import System

func sum(nums ...int32) int32 {
  var total = 0
  for v in nums {
    total = total + v
  }
  return total
}

Console.WriteLine(sum(1, 2, 3, 4, 5))`
        Assert.Equal("15${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func Variadic_EmptyCall() {
        let source = `import System

func sum(nums ...int32) int32 {
  var total = 0
  for v in nums {
    total = total + v
  }
  return total
}

Console.WriteLine(sum())`
        Assert.Equal("0${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func Variadic_WithFixedPrefix() {
        let source = `import System

func sumWithBase(base int32, extras ...int32) int32 {
  var total = base
  for v in extras {
    total = total + v
  }
  return total
}

Console.WriteLine(sumWithBase(100, 1, 2, 3))`
        Assert.Equal("106${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func Variadic_Generic_PacksMultipleArgs() {
        let source = `import System

func Of[T](values ...T) []T { return values }

let xs = Of(1, 2, 3, 4)
Console.WriteLine(xs.Length)
Console.WriteLine(xs[0])
Console.WriteLine(xs[3])`
        Assert.Equal("4${Environment.NewLine}1${Environment.NewLine}4${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func Variadic_Generic_SingleArrayPassesThrough() {
        // ADR-0101 §3 — single trailing []T argument is the same array.
        let source = `import System

func Of[T](values ...T) []T { return values }

let arr = []int32{10, 20, 30}
let xs = Of(arr)
Console.WriteLine(xs.Length)
Console.WriteLine(xs[1])`
        Assert.Equal("3${Environment.NewLine}20${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func Variadic_Generic_EmptyCall() {
        let source = `import System

func Of[T](values ...T) []T { return values }

let xs = Of[int32]()
Console.WriteLine(xs.Length)`
        Assert.Equal("0${Environment.NewLine}", Evaluate(source))
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
