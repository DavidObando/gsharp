// <copyright file="Issue2962ConstrainedStaticPropertyChainEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Interpreter
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #2962: Emitted-oracle coverage for constrained static property chain.
open class Issue2962ConstrainedStaticPropertyChainEmittedOracleTests {
    @Fact
    func ChainedPropertyAccess_Evaluates() {
        const Source = `import System

sealed interface I[T] {
    shared { prop V T { get; } }
}

struct C : I[string] {
    shared { prop V string -> "value" }
}

func Read[T I[string]](w T) int32 {
    return T.V.Length
}

Console.WriteLine(Read(C{}))`
        Assert.Equal("5${Environment.NewLine}", Evaluate(Source))
    }

    @Fact
    func NonMemberStaticSuffix_ReportsSourceTextInsteadOfIce() {
        const Source = `sealed interface I[T] {
    shared { prop V T { get; } }
}

struct C : I[string] {
    shared { prop V string -> "value" }
}

func Read[T I[string]](w T) int32 {
    return T.sizeof(int32)
}

Read(C{})`
        let output = RunSubmission(Source)
        Assert.Contains(
            "error GS0333: Constrained static access 'sizeof' on type parameter 'T' must name a static-virtual member declared by an interface constraint (ADR-0089).",
            output,
            StringComparison.Ordinal
        )
        Assert.DoesNotContain("GS9999", output, StringComparison.Ordinal)
        Assert.DoesNotContain("member '?'", output, StringComparison.Ordinal)
    }

    shared {
        private func Evaluate(source string) string {
            let result = EmittedOracle.Evaluate(source)
            let errors = result
                .Diagnostics
                .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
                .ToList()
            Assert.True(
                errors.Count == 0,
                "evaluation failed:\n" + string.Join(
                    "\n",
                    errors.Select((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.ToString())
                )
            )
            return result.Output.ReplaceLineEndings(Environment.NewLine)
        }

        private func RunSubmission(source string) string {
            using let output = StringWriter()
            let previousOut = Console.Out
            Console.SetOut(output)
            try {
                GSharpRepl().EvaluateSubmission(source)
            } finally {
                Console.SetOut(previousOut)
            }
            return output.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
