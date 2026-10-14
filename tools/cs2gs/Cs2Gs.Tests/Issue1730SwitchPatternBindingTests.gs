// <copyright file="Issue1730SwitchPatternBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

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
/// Native G# property-pattern bindings now preserve those names directly in
/// the switch pattern, guard, and body, scoped per case/arm.
open class Issue1730SwitchPatternBindingTests {
    /// A switch-statement pattern label's `var` property binding must be
    /// preserved in the native G# pattern so the body reads the bound name.
    @Fact
    func SwitchStatement_RecursivePatternVarBinding_UsedInBody_UsesNativeBinding() {
        let printed = TranslateUnit(ShapesPrelude + `
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
}`)
        Assert.Contains("case Circle { Radius: var r }", printed)
        Assert.Contains("return r", printed)
        Assert.DoesNotContain("circle.Radius", printed)
    }

    /// A switch-statement pattern label's `when` guard must also see the
    /// pattern's own bindings (the guard and the body share the same
    /// installed scope).
    @Fact
    func SwitchStatement_RecursivePatternVarBinding_UsedInGuard_UsesNativeBinding() {
        let printed = TranslateUnit(ShapesPrelude + `
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
}`)
        Assert.Contains("case Circle { Radius: var r } when r > 0", printed)
        Assert.Contains("return r", printed)
        Assert.DoesNotContain("circle.Radius", printed)
    }

    /// A switch-expression arm's `when` guard must be translated AFTER the
    /// arm's pattern bindings are installed, so a guard referencing the bound
    /// variable (`Circle { Radius: var r } when r > 0 => ...`) sees it in
    /// scope, exactly like the arm's result expression does.
    @Fact
    func SwitchExpression_RecursivePatternVarBinding_GuardAndResult_BothSeeBinding() {
        let printed = TranslateUnit(ShapesPrelude + `
    public static class Shapes
    {
        public static int Describe(Shape shape) => shape switch
        {
            Circle { Radius: var r } when r > 0 => r,
            _ => 0,
        };
    }
}`)
        Assert.Contains("case Circle { Radius: var r } when r > 0: r", printed)
        Assert.DoesNotContain("circle.Radius", printed)
    }

    /// Distinct sections in the same switch statement each carry their own
    /// pattern binding, and each section's binding must not leak into a
    /// sibling section's body.
    @Fact
    func SwitchStatement_MultipleSections_EachInstallsOwnBindingWithoutLeaking() {
        let printed = TranslateUnit(ShapesPrelude + `
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
}`)
        Assert.Contains("case Circle { Radius: var r }", printed)
        Assert.Contains("case Square { Side: var r }", printed)
        Assert.Contains("return r", printed)
        Assert.DoesNotContain("circle.Radius", printed)
        Assert.DoesNotContain("square.Side", printed)
    }

    @Fact
    func TypedPropertyConstraints_LowerToArmGuards() {
        let printed = TranslateUnit(ShapesPrelude + `
    public class Center
    {
        public int X;
    }

    public class DetailedCircle : Shape
    {
        public int Radius;
        public Center Center;
    }

    public static class Shapes
    {
        public static int Describe(Shape shape)
        {
            switch (shape)
            {
                case DetailedCircle { Radius: > 0, Center.X: 0 }:
                    return 1;
                default:
                    return 0;
            }
        }
    }
}`)
        Assert.Contains("case detailedCircle is DetailedCircle when", printed)
        Assert.Contains("detailedCircle.Radius > 0", printed)
        Assert.Contains("detailedCircle.Center.X == 0", printed)
    }

    shared {
        private const ShapesPrelude string = `
namespace Demo
{
    public class Shape { }

    public class Circle : Shape
    {
        public int Radius;
    }
`

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
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
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
    }
}
