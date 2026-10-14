// <copyright file="Issue1892ObjectInitializerStrayAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Regression tests for issue #1892: every member of the C# object-initializer
/// family (plain object initializer, `with`-expression, `required`
/// member, `init`-accessor target, and constructor-args-plus-initializer)
/// was ALSO walked by (cref:CSharpToGSharpTranslator)'s embedded-
/// assignment hoist (issue #1723's `M(x = 5)` seam) as if each
/// `Field = value` member were a genuine value-position assignment, emitting a
/// stray bare `Field = value;` statement in front of the (correct) composite
/// literal/with-expression. The hoist's descend guard now stops at any
/// (cref:Microsoft.CodeAnalysis.CSharp.Syntax.InitializerExpressionSyntax)
/// (object/with/collection initializer), since none of its `Field = value`
/// elements are real assignments to hoist.
open class Issue1892ObjectInitializerStrayAssignmentTests {
    @Fact
    func ObjectInitializer_PlainMembers_EmitsNoStrayAssignmentStatement() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class ProfileCard
    {
        public string Name { get; set; }
        public int Age { get; set; }
    }

    public sealed class C
    {
        public void M()
        {
            ProfileCard card = new ProfileCard { Name = "ada", Age = 36 };
            System.Console.WriteLine(card.Name);
        }
    }
}`)
        AssertNoStandaloneAssignmentLine(printed, "Name = \"ada\"")
        AssertNoStandaloneAssignmentLine(printed, "Age = 36")
        Assert.Contains("ProfileCard{Name: \"ada\", Age: 36}", printed)
    }

    @Fact
    func WithExpression_EmitsNoStrayAssignmentStatement() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed record Point(int X, int Y);

    public sealed class C
    {
        public Point M(Point first)
        {
            return first with { Y = 9 };
        }
    }
}`)
        AssertNoStandaloneAssignmentLine(printed, "Y = 9")
        Assert.Contains("first with { Y = 9 }", printed)
    }

    @Fact
    func RequiredMemberInitializer_EmitsNoStrayAssignmentStatement() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class ProfileCard
    {
        public required string Name { get; set; }
    }

    public sealed class C
    {
        public ProfileCard M()
        {
            return new ProfileCard { Name = "ada" };
        }
    }
}`)
        AssertNoStandaloneAssignmentLine(printed, "Name = \"ada\"")
        Assert.Contains("ProfileCard{Name: \"ada\"}", printed)
    }

    @Fact
    func InitAccessorTarget_EmitsNoStrayAssignmentStatement() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class ProfileCard
    {
        public string Name { get; init; }
    }

    public sealed class C
    {
        public ProfileCard M()
        {
            return new ProfileCard { Name = "ada" };
        }
    }
}`)
        AssertNoStandaloneAssignmentLine(printed, "Name = \"ada\"")
        Assert.Contains("ProfileCard{Name: \"ada\"}", printed)
    }

    @Fact
    func ConstructorArgsPlusInitializer_EmitsNoStrayAssignmentAndRendersParseableComposite() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class GridPoint
    {
        public GridPoint(int x, int y)
        {
            X = x;
            Y = y;
        }

        public int X { get; set; }
        public int Y { get; set; }
    }

    public sealed class C
    {
        public GridPoint M()
        {
            return new GridPoint(9, 0) { Y = 8 };
        }
    }
}`)
        AssertNoStandaloneAssignmentLine(printed, "Y = 8")
        Assert.Contains("GridPoint(9, 0){Y = 8}", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
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

        // A bare semicolon-free check for "Field = value" would also match that
        // exact text as a substring of the (correct) composite-literal/with-
        // expression rendering elsewhere in the same line — asserting on the full
        // trimmed LINE is the only way to catch a genuine stray top-level
        // assignment STATEMENT without false-negatives against the correct form.
        private func AssertNoStandaloneAssignmentLine(printed string, assignmentText string) {
            let hasStrayLine = printed.Split(Environment.NewLine).Any((line string) -> line.Trim() == assignmentText)
            Assert.False(hasStrayLine, (`Found stray bare assignment statement '` + "$assignmentText" + `' in:
` + "$printed"))
        }
    }
}
