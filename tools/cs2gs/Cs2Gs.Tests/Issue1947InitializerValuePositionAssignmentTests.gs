// <copyright file="Issue1947InitializerValuePositionAssignmentTests.cs" company="GSharp">
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

/// Regression tests for assignments nested in initializer values. ADR-0161
/// keeps genuine value-position assignments inline while object-initializer
/// member syntax remains structural.
open class Issue1947InitializerValuePositionAssignmentTests {
    @Fact
    func ObjectInitializerMemberValue_EmbeddedAssignment_RemainsInline() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Widget
    {
        public int A { get; set; }
    }

    public sealed class C
    {
        public void M()
        {
            int x = 0;
            Widget w = new Widget { A = (x = 3) };
            System.Console.WriteLine(w.A);
            System.Console.WriteLine(x);
        }
    }
}`)
        Assert.Contains("Widget{A: (x = 3)}", printed, StringComparison.Ordinal)
    }

    @Fact
    func ArrayInitializerElement_EmbeddedAssignment_RemainsInline() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            int x = 0;
            int[] values = new int[] { x = 5, 2 };
            System.Console.WriteLine(values[0]);
            System.Console.WriteLine(x);
        }
    }
}`)
        Assert.Contains("[]int32{(x = 5), 2}", printed, StringComparison.Ordinal)
    }

    @Fact
    func DictionaryIndexInitializerElement_EmbeddedAssignment_RemainsInline() {
        // `["k"] = value` (a C# 6 index/collection initializer) is also an
        // `AssignmentExpressionSyntax` initializer element, but its LHS is an
        // implicit ELEMENT access, not the identifier-member shape, so it is a
        // genuine value-position assignment candidate like the array case
        // above (`new List<int> { x = 5 }` from the issue does not actually
        // compile — the parser always treats an `Identifier = Value` element
        // as an object-initializer member set, regardless of the target
        // type's shape).
        let printed = TranslateUnit(`
using System.Collections.Generic;

namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            int x = 0;
            Dictionary<string, int> values = new Dictionary<string, int> { ["k"] = (x = 5) };
            System.Console.WriteLine(values["k"]);
            System.Console.WriteLine(x);
        }
    }
}`)
        Assert.Contains("[\"k\"] = (x = 5)", printed, StringComparison.Ordinal)
    }

    @Fact
    func NestedObjectInitializer_EmbeddedAssignmentInInnerMemberValue_RemainsInline() {
        // A genuine assignment nested two initializer levels deep (inside the
        // VALUE of another object-initializer member) must still be found —
        // the fix must not stop at the first initializer member boundary.
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class Inner
    {
        public int A { get; set; }
    }

    public sealed class Outer
    {
        public Inner Nested { get; set; }
    }

    public sealed class C
    {
        public void M()
        {
            int x = 0;
            Outer o = new Outer { Nested = new Inner { A = (x = 7) } };
            System.Console.WriteLine(o.Nested.A);
            System.Console.WriteLine(x);
        }
    }
}`)
        Assert.Contains("Inner{A: (x = 7)}", printed, StringComparison.Ordinal)
    }

    /// The #1892 fix (a plain `Field = value` member emits no stray
    /// assignment statement) must still hold once the #1947 fix descends
    /// into initializer values.
    @Fact
    func ObjectInitializerPlainMember_StillEmitsNoStrayAssignmentStatement() {
        let printed = TranslateUnit(`
namespace Demo
{
    public sealed class ProfileCard
    {
        public string Name { get; set; }
    }

    public sealed class C
    {
        public void M()
        {
            ProfileCard card = new ProfileCard { Name = "ada" };
            System.Console.WriteLine(card.Name);
        }
    }
}`)
        let hasStrayLine = Array.Exists(
            printed.Split(Environment.NewLine),
            (line string) -> line.Trim() == "Name = \"ada\""
        )
        Assert.False(hasStrayLine, (`Found stray bare assignment statement in:
` + "$printed"))
        Assert.Contains("ProfileCard{Name: \"ada\"}", printed)
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
    }
}
