// <copyright file="LocalFunctionHoistTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for C# local functions. C# local functions are
/// hoisted (callable before their lexical declaration), but G# renders them as
/// <c>let name = func(...)</c> bindings, which are not hoisted and cannot be
/// forward-referenced (GS0130). When a local function is called before its
/// declaration, the translator moves its declaration to the top of the block —
/// unless it captures a sibling local declared in the same block (G# closures
/// require captured locals to already be in scope at the binding point).
/// </summary>
public class LocalFunctionHoistTranslationTests
{
    [Fact]
    public void LocalFunctionCalledBeforeDeclaration_IsHoistedToTop()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int Field;
        public void M(int input)
        {
            if (input > 0)
            {
                Helper(input);
            }
            else
            {
                Helper(0);
            }

            void Helper(int x)
            {
                Field = x;
            }
        }
    }
}");

        // The `let Helper = func ...` binding must precede the first call site.
        int declIndex = printed.IndexOf("let Helper", StringComparison.Ordinal);
        int callIndex = printed.IndexOf("Helper(input)", StringComparison.Ordinal);
        Assert.True(declIndex >= 0, "Local function should be emitted as a let binding.\n" + printed);
        Assert.True(callIndex >= 0, "Call site should be present.\n" + printed);
        Assert.True(
            declIndex < callIndex,
            "Local function declaration must be hoisted above its first use.\n" + printed);
    }

    [Fact]
    public void LocalFunctionCapturingSiblingLocal_IsNotHoisted()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int M()
        {
            int seed = 5;
            int result = Helper();

            int Helper()
            {
                return seed + 1;
            }

            return result;
        }
    }
}");

        // Hoisting would move `let Helper` above `let seed`, breaking the capture,
        // so the declaration must stay after the sibling local it captures.
        int seedIndex = printed.IndexOf("let seed", StringComparison.Ordinal);
        int declIndex = printed.IndexOf("let Helper", StringComparison.Ordinal);
        Assert.True(seedIndex >= 0 && declIndex >= 0, "Both bindings should be present.\n" + printed);
        Assert.True(
            seedIndex < declIndex,
            "Local function capturing a sibling local must not be hoisted above it.\n" + printed);
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
