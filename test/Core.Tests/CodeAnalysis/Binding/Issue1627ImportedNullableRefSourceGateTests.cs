// <copyright file="Issue1627ImportedNullableRefSourceGateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1627: an imported/CLR-backed nullable reference <c>S?</c> was
/// misclassified as implicitly convertible to its non-nullable form <c>S</c>
/// because <c>NullableTypeSymbol</c> exposes the underlying CLR type, so the
/// generic #521 reference-upcast arm in <c>Conversion.Classify</c> saw two
/// ordinary non-value-type CLR types and let the <c>?</c> silently drop. The
/// #1552 gate only patched the multi-candidate positional overload filter, so
/// a single-overload call, a named-argument call, an assignment, and a return
/// position all still leaked. This is fixed at the classification source, so
/// every position now reports the same GS0154/GS0155 null-safety diagnostic
/// user-declared classes already got. All allowed nullable-target conversions
/// (<c>S? -&gt; S?</c>, <c>S? -&gt; U?</c> derived-to-base, and the <c>!!</c>
/// escape hatch) must keep compiling. Every type below uses an
/// <c>Issue1627</c>-unique name; imported types (<c>System.Exception</c> /
/// <c>System.ArgumentException</c>) exercise the "live ClrType" leak path that
/// user-declared classes never had.
/// </summary>
public class Issue1627ImportedNullableRefSourceGateTests
{
    [Fact]
    public void SingleOverload_ImportedNullableArg_ReportsGS0154()
    {
        var source = @"
package p
import System
func Issue1627ASink(a Exception) int32 -> 1
func Issue1627AUse(e ArgumentException?) int32 -> Issue1627ASink(e)
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0154");
    }

    [Fact]
    public void NamedArgument_ImportedNullableArg_ReportsGS0154()
    {
        var source = @"
package p
import System
func Issue1627BSink(a Exception) int32 -> 1
func Issue1627BUse(e ArgumentException?) int32 -> Issue1627BSink(a: e)
";
        var result = Evaluate(source);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0154");
    }

    [Fact]
    public void Assignment_ImportedNullableSource_ReportsNullSafetyDiagnostic()
    {
        var source = @"
package p
import System
func Issue1627CUse(e ArgumentException?) int32 {
    var x Exception = e
    return 1
}
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(
            result.Diagnostics,
            d => d.Id == "GS0154" || d.Id == "GS0155" || d.Message.Contains("Cannot convert"));
    }

    [Fact]
    public void ReturnPosition_ImportedNullableSource_ReportsNullSafetyDiagnostic()
    {
        var source = @"
package p
import System
func Issue1627DGet(e ArgumentException?) Exception -> e
";
        var result = Evaluate(source);
        Assert.NotEmpty(result.Diagnostics);
        Assert.Contains(
            result.Diagnostics,
            d => d.Id == "GS0154" || d.Id == "GS0155" || d.Message.Contains("Cannot convert"));
    }

    [Fact]
    public void NullableToNullable_SameType_StillCompiles()
    {
        var source = @"
package p
import System
func Issue1627EGet(e ArgumentException?) Exception? -> e
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void NullableToNullable_DerivedToBase_StillCompiles()
    {
        var source = @"
package p
import System
func Issue1627FSink(a Exception?) int32 -> 1
func Issue1627FUse(e ArgumentException?) int32 -> Issue1627FSink(e)
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void BangEscape_ImportedNullableSource_StillCompiles()
    {
        var source = @"
package p
import System
func Issue1627GSink(a Exception) int32 -> 1
func Issue1627GUse(e ArgumentException?) int32 -> Issue1627GSink(e!!)
";
        Assert.Empty(Evaluate(source).Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { IsLibrary = true };
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
