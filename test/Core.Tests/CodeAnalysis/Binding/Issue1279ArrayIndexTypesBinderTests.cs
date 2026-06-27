// <copyright file="Issue1279ArrayIndexTypesBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1279: array/slice element access accepts ANY C#-supported integer
/// type as the index (matching C#'s element-access rule). Narrower types that
/// implicitly widen to int32 already worked; this verifies the wider integer
/// types (uint32/int64/uint64/nint/nuint) are now accepted too, while a
/// non-integer index still reports GS0156.
/// </summary>
public class Issue1279ArrayIndexTypesBinderTests
{
    [Theory]
    [InlineData("int8")]
    [InlineData("uint8")]
    [InlineData("int16")]
    [InlineData("uint16")]
    [InlineData("char")]
    [InlineData("int32")]
    [InlineData("uint32")]
    [InlineData("int64")]
    [InlineData("uint64")]
    [InlineData("nint")]
    [InlineData("nuint")]
    public void ArrayElementRead_AcceptsAnyIntegerIndexType(string indexType)
    {
        var source = $@"
package main
func F(arr []int32, i {indexType}) int32 {{ return arr[i] }}
";
        Assert.Empty(Errors(source));
    }

    [Theory]
    [InlineData("int8")]
    [InlineData("uint8")]
    [InlineData("int16")]
    [InlineData("uint16")]
    [InlineData("char")]
    [InlineData("int32")]
    [InlineData("uint32")]
    [InlineData("int64")]
    [InlineData("uint64")]
    [InlineData("nint")]
    [InlineData("nuint")]
    public void ArrayElementWrite_AcceptsAnyIntegerIndexType(string indexType)
    {
        var source = $@"
package main
func G(arr []int32, i {indexType}, v int32) {{ arr[i] = v }}
";
        Assert.Empty(Errors(source));
    }

    [Theory]
    [InlineData("int8")]
    [InlineData("uint8")]
    [InlineData("int16")]
    [InlineData("uint16")]
    [InlineData("char")]
    [InlineData("int32")]
    [InlineData("uint32")]
    [InlineData("int64")]
    [InlineData("uint64")]
    [InlineData("nint")]
    [InlineData("nuint")]
    public void SliceElementRead_AcceptsAnyIntegerIndexType(string indexType)
    {
        // A `[N]T` fixed-size slice exercises the same element-index path.
        var source = $@"
package main
func F(arr [4]int32, i {indexType}) int32 {{ return arr[i] }}
";
        Assert.Empty(Errors(source));
    }

    [Theory]
    [InlineData("int32")]
    [InlineData("int64")]
    [InlineData("uint64")]
    [InlineData("nint")]
    public void StringCharIndex_AcceptsAnyIntegerIndexType(string indexType)
    {
        var source = $@"
package main
func F(s string, i {indexType}) char {{ return s[i] }}
";
        Assert.Empty(Errors(source));
    }

    [Theory]
    [InlineData("float32")]
    [InlineData("float64")]
    public void ArrayElementAccess_NonIntegerIndex_StillReportsGS0156(string indexType)
    {
        var source = $@"
package main
func F(arr []int32, i {indexType}) int32 {{ return arr[i] }}
";
        Assert.Contains(Errors(source), d => d.Id == "GS0156");
    }

    [Theory]
    [InlineData("bool")]
    [InlineData("string")]
    public void ArrayElementAccess_NonNumericIndex_StillRejected(string indexType)
    {
        // bool/string have no conversion to a CIL index type at all, so the
        // element index is still rejected (a non-integer index is never valid).
        var source = $@"
package main
func F(arr []int32, i {indexType}) int32 {{ return arr[i] }}
";
        Assert.NotEmpty(Errors(source));
    }

    private static IReadOnlyList<Diagnostic> Errors(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
    }
}
