// <copyright file="Issue3501GuardedDiscardArmTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3501: a guarded discard arm (<c>_ when g =&gt;</c>) rendered as
/// <c>default:</c>, silently DROPPING the guard and colliding with the
/// synthesized total arm (GS0169 "only one 'default' arm" — the
/// GSharp.GeneratorHost wall, GsStubRenderer's <c>EscapeChar</c>). The
/// spelling is <c>case _ when g:</c>; only an UNGUARDED discard folds to
/// <c>default</c>.
/// </summary>
public class Issue3501GuardedDiscardArmTests
{
    private const string EscapeSource = @"
using System.Globalization;

namespace N
{
    public static class C
    {
        public static string EscapeChar(char c) => c switch
        {
            '\n' => ""\\n"",
            _ when char.IsControl(c) => ""\\u"" + ((int)c).ToString(""x4"", CultureInfo.InvariantCulture),
            _ => c.ToString(),
        };
    }
}";

    [Fact]
    public void GuardedDiscardArm_KeepsItsGuard()
    {
        string g = Render(EscapeSource);

        Assert.Contains("case _ when char.IsControl(c):", g, StringComparison.Ordinal);
        Assert.Single(SplitOccurrences(g, "default:"));
    }

    [Fact]
    public void GuardedDiscardArm_TranslatedGSharp_CompilesAndBehaves()
    {
        string g = Render(EscapeSource);

        var result = EmittedOracle.Evaluate(
            new[] { g },
            new EmittedOracleOptions { IsLibrary = true });
        Assert.DoesNotContain(result.Diagnostics, diagnostic => diagnostic.IsError);
        Assert.Equal(0, result.ExitCode);
    }

    private static string[] SplitOccurrences(string haystack, string needle)
        => haystack.Split(needle, StringSplitOptions.None)[1..];

    private static string Render(string csharp)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", csharp) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
