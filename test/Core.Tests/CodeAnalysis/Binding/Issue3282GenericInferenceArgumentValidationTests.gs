// <copyright file="Issue3282GenericInferenceArgumentValidationTests.cs" company="GSharp">
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

/// Issue #3282: arguments must be checked against the type inferred from
/// earlier arguments before a generic call is emitted.
open class Issue3282GenericInferenceArgumentValidationTests {
    @Theory
    @MemberData("InvalidCalls")
    func ConflictingInferredArgument_MatchesNonGenericDiagnostic(
        genericSource string,
        nonGenericSource string,
        expectedId string,
        expectedSpan string
    ) {
        AssertDiagnostic(genericSource, expectedId, expectedSpan)
        AssertDiagnostic(nonGenericSource, expectedId, expectedSpan)
    }

    @Theory
    @MemberData("ValidCalls")
    func CompatibleInferredArguments_CompileAndRun(source string, expectedOutput string) {
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.ExitCode)
        Assert.Null(result.UnhandledException)
        Assert.Equal(expectedOutput, result.Output)
    }

    @Fact
    func ConflictingInstanceInference_UsesCallArgumentContract() {
        const source = `class Box {
    func Show[T](a T, b T) { }
}
Box().Show(131, "str")`
        let diagnostic = Assert.Single(GetErrors(source))
        Assert.Equal(
            "Parameter 'b' requires a value of type 'int32' but was given a value of type 'string'.",
            diagnostic.Message
        )
    }

    shared {
        prop InvalidCalls TheoryData[string, string, string, string] -> {
            let values = TheoryData[string, string, string, string]()
            values.Add(
                "func Show[T](a T, b T) { }\nShow(131, \"str\")",
                "func Show(a int32, b int32) { }\nShow(131, \"str\")",
                "GS0154",
                "\"str\""
            )
            values.Add(
                "func Show[T](a T, b T) { }\nShow(\"str\", 131)",
                "func Show(a string, b string) { }\nShow(\"str\", 131)",
                "GS0154",
                "131"
            )
            values.Add(
                "func Show[T](a T, b T, c T) { }\nShow(131, 132, \"str\")",
                "func Show(a int32, b int32, c int32) { }\nShow(131, 132, \"str\")",
                "GS0154",
                "\"str\""
            )
            values.Add(
                "func Show[T](source T, later []T) { }\nShow(131, []string{\"str\"})",
                "func Show(source int32, later []int32) { }\nShow(131, []string{\"str\"})",
                "GS0154",
                "[]string{\"str\"}"
            )
            values.Add(
                "func Show[T](source T, later T?) { }\nShow(131, \"str\")",
                "func Show(source int32, later int32?) { }\nShow(131, \"str\")",
                "GS0154",
                "\"str\""
            )
            values.Add(
                "func Show[T](source T, later (T, T)) { }\nShow(131, (\"str\", \"other\"))",
                "func Show(source int32, later (int32, int32)) { }\nShow(131, (\"str\", \"other\"))",
                "GS0154",
                "(\"str\", \"other\")"
            )
            values.Add(`struct Mark { var V int32 }
struct Other { }
func Show[T](a T, b T) { }
Show(Mark{V: 1}, Other{})`, `struct Mark { var V int32 }
struct Other { }
func Show(a Mark, b Mark) { }
Show(Mark{V: 1}, Other{})`, "GS0154", "Other{}")
            values.Add(`class Box {
    func Show[T](a T, b T) { }
}
Box().Show(131, "str")`, `class Box {
    func Show(a int32, b int32) { }
}
Box().Show(131, "str")`, "GS0154", "\"str\"")
            values.Add(
                "func (self string) Show[T](a T, b T) { }\n\"receiver\".Show(131, \"str\")",
                "func (self string) Show(a int32, b int32) { }\n\"receiver\".Show(131, \"str\")",
                "GS0154",
                "\"str\""
            )
            values
        }

        prop ValidCalls TheoryData[string, string] -> TheoryData[string, string]{`import System
func Show[T](a T, b T) {
    Console.WriteLine([]T{a}.GetType())
    Console.WriteLine(a)
    Console.WriteLine(b)
}
Show(131, 132)`: `System.Int32[]
131
132
`, `import System
func Show[T](a T, b T) {
    Console.WriteLine([]T{a}.GetType())
    Console.WriteLine(a)
    Console.WriteLine(b)
}
Show("str", "other")`: `System.String[]
str
other
`, `import System
func Show[T](source T, slice []T) {
    Console.WriteLine([]T{source}.GetType())
    Console.WriteLine(source)
    Console.WriteLine(slice[0])
}
Show(131, []int32{132})`: `System.Int32[]
131
132
`, `import System
func Show[T](a T, b T) {
    Console.WriteLine([]T{a}.GetType())
    Console.WriteLine(a)
    Console.WriteLine(b)
}
Show[object](131, "str")`: `System.Object[]
131
str
`, `import System
func Plain(v object) {
    Console.WriteLine(v.GetType())
    Console.WriteLine(v)
}
Plain(131)
Plain("str")`: `System.Int32
131
System.String
str
`}

        private func AssertDiagnostic(source string, expectedId string, expectedSpan string) {
            let diagnostic = Assert.Single(GetErrors(source))
            let expectedStart = source.LastIndexOf(expectedSpan, StringComparison.Ordinal)
            Assert.Equal(expectedId, diagnostic.Id)
            Assert.Equal(expectedStart, diagnostic.Location.Span.Start)
            Assert.Equal(expectedSpan.Length, diagnostic.Location.Span.Length)
            Assert.Equal(expectedSpan, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
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
