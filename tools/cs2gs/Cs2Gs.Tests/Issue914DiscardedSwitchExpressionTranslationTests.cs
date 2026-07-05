// <copyright file="Issue914DiscardedSwitchExpressionTranslationTests.cs" company="GSharp">
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
/// Issue #914: a C# switch EXPRESSION used in statement position (a discard
/// <c>_ = x switch { ... };</c>, or any other expression-statement) was
/// translated as a G# switch-EXPRESSION with <c>case P: expr</c> arms emitted
/// at statement position. That arm form is only valid in value position; at
/// statement position G# parses a switch STATEMENT, whose arms require a
/// <c>case P { block }</c> body, so the emitted G# failed to round-trip
/// (GS0005 "Unexpected token ColonToken, expected OpenBraceToken").
///
/// The fix lowers such a discarded switch expression into a genuine G# switch
/// STATEMENT, running each arm's expression for its side effect.
/// </summary>
public class Issue914DiscardedSwitchExpressionTranslationTests
{
    private const string Prelude = @"
namespace Demo
{
    public enum EState { LocalLocked, LocalUnlocked, Exported, Converted }
";

    /// <summary>
    /// The dominant Oahu shape: a discarded switch expression whose arms are
    /// side-effecting method calls, with a value-only <c>_ =&gt; false</c>
    /// default. It must round-trip (the helper asserts that) as a switch
    /// STATEMENT, not a bare colon-arm expression at statement position.
    /// </summary>
    [Fact]
    public void DiscardedSwitchExpression_WithSideEffectingArms_LowersToSwitchStatement()
    {
        string printed = TranslateUnit(Prelude + @"
    public static class Ops
    {
        private static bool Check(EState s) => true;

        public static void Run(EState state)
        {
            _ = state switch
            {
                EState.LocalLocked => Check(state),
                EState.LocalUnlocked => Check(state),
                EState.Exported => Check(state),
                EState.Converted => Check(state),
                _ => false
            };
        }
    }
}");

        // Lowered to a switch STATEMENT: arms carry brace bodies, never a bare
        // `case ...:` colon arm at statement position.
        Assert.Contains("switch state", printed);
        Assert.Contains("Check(state)", printed);
        Assert.DoesNotContain("_ =", printed);
    }

    /// <summary>
    /// A discarded switch expression with no total (<c>_</c>/<c>var</c>/default)
    /// arm is exhaustive in C# by its type arms; the lowering must still
    /// round-trip by synthesizing a throwing default (mirroring C#'s runtime
    /// <c>SwitchExpressionException</c>), so gsc's total-arm rule is satisfied.
    /// </summary>
    [Fact]
    public void DiscardedSwitchExpression_NonTotalArms_SynthesizesThrowingDefault()
    {
        string printed = TranslateUnit(Prelude + @"
    public static class Ops
    {
        private static bool Check(EState s) => true;

        public static void Run(bool flag)
        {
            _ = flag switch
            {
                true => Check(EState.Exported),
                false => Check(EState.Converted)
            };
        }
    }
}");

        Assert.Contains("switch flag", printed);
        Assert.Contains("default", printed);
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
