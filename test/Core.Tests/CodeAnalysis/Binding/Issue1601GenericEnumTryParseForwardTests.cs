// <copyright file="Issue1601GenericEnumTryParseForwardTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1601 (follow-up to #1599): a generic BCL method whose type parameter
/// carries a value-type/<c>struct</c> constraint — canonically
/// <c>Enum.TryParse&lt;TEnum&gt;(string, out TEnum)</c> — invoked with a caller
/// type argument that is itself an in-scope generic type parameter constrained
/// to <c>Enum</c>/<c>struct</c> (as opposed to a concrete enum) must resolve and
/// bind, with an inline <c>out var</c> local typed as that type parameter.
/// <para>
/// Before the fix the type parameter erased to a <c>System.Object</c> placeholder
/// that <see cref="System.Reflection.GenericParameterAttributes"/> classified as a
/// reference type, so the value-type placeholder closure was skipped and the
/// candidate was dropped — reported as <c>GS0159</c> (Cannot find function
/// TryParse), which cascaded to <c>GS0125</c> on the inline <c>out var</c> local.
/// </para>
/// </summary>
public class Issue1601GenericEnumTryParseForwardTests
{
    [Fact]
    public void GenericForward_InlineOutVar_ResolvesAndBinds_NoGS0159OrGS0125()
    {
        // Exact repro from the issue: a generic function forwards its own
        // Enum/struct-constrained type parameter to Enum.TryParse[TEnum].
        const string source = @"
package p
import System

func Parse[TEnum Enum struct](arg string) TEnum? {
    if !Enum.TryParse[TEnum](arg, out var result) {
        return nil
    }
    return result
}

Console.WriteLine(""ok"")
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9999");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void GenericForward_IgnoreCaseOverload_ResolvesAndBinds()
    {
        // The three-argument `(string, bool ignoreCase, out TEnum)` overload
        // must also close over the constrained type parameter.
        const string source = @"
package p
import System

func Parse[TEnum Enum struct](arg string) TEnum? {
    if !Enum.TryParse[TEnum](arg, true, out var result) {
        return nil
    }
    return result
}

Console.WriteLine(""ok"")
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9999");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void GenericForward_PreDeclaredReceiver_Resolves_NoGS0159()
    {
        // The pre-declared receiver variant: `out r` where `r` is typed by the
        // value-type-constrained type parameter.
        const string source = @"
package p
import System

func Parse[TEnum Enum struct](arg string) TEnum {
    var r TEnum
    var ok = Enum.TryParse[TEnum](arg, out r)
    return r
}

Console.WriteLine(""ok"")
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ConcreteEnum_InlineOutVar_StillResolves_Issue1599Regression()
    {
        // Control: the concrete same-compilation enum case fixed by #1599 must
        // keep resolving through the placeholder-recovery path.
        const string source = @"
package p
import System

enum Color { Red, Green }

var ok = Enum.TryParse[Color](""Red"", out var result)
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9999");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.Empty(diagnostics);
    }

    private static IReadOnlyList<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new System.IO.MemoryStream();
        return compilation.Emit(peStream).Diagnostics.ToList();
    }
}
