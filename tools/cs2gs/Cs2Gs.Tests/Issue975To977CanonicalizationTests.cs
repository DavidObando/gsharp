// <copyright file="Issue975To977CanonicalizationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Canonicalization tests for the three L4-discovered compiler gaps that are now
/// resolved on the compiler side (ADR-0115 §B.4/§B.28/§B.30, §G):
/// <list type="bullet">
/// <item>#975 — an interpolated string in a <c>: base(...)</c> constructor
/// argument is emitted directly (no bare-parameter forward needed).</item>
/// <item>#976 — a <c>struct</c> keeps its interface clause
/// (<c>struct Money : IEquatable[Money]</c>).</item>
/// <item>#977 — a BCL method invoked with an inline <c>out var x</c> is emitted
/// inline (no pre-declared <c>&amp;x</c> workaround needed).</item>
/// </list>
/// The translator already produces these canonical forms for canonical-capable
/// C#; these tests lock that in so a regression to the former workaround forms
/// is caught. Each printed form additionally round-trip-parses with the real
/// G# parser via <see cref="Translate"/>.
/// </summary>
public class Issue975To977CanonicalizationTests
{
    /// <summary>
    /// #975 (ADR-0115 §B.28): an interpolated string in <c>: base(...)</c> arg
    /// position is emitted directly into the base initializer — the canonical
    /// <c>init(params) : base($"…")</c> form — now that the emitter no longer
    /// ICEs (GS9998) on it.
    /// </summary>
    [Fact]
    public void InterpolatedString_InBaseInitializer_EmittedDirectly()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System;

    public sealed class ShortStockException : Exception
    {
        public ShortStockException(int n) : base($""only {n} left"") { }
    }
}");

        Assert.Contains("init(n int32) : base(\"only $n left\") {", printed);
    }

    /// <summary>
    /// #976 (ADR-0115 §B.4): a <c>struct</c> that implements an interface keeps
    /// its interface clause (<c>struct S : I[…]</c>) now that the parser accepts
    /// a struct base clause (struct naming a class base is rejected with
    /// GS0382, but an interface clause is legal).
    /// </summary>
    [Fact]
    public void Struct_ImplementingInterface_KeepsInterfaceClause()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System;

    public struct Money : IEquatable<Money>
    {
        public int Cents;

        public Money(int cents)
        {
            Cents = cents;
        }

        public bool Equals(Money other) => Cents == other.Cents;

        public override int GetHashCode() => Cents;
    }
}");

        Assert.Contains("struct Money(Cents int32) : IEquatable[Money] {", printed);
    }

    /// <summary>
    /// #977 (ADR-0115 §B.30): a BCL method (<c>Dictionary.TryGetValue</c>)
    /// invoked with an inline <c>out var x</c> declaration is emitted inline as
    /// <c>out var x</c> — the canonical form — now that BCL overload resolution
    /// accepts it (no pre-declared <c>&amp;x</c> workaround).
    /// </summary>
    [Fact]
    public void BclMethod_WithInlineOutVar_EmittedInline()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    using System.Collections.Generic;

    public static class Lookup
    {
        public static int Get(Dictionary<string, int> table, string key)
        {
            if (table.TryGetValue(key, out var value))
            {
                return value;
            }

            return 0;
        }
    }
}");

        Assert.Contains("if table.TryGetValue(key, out var value) {", printed);
        Assert.DoesNotContain("&value", printed);
    }

    private static string TranslateUnit(string source)
    {
        (string printed, _) = Translate(source);
        return printed;
    }

    private static (string Printed, TranslationContext Context) Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return (printed, context);
    }
}
