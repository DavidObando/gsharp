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
/// restricted there). #2224 replaced that with a first-class G#
/// anonymous-class literal, <c>object { let A int32 = 1 }</c>. Issue #2282
/// found that the <c>object { }</c> literal has no corresponding TYPE
/// ANNOTATION spelling (it is only a value-literal expression form), so it
/// cannot express an anonymous type that crosses a real type boundary — e.g.
/// an EF-Core-style <c>CreateTable</c>/<c>PrimaryKey</c> shape where the same
/// anonymous type is inferred as a generic type argument in one lambda and
/// then spelled as another lambda's parameter type. #2282 therefore
/// supersedes the <c>object { }</c> lowering with a synthesized,
/// shape-deduplicated <c>data class</c> (<c>AnonymousType1_hash(1)</c>), which
/// is nameable at both the construction site and any type-position use, and
/// still preserves member names and legality inside expression trees (named
/// class construction is permitted there, unlike a tuple literal).
/// </summary>
public class Issue2224AnonymousObjectCreationTests
{
    [Fact]
    public void AnonymousObjectCreation_SingleMember_LowersToSynthesizedDataClassLiteral()
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

    string name = AnonymousTypeName(printed);
    Assert.Contains($"return {name}(1)", printed);
    Assert.Contains($"data class {name}(A int32)", printed);
    }

    [Fact]
    public void AnonymousObjectCreation_MultipleMembers_LowersToSynthesizedDataClassAndPreservesMemberNames()
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

        string name = AnonymousTypeName(printed);
        Assert.Contains($"{name}(1, \"two\")", printed);
        Assert.Contains($"data class {name}(A int32, B string)", printed);
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
        // member-access path would wrap in a G# `!!` non-null assertion. A
        // freshly-constructed anonymous-type value can never itself be null,
        // so `!!` on it would be meaningless — the translator skips
        // forgiveness for anonymous-type receivers.
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

        Assert.Contains($"{AnonymousTypeName(printed)}(1, \"two\")", printed);
        Assert.Contains("pair.A", printed);
        Assert.Contains("pair.B", printed);
        Assert.DoesNotContain("pair!!", printed);
    }

    [Fact]
    public void AnonymousObjectCreation_MemberNameInference_UsesSourceIdentifier()
    {
        // C# infers the projected member name from a bare identifier or the
        // last segment of a member access when no `Name =` is given
        // (`new { x.Id }` names the member `Id`) — the same rule the
        // synthesized data class's primary-constructor parameter name must
        // follow.
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

        string name = AnonymousTypeName(printed);
        Assert.Contains($"{name}(id, row.Id)", printed);
        Assert.Contains($"data class {name}(id int32, Id int32)", printed);
    }

    [Fact]
    public void AnonymousObjectCreation_IdenticalShapesAcrossSite_ReuseSameSynthesizedDataClass()
    {
        // Issue #2282: two structurally-identical anonymous types declared in
        // different places must share ONE synthesized data class — a
        // per-occurrence synthesis would combinatorially explode across a
        // large file (17+ occurrences were reported in the originating
        // Oahu.Data migration files).
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public object M1()
        {
            return new { A = 1, B = ""x"" };
        }

        public object M2()
        {
            return new { A = 2, B = ""y"" };
        }
    }
}");

        string name = AnonymousTypeName(printed);
        Assert.Contains($"{name}(1, \"x\")", printed);
        Assert.Contains($"{name}(2, \"y\")", printed);

        int declarationCount = 0;
        int index = 0;
        while ((index = printed.IndexOf($"data class {name}(", index, System.StringComparison.Ordinal)) >= 0)
        {
            declarationCount++;
            index++;
        }

        Assert.Equal(1, declarationCount);
    }

    private static string AnonymousTypeName(string printed) =>
        System.Text.RegularExpressions.Regex.Match(
            printed,
            @"data class (AnonymousType\d+_[0-9A-F]{16})\(").Groups[1].Value;

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
