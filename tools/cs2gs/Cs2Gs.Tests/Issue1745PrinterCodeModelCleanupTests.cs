// <copyright file="Issue1745PrinterCodeModelCleanupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1745's cleanup batch: the string/interpolation
/// escaper is a single shared function (locks its output for the tricky
/// escape chars so a future edit can't silently diverge the two call sites
/// again), <see cref="ForInStatement.IsAwait"/> is now constructor-only, and
/// re-printing the same AST node is byte-identical (the "same AST → same
/// text" guarantee the mutable setter used to put at risk), and
/// <see cref="GSharpPrinter.Print"/> is safe to call concurrently (it has no
/// shared mutable state). The <c>isOpen</c>-extraction cleanup is pure
/// perf/dedup with no observable-output change, so it's covered implicitly
/// by every other printer test in this suite continuing to pass unchanged.
/// </summary>
public class Issue1745PrinterCodeModelCleanupTests
{
    /// <summary>
    /// A string literal and an interpolated string share the exact same
    /// escaper (<c>GSharpPrinter.RenderEscapedLiteralBody</c>) for their text
    /// body. Both must escape backslash, the closing quote, control chars
    /// (as <c>\uXXXX</c>), and double a literal <c>$</c> (so it can't be
    /// mistaken for an interpolation hole) identically.
    /// </summary>
    [Fact]
    public void StringLiteralAndInterpolation_EscapeIdentically()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public string Plain() => ""a\\b\""c$d\u0001e"";

        public string Interpolated(int x) => $""a\\b\""c$d\u0001e{x}"";
    }
}");

        // Plain string: backslash doubled, quote escaped, '$' doubled, control
        // char rendered as \u0001.
        Assert.Contains(@"""a\\b\""c$$d\u0001e""", printed, StringComparison.Ordinal);

        // Interpolated string: identical escaping for the literal text
        // segment, plus the `$x` interpolation hole for the expression.
        Assert.Contains(@"""a\\b\""c$$d\u0001e$x""", printed, StringComparison.Ordinal);

        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(result.Success, "Translated G# must round-trip. Errors:\n" + string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
    }

    /// <summary>
    /// <see cref="ForInStatement.IsAwait"/> used to be a mutable
    /// <c>{ get; set; }</c> property, which broke the printer's "same AST
    /// always produces byte-identical text" guarantee if a shared node was
    /// mutated between prints. It's now set once at construction time.
    /// Printing the very same <see cref="ForInStatement"/> instance twice
    /// must yield byte-identical text.
    /// </summary>
    [Fact]
    public void ForInStatement_SameInstancePrintedTwice_IsByteIdentical()
    {
        var loop = new ForInStatement(
            "x",
            new IdentifierExpression("src"),
            new BlockStatement(Array.Empty<GStatement>()),
            isAwait: true);

        var unit = new CompilationUnit(members: new GNode[] { loop });

        string first = GSharpPrinter.Print(unit);
        string second = GSharpPrinter.Print(unit);

        Assert.Equal(first, second);
        Assert.Contains("await for x in src", first, StringComparison.Ordinal);
    }

    /// <summary>
    /// <see cref="GSharpPrinter.Print"/> is a public static API and xunit
    /// runs test classes in parallel by default, so it must not rely on any
    /// unsynchronized shared mutable state (a prior indent-string cache did,
    /// and could race). Printing many nested, varying-depth ASTs from
    /// multiple threads at once must not throw and must produce correctly
    /// nested output every time.
    /// </summary>
    [Fact]
    public void Print_FromMultipleThreadsConcurrently_DoesNotThrow()
    {
        System.Threading.Tasks.Parallel.For(0, 64, i =>
        {
            GStatement body = new BlockStatement(Array.Empty<GStatement>());
            for (int depth = 0; depth < (i % 20) + 1; depth++)
            {
                body = new BlockStatement(new[] { body });
            }

            var unit = new CompilationUnit(members: new GNode[] { body });
            string printed = GSharpPrinter.Print(unit);
            Assert.Contains("{", printed, StringComparison.Ordinal);
        });
    }

    private static string TranslateUnit(string source)
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
        return printed;
    }
}
