// <copyright file="Issue4354StatedNullableCompoundReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4354: a compound member assignment (<c>recv.Member op= value</c>)
/// through a receiver STATED as <c>T?</c> bound clean and failed at run time
/// with an unattributed <c>NullReferenceException</c>, while the plain write
/// and the read through the same receiver report GS0158. The compound binder
/// took the receiver's CLR type from <c>NullableTypeSymbol.ClrType</c>, which
/// relays to the underlying type, instead of the gate the plain paths use.
/// </summary>
public sealed class Issue4354StatedNullableCompoundReceiverTests
{
    /// <summary>
    /// Each stated-nullable receiver shape reports exactly the diagnostic the
    /// plain write through the same receiver reports.
    /// </summary>
    /// <param name="declarations">Top-level declarations.</param>
    /// <param name="body">The body of the program.</param>
    [Theory]
    [InlineData("", "    let xs List[int32]? = nil\n    xs.Capacity += 1")]
    [InlineData("func use(xs List[int32]?) { xs.Capacity += 1 }", "")]
    [InlineData("func use(xs List[int32]?) { xs.Capacity -= 1 }", "")]
    [InlineData("class Holder {\n    var xs List[int32]? = nil\n    func Use() { this.xs.Capacity += 1 }\n}", "")]
    [InlineData("", "    let e = Exception(\"m\")\n    e.InnerException.Source += \"x\"")]
    [InlineData("func use(p Process?) { p.Exited += (s, e) -> { } }", "")]
    public void A_StatedNullableReceiver_CompoundWrite_Reports_GS0158(string declarations, string body)
    {
        var diagnostics = Compile(declarations, body);

        var report = Assert.Single(diagnostics, d => d.IsError);
        Assert.Equal("GS0158", report.Id);
    }

    /// <summary>
    /// The plain write through the same receiver reports the same code, so the
    /// compound form is consistent with it.
    /// </summary>
    [Fact]
    public void The_Plain_Write_Reports_The_Same_Diagnostic()
    {
        var diagnostics = Compile("func use(xs List[int32]?) { xs.Capacity = 1 }", string.Empty);

        Assert.Equal("GS0158", Assert.Single(diagnostics, d => d.IsError).Id);
    }

    /// <summary>
    /// The remedies the diagnostic points at, and every receiver that never
    /// was nilable, still compile and run.
    /// </summary>
    /// <param name="declarations">Top-level declarations.</param>
    /// <param name="body">The body of the program.</param>
    /// <param name="expected">The expected program output.</param>
    [Theory]
    [InlineData("func use(xs List[int32]?) int32 { xs!!.Capacity += 4\n    return xs!!.Capacity }", "    Console.WriteLine(use(List[int32](2)) >= 6)", "True")]
    [InlineData("func use(xs List[int32]?) int32 { if let l = xs { l.Capacity += 4\n        return l.Capacity }\n    return -1 }", "    Console.WriteLine(use(List[int32](2)) >= 6)", "True")]
    [InlineData("func use(xs List[int32]?) int32 { if xs != nil { xs.Capacity += 4\n        return xs.Capacity }\n    return -1 }", "    Console.WriteLine(use(List[int32](2)) >= 6)", "True")]
    [InlineData("func use(xs List[int32]) int32 { xs.Capacity += 4\n    return xs.Capacity }", "    Console.WriteLine(use(List[int32](2)) >= 6)", "True")]
    [InlineData("", "    let sb = StringBuilder()\n    sb.Length += 0\n    Console.WriteLine(sb.Length)", "0")]
    public void The_Remedies_And_NonNil_Receivers_Still_Compile_And_Run(string declarations, string body, string expected)
    {
        var result = EmittedOracle.Evaluate(Source(declarations, body));
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(expected, result.Output.Trim());
    }

    private static string Source(string declarations, string body)
        => $$"""
            package P4354
            import System
            import System.Text
            import System.Diagnostics
            import System.Collections.Generic

            {{declarations}}

            {{(body.Trim().Length == 0 ? "0" : body.Trim())}}
            """;

    private static ImmutableArray<Diagnostic> Compile(string declarations, string body)
        => EmittedOracle.Evaluate(Source(declarations, body)).Diagnostics;
}
