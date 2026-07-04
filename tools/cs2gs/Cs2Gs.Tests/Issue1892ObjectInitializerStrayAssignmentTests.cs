// <copyright file="Issue1892ObjectInitializerStrayAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for issue #1892: every member of the C# object-initializer
/// family (plain object initializer, <c>with</c>-expression, <c>required</c>
/// member, <c>init</c>-accessor target, and constructor-args-plus-initializer)
/// was ALSO walked by <see cref="CSharpToGSharpTranslator"/>'s embedded-
/// assignment hoist (issue #1723's `M(x = 5)` seam) as if each
/// `Field = value` member were a genuine value-position assignment, emitting a
/// stray bare `Field = value;` statement in front of the (correct) composite
/// literal/with-expression. The hoist's descend guard now stops at any
/// <see cref="Microsoft.CodeAnalysis.CSharp.Syntax.InitializerExpressionSyntax"/>
/// (object/with/collection initializer), since none of its `Field = value`
/// elements are real assignments to hoist.
/// </summary>
public class Issue1892ObjectInitializerStrayAssignmentTests
{
    [Fact]
    public void ObjectInitializer_PlainMembers_EmitsNoStrayAssignmentStatement()
    {
        string printed = TranslateUnit(@"
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
            ProfileCard card = new ProfileCard { Name = ""ada"", Age = 36 };
            System.Console.WriteLine(card.Name);
        }
    }
}");

        AssertNoStandaloneAssignmentLine(printed, "Name = \"ada\"");
        AssertNoStandaloneAssignmentLine(printed, "Age = 36");
        Assert.Contains("ProfileCard{Name: \"ada\", Age: 36}", printed);
    }

    [Fact]
    public void WithExpression_EmitsNoStrayAssignmentStatement()
    {
        string printed = TranslateUnit(@"
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
}");

        AssertNoStandaloneAssignmentLine(printed, "Y = 9");
        Assert.Contains("first with { Y = 9 }", printed);
    }

    [Fact]
    public void RequiredMemberInitializer_EmitsNoStrayAssignmentStatement()
    {
        string printed = TranslateUnit(@"
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
            return new ProfileCard { Name = ""ada"" };
        }
    }
}");

        AssertNoStandaloneAssignmentLine(printed, "Name = \"ada\"");
        Assert.Contains("ProfileCard{Name: \"ada\"}", printed);
    }

    [Fact]
    public void InitAccessorTarget_EmitsNoStrayAssignmentStatement()
    {
        string printed = TranslateUnit(@"
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
            return new ProfileCard { Name = ""ada"" };
        }
    }
}");

        AssertNoStandaloneAssignmentLine(printed, "Name = \"ada\"");
        Assert.Contains("ProfileCard{Name: \"ada\"}", printed);
    }

    [Fact]
    public void ConstructorArgsPlusInitializer_EmitsNoStrayAssignmentAndRendersParseableComposite()
    {
        string printed = TranslateUnit(@"
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
}");

        AssertNoStandaloneAssignmentLine(printed, "Y = 8");
        Assert.Contains("GridPoint(9, 0){Y = 8}", printed);
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

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    // A bare semicolon-free check for "Field = value" would also match that
    // exact text as a substring of the (correct) composite-literal/with-
    // expression rendering elsewhere in the same line — asserting on the full
    // trimmed LINE is the only way to catch a genuine stray top-level
    // assignment STATEMENT without false-negatives against the correct form.
    private static void AssertNoStandaloneAssignmentLine(string printed, string assignmentText)
    {
        bool hasStrayLine = printed
            .Split('\n')
            .Any(line => line.Trim() == assignmentText);
        Assert.False(hasStrayLine, $"Found stray bare assignment statement '{assignmentText}' in:\n{printed}");
    }
}
