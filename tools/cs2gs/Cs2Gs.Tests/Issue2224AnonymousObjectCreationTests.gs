// <copyright file="Issue2224AnonymousObjectCreationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Text.RegularExpressions
import Xunit

/// Regression tests for issue #2224: a C# anonymous object creation
/// (`new { A = 1 }`) previously lowered to a positional G# tuple literal
/// (issue #1934), which dropped member names (`x.A` rewritten to
/// `x.Item1`) and — critically for EF Core migrations — made the value
/// illegal inside expression-tree lambdas (GS0473, tuple literals are
/// restricted there). #2224 replaced that with a first-class G#
/// anonymous-class literal, `object { let A int32 = 1 }`. Issue #2282
/// found that the `object { }` literal has no corresponding TYPE
/// ANNOTATION spelling (it is only a value-literal expression form), so it
/// cannot express an anonymous type that crosses a real type boundary — e.g.
/// an EF-Core-style `CreateTable`/`PrimaryKey` shape where the same
/// anonymous type is inferred as a generic type argument in one lambda and
/// then spelled as another lambda's parameter type. #2282 therefore
/// supersedes the `object { }` lowering with a synthesized,
/// shape-deduplicated `data class` (`AnonymousType1_hash(1)`), which
/// is nameable at both the construction site and any type-position use, and
/// still preserves member names and legality inside expression trees (named
/// class construction is permitted there, unlike a tuple literal).
open class Issue2224AnonymousObjectCreationTests {
    @Fact
    func AnonymousObjectCreation_SingleMember_LowersToSynthesizedDataClassLiteral() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public object M()
        {
            return new { A = 1 };
        }
    }
}`)
        let name = AnonymousTypeName(printed)
        Assert.Contains("return $name(1)", printed)
        Assert.Contains("data class $name(A int32)", printed)
    }

    @Fact
    func AnonymousObjectCreation_MultipleMembers_LowersToSynthesizedDataClassAndPreservesMemberNames() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            var pair = new { A = 1, B = "two" };
            System.Console.WriteLine(pair.A);
            System.Console.WriteLine(pair.B);
        }
    }
}`)
        let name = AnonymousTypeName(printed)
        Assert.Contains("$name(1, \"two\")", printed)
        Assert.Contains("data class $name(A int32, B string)", printed)
        Assert.Contains("pair.A", printed)
        Assert.Contains("pair.B", printed)
        Assert.DoesNotContain("Item1", printed)
        Assert.DoesNotContain("Item2", printed)
    }

    @Fact
    func AnonymousObjectCreation_NullableEnabledMemberAccess_DoesNotEmitNonNullAssertion() {
        // Regression test: under `#nullable enable`, an anonymous-typed local
        // is a flow-proven-non-null C# reference type, which the general
        // member-access path would wrap in a G# `!!` non-null assertion. A
        // freshly-constructed anonymous-type value can never itself be null,
        // so `!!` on it would be meaningless — the translator skips
        // forgiveness for anonymous-type receivers.
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            var pair = new { A = 1, B = "two" };
            System.Console.WriteLine(pair.A);
            System.Console.WriteLine(pair.B);
        }
    }
}`)
        Assert.Contains("${AnonymousTypeName(printed)}(1, \"two\")", printed)
        Assert.Contains("pair.A", printed)
        Assert.Contains("pair.B", printed)
        Assert.DoesNotContain("pair!!", printed)
    }

    @Fact
    func AnonymousObjectCreation_MemberNameInference_UsesSourceIdentifier() {
        // C# infers the projected member name from a bare identifier or the
        // last segment of a member access when no `Name =` is given
        // (`new { x.Id }` names the member `Id`) — the same rule the
        // synthesized data class's primary-constructor parameter name must
        // follow.
        let printed = TranslateUnit(`
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
}`)
        let name = AnonymousTypeName(printed)
        Assert.Contains("$name(id, row.Id)", printed)
        Assert.Contains("data class $name(id int32, Id int32)", printed)
    }

    @Fact
    func AnonymousObjectCreation_IdenticalShapesAcrossSite_ReuseSameSynthesizedDataClass() {
        // Issue #2282: two structurally-identical anonymous types declared in
        // different places must share ONE synthesized data class — a
        // per-occurrence synthesis would combinatorially explode across a
        // large file (17+ occurrences were reported in the originating
        // Oahu.Data migration files).
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public object M1()
        {
            return new { A = 1, B = "x" };
        }

        public object M2()
        {
            return new { A = 2, B = "y" };
        }
    }
}`)
        let name = AnonymousTypeName(printed)
        Assert.Contains("$name(1, \"x\")", printed)
        Assert.Contains("$name(2, \"y\")", printed)
        var declarationCount = 0
        var index = 0
        while (index = printed.IndexOf("data class $name(", index, StringComparison.Ordinal)) >= 0 {
            declarationCount++
            index++
        }
        Assert.Equal(1, declarationCount)
    }

    shared {
        private func AnonymousTypeName(printed string) string -> Regex
            .Match(printed, "data class (AnonymousType\\d+_[0-9A-F]{16})\\(")
            .Groups[1]
            .Value

        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
