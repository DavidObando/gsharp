// <copyright file="Issue3501OutVarTaintTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501 (Translator burn-down, GS0154 family): an <c>out</c>/<c>ref</c>
/// argument flows the OPPOSITE way through a call — the callee writes the
/// parameter's value into the caller's variable. The oblivious taint analysis
/// only modeled argument→parameter edges, so a Try-pattern out parameter that
/// can be assigned null (<c>bool TryGet(..., out T value)</c> assigning an
/// <c>as</c>-cast) rendered <c>T?</c> while the caller's out-var local stayed
/// untainted; gsc independently infers the out-var's type from the promoted
/// parameter (<c>T?</c>), so downstream reads passed a <c>T?</c> where the
/// translator believed a <c>T</c> flowed and never bridged with <c>!!</c>.
/// The parameter→receiver back-edge closes the gap.
/// </summary>
public class Issue3501OutVarTaintTranslationTests
{
    [Fact]
    public void Oblivious_TryPatternOutVar_TaintsReceiverAndBridgesUse()
    {
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        public bool TryPick(object value, out string picked)
        {
            picked = value as string;
            return picked != null;
        }

        public int Consume(string exact) { return exact.Length; }

        public int Run(object value)
        {
            if (this.TryPick(value, out var picked))
            {
                return this.Consume(picked);
            }

            return 0;
        }
    }
}");

        // The out parameter itself is tainted (assigned an `as`-cast)...
        Assert.Contains("out picked string?", printed);

        // ...and the receiving out-var local now inherits that taint, which the
        // fixpoint carries onward through the argument edge into `Consume`'s
        // parameter — the whole chain agrees on `string?` and the read needs no
        // call-site bridge. (Before the back-edge, the local stayed untainted,
        // `Consume` kept `string`, and gsc rejected the `T? -> T` argument.)
        Assert.Contains("func Consume(exact string?)", printed);
        Assert.Contains("Consume(picked)", printed);
    }

    [Fact]
    public void Oblivious_NonNullOutVar_StaysBare()
    {
        // The out parameter is always assigned a non-null value, so neither the
        // parameter nor the receiving local is promoted and no `!!` appears.
        string printed = TranslateOblivious(@"
namespace Demo
{
    public class C
    {
        public bool TryPick(object value, out string picked)
        {
            picked = ""fixed"";
            return true;
        }

        public int Consume(string exact) { return exact.Length; }

        public int Run(object value)
        {
            if (this.TryPick(value, out var picked))
            {
                return this.Consume(picked);
            }

            return 0;
        }
    }
}");

        Assert.Contains("out picked string)", printed);
        Assert.Contains("Consume(picked)", printed);
    }

    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
