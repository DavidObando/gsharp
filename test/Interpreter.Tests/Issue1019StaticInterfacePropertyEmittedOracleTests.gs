// <copyright file="Issue1019StaticInterfacePropertyEmittedOracleTests.cs" company="GSharp">
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

/// Issue #1019: Emitted-oracle coverage for static interface property.
/// Traceability: ADR-0089.
open class Issue1019StaticInterfacePropertyEmittedOracleTests {
    @Fact
    func Generic_Read_Through_Constraint_Calls_Implementer_Static_Property() {
        let source = `import System

sealed interface IData {
    shared {
        prop Name string { get; }
    }
}

struct AppleData : IData {
    shared {
        prop Name string { get { return "apple" } }
    }
}

func Describe[T IData](witness T) string {
    return T.Name
}

Console.WriteLine(Describe(AppleData{}))`
        Assert.Equal("apple${Environment.NewLine}", Evaluate(source))
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
