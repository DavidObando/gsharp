// <copyright file="Issue1599EnumTryParseOutVarTests.cs" company="GSharp">
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
/// Issue #1599: <c>Enum.TryParse&lt;TEnum&gt;(string, out TEnum)</c> (a generic
/// BCL method whose type parameter has a value-type/<c>struct</c> constraint)
/// invoked over a SAME-COMPILATION user enum must resolve and bind — both with
/// an inline <c>out var</c> declaration and with a pre-declared receiver.
/// <para>
/// Before the fix the inline <c>out var</c> form crashed the compiler with an
/// internal <c>GS9999</c> because the value-type placeholder used to close the
/// method leaked into the synthesized local's type, and the pre-declared form
/// failed with <c>GS0159</c> because the by-ref user-enum argument could not
/// match the value-type-constrained by-ref parameter.
/// </para>
/// </summary>
public class Issue1599EnumTryParseOutVarTests
{
    [Fact]
    public void InlineOutVar_EnumTryParse_ResolvesAndBinds_NoDiagnostics()
    {
        // Exact repro from the issue: inline `out var` over a user enum.
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

    [Fact]
    public void InlineOutVar_ResultLocal_IsTypedAsTheEnum()
    {
        // The synthesized local must carry the enum type, not the placeholder
        // (which is what leaked and caused GS9999).
        const string source = @"
package p
import System

enum Color { Red, Green }

var ok = Enum.TryParse[Color](""Red"", out var result)
var reuse Color = result
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9999");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InlineOutVar_IgnoreCaseOverload_ResolvesAndBinds()
    {
        const string source = @"
package p
import System

enum Color { Red, Green }

var ok = Enum.TryParse[Color](""red"", true, out var result)
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS9999");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void PreDeclaredReceiver_EnumTryParse_Resolves_NoGS0159()
    {
        const string source = @"
package p
import System

enum Color { Red, Green }

var r Color = Color.Red
var ok = Enum.TryParse[Color](""Green"", out r)
";
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0159");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void BclEnum_InlineOutVar_StillResolves_Regression()
    {
        // Control: a real BCL enum (with a CLR type) keeps resolving through
        // the ordinary path, not the placeholder recovery.
        const string source = @"
package p
import System

var ok = Enum.TryParse[DayOfWeek](""Monday"", out var d)
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
