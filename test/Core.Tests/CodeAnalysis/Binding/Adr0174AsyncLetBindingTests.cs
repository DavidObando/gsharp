// <copyright file="Adr0174AsyncLetBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0174 D15, the rules around the <c>async let</c> binding: it needs a
/// <c>scope</c> to own it (GS0551), every read is spelled <c>await</c>
/// (GS0569), and a binding nobody reads had its work started only to be
/// cancelled (GS0559). The binding's type is the child's result, never a
/// handle, which is what makes a spawn unable to outlive its owner.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): GS0569 is enforced twice, and both are
/// needed. A mutant that keeps only the name-resolution check breaks
/// <see cref="ReadInAReceiverPosition_ReportsGS0569"/>, because a receiver
/// resolves the symbol through a different path; a mutant that keeps only the
/// walk over the bound block still reports, but at the declaration rather than
/// the read, which <see cref="BareRead_ReportsGS0569_AtTheRead"/> pins.
/// </remarks>
public class Adr0174AsyncLetBindingTests
{
    [Fact]
    public void OutsideAScope_ReportsGS0551()
    {
        var diagnostics = Compile("""
            package P
            func work() int32 {
                return 1
            }

            async let stray = work()
            """);

        var diagnostic = Assert.Single(diagnostics, d => d.Id == "GS0551");
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity);
    }

    [Fact]
    public void InsideAScope_IsAccepted()
    {
        var diagnostics = Compile("""
            package P
            func work() int32 {
                return 1
            }

            scope {
                async let v = work()
                let n = await v
            }
            """);

        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    [Fact]
    public void BareRead_ReportsGS0569_AtTheRead()
    {
        var diagnostics = Compile("""
            package P
            func work() int32 {
                return 1
            }

            scope {
                async let v = work()
                let copy = v
            }
            """);

        var diagnostic = Assert.Single(diagnostics, d => d.Id == "GS0569");
        Assert.Equal(DiagnosticSeverity.Error, diagnostic.Severity);
        Assert.Contains("'v'", diagnostic.Message);
        Assert.Equal(8, diagnostic.Location.StartLine + 1);
    }

    [Fact]
    public void ReadInAReceiverPosition_ReportsGS0569()
    {
        var diagnostics = Compile("""
            package P
            func work() int32 {
                return 1
            }

            scope {
                async let v = work()
                let text = v.ToString()
            }
            """);

        Assert.Contains(diagnostics, d => d.Id == "GS0569");
    }

    [Fact]
    public void NeverAwaited_ReportsGS0559()
    {
        var diagnostics = Compile("""
            package P
            func work() int32 {
                return 1
            }

            scope {
                async let unused = work()
            }
            """);

        var diagnostic = Assert.Single(diagnostics, d => d.Id == "GS0559");
        Assert.Equal(DiagnosticSeverity.Warning, diagnostic.Severity);
        Assert.Contains("'unused'", diagnostic.Message);
    }

    [Fact]
    public void AwaitedOnce_DoesNotReportGS0559()
    {
        var diagnostics = Compile("""
            package P
            func work() int32 {
                return 1
            }

            scope {
                async let used = work()
                let n = await used
            }
            """);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0559");
    }

    [Fact]
    public void TheBindingIsTypedAsTheChildsResult()
    {
        // The binding names `R`, not a task: `await text` is a `string`, and
        // assigning it to an `int32` is an ordinary conversion error rather
        // than a complaint about a `ValueTask`.
        var diagnostics = Compile("""
            package P
            func work() string {
                return "hi"
            }

            scope {
                async let text = work()
                let n int32 = await text
            }
            """);

        var diagnostic = Assert.Single(diagnostics, d => d.IsError);
        Assert.Contains("string", diagnostic.Message);
        Assert.DoesNotContain("ValueTask", diagnostic.Message);
    }

    [Fact]
    public void ANestedScopeOwnsItsOwnBindings()
    {
        // The outer block's GS0559 walk must not claim the inner block's
        // binding, and vice versa.
        var diagnostics = Compile("""
            package P
            func work() int32 {
                return 1
            }

            scope {
                async let outer = work()
                scope {
                    async let inner = work()
                    let a = await inner
                }

                let b = await outer
            }
            """);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0559");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0569");
    }

    private static ImmutableArray<Diagnostic> Compile(string source)
        => EmittedOracle.CompileDiagnostics(new Compilation(SyntaxTree.Parse(source)));

}
