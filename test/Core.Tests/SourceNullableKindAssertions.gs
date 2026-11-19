// <copyright file="SourceNullableKindAssertions.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import System.Text.RegularExpressions
import Xunit

internal shared class SourceNullableKindAssertions {
    internal func Reject(source string, parameter string, count int32, otherError string? = nil) {
        let markers = Regex.Matches(source, `\b` + Regex.Escape(parameter) + `\?`)
        Assert.Equal(count, markers.Count)
        Assert.NotEmpty(markers)
        let allErrors = Compilation(SyntaxTree.Parse(source))
            .GetDiagnostics()
            .Where((d Diagnostic) -> d.IsError)
            .ToArray()
        let errors = allErrors.Where((d Diagnostic) -> d.Id == "GS0641").ToArray()
        Assert.Equal(
            count +
                (
                if otherError == nil {
                    0
                } else {
                    1
                }
            ),
            allErrors.Length
        )
        Assert.Equal(count, errors.Length)
        if otherError != nil {
            Assert.Single(allErrors.Where((d Diagnostic) -> d.Id == otherError))
        }
        for var i = 0; i < count; i++ {
            Assert.Equal("GS0641", errors[i].Id)
            Assert.Equal(markers[i].Index + parameter.Length, errors[i].Location.Span.Start)
            Assert.Equal(1, errors[i].Location.Span.Length)
        }
    }
}
