// <copyright file="Issue3554MetadataHomonymQualificationTests.cs" company="GSharp">
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
/// Issue #3554: a fully-qualified METADATA reference used to shorten to its
/// bare simple name even when a DISTINCT same-named type sits in another of
/// the file's imported namespaces — gsc then silently bound the bare name to
/// the wrong package (the `GSharp.Core…Syntax.SyntaxFacts` vs Roslyn
/// `SyntaxFacts` family, GS0159 "Cannot find function IsReservedIdentifier").
/// The imported-namespace homonym scan now runs for metadata types in
/// ordinary positions too; it only fires on genuine collisions, so common
/// framework types still print bare.
/// </summary>
public class Issue3554MetadataHomonymQualificationTests
{
    [Fact]
    public void FullyQualifiedMetadataHomonym_StaysDisambiguated()
    {
        string printed = TranslateUnit(@"
using System.Timers;

namespace Demo
{
    public class Probe
    {
        public ElapsedEventHandler Handler { get; set; }

        public object MakeThreadingTimer()
        {
            return new System.Threading.Timer(_ => { }, null, 0, 1000);
        }
    }
}");

        // The System.Threading.Timer reference must not shorten to a bare
        // `Timer` that gsc would bind to System.Timers.Timer.
        Assert.DoesNotContain("return Timer(", printed);
        Assert.True(
            printed.Contains("System.Threading.Timer(", StringComparison.Ordinal)
                || System.Text.RegularExpressions.Regex.IsMatch(printed, @"import \w+ = System\.Threading\.Timer"),
            "The threading Timer must stay qualified or aliased. Printed:\n" + printed);
    }

    [Fact]
    public void UncollidedMetadataType_StaysBare()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Probe
    {
        public System.Text.StringBuilder Make()
        {
            return new System.Text.StringBuilder();
        }
    }
}");

        Assert.Contains("StringBuilder()", printed);
        Assert.DoesNotContain("System.Text.StringBuilder()", printed);
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
