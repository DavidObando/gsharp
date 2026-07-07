// <copyright file="Issue2224AnonymousObjectCreationTests.cs" company="GSharp">
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
/// Regression tests for issue #2224: a C# anonymous object creation
/// (<c>new { A = 1 }</c>) previously lowered to a positional G# tuple literal
/// (issue #1934), which dropped member names (<c>x.A</c> rewritten to
/// <c>x.Item1</c>) and — critically for EF Core migrations — made the value
/// illegal inside expression-tree lambdas (GS0473, tuple literals are
/// restricted there). It now lowers to a first-class G# anonymous-class
/// literal, <c>interface { A = 1 }</c>, which preserves member names and is
/// legal inside expression trees, exactly like C#'s <c>new { ... }</c> is.
/// </summary>
public class Issue2224AnonymousObjectCreationTests
{
    [Fact]
    public void AnonymousObjectCreation_SingleMember_LowersToAnonymousClassLiteral()
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

        Assert.Contains("return interface { A = 1 }", printed);
    }

    [Fact]
    public void AnonymousObjectCreation_MultipleMembers_LowersToAnonymousClassLiteralAndPreservesMemberNames()
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

        Assert.Contains("interface { A = 1, B = \"two\" }", printed);
        Assert.Contains("pair.A", printed);
        Assert.Contains("pair.B", printed);
        Assert.DoesNotContain("Item1", printed);
        Assert.DoesNotContain("Item2", printed);
    }

    [Fact]
    public void AnonymousObjectCreation_NullableEnabledMemberAccess_DoesNotEmitNonNullAssertion()
    {
        // Regression test: under `#nullable enable`, an anonymous-typed local
        // is a flow-proven-non-null C# reference type, which the general
        // member-access path would wrap in a G# `!!` non-null assertion. The
        // receiver lowers to a G# anonymous-class literal (a synthesized
        // value type that can never be null), so `!!` on it is both
        // meaningless and hits a gsc IL-emission gap (StackUnexpected) for
        // value-type receivers.
        string printed = TranslateUnit(@"
#nullable enable
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

        Assert.Contains("interface { A = 1, B = \"two\" }", printed);
        Assert.Contains("pair.A", printed);
        Assert.Contains("pair.B", printed);
        Assert.DoesNotContain("pair!!", printed);
    }

    [Fact]
    public void AnonymousObjectCreation_MemberNameInference_UsesSourceIdentifier()
    {
        // C# infers the projected member name from a bare identifier or the
        // last segment of a member access when no `Name =` is given
        // (`new { x.Id }` names the member `Id`) — the same rule the anonymous
        // class literal's member name must follow.
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Row
    {
        public int Id;
    }

    public sealed class C
    {
        public object M(Row row)
        {
            int id = row.Id;
            return new { id, row.Id };
        }
    }
}");

        Assert.Contains("interface { id = id, Id = row.Id }", printed);
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
