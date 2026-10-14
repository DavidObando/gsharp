// <copyright file="StaticVirtualInterfaceEmittedOracleTests.cs" company="GSharp">
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

/// Emitted-oracle coverage for static virtual interface.
/// Traceability: ADR-0087 and ADR-0089; issue #755.
open class StaticVirtualInterfaceEmittedOracleTests {
    @Fact
    func Generic_Dispatch_Calls_Implementer_Static() {
        let source = `import System

sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

class Adder : IAdd {
    shared {
        func Add(a int32, b int32) int32 { return a + b }
    }
}

func Compute[T IAdd](w T, a int32, b int32) int32 {
    return T.Add(a, b)
}

Console.WriteLine(Compute(Adder{}, 3, 4))`
        Assert.Equal("7${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func Default_Body_Inherited_When_Implementer_Omits_Override() {
        let source = `import System

sealed interface IGreet {
    shared {
        func Hello() string { return "default-hello" }
    }
}

class Quiet : IGreet {
}

func Use[T IGreet](w T) string {
    return T.Hello()
}

Console.WriteLine(Use(Quiet{}))`
        Assert.Equal("default-hello${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func Implementer_Override_Wins_Over_Default() {
        let source = `import System

sealed interface IGreet {
    shared {
        func Hello() string { return "default-hello" }
    }
}

class Loud : IGreet {
    shared {
        func Hello() string { return "LOUD-hello" }
    }
}

func Use[T IGreet](w T) string {
    return T.Hello()
}

Console.WriteLine(Use(Loud{}))`
        Assert.Equal("LOUD-hello${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func Two_Implementers_Resolve_Independently() {
        let source = `import System

sealed interface IAdd {
    shared {
        func Add(a int32, b int32) int32;
    }
}

class Plus : IAdd {
    shared { func Add(a int32, b int32) int32 { return a + b } }
}

class Times : IAdd {
    shared { func Add(a int32, b int32) int32 { return a * b } }
}

func Apply[T IAdd](w T, a int32, b int32) int32 {
    return T.Add(a, b)
}

Console.WriteLine(Apply(Plus{}, 3, 4))
Console.WriteLine(Apply(Times{}, 3, 4))`
        Assert.Equal("7${Environment.NewLine}12${Environment.NewLine}", Evaluate(source))
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
