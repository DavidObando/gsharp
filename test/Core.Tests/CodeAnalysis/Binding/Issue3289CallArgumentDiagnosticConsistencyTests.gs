// <copyright file="Issue3289CallArgumentDiagnosticConsistencyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issues #3289 and #3312: rejected call arguments use the same GS0154
/// contract across free, instance, extension, and shared calls.
class Issue3289CallArgumentDiagnosticConsistencyTests {
    @Theory
    @MemberData("RejectedCalls")
    func RejectedArgument_UsesGs0154AtExactArgumentSpan(
        _ string,
        source string,
        startLine int32,
        startCharacter int32,
        endLine int32,
        endCharacter int32,
        parameterName string
    ) {
        let diagnostic = Assert.Single(GetErrors(source))
        Assert.Equal("GS0154", diagnostic.Id)
        Assert.Equal(
            "Parameter '$parameterName' requires a value of type 'System.ValueType' but was given a value of type 'string'.",
            diagnostic.Message
        )
        Assert.Equal(startLine, diagnostic.Location.StartLine)
        Assert.Equal(startCharacter, diagnostic.Location.StartCharacter)
        Assert.Equal(endLine, diagnostic.Location.EndLine)
        Assert.Equal(endCharacter, diagnostic.Location.EndCharacter)
        Assert.Equal("\"wrong\"", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    @Theory
    @MemberData("ExplicitOnlyRejectedCalls")
    func ExplicitOnlyArgumentConversion_UsesGs0154AtExactArgumentSpan(
        _ string,
        source string,
        startLine int32,
        startCharacter int32,
        endLine int32,
        endCharacter int32
    ) {
        let diagnostic = Assert.Single(GetErrors(source))
        Assert.Equal("GS0154", diagnostic.Id)
        Assert.Equal(
            "Parameter 'value' requires a value of type 'int32' but was given a value of type 'float64'.",
            diagnostic.Message
        )
        Assert.Equal(startLine, diagnostic.Location.StartLine)
        Assert.Equal(startCharacter, diagnostic.Location.StartCharacter)
        Assert.Equal(endLine, diagnostic.Location.EndLine)
        Assert.Equal(endCharacter, diagnostic.Location.EndCharacter)
        Assert.Equal("3.14", diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
    }

    shared {
        prop RejectedCalls TheoryData[string, string, int32, int32, int32, int32, string] -> {
            let values = TheoryData[string, string, int32, int32, int32, int32, string]()
            values.Add("free explicit-generic control", `import System
func Take(value ValueType) { }
Take("wrong")`, 2, 5, 2, 12, "value")
            values.Add("free explicit generic", `import System
func Take[T](value T) { }
Take[ValueType]("wrong")`, 2, 16, 2, 23, "value")
            values.Add("instance explicit-generic control", `import System
class Runner { func Take(value ValueType) { } }
Runner().Take("wrong")`, 2, 14, 2, 21, "value")
            values.Add("instance explicit generic", `import System
class Runner { func Take[T](value T) { } }
Runner().Take[ValueType]("wrong")`, 2, 25, 2, 32, "value")
            values.Add("extension explicit-generic control", `import System
func (self string) Take(value ValueType) { }
"receiver".Take("wrong")`, 2, 16, 2, 23, "value")
            values.Add("extension explicit generic", `import System
func (self string) Take[T](value T) { }
"receiver".Take[ValueType]("wrong")`, 2, 27, 2, 34, "value")
            values.Add("shared explicit-generic control", `import System
class Runner { shared { func Take(value ValueType) { } } }
Runner.Take("wrong")`, 2, 12, 2, 19, "value")
            values.Add("shared explicit generic", `import System
class Runner { shared { func Take[T](value T) { } } }
Runner.Take[ValueType]("wrong")`, 2, 23, 2, 30, "value")
            values.Add("free inference control", `import System
func Take(expected ValueType, actual ValueType) { }
let expected ValueType = 42
Take(expected, "wrong")`, 3, 15, 3, 22, "actual")
            values.Add("free inference", `import System
func Take[T](expected T, actual T) { }
let expected ValueType = 42
Take(expected, "wrong")`, 3, 15, 3, 22, "actual")
            values.Add("instance inference control", `import System
class Runner { func Take(expected ValueType, actual ValueType) { } }
let expected ValueType = 42
Runner().Take(expected, "wrong")`, 3, 24, 3, 31, "actual")
            values.Add("instance inference", `import System
class Runner { func Take[T](expected T, actual T) { } }
let expected ValueType = 42
Runner().Take(expected, "wrong")`, 3, 24, 3, 31, "actual")
            values.Add("extension inference control", `import System
func (self string) Take(expected ValueType, actual ValueType) { }
let expected ValueType = 42
"receiver".Take(expected, "wrong")`, 3, 26, 3, 33, "actual")
            values.Add("extension inference", `import System
func (self string) Take[T](expected T, actual T) { }
let expected ValueType = 42
"receiver".Take(expected, "wrong")`, 3, 26, 3, 33, "actual")
            values.Add("shared inference control", `import System
class Runner { shared { func Take(expected ValueType, actual ValueType) { } } }
let expected ValueType = 42
Runner.Take(expected, "wrong")`, 3, 22, 3, 29, "actual")
            values.Add("shared inference", `import System
class Runner { shared { func Take[T](expected T, actual T) { } } }
let expected ValueType = 42
Runner.Take(expected, "wrong")`, 3, 22, 3, 29, "actual")
            values
        }

        prop ExplicitOnlyRejectedCalls TheoryData[string, string, int32, int32, int32, int32] -> {
            let values = TheoryData[string, string, int32, int32, int32, int32]()
            values.Add("free", "func Take(value int32) { }\nTake(3.14)", 1, 5, 1, 9)
            values.Add("instance", "class Runner { func Take(value int32) { } }\nRunner().Take(3.14)", 1, 14, 1, 18)
            values.Add("extension", "func (self string) Take(value int32) { }\n\"receiver\".Take(3.14)", 1, 16, 1, 20)
            values.Add(
                "shared",
                "class Runner { shared { func Take(value int32) { } } }\nRunner.Take(3.14)",
                1,
                12,
                1,
                16
            )
            values
        }

        private func GetErrors(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source, "Issue3289.gs"))
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
