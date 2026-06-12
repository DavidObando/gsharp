// <copyright file="Issue722GoExtensionsImportGateTests.cs" company="GSharp">
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
/// Issue #722 / ADR-0082 — the Go-flavored concurrency syntactic
/// surface (<c>go</c>, <c>chan T</c>, <c>&lt;-</c> send, <c>&lt;-</c>
/// receive, <c>select</c>, <c>close(ch)</c>, <c>make(chan T)</c>) is
/// gated behind a per-file <c>import Gsharp.Extensions.Go</c>. The
/// binder emits <c>GS0316</c> when any gated form is used without the
/// import in the current compilation unit, naming the triggering form.
/// </summary>
public class Issue722GoExtensionsImportGateTests
{
    private const string GateDiagnosticId = "GS0316";
    private const string GoImport = "import Gsharp.Extensions.Go";

    // ─────────────────────────────────────────────────────────────────────
    // Per-form gate checks. Each gated syntactic form gets two cases:
    //   (a) import missing → GS0316 fires, anchored on the form keyword,
    //       and the message names the form.
    //   (b) import present → no GS0316, no cascading diagnostics from the
    //       form itself.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void Go_WithoutImport_ReportsGS0316()
    {
        var diags = Bind(@"
func work() int32 { return 1 }
go work()
");

        var diag = Assert.Single(diags.Where(d => d.Id == GateDiagnosticId));
        Assert.Contains("'go'", diag.Message);
        Assert.Contains("Gsharp.Extensions.Go", diag.Message);
        Assert.Equal("go", diag.Location.Text.ToString(diag.Location.Span));
    }

    [Fact]
    public void Go_WithImport_DoesNotReportGS0316()
    {
        var diags = Bind(GoImport + @"
func work() int32 { return 1 }
go work()
");
        AssertNoGateDiagnostic(diags);
    }

    [Fact]
    public void Chan_TypeClause_WithoutImport_ReportsGS0316()
    {
        var diags = Bind(@"
func consume(c chan int32) int32 { return 0 }
");

        var diag = Assert.Single(diags.Where(d => d.Id == GateDiagnosticId));
        Assert.Contains("'chan'", diag.Message);
        Assert.Equal("chan", diag.Location.Text.ToString(diag.Location.Span));
    }

    [Fact]
    public void Chan_TypeClause_WithImport_DoesNotReportGS0316()
    {
        var diags = Bind(GoImport + @"
func consume(c chan int32) int32 { return 0 }
");
        AssertNoGateDiagnostic(diags);
    }

    [Fact]
    public void MakeChan_WithoutImport_ReportsGS0316_AnchoredOnChan()
    {
        // `make(chan T)` is anchored at the inner `chan` keyword: a
        // single GS0316 is reported per make-site, per ADR-0082.
        var diags = Bind(@"
let ch = make(chan int32, 1)
");

        var diag = Assert.Single(diags.Where(d => d.Id == GateDiagnosticId));
        Assert.Equal("chan", diag.Location.Text.ToString(diag.Location.Span));
        Assert.Contains("'chan'", diag.Message);
    }

    [Fact]
    public void MakeChan_WithImport_DoesNotReportGS0316()
    {
        var diags = Bind(GoImport + @"
let ch = make(chan int32, 1)
");
        AssertNoGateDiagnostic(diags);
    }

    [Fact]
    public void Send_WithoutImport_ReportsGS0316()
    {
        // `chan T` itself also reports — assert that the send-form GS0316
        // is among the diagnostics, anchored at the send operator token.
        var diags = Bind(@"
let ch = make(chan int32, 1)
ch <- 7
");

        var sendDiags = diags.Where(d => d.Id == GateDiagnosticId
                                         && d.Message.Contains("<- (send)"));
        var diag = Assert.Single(sendDiags);
        Assert.Equal("<-", diag.Location.Text.ToString(diag.Location.Span));
    }

    [Fact]
    public void Send_WithImport_DoesNotReportGS0316()
    {
        var diags = Bind(GoImport + @"
let ch = make(chan int32, 1)
ch <- 7
");
        AssertNoGateDiagnostic(diags);
    }

    [Fact]
    public void Receive_WithoutImport_ReportsGS0316()
    {
        var diags = Bind(@"
let ch = make(chan int32, 1)
ch <- 5
let v = <-ch
");

        var recvDiags = diags.Where(d => d.Id == GateDiagnosticId
                                         && d.Message.Contains("<- (receive)"));
        var diag = Assert.Single(recvDiags);
        Assert.Equal("<-", diag.Location.Text.ToString(diag.Location.Span));
    }

    [Fact]
    public void Receive_WithImport_DoesNotReportGS0316()
    {
        var diags = Bind(GoImport + @"
let ch = make(chan int32, 1)
ch <- 5
let v = <-ch
");
        AssertNoGateDiagnostic(diags);
    }

    [Fact]
    public void Select_WithoutImport_ReportsGS0316()
    {
        var diags = Bind(@"
let ch = make(chan int32, 1)
ch <- 1
select {
    case let v = <-ch { }
    default { }
}
");

        var selectDiags = diags.Where(d => d.Id == GateDiagnosticId
                                           && d.Message.Contains("'select'"));
        var diag = Assert.Single(selectDiags);
        Assert.Equal("select", diag.Location.Text.ToString(diag.Location.Span));
    }

    [Fact]
    public void Select_WithImport_DoesNotReportGS0316()
    {
        var diags = Bind(GoImport + @"
let ch = make(chan int32, 1)
ch <- 1
select {
    case let v = <-ch { }
    default { }
}
");
        AssertNoGateDiagnostic(diags);
    }

    [Fact]
    public void Close_WithoutImport_ReportsGS0316()
    {
        var diags = Bind(@"
let ch = make(chan int32, 1)
close(ch)
");

        var closeDiags = diags.Where(d => d.Id == GateDiagnosticId
                                          && d.Message.Contains("'close'"));
        var diag = Assert.Single(closeDiags);
        Assert.Equal("close", diag.Location.Text.ToString(diag.Location.Span));
    }

    [Fact]
    public void Close_WithImport_DoesNotReportGS0316()
    {
        var diags = Bind(GoImport + @"
let ch = make(chan int32, 1)
close(ch)
");
        AssertNoGateDiagnostic(diags);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Negative space: programs that use none of the gated forms must not
    // see the gate fire even if the import is absent (the common case).
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

    [Fact]
    public void RegularProgram_WithUnusedGoImport_IsAllowed()
    {
        // Importing Gsharp.Extensions.Go without exercising any gated
        // form must not produce an unused-import diagnostic. The import
        // is the user's contract that they intend to opt into the
        // surface — silence is the desired outcome.
        var result = Evaluate(GoImport + @"
let n = 41 + 1
n
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    // ─────────────────────────────────────────────────────────────────────
    // ADR-0082: /noimplicitimports does not auto-add Gsharp.Extensions.Go.
    // The Compilation-level switch that disables implicit System imports
    // must not paper over the gate either: a missing import is still a
    // missing import regardless of how the compilation was configured.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void NoImplicitImports_DoesNotAutoAddGoExtensions()
    {
        // The Go gate is purely import-driven, so toggling implicit
        // imports off should leave GS0316 firing the same way; the
        // compilation must not synthesise the import for the user.
        var source = @"
func work() int32 { return 1 }
go work()
";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { ImplicitSystemImport = false };
        var diags = compilation.Evaluate(new Dictionary<VariableSymbol, object>()).Diagnostics;

        Assert.Contains(diags, d => d.Id == GateDiagnosticId);
    }

    // ─────────────────────────────────────────────────────────────────────
    // End-to-end interpreter coverage: with the import present, the full
    // Go-flavored channel program binds, lowers, and evaluates cleanly —
    // proving the gate's recovery path matches the un-gated bound shape.
    // ─────────────────────────────────────────────────────────────────────

    [Fact]
    public void EndToEnd_GoChanSelectClose_Evaluates_WithImport()
    {
        var result = Evaluate(GoImport + @"
func producer(ch chan int32) int32 {
    ch <- 7
    close(ch)
    return 0
}

let ch = make(chan int32, 1)
go producer(ch)
var got = 0
select {
    case let v = <-ch {
        got = v
    }
}
got
");
        Assert.Empty(result.Diagnostics);
        Assert.Equal(7, result.Value);
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

    private static void AssertNoGateDiagnostic(ImmutableArray<Diagnostic> diags)
    {
        Assert.DoesNotContain(diags, d => d.Id == GateDiagnosticId);
    }
}
