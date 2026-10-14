// <copyright file="Issue1741SilentDivergenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #1741: four SILENT-DIVERGENCE bugs where the translator either
/// altered the translated API surface or dropped information with no
/// diagnostic. Each case here either now translates faithfully or reports a
/// (cref:TranslationDiagnostic) (mirroring the existing
/// `protected internal` mapping at `MapVisibility`).
open class Issue1741SilentDivergenceTests {
    /// An accessor-level accessibility modifier (`{ get; private set; }`)
    /// must remain on the translated accessor.
    @Fact
    func PrivateSetAccessor_PreservesAccessibility() {
        let (unit, context) = Translate(`
namespace Demo
{
    public class C
    {
        public int X { get; private set; }
    }
}`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains(
                "narrower accessibility",
                StringComparison.OrdinalIgnoreCase
            )
        )
        Assert.Contains("private set", GSharpPrinter.Print(unit), StringComparison.Ordinal)
    }

    /// A protected get-accessor on a public property is preserved too.
    @Fact
    func ProtectedGetAccessor_PreservesAccessibility() {
        let (unit, context) = Translate(`
namespace Demo
{
    public class C
    {
        public int X { protected get; set; }
    }
}`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains(
                "narrower accessibility",
                StringComparison.OrdinalIgnoreCase
            )
        )
        Assert.Contains("protected get", GSharpPrinter.Print(unit), StringComparison.Ordinal)
    }

    /// A plain read-write auto-property with no accessor modifiers must not be
    /// flagged: there is nothing being narrowed.
    @Fact
    func PlainAutoProperty_NoAccessibilityLossDiagnostic() {
        let (_, context) = Translate(`
namespace Demo
{
    public class C
    {
        public int X { get; set; }
    }
}`)
        Assert.DoesNotContain(
            context.Diagnostics,
            (d TranslationDiagnostic) -> d.Message!!.Contains(
                "narrower accessibility",
                StringComparison.OrdinalIgnoreCase
            )
        )
    }

    /// An attribute on a field-like event must round-trip into the printed
    /// G#, not vanish.
    @Fact
    func EventAttribute_TranslatesFaithfully() {
        let (unit, _) = Translate(`
using System;

namespace Demo
{
    public class C
    {
        [Obsolete]
        public event EventHandler X;
    }
}`)
        let type = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "C")
        let ev = type.Members.OfType[EventDeclaration]().Single((e EventDeclaration) -> e.Name == "X")
        Assert.Single(ev.Attributes)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("Obsolete", printed, StringComparison.Ordinal)
    }

    /// An attribute on a finalizer must round-trip into the printed G#, not
    /// vanish.
    @Fact
    func FinalizerAttribute_TranslatesFaithfully() {
        let (unit, _) = Translate(`
using System;

namespace Demo
{
    public class C
    {
        [Obsolete]
        ~C() { }
    }
}`)
        let type = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "C")
        let destructor = type.Members.OfType[DestructorDeclaration]().Single()
        Assert.Single(destructor.Attributes)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("Obsolete", printed, StringComparison.Ordinal)
    }

    /// A user class literally named `Enum` must keep its own base clause;
    /// the old fragile string-name guard (`csBase.Name != "Enum"`) dropped
    /// it purely because of the name match.
    @Fact
    func UserClassNamedEnum_KeepsBaseClause() {
        let (unit, _) = Translate(`
namespace Demo
{
    public class Enum
    {
    }

    public class Foo : Enum
    {
    }
}`)
        let foo = unit.Members.OfType[TypeDeclaration]().Single((t TypeDeclaration) -> t.Name == "Foo")
        Assert.NotNull(foo.BaseType)
    }

    /// A real local variable named `_` is a genuine assignment target in
    /// C#; the old name-based discard check dropped the assignment even
    /// though `_` here is a real variable in scope, not
    /// (cref:Microsoft.CodeAnalysis.IDiscardSymbol).
    @Fact
    func RealVariableNamedUnderscore_AssignmentIsPreserved() {
        let (unit, _) = Translate(`
namespace Demo
{
    public class C
    {
        public void M()
        {
            int _ = 0;
            _ = 5;
        }
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("_ = 5", printed, StringComparison.Ordinal)
    }

    /// A genuine C# discard (`_ = e;` with no `_` variable in scope)
    /// must still drop the assignment target and preserve RHS evaluation.
    @Fact
    func TrueDiscard_StillDropsAssignment() {
        let (unit, _) = Translate(`
namespace Demo
{
    public class C
    {
        public int Next() => 1;

        public void M()
        {
            _ = Next();
        }
    }
}`)
        let printed = GSharpPrinter.Print(unit)
        Assert.Contains("let _ = Next()", printed, StringComparison.Ordinal)
    }

    shared {
        private func Translate(source string)(Unit CompilationUnit, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return (unit, context)
        }
    }
}
