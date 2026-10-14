// <copyright file="Issue664ClrArrayIndexerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #664 — CLR `T[]` arrays (e.g. the result of `string.Split`,
/// `.ToArray()`, or any imported method returning a CLR array) must be
/// indexable with `arr[i]` for both read and write.
open class Issue664ClrArrayIndexerTests {
    @Fact
    func ReadIndex_StringArray_FromSplit_Compiles() {
        let source = `
package P
import System

let parts = "a,b,c".Split(",")
let first = parts[0]
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func ReadIndex_IntArray_FromLinq_Compiles() {
        let source = `
package P
import System
import System.Linq

let arr = Enumerable.ToArray[int32](Enumerable.Range(0, 5))
let v = arr[2]
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func ReadIndex_ObjectArray_Compiles() {
        let source = `
package P
import System

let arr = Environment.GetCommandLineArgs()
let first = arr[0]
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func WriteIndex_StringArray_Compiles() {
        let source = `
package P
import System

var parts = "a,b,c".Split(",")
parts[0] = "z"
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func WriteIndex_IntArray_Compiles() {
        let source = `
package P
import System
import System.Linq

var arr = Enumerable.ToArray[int32](Enumerable.Range(0, 5))
arr[0] = 99
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func GSharpSlice_StillIndexable() {
        let source = `
package P

var xs = []int32{1, 2, 3}
let v = xs[0]
xs[1] = 42
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func List_StillIndexable() {
        let source = `
package P
import System.Collections.Generic

var list = List[int32]()
list.Add(10)
let v = list[0]
`
        AssertCompilesWithoutErrors(source)
    }

    @Fact
    func NonIndexableType_StillProducesGS0116() {
        let source = `
package P
import System.IO

var s = Stream.Null
let v = s[0]
`
        let diagnostics = EmitDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.IsError && d.Message.Contains("not indexable"))
    }

    shared {
        private func AssertCompilesWithoutErrors(source string) {
            let diagnostics = EmitDiagnostics(source, out var success)
            Assert.True(
                success,
                "Emit failed:\n" + string.Join("\n", diagnostics.Select((d Diagnostic) -> d.ToString()))
            )
            Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.IsError)
        }

        private func EmitDiagnostics(source string) IReadOnlyList[Diagnostic] -> EmitDiagnostics(source, out _)

        private func EmitDiagnostics(source string, out success bool) IReadOnlyList[Diagnostic] {
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            success = result.Success
            return result.Diagnostics
        }
    }
}
