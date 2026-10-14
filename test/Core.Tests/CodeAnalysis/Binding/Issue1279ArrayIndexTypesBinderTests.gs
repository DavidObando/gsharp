// <copyright file="Issue1279ArrayIndexTypesBinderTests.cs" company="GSharp">
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

/// Issue #1279: array/slice element access accepts ANY C#-supported integer
/// type as the index (matching C#'s element-access rule). Narrower types that
/// implicitly widen to int32 already worked; this verifies the wider integer
/// types (uint32/int64/uint64/nint/nuint) are now accepted too, while a
/// non-integer index still reports GS0156.
open class Issue1279ArrayIndexTypesBinderTests {
    @Theory
    @InlineData("int8")
    @InlineData("uint8")
    @InlineData("int16")
    @InlineData("uint16")
    @InlineData("char")
    @InlineData("int32")
    @InlineData("uint32")
    @InlineData("int64")
    @InlineData("uint64")
    @InlineData("nint")
    @InlineData("nuint")
    func ArrayElementRead_AcceptsAnyIntegerIndexType(indexType string) {
        let source = (`
package main
func F(arr []int32, i ` + "$indexType" + `) int32 { return arr[i] }
`)
        Assert.Empty(Errors(source))
    }

    @Theory
    @InlineData("int8")
    @InlineData("uint8")
    @InlineData("int16")
    @InlineData("uint16")
    @InlineData("char")
    @InlineData("int32")
    @InlineData("uint32")
    @InlineData("int64")
    @InlineData("uint64")
    @InlineData("nint")
    @InlineData("nuint")
    func ArrayElementWrite_AcceptsAnyIntegerIndexType(indexType string) {
        let source = (`
package main
func G(arr []int32, i ` + "$indexType" + `, v int32) { arr[i] = v }
`)
        Assert.Empty(Errors(source))
    }

    @Theory
    @InlineData("int8")
    @InlineData("uint8")
    @InlineData("int16")
    @InlineData("uint16")
    @InlineData("char")
    @InlineData("int32")
    @InlineData("uint32")
    @InlineData("int64")
    @InlineData("uint64")
    @InlineData("nint")
    @InlineData("nuint")
    func SliceElementRead_AcceptsAnyIntegerIndexType(indexType string) {
        // A `[N]T` fixed-size slice exercises the same element-index path.
        let source = (`
package main
func F(arr [4]int32, i ` + "$indexType" + `) int32 { return arr[i] }
`)
        Assert.Empty(Errors(source))
    }

    @Theory
    @InlineData("int32")
    @InlineData("int64")
    @InlineData("uint64")
    @InlineData("nint")
    func StringCharIndex_AcceptsAnyIntegerIndexType(indexType string) {
        let source = (`
package main
func F(s string, i ` + "$indexType" + `) char { return s[i] }
`)
        Assert.Empty(Errors(source))
    }

    @Theory
    @InlineData("float32")
    @InlineData("float64")
    func ArrayElementAccess_NonIntegerIndex_StillReportsGS0156(indexType string) {
        let source = (`
package main
func F(arr []int32, i ` + "$indexType" + `) int32 { return arr[i] }
`)
        Assert.Contains(Errors(source), (d Diagnostic) -> d.Id == "GS0156")
    }

    @Theory
    @InlineData("bool")
    @InlineData("string")
    func ArrayElementAccess_NonNumericIndex_StillRejected(indexType string) {
        // bool/string have no conversion to a CIL index type at all, so the
        // element index is still rejected (a non-integer index is never valid).
        let source = (`
package main
func F(arr []int32, i ` + "$indexType" + `) int32 { return arr[i] }
`)
        Assert.NotEmpty(Errors(source))
    }

    shared {
        private func Errors(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            return compilation
                .Emit(peStream)
                .Diagnostics
                .Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                .ToList()
        }
    }
}
