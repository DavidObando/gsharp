// <copyright file="Issue4422CompilerDiagnosticSuppressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// ADR-0175 amendment (issue #4422): <c>@SuppressDiagnostic</c> scopes now
/// filter the compiler's own warnings, not only analyzer diagnostics, so a
/// migrated <c>ref x!</c> can carry its C# suppression of GS0612. The filter
/// sits in <c>Compilation</c>, where every <c>EmitResult</c> is produced, so gsc,
/// the emitted-program host and the language server agree. Errors are never
/// suppressed, as with C#'s <c>#pragma warning</c>.
/// </summary>
public class Issue4422CompilerDiagnosticSuppressionTests
{
    private const string Callee = "func R(ref s string) { s = \"r\" }\n";

    [Fact]
    public void BlockForm_SuppressesOnlyInsideTheBlock()
    {
        var result = EmittedOracle.Evaluate(Callee + @"
var a string? = nil
@SuppressDiagnostic(""GS0612"") {
    R(&a)
}
R(&a)
Console.WriteLine(a)
");

        var warning = Assert.Single(result.Diagnostics, d => d.Id == "GS0612");
        var text = Assert.IsType<SourceText>(warning.Location.Text);
        Assert.Equal(text.ToString().LastIndexOf("R(&a)", System.StringComparison.Ordinal) + 2, warning.Location.Span.Start);
        Assert.Equal("r", result.Output.Trim());
    }

    [Fact]
    public void DeclarationForms_SuppressTheirOwnSpan()
    {
        var result = EmittedOracle.Evaluate(Callee + @"
@SuppressDiagnostic(""GS0612"")
func Whole() string {
    var a string? = nil
    R(&a)
    return a!!
}

func Local() int32 {
    var a string? = nil
    @SuppressDiagnostic(""GS0612"") let n = Count(&a)
    return n
}

func Count(ref s string) int32 -> s.Length

Console.WriteLine(Whole())
");

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0612");
        Assert.Equal("r", result.Output.Trim());
    }

    [Fact]
    public void AnUnrelatedIdentifier_DoesNotSuppress()
    {
        var result = EmittedOracle.Evaluate(Callee + @"
var a string? = nil
@SuppressDiagnostic(""GS0536"") {
    R(&a)
}
");

        Assert.Single(result.Diagnostics, d => d.Id == "GS0612");
    }

    [Fact]
    public void Errors_AreNeverSuppressed()
    {
        var result = EmittedOracle.Evaluate(Callee + @"
var n int32 = 1
@SuppressDiagnostic(""GS0154"") {
    R(&n)
}
");

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0154" && d.IsError);
    }

    [Fact]
    public void Compilation_ExposesTheSameFilterToOtherHosts()
    {
        var tree = SyntaxTree.Parse(SourceText.From(Callee + @"
var a string? = nil
@SuppressDiagnostic(""GS0612"") {
    R(&a)
}
"));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);

        var raw = compilation.GlobalScope.Diagnostics.AddRange(compilation.BoundProgram.Diagnostics);
        Assert.Contains(raw, d => d.Id == "GS0612");
        Assert.DoesNotContain(compilation.ApplySourceSuppressions(raw), d => d.Id == "GS0612");

        using var stream = new MemoryStream();
        var emit = compilation.Emit(stream);
        Assert.True(emit.Success);
        Assert.DoesNotContain(emit.Diagnostics, d => d.Id == "GS0612");
    }
}
