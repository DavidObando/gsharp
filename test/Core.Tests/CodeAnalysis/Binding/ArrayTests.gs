// <copyright file="ArrayTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Phase 3.A.1 / 3.A.3 — fixed-length arrays, composite literals,
/// read and write indexing.
open class ArrayTests {
    @Fact
    func ArrayLiteral_BindsAndEvaluates() {
        let result = Evaluate(`var xs = [3]int32{10, 20, 30}
let y = xs[1]
y`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(20, result.Value)
    }

    @Fact
    func ArrayLiteral_LengthMismatch_Diagnosed() {
        let diagnostics = Bind("var xs = [3]int32{1, 2}\n")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("3 initialisers"))
    }

    @Fact
    func TypedArrayDeclaration_Works() {
        let result = Evaluate("var xs [3]int32 = [3]int32{1, 2, 3}\nxs[0] + xs[2]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func IndexAssignment_UpdatesElement() {
        let result = Evaluate(`var xs = [3]int32{1, 2, 3}
xs[1] = 99
xs[1]`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(99, result.Value)
    }

    @Fact
    func IndexExpression_OnString_ReturnsChar() {
        // Issue #1129: `string` is now indexable; `s[i]` yields the char at
        // position `i` (via .NET's String.get_Chars). 'h' = 104.
        let result = Evaluate("let s = \"hello\"\nint32(s[0])")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(104, result.Value)
    }

    @Fact
    func IndexExpression_OnNonIndexable_Diagnosed() {
        let diagnostics = Bind(`let x = 5
let c = x[0]
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("not indexable"))
    }

    @Fact
    func StringArray_Works() {
        let result = Evaluate("var names = [2]string{\"a\", \"b\"}\nnames[1]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal("b", result.Value)
    }

    @Fact
    func BoolArray_Works() {
        let result = Evaluate("var flags = [2]bool{true, false}\nflags[0]")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func InvalidElementType_Diagnosed() {
        let diagnostics = Bind("var xs = [3]NotAType{1, 2, 3}\n")
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Message.Contains("doesn't exist"))
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] -> Evaluate(source).Diagnostics
    }
}
