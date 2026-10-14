// <copyright file="Issue3267ExplicitGenericArgumentValidationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #3267: explicitly substituted generic parameter types must be
/// validated like their non-generic equivalents before invalid IL is emitted.
open class Issue3267ExplicitGenericArgumentValidationTests {
    @Theory
    @MemberData("InvalidCalls")
    func ExplicitGenericArgumentMismatch_ReportsAtArgument(source string, expectedId string, expectedSpan string) {
        let diagnostic = Assert.Single(GetErrors(source))
        let expectedStart = source.IndexOf(expectedSpan, StringComparison.Ordinal)
        Assert.Equal(expectedId, diagnostic.Id)
        Assert.Equal(expectedStart, diagnostic.Location.Span.Start)
        Assert.Equal(expectedSpan.Length, diagnostic.Location.Span.Length)
        Assert.Equal(expectedSpan, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Fact
    func ExplicitGenericInstanceArgumentMismatch_UsesCallArgumentContract() {
        const source = `class Box {
    func Id[T](value T) T -> value
}
Box().Id[int32]("wrong")`
        let diagnostic = Assert.Single(GetErrors(source))
        Assert.Equal(
            "Parameter 'value' requires a value of type 'int32' but was given a value of type 'string'.",
            diagnostic.Message
        )
    }

    @Theory
    @MemberData("ValidCalls")
    func CompatibleGenericArguments_CompileAndRun(source string, expected object) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(expected, result.Value)
    }

    shared {
        prop InvalidCalls TheoryData[string, string, string] -> {
            let values2 = TheoryData[string, string, string]()
            values2.Add("func Id[T](value T) T -> value\nId[int32](\"wrong\")", "GS0154", "\"wrong\"")
            values2.Add(`class Box {
    func Id[T](value T) T -> value
}
Box().Id[int32]("wrong")`, "GS0154", "\"wrong\"")
            values2.Add(
                "func (self string) IdExt[T](value T) T -> value\n\"receiver\".IdExt[int32](\"wrong\")",
                "GS0154",
                "\"wrong\""
            )
            values2.Add(`class Box[T](value T) {
    prop Value T { get -> value }
}
Box[int32]("wrong").Value`, "GS0154", "\"wrong\"")
            values2.Add(
                "func First[T](first T, second T) T -> first\nFirst[int32](1, \"wrong\")",
                "GS0154",
                "\"wrong\""
            )
            values2.Add(
                "func Take[T](values []T) { }\nTake[int32]([]string{\"wrong\"})",
                "GS0154",
                "[]string{\"wrong\"}"
            )
            values2.Add(
                "func (self string) TakeExt[T](values []T) { }\n\"receiver\".TakeExt[int32]([]string{\"wrong\"})",
                "GS0154",
                "[]string{\"wrong\"}"
            )
            values2
        }

        prop ValidCalls TheoryData[string, object] -> TheoryData[string, object]{
            "func Id[T](value T) T -> value\nId[int32](41)": 41,
            "func Id[T](value T) T -> value\nId[object](\"explicit-object\")": "explicit-object",
            "func Id[T](value T) T -> value\nId[object](41)": 41,
            "func Id[T](value T) T -> value\nId[int64](42)": 42L,
            "func Id[T](value T) T -> value\nId(\"inferred-string\")": "inferred-string",
            "func Keep[T class](value T) T -> value\nKeep[string](\"constrained\")": "constrained",
            "func First[T](first T, second T) T -> first\nFirst[int64](43, 44)": 43L,
            `class Box {
    func Id[T](value T) T -> value
}
Box().Id[int64](45)`: 45L,
            "func (self string) IdExt[T](value T) T -> value\n\"receiver\".IdExt[int64](46)": 46L,
            `class Box[T](value T) {
    prop Value T { get -> value }
}
Box[int64](47).Value`: 47L
        }

        private func GetErrors(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation
                .Emit(peStream)
                .Diagnostics
                .Where((diagnostic Diagnostic) -> diagnostic.Severity == DiagnosticSeverity.Error)
                .ToArray()
        }
    }
}
