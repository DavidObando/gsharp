// <copyright file="Issue3501DirectDeconstructionNamesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501 (__decon retirement): a single-variable declaration element of
/// a C# deconstruction assignment binds its REAL name directly in the native
/// G# `let (…)` — no `__deconN` temp plus re-declaration — when the local is
/// never reassigned and its declared type matches the deconstructed element.
/// </summary>
public class Issue3501DirectDeconstructionNamesTests
{
    [Fact]
    public void TypedAndVarSingleElements_BindDirectly()
    {
        string printed = Translate("""
            public class Runner
            {
                private (int, string) RunDotnet(string[] args) => (0, "ok");

                public bool Probe()
                {
                    (int probeExit, _) = this.RunDotnet(new[] { "tool", "run" });
                    var ok = probeExit == 0;
                    if (!ok)
                    {
                        (int restoreExit, _) = this.RunDotnet(new[] { "tool", "restore" });
                        ok = restoreExit == 0;
                    }

                    (var a, var b) = this.RunDotnet(new[] { "x" });
                    return ok && a == 0 && b.Length > 0;
                }
            }
            """);

        Assert.Contains("let (probeExit, _) = this.RunDotnet", printed, StringComparison.Ordinal);
        Assert.Contains("let (restoreExit, _) = this.RunDotnet", printed, StringComparison.Ordinal);
        Assert.Contains("let (a, b) = this.RunDotnet", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("__decon", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void WideningTypedElement_KeepsTheTemp()
    {
        // `long total` widens the int element — direct binding would change
        // the local's type, so the temp + re-declaration stays.
        string printed = Translate("""
            public class Runner
            {
                private (int, string) RunDotnet(string[] args) => (0, "ok");

                public long Probe()
                {
                    (long total, _) = this.RunDotnet(new[] { "x" });
                    return total;
                }
            }
            """);

        Assert.Contains("__decon", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string rendered = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(context.Diagnostics, d => d.Severity != TranslationSeverity.Info);
        return rendered;
    }
}
