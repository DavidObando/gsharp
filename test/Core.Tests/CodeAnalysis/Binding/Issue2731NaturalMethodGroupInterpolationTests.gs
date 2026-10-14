// <copyright file="Issue2731NaturalMethodGroupInterpolationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.IO
import Xunit

class Issue2731NaturalMethodGroupInterpolationTests {
    @Fact
    func AmbiguousMethodGroupInInterpolation_ReportsUserDiagnostic() {
        const source = `package Issue2731Negative
import System

func Convert(value string) int32 -> value.Length
func Convert(value int32) string -> value.ToString()

func Render() string -> "value=${Convert}"`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        using let output = MemoryStream()
        let result = compilation.Emit(output)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0582")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9998")
    }

    @Fact
    func ImportedOverloadSetInInterpolation_ReportsUserDiagnostic() {
        const source = `package Issue2731ImportedNegative
import System

func Render() string -> "value=${Convert.ToString}"`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        using let output = MemoryStream()
        let result = compilation.Emit(output)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0582")
        Assert.DoesNotContain(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS9998")
    }
}
