// <copyright file="Issue3501ResidualSyntheticRetargetTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501 residual-synthetic burn-down: <c>goto default</c> to a
/// do-nothing arm prints as a native <c>break</c> (no <c>__gotoDefault</c>
/// label pair), and an implicit C# <c>in</c> argument to a source-declared
/// method gains the modifier G# requires (GS0242 is an error).
/// </summary>
public class Issue3501ResidualSyntheticRetargetTests
{
    [Fact]
    public void GotoDefault_ToEmptyBreakArm_PrintsAsBreak()
    {
        string printed = Translate("""
            public class C
            {
                public static int Route(int value, bool bail)
                {
                    switch (value)
                    {
                        case 1:
                            if (bail)
                            {
                                goto default;
                            }

                            return 10;
                        case 2:
                            return 20;
                        default:
                            break;
                    }

                    return -1;
                }
            }
            """);

        Assert.DoesNotContain("__gotoDefault", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("goto ", printed, StringComparison.Ordinal);
        Assert.Contains("break", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void GotoDefault_InsideLoop_KeepsTheLabelLowering()
    {
        // A bare `break` in the goto's position would exit the inner loop,
        // not the switch, so the synthesized label pair stays.
        string printed = Translate("""
            public class C
            {
                public static int Route(int value)
                {
                    switch (value)
                    {
                        case 1:
                            for (int i = 0; i < 3; i++)
                            {
                                goto default;
                            }

                            return 10;
                        default:
                            break;
                    }

                    return -1;
                }
            }
            """);

        Assert.Contains("__gotoDefault", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ImplicitInArgument_ToSourceDeclaredMethod_GainsTheModifier()
    {
        string printed = Translate("""
            public class C
            {
                private static int Scale(in int factor) => factor * 2;

                public static int Run()
                {
                    int x = 3;
                    return Scale(x);
                }
            }
            """);

        Assert.Contains("Scale(in x)", printed, StringComparison.Ordinal);
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
