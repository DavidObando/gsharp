// <copyright file="Issue1730SwitchPatternBindingTests.cs" company="GSharp">
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
/// Issue #1730: two related pattern-binding ordering bugs.
///
/// (1) A switch-STATEMENT pattern label's bindings (`case Circle { Radius: var r }:`)
/// were computed and then discarded — the case body was translated before the
/// bindings were installed, so a reference to the bound variable in the body
/// resolved to a bare, undeclared name.
///
/// (2) A switch-EXPRESSION arm's `when` guard was translated before the arm's
/// pattern bindings were installed, so a guard referencing a bound variable
/// (`Circle { Radius: var r } when r > 0 => ...`) resolved it while still out
/// of scope.
///
/// Both are fixed by installing each pattern's bindings before translating
/// anything that can reference them (guard and body alike), scoped per
/// case/arm exactly like the existing `TranslateIf` condition-binding scope.
/// </summary>
public class Issue1730SwitchPatternBindingTests
{
    private const string ShapesPrelude = @"
namespace Demo
{
    public class Shape { }

    public class Circle : Shape
    {
        public int Radius;
    }
";

    /// <summary>
    /// A switch-statement pattern label's `var` property binding must be
    /// installed before the case body is translated, so a body reference to
    /// the bound variable resolves to the rewritten member access instead of a
    /// bare, undeclared name.
    /// </summary>
    [Fact]
    public void SwitchStatement_RecursivePatternVarBinding_UsedInBody_ResolvesToMemberAccess()
    {
        string printed = TranslateUnit(ShapesPrelude + @"
    public static class Shapes
    {
        public static int Describe(Shape shape)
        {
            switch (shape)
            {
                case Circle { Radius: var r }:
                    return r;
                default:
                    return 0;
            }
        }
    }
}");

        Assert.Contains("circle.Radius", printed);
        Assert.DoesNotContain("return r", printed);
    }

    /// <summary>
    /// A switch-statement pattern label's `when` guard must also see the
    /// pattern's own bindings (the guard and the body share the same
    /// installed scope).
    /// </summary>
    [Fact]
    public void SwitchStatement_RecursivePatternVarBinding_UsedInGuard_ResolvesToMemberAccess()
    {
        string printed = TranslateUnit(ShapesPrelude + @"
    public static class Shapes
    {
        public static int Describe(Shape shape)
        {
            switch (shape)
            {
                case Circle { Radius: var r } when r > 0:
                    return r;
                default:
                    return 0;
            }
        }
    }
}");

        Assert.Contains("when circle.Radius > 0", printed);
        Assert.Contains("circle.Radius", printed);
        Assert.DoesNotContain("when r > 0", printed);
        Assert.DoesNotContain("return r", printed);
    }

    /// <summary>
    /// A switch-expression arm's `when` guard must be translated AFTER the
    /// arm's pattern bindings are installed, so a guard referencing the bound
    /// variable (`Circle { Radius: var r } when r > 0 => ...`) sees it in
    /// scope, exactly like the arm's result expression does.
    /// </summary>
    [Fact]
    public void SwitchExpression_RecursivePatternVarBinding_GuardAndResult_BothSeeBinding()
    {
        string printed = TranslateUnit(ShapesPrelude + @"
    public static class Shapes
    {
        public static int Describe(Shape shape) => shape switch
        {
            Circle { Radius: var r } when r > 0 => r,
            _ => 0,
        };
    }
}");

        Assert.Contains("when circle.Radius > 0", printed);
        Assert.Contains("circle.Radius", printed);
        Assert.DoesNotContain("when r > 0", printed);
        Assert.DoesNotContain("=> r,", printed);
    }

    /// <summary>
    /// Distinct sections in the same switch statement each carry their own
    /// pattern binding, and each section's binding must not leak into a
    /// sibling section's body.
    /// </summary>
    [Fact]
    public void SwitchStatement_MultipleSections_EachInstallsOwnBindingWithoutLeaking()
    {
        string printed = TranslateUnit(ShapesPrelude + @"
    public class Square : Shape
    {
        public int Side;
    }

    public static class Shapes
    {
        public static int Area(Shape shape)
        {
            switch (shape)
            {
                case Circle { Radius: var r }:
                    return r;
                case Square { Side: var r }:
                    return r;
                default:
                    return 0;
            }
        }
    }
}");

        Assert.Contains("circle.Radius", printed);
        Assert.Contains("square.Side", printed);
        Assert.DoesNotContain("return r", printed);
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
