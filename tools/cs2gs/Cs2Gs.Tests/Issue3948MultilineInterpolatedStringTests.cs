// <copyright file="Issue3948MultilineInterpolatedStringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Globalization;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3948: multiline interpolated strings must keep their line structure
/// without changing interpolation semantics.
/// </summary>
public sealed class Issue3948MultilineInterpolatedStringTests
{
    [Fact]
    public void MultilineInterpolation_UsesRawLiteralRunsAndQuotedHoles()
    {
        string printed = Translate(FixtureSource);

        Assert.Contains("`head ` + \"\\u0060\" + `{} $", printed, StringComparison.Ordinal);
        Assert.Contains("\"${Next(),7:F1}\"", printed, StringComparison.Ordinal);
        Assert.Contains("\"${Next(),-7:F1}\"", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("\\n", printed, StringComparison.Ordinal);
        Assert.All(
            printed.Split('\n'),
            line => Assert.True(line.Length <= 300, "Unexpected long line: " + line));
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void MultilineInterpolation_PreservesValueCultureFormattingAndEvaluationOrder()
    {
        string printed = Translate(FixtureSource);
        string program = printed + """

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fr-FR")
let value = Demo.Fixture.Render()
System.Console.Write(System.Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(value)))
""";

        CultureInfo originalCulture = CultureInfo.CurrentCulture;
        EmittedOracleResult result;
        try
        {
            result = EmittedOracle.Evaluate(new[] { program });
        }
        finally
        {
            CultureInfo.CurrentCulture = originalCulture;
        }

        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(0, result.ExitCode);

        string expected = "head `{} $\nleft=    0,5 middle=1,0    \ntail";
        Assert.Equal(
            Convert.ToBase64String(Encoding.UTF8.GetBytes(expected)),
            result.Output);
    }

    private const string FixtureSource = """""
        using System.Globalization;

        namespace Demo
        {
            public static class Fixture
            {
                private static int sequence;

                private static double Next()
                {
                    sequence++;
                    return sequence / 2.0;
                }

                public static string Render()
                {
                    return $$"""
                    head `{} $
                    left={{Next(),7:F1}} middle={{Next(),-7:F1}}
                    tail
                    """;
                }
            }
        }
        """"";

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
