// <copyright file="Issue1741SilentDivergenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1741: four SILENT-DIVERGENCE bugs where the translator either
/// altered the translated API surface or dropped information with no
/// diagnostic. Each case here either now translates faithfully or reports a
/// <see cref="TranslationDiagnostic"/> (mirroring the existing
/// <c>protected internal</c> mapping at <c>MapVisibility</c>).
/// </summary>
public class Issue1741SilentDivergenceTests
{
    /// <summary>
    /// An accessor-level accessibility modifier (<c>{ get; private set; }</c>)
    /// used to collapse to the plain auto form, silently widening a
    /// private-set property to fully public. G# has no per-accessor
    /// accessibility, so the loss is now diagnosed instead of silent.
    /// </summary>
    [Fact]
    public void PrivateSetAccessor_ReportsAccessibilityLossDiagnostic()
    {
        (CompilationUnit unit, TranslationContext context) = Translate(@"
namespace Demo
{
    public class C
    {
        public int X { get; private set; }
    }
}");
        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Warning
                && d.Message.Contains("narrower accessibility", StringComparison.OrdinalIgnoreCase));
        Assert.NotNull(unit);
    }

    /// <summary>
    /// A protected get-accessor on a public property must also be diagnosed;
    /// the fix generalizes to any accessor with a narrowing modifier, not just
    /// <c>private set</c>.
    /// </summary>
    [Fact]
    public void ProtectedGetAccessor_ReportsAccessibilityLossDiagnostic()
    {
        (_, TranslationContext context) = Translate(@"
namespace Demo
{
    public class C
    {
        public int X { protected get; set; }
    }
}");
        Assert.Contains(
            context.Diagnostics,
            d => d.Severity == TranslationSeverity.Warning
                && d.Message.Contains("narrower accessibility", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// A plain read-write auto-property with no accessor modifiers must not be
    /// flagged: there is nothing being narrowed.
    /// </summary>
    [Fact]
    public void PlainAutoProperty_NoAccessibilityLossDiagnostic()
    {
        (_, TranslationContext context) = Translate(@"
namespace Demo
{
    public class C
    {
        public int X { get; set; }
    }
}");
        Assert.DoesNotContain(
            context.Diagnostics,
            d => d.Message.Contains("narrower accessibility", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// An attribute on a field-like event must round-trip into the printed
    /// G#, not vanish.
    /// </summary>
    [Fact]
    public void EventAttribute_TranslatesFaithfully()
    {
        (CompilationUnit unit, _) = Translate(@"
using System;

namespace Demo
{
    public class C
    {
        [Obsolete]
        public event EventHandler X;
    }
}");
        TypeDeclaration type = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "C");
        EventDeclaration ev = type.Members.OfType<EventDeclaration>().Single(e => e.Name == "X");
        Assert.Single(ev.Attributes);

        string printed = GSharpPrinter.Print(unit);
        Assert.Contains("Obsolete", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// An attribute on a finalizer must round-trip into the printed G#, not
    /// vanish.
    /// </summary>
    [Fact]
    public void FinalizerAttribute_TranslatesFaithfully()
    {
        (CompilationUnit unit, _) = Translate(@"
using System;

namespace Demo
{
    public class C
    {
        [Obsolete]
        ~C() { }
    }
}");
        TypeDeclaration type = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "C");
        DestructorDeclaration destructor = type.Members.OfType<DestructorDeclaration>().Single();
        Assert.Single(destructor.Attributes);

        string printed = GSharpPrinter.Print(unit);
        Assert.Contains("Obsolete", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A user class literally named <c>Enum</c> must keep its own base clause;
    /// the old fragile string-name guard (<c>csBase.Name != "Enum"</c>) dropped
    /// it purely because of the name match.
    /// </summary>
    [Fact]
    public void UserClassNamedEnum_KeepsBaseClause()
    {
        (CompilationUnit unit, _) = Translate(@"
namespace Demo
{
    public class Enum
    {
    }

    public class Foo : Enum
    {
    }
}");
        TypeDeclaration foo = unit.Members.OfType<TypeDeclaration>().Single(t => t.Name == "Foo");
        Assert.NotNull(foo.BaseType);
    }

    /// <summary>
    /// A real local variable named <c>_</c> is a genuine assignment target in
    /// C#; the old name-based discard check dropped the assignment even
    /// though <c>_</c> here is a real variable in scope, not
    /// <see cref="Microsoft.CodeAnalysis.IDiscardSymbol"/>.
    /// </summary>
    [Fact]
    public void RealVariableNamedUnderscore_AssignmentIsPreserved()
    {
        (CompilationUnit unit, _) = Translate(@"
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
}");
        string printed = GSharpPrinter.Print(unit);
        Assert.Contains("_ = 5", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A genuine C# discard (<c>_ = e;</c> with no <c>_</c> variable in scope)
    /// must still drop the assignment and keep only the RHS, exactly as
    /// before (issue #914).
    /// </summary>
    [Fact]
    public void TrueDiscard_StillDropsAssignment()
    {
        (CompilationUnit unit, _) = Translate(@"
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
}");
        string printed = GSharpPrinter.Print(unit);
        Assert.DoesNotContain("_ =", printed, StringComparison.Ordinal);
        Assert.Contains("Next()", printed, StringComparison.Ordinal);
    }

    private static (CompilationUnit Unit, TranslationContext Context) Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return (unit, context);
    }
}
