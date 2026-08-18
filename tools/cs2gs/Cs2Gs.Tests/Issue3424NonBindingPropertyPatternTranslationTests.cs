// <copyright file="Issue3424NonBindingPropertyPatternTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3424: non-binding property patterns over implicit property or field
/// receivers must use native G# patterns because gsc does not smart-cast members.
/// </summary>
public sealed class Issue3424NonBindingPropertyPatternTranslationTests
{
    private const string Symbols = """
        namespace Demo
        {
            public abstract class BoundPattern
            {
            }

            public sealed class BoundTypePattern : BoundPattern
            {
                public object? PropertyPattern { get; init; }
                public bool HasBinding { get; init; }
            }
        """;

    [Fact]
    public void ImplicitPropertyReceiver_UsesNativePatternAndEvaluatesOnce()
    {
        string printed = Translate(
            Symbols + """
            public sealed class C
            {
                private readonly BoundPattern pattern =
                    new BoundTypePattern { PropertyPattern = null, HasBinding = false };
                private int reads;

                private BoundPattern Pattern
                {
                    get
                    {
                        reads++;
                        return pattern;
                    }
                }

                public int Run()
                {
                    bool matched = Pattern is BoundTypePattern
                    {
                        PropertyPattern: null,
                        HasBinding: false,
                    };
                    return matched ? reads : -1;
                }
                }
            }
            """);

        Assert.Contains(
            "Pattern is BoundTypePattern and { PropertyPattern: nil, HasBinding: false }",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("Pattern.PropertyPattern", printed, StringComparison.Ordinal);
        LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "Console.WriteLine(C().Run())",
            "1");
    }

    [Fact]
    public void ImplicitFieldReceiver_UsesNativePatternAndBinds()
    {
        string printed = Translate(
            Symbols + """
            public sealed class C
            {
                private readonly BoundPattern pattern =
                    new BoundTypePattern { PropertyPattern = null, HasBinding = false };

                public bool IsSimple =>
                    pattern is BoundTypePattern
                    {
                        PropertyPattern: null,
                        HasBinding: false,
                    };
                }
            }
            """);

        Assert.Contains(
            "pattern is BoundTypePattern and { PropertyPattern: nil, HasBinding: false }",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain("pattern.PropertyPattern", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        string printed = GSharpPrinter.Print(
            new CSharpToGSharpTranslator().TranslateDocument(document, context));
        Assert.DoesNotContain(
            context.Diagnostics,
            diagnostic => diagnostic.Severity != TranslationSeverity.Info);
        TranslationTestValidation.AssertBinds(printed);
        return printed;
    }
}
