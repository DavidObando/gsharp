// <copyright file="Issue1129StringIndexerBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #1129: indexing a `string` with `s[i]` was rejected with
/// GS0116 "Type 'string' is not indexable." In C#/.NET `string` exposes
/// `char this[int]` (`get_Chars`), so `s[i]` yields the
/// `char` at that position. The binder now maps `string[int]` to a
/// `BoundIndexExpression` with a `char` result; string WRITE
/// (`s[i] = c`) remains rejected because .NET strings are immutable.
open class Issue1129StringIndexerBinderTests {
    @Fact
    func StringIndex_ReadByConstant_NoDiagnostics() {
        // Acceptance criteria #1: the repro binds with no diagnostics.
        let result = Evaluate("let s = \"ABCD\"\ns[1]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal('B', result.Value)
    }

    @Fact
    func StringIndex_ReadByConstant_FirstChar() {
        let result = Evaluate("let s = \"ABCD\"\nint32(s[0])")
        Assert.Empty(result.Diagnostics)
        // 'A' = 65
        Assert.Equal(65, result.Value)
    }

    @Fact
    func StringIndex_ReadByVariable_NoDiagnostics() {
        // Acceptance criteria #3: indexing with a non-constant int variable.
        let result = Evaluate(`let s = "ABCD"
let i = 2
s[i]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal('C', result.Value)
    }

    @Fact
    func StringIndex_ResultIsChar() {
        // The bound element/result type must be `char` so downstream
        // numeric/char handling (e.g. int32(c)) works.
        let diagnostics = GetDiagnostics(`package p
class C {
    func F(s string) char {
        return s[0]
    }
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func StringIndex_ResultUsedAsChar_AssignsToCharTyped() {
        let diagnostics = GetDiagnostics(`package p
class C {
    func F(s string, i int32) char {
        return s[i]
    }
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func StringIndex_WriteStillRejected() {
        // Acceptance criteria #4: .NET strings are immutable, so s[i] = c
        // must still report GS0116.
        let diagnostics = GetDiagnostics(`package p
class C {
    func F(s string) {
        s[0] = 'x'
    }
}`)
        Assert.NotEmpty(diagnostics)
        Assert.Contains(diagnostics, (d string) -> d.Contains("not indexable"))
    }

    @Fact
    func StringSlice_StillWorks() {
        // Acceptance criteria #5: no regression to string slicing.
        let result = Evaluate("let s = \"abcdef\"\ns[1..3]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("bc", result.Value)
    }

    @Fact
    func StringFromEndIndex_StillWorks() {
        // Acceptance criteria #5: no regression to from-end indexing on string.
        let result = Evaluate("let s = \"ABCD\"\ns[^1]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal('D', result.Value)
    }

    @Fact
    func StringLength_StillWorks() {
        // Acceptance criteria #5: no regression to s.Length.
        let result = Evaluate("let s = \"ABCD\"\ns.Length")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func ArrayIndex_StillWorks() {
        // Acceptance criteria #5: no regression to array indexing.
        let result = Evaluate("var xs = [3]int32{10, 20, 30}\nxs[1]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(20, result.Value)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func GetDiagnostics(source string)[]string {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            return result.Diagnostics.Where((d Diagnostic) -> d.IsError).Select((d Diagnostic) -> d.Message).ToArray()
        }
    }
}
