// <copyright file="Issue3030LocalFunctionDeclarationEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Repl.Engine
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import Xunit

/// Issue #3030: Emitted-oracle coverage for local function declaration.
/// Traceability: issue #3050.
open class Issue3030LocalFunctionDeclarationEmittedOracleTests {
    @Fact
    func Issue4219_GenericRegionInEmittedSubmission() {
        using let engine = EmittedSessionEngine()
        let declared = engine.Evaluate(`func Run() int32 {
    let first[T] = func(x T, n int32) int32 {
        if n == 0 { return 23 }
        return second(x, n - 1)
    }
    let second[U] = func(x U, n int32) int32 { return first(x, n) }
    return first("x", 3)
}`)
        Assert.False(declared.HasError, string.Join("; ", declared.Diagnostics))
        let called = engine.Evaluate("Run()")
        Assert.False(called.HasError, string.Join("; ", called.Diagnostics))
        Assert.Equal(23, called.Value)
    }

    @Theory
    @MemberData("Cases")
    func GenericLocalFunctionDeclaration_EvaluatesCalls(source string, expectedOutput string) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expectedOutput, result.Output.ReplaceLineEndings(Environment.NewLine))
    }

    shared {
        func Cases() sequence[[]object] {
            yield Case(`let first[T] = func(x T, n int32) T {
    if n == 0 { return x }
    return second(x, n - 1)
}
let second[U] = func(x U, n int32) U { return first(x, n) }
Console.WriteLine(first(23, 4))
Console.WriteLine(second("group", 3))`, `23
group
`)
            yield Case(`let Identity[T] = func(value T) T {
    return value
}

Console.WriteLine(Identity(17))
Console.WriteLine(Identity("top-level"))`, `17
top-level
`)
            yield Case(`func PrintValues() {
    let First[T] = func(first T, second T) T {
        return first
    }

    Console.WriteLine(First(42, 99))
    Console.WriteLine(First("nested", "other"))
}

PrintValues()`, `42
nested
`)
            yield Case(`data struct Item {
    var Value int32
}

let MakeIdentity[T] = func() (T) -> T {
    return (value T) -> value
}

let identity = MakeIdentity[Item]()
Console.WriteLine(identity(Item{ Value: 11 }).Value)
Console.WriteLine(identity(Item{ Value: 22 }).Value)
Console.WriteLine(identity(Item{ Value: 33 }).Value)`, `11
22
33
`)
        }

        private func Case(source string, expectedOutput string)[]object -> []object{source, expectedOutput}
    }
}
