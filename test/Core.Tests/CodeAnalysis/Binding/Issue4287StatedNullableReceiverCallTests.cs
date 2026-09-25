// <copyright file="Issue4287StatedNullableReceiverCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4287: a call to an imported CLR instance method on a receiver
/// somebody STATED is <c>T?</c> must be narrowed, asserted or made
/// null-safe first. The call now reports GS0159, as a member read on the
/// same receiver has since #4390 and a call to a G#-declared method always
/// has.
/// <para>
/// The call path used to bind straight through: the receiver's
/// <c>ClrType</c> is the underlying type's, and the only
/// <c>NullableTypeSymbol</c> test on that path redirects a value-type
/// <c>Nullable&lt;T&gt;</c>. So <c>this.name.ToUpper()</c> on a
/// <c>string?</c> field compiled with no diagnostic and threw a bare
/// <c>NullReferenceException</c> — while <c>this.name.Length</c> reported.
/// </para>
/// </summary>
public sealed class Issue4287StatedNullableReceiverCallTests
{
    /// <summary>
    /// Every stated-nullable reference receiver shape the re-verification on
    /// the issue found binding without a check now reports GS0159.
    /// </summary>
    /// <param name="declarations">Top-level declarations.</param>
    /// <param name="body">The body of <c>Main</c>.</param>
    [Theory]

    // Case 0, the repro as the issue reports it: a `let` field.
    [InlineData("class Holder {\n    let name string? = nil\n    func Use() string { return this.name.ToUpper() }\n}", "")]

    // Case 1: a `var` field; case 14: a property.
    [InlineData("class Holder {\n    var name string?\n    func Use() string { return this.name.Trim() }\n}", "")]
    [InlineData("class Holder {\n    prop Name string? { get; set }\n    func Use() string { return this.Name.ToUpper() }\n}", "")]

    // Case 3: a local; case 7: a parameter.
    [InlineData("func get() string? { return nil }", "    let s string? = get()\n    Console.WriteLine(s.ToUpper())")]
    [InlineData("func use(s string?) string { return s.ToUpper() }", "")]

    // Case 13: other imported types and object members through a `T?` parameter.
    [InlineData("func use(u Uri?) string { return u.GetLeftPart(UriPartial.Path) }", "")]
    [InlineData("func use(b StringBuilder?) { b.Append(\"x\") }", "")]
    [InlineData("func use(l List[int32]?) { l.Add(1) }", "")]
    [InlineData("func use(l List[int32]?) bool { return l.Contains(1) }", "")]
    [InlineData("func use(s string?) bool { return s.StartsWith(\"a\") }", "")]
    [InlineData("func use(o object?) string? { return o.ToString() }", "")]

    // Cases 5, 11 and 12: a stated `string?` return, chained with no syntax
    // of its own for the receiver.
    [InlineData("", "    Console.WriteLine(Path.GetDirectoryName(\"/\").ToUpper())")]
    [InlineData("", "    Console.WriteLine(Environment.GetEnvironmentVariable(\"X_4287\").Trim())")]
    [InlineData("", "    Console.WriteLine(Enumerable.FirstOrDefault(List[string]()).ToUpper())")]
    public void A_StatedNullableReceiver_Call_Reports_GS0159(string declarations, string body)
    {
        var diagnostics = Compile(declarations, body);

        var report = Assert.Single(diagnostics, d => d.IsError);
        Assert.Equal("GS0159", report.Id);
        Assert.Contains("may be nil", report.Message, System.StringComparison.Ordinal);
    }

    /// <summary>
    /// The controls. Everything the diagnostic tells the author to write
    /// compiles, and so does every nilable receiver that never reaches an
    /// imported instance method: a null-safe call, an assertion, a nil guard,
    /// <c>if let</c>, a value-type <c>Nullable&lt;T&gt;</c> (whose members
    /// live on <c>Nullable&lt;T&gt;</c> itself and are nil-safe), and an
    /// extension declared over the nilable type.
    /// </summary>
    /// <param name="declarations">Top-level declarations.</param>
    /// <param name="body">The body of <c>Main</c>.</param>
    /// <param name="expected">The expected program output.</param>
    [Theory]
    [InlineData("func use(s string?) string? { return s?.ToUpper() }", "    Console.WriteLine(use(\"a\"))", "A")]
    [InlineData("func use(s string?) string { return s!!.ToUpper() }", "    Console.WriteLine(use(\"a\"))", "A")]
    [InlineData("func use(s string?) string { if s != nil { return s.ToUpper() }\n    return \"-\" }", "    Console.WriteLine(use(nil))", "-")]
    [InlineData("func use(s string?) string { if let t = s { return t.ToUpper() }\n    return \"-\" }", "    Console.WriteLine(use(\"b\"))", "B")]
    [InlineData("func use(n int32?) int32 { return n.GetValueOrDefault() }", "    Console.WriteLine(use(nil))", "0")]
    [InlineData("func (s string?) OrDash() string { return s ?? \"-\" }\nfunc use(s string?) string { return s.OrDash() }", "    Console.WriteLine(use(nil))", "-")]
    [InlineData("class Holder {\n    let name string? = \"n\"\n    func Use() string { return this.name?.ToUpper() ?? \"-\" }\n}", "    Console.WriteLine(Holder().Use())", "N")]

    // A nil test on a STABLE (`let`) field narrows it for the rest of the
    // condition (ADR-0069), by bare name and through `this.`, exactly as a
    // member read through it is narrowed. This is the self-migrated
    // `AsyncBoundTreeQueries` shape: `memo != nil && memo.TryGetValue(…)`.
    [InlineData("class Holder {\n    let memo Dictionary[string, bool]? = Dictionary[string, bool]()\n    func Use() bool { return memo != nil && memo.TryGetValue(\"k\", out var c) }\n}", "    Console.WriteLine(Holder().Use())", "False")]
    [InlineData("class Holder {\n    let memo Dictionary[string, bool]? = Dictionary[string, bool]()\n    func Use() bool { return this.memo != nil && this.memo.TryGetValue(\"k\", out var c) }\n}", "    Console.WriteLine(Holder().Use())", "False")]
    [InlineData("class Holder {\n    let memo Dictionary[string, bool]? = nil\n    func Use() int32 { if memo != nil { return memo.Count }\n        return -1 }\n}", "    Console.WriteLine(Holder().Use())", "-1")]
    [InlineData("func use(l List[int32]?) bool { return l != nil && l.Contains(1) }", "    Console.WriteLine(use(List[int32]{1}))", "True")]
    public void The_Remedies_And_NilSafe_Receivers_Still_Compile_And_Run(string declarations, string body, string expected)
    {
        var result = EmittedOracle.Evaluate(Source(declarations, body));
        Assert.DoesNotContain(result.Diagnostics, d => d.IsError);
        Assert.Equal(expected, result.Output.Trim());
    }

    private static string Source(string declarations, string body)
        => $$"""
            package P4287
            import System
            import System.IO
            import System.Linq
            import System.Text
            import System.Collections.Generic

            {{declarations}}

            {{(body.Trim().Length == 0 ? "0" : body.Trim())}}
            """;

    private static ImmutableArray<Diagnostic> Compile(string declarations, string body)
        => EmittedOracle.Evaluate(Source(declarations, body)).Diagnostics;
}
