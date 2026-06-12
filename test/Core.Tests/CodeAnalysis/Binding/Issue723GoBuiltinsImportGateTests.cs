// <copyright file="Issue723GoBuiltinsImportGateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #723 / ADR-0083 — the Go-style built-in functions
/// (<c>len</c>, <c>cap</c>, <c>append</c>, <c>delete</c>, plus <c>make</c>
/// for <c>chan T</c>) only resolve when the same compilation unit imports
/// <c>Gsharp.Extensions.Go</c>. The binder emits <c>GS0317</c> for the
/// strict built-in identifiers (<c>len</c> / <c>cap</c> / <c>append</c> /
/// <c>delete</c>), with a per-built-in / per-receiver-type
/// .NET-idiomatic suggestion baked into the message. <c>close(ch)</c>
/// keeps the GS0316 message (#722 / ADR-0082); <c>make(chan T)</c> is
/// gated through the inner <c>chan</c> type-clause and therefore also
/// surfaces as GS0316.
/// </summary>
public class Issue723GoBuiltinsImportGateTests
{
    private const string BuiltinDiagnosticId = "GS0317";
    private const string ChannelDiagnosticId = "GS0316";
    private const string GoImport = "import Gsharp.Extensions.Go";

    // ─────────────────────────────────────────────────────────────────────
    // len — slice / array / string / map. Each receiver kind drives a
    // different .NET-idiomatic suggestion in the diagnostic text.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Len_Slice_WithoutImport_ReportsGS0317_SuggestsLength()
    {
        var diags = Bind(@"
let xs = []int32{1, 2, 3}
let n = len(xs)
");

        var diag = Assert.Single(diags.Where(d => d.Id == BuiltinDiagnosticId));
        Assert.Equal("len", diag.Location.Text.ToString(diag.Location.Span));
        Assert.Contains("'len'", diag.Message);
        Assert.Contains("Gsharp.Extensions.Go", diag.Message);
        Assert.Contains(".Length", diag.Message);
        Assert.Contains("ADR-0083", diag.Message);
    }

    [Fact]
    public void Len_String_WithoutImport_ReportsGS0317_SuggestsLength()
    {
        var diags = Bind(@"
let n = len(""hello"")
");

        var diag = Assert.Single(diags.Where(d => d.Id == BuiltinDiagnosticId));
        Assert.Contains(".Length", diag.Message);
    }

    [Fact]
    public void Len_Map_WithoutImport_ReportsGS0317_SuggestsCount()
    {
        var diags = Bind(@"
let m = map[string]int32{""a"": 1}
let n = len(m)
");

        var diag = Assert.Single(diags.Where(d => d.Id == BuiltinDiagnosticId));
        Assert.Contains(".Count", diag.Message);
    }

    [Fact]
    public void Len_WithImport_DoesNotReportGS0317()
    {
        var diags = Bind(GoImport + @"
let xs = []int32{1, 2, 3}
let n = len(xs)
");
        AssertNoBuiltinGateDiagnostic(diags);
    }

    // ─────────────────────────────────────────────────────────────────────
    // cap — slice receiver. No clean .NET-idiomatic alternative: the
    // diagnostic falls back to the import-only message variant.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Cap_Slice_WithoutImport_ReportsGS0317_NoSuggestion()
    {
        var diags = Bind(@"
let xs = []int32{1, 2, 3}
let c = cap(xs)
");

        var diag = Assert.Single(diags.Where(d => d.Id == BuiltinDiagnosticId));
        Assert.Equal("cap", diag.Location.Text.ToString(diag.Location.Span));
        Assert.Contains("'cap'", diag.Message);
        Assert.Contains("Gsharp.Extensions.Go", diag.Message);

        // cap has no documented .NET-idiomatic suggestion; the message
        // must not advertise a stale `.Length`-style alternative.
        Assert.DoesNotContain(".Length", diag.Message);
        Assert.DoesNotContain(".Count", diag.Message);
    }

    [Fact]
    public void Cap_WithImport_DoesNotReportGS0317()
    {
        var diags = Bind(GoImport + @"
let xs = []int32{1, 2, 3}
let c = cap(xs)
");
        AssertNoBuiltinGateDiagnostic(diags);
    }

    // ─────────────────────────────────────────────────────────────────────
    // append — slice receiver. Suggestion mentions List[T].Add as the
    // mutable-list fallback the recommendation column documents.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Append_WithoutImport_ReportsGS0317_SuggestsListAdd()
    {
        var diags = Bind(@"
var xs = []int32{1}
xs = append(xs, 2)
");

        var diag = Assert.Single(diags.Where(d => d.Id == BuiltinDiagnosticId));
        Assert.Equal("append", diag.Location.Text.ToString(diag.Location.Span));
        Assert.Contains("'append'", diag.Message);
        Assert.Contains("List[T].Add", diag.Message);
    }

    [Fact]
    public void Append_WithImport_DoesNotReportGS0317()
    {
        var diags = Bind(GoImport + @"
var xs = []int32{1}
xs = append(xs, 2)
");
        AssertNoBuiltinGateDiagnostic(diags);
    }

    // ─────────────────────────────────────────────────────────────────────
    // delete — map receiver. Suggestion points at .Remove(k).
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Delete_WithoutImport_ReportsGS0317_SuggestsRemove()
    {
        var diags = Bind(@"
var m = map[string]int32{""a"": 1}
delete(m, ""a"")
");

        var diag = Assert.Single(diags.Where(d => d.Id == BuiltinDiagnosticId));
        Assert.Equal("delete", diag.Location.Text.ToString(diag.Location.Span));
        Assert.Contains("'delete'", diag.Message);
        Assert.Contains(".Remove(k)", diag.Message);
    }

    [Fact]
    public void Delete_WithImport_DoesNotReportGS0317()
    {
        var diags = Bind(GoImport + @"
var m = map[string]int32{""a"": 1}
delete(m, ""a"")
");
        AssertNoBuiltinGateDiagnostic(diags);
    }

    // ─────────────────────────────────────────────────────────────────────
    // close / make — covered by the GS0316 surface (channel cluster).
    // Re-asserted here so the deconfliction note in ADR-0083 is regression-
    // proof: GS0317 must NOT fire for close/make even though they are in
    // the same import cluster.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Close_WithoutImport_KeepsGS0316_NotGS0317()
    {
        var diags = Bind(@"
let ch = make(chan int32, 1)
close(ch)
");

        Assert.DoesNotContain(diags, d => d.Id == BuiltinDiagnosticId);
        Assert.Contains(diags, d => d.Id == ChannelDiagnosticId && d.Message.Contains("'close'"));
    }

    [Fact]
    public void MakeChan_WithoutImport_KeepsGS0316_NotGS0317()
    {
        var diags = Bind(@"
let ch = make(chan int32, 1)
");

        Assert.DoesNotContain(diags, d => d.Id == BuiltinDiagnosticId);
        Assert.Contains(diags, d => d.Id == ChannelDiagnosticId && d.Message.Contains("'chan'"));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Cross-check: a single `import Gsharp.Extensions.Go` unlocks BOTH
    // the channel surface (#722 / GS0316) and the built-in surface
    // (#723 / GS0317). One import — entire Go cluster green.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void GoImport_UnlocksBothChannelSurfaceAndBuiltins()
    {
        var diags = Bind(GoImport + @"
let ch = make(chan int32, 1)
ch <- 7
close(ch)
let v = <-ch

var xs = []int32{1, 2}
let n = len(xs)
let c = cap(xs)
xs = append(xs, 3)
let m = map[string]int32{""a"": 1}
delete(m, ""a"")
let q = len(m)
");

        Assert.DoesNotContain(diags, d => d.Id == BuiltinDiagnosticId);
        Assert.DoesNotContain(diags, d => d.Id == ChannelDiagnosticId);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Recovery: the gate reports GS0317 but still binds the form as if
    // the import were present. Genuine shape errors on the built-in's
    // argument (e.g. `len(42)`) must still surface in the same pass.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void GateRecovery_DoesNotSwallowShapeDiagnostic()
    {
        var diags = Bind(@"
let n = len(42)
");

        // Both the gate (GS0317) AND the type-shape diagnostic must
        // surface — recovery must not cascade-collapse.
        Assert.Contains(diags, d => d.Id == BuiltinDiagnosticId);
        Assert.Contains(diags, d => d.Id == "GS0117"); // wrong-intrinsic-arg-type
    }

    // ─────────────────────────────────────────────────────────────────────
    // /noimplicitimports does not auto-add Gsharp.Extensions.Go.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void NoImplicitImports_DoesNotAutoAddGoExtensionsForBuiltins()
    {
        var source = @"
let xs = []int32{1}
let n = len(xs)
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { ImplicitSystemImport = false };
        var diags = compilation.Evaluate(new Dictionary<VariableSymbol, object>()).Diagnostics;

        Assert.Contains(diags, d => d.Id == BuiltinDiagnosticId);
    }

    // ─────────────────────────────────────────────────────────────────────
    // End-to-end emit / interpreter coverage: each built-in evaluates
    // cleanly under the import.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void EndToEnd_Len_Evaluates_WithImport()
    {
        var result = Evaluate(GoImport + @"
let xs = []int32{10, 20, 30}
len(xs)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void EndToEnd_Cap_Evaluates_WithImport()
    {
        var result = Evaluate(GoImport + @"
let xs = []int32{10, 20, 30}
cap(xs)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void EndToEnd_Append_Evaluates_WithImport()
    {
        var result = Evaluate(GoImport + @"
var xs = []int32{1}
xs = append(xs, 2)
xs = append(xs, 3)
len(xs)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(3, result.Value);
    }

    [Fact]
    public void EndToEnd_Delete_Evaluates_WithImport()
    {
        var result = Evaluate(GoImport + @"
var m = map[string]int32{""a"": 1, ""b"": 2}
delete(m, ""a"")
len(m)
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void EndToEnd_LenString_Evaluates_WithImport()
    {
        var result = Evaluate(GoImport + @"
len(""hello"")
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(5, result.Value);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Negative space: programs that never call a gated built-in must not
    // see GS0317 even without the import.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void RegularProgram_WithoutImport_IsUnaffected()
    {
        var result = Evaluate(@"
let n = 1 + 2 + 3
n
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(6, result.Value);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Helpers.
    // ─────────────────────────────────────────────────────────────────────

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>()).Diagnostics;
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }

    private static void AssertNoBuiltinGateDiagnostic(ImmutableArray<Diagnostic> diags)
    {
        Assert.DoesNotContain(diags, d => d.Id == BuiltinDiagnosticId);
    }
}
