// <copyright file="Issue1934AnonymousObjectCreationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1934: a C# anonymous object creation
/// (<c>new { A = 1 }</c>) previously had no G# mapping and hit the
/// "no canonical G# form yet" placeholder. G# has no anonymous types, but an
/// anonymous object's shape is exactly its ordered member list, which is the
/// same shape a G# tuple has (ADR-0115 §B.4, already used for C# named
/// tuples) — so the anonymous object lowers to a positional tuple literal,
/// and a named member access on it lowers to the matching positional
/// <c>.ItemN</c>.
/// </summary>
public class Issue1934AnonymousObjectCreationTests
{
    [Fact]
    public void AnonymousObjectCreation_SingleMember_LowersToTupleLiteral()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public object M()
        {
            return new { A = 1 };
        }
    }
}");

        Assert.Contains("return (1)", printed);
    }

    [Fact]
    public void AnonymousObjectCreation_MultipleMembers_LowersToTupleLiteralAndPositionalAccess()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            var pair = new { A = 1, B = ""two"" };
            System.Console.WriteLine(pair.A);
            System.Console.WriteLine(pair.B);
        }
    }
}");

        Assert.Contains("(1, \"two\")", printed);
        Assert.Contains("pair.Item1", printed);
        Assert.Contains("pair.Item2", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(System.Environment.NewLine, project.ErrorDiagnostics));

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
