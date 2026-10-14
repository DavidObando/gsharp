// <copyright file="Issue1736OutOfBodyLambdaMutabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #1736 — a lambda translated OUTSIDE any body scope (a field/property
/// initializer, a folded static-ctor RHS, a ctor `base(...)`/
/// `this(...)` argument, etc.) left `currentBodyScope` null, so the
/// mutability scan (`IsSymbolReassigned`) always answered "never
/// reassigned" for locals declared inside that lambda: a reassigned local
/// wrongly emitted the immutable `let` binding, producing an illegal
/// `i++`/assignment against a `let`. (cref:TranslateLambda)
/// now narrows `currentBodyScope` to the lambda node itself, fixing every
/// out-of-body position at once.
open class Issue1736OutOfBodyLambdaMutabilityTests {
    /// A lambda in a FIELD initializer that reassigns a local declared inside
    /// its own block body must emit that local as mutable (`var`), not `let`.
    @Fact
    func FieldInitializerLambda_ReassignedLocal_EmitsVar() {
        let (printed, context) = Translate(`
using System;
namespace Demo
{
    public class C
    {
        public Func<int> F = () => { int i = 0; i++; return i; };
    }
}`)
        Assert.Contains("var i = 0", printed)
        Assert.DoesNotContain("let i", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
    }

    /// Regression guard: a lambda in a field initializer whose local is NEVER
    /// reassigned still emits the immutable `let` — the fix must not make
    /// every out-of-body local mutable by default.
    @Fact
    func FieldInitializerLambda_NonReassignedLocal_StaysLet() {
        let (printed, context) = Translate(`
using System;
namespace Demo
{
    public class C
    {
        public Func<int> F = () => { int i = 0; return i + 1; };
    }
}`)
        Assert.Contains("let i = 0", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
    }

    /// A lambda in a PROPERTY initializer that reassigns a local declared
    /// inside its own block body must also emit that local as mutable.
    @Fact
    func PropertyInitializerLambda_ReassignedLocal_EmitsVar() {
        let (printed, context) = Translate(`
using System;
namespace Demo
{
    public class C
    {
        public Func<int> F { get; } = () => { int i = 0; i++; return i; };
    }
}`)
        Assert.Contains("var i = 0", printed)
        Assert.DoesNotContain("let i", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
    }

    /// Regression guard: a lambda inside a NORMAL method body, whose local is
    /// reassigned, is unaffected by the fix — it was already correctly
    /// classified via the enclosing method's body scope, and the narrower
    /// per-lambda scope (a subset that still contains the lambda's own
    /// reassignment) must not change that outcome.
    @Fact
    func InBodyLambda_ReassignedLocal_StillEmitsVar() {
        let (printed, context) = Translate(`
using System;
namespace Demo
{
    public class C
    {
        public Func<int> Make()
        {
            return () => { int i = 0; i++; return i; };
        }
    }
}`)
        Assert.Contains("var i = 0", printed)
        Assert.DoesNotContain("let i", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
    }

    /// Regression guard: a lambda inside a NORMAL method body, whose local is
    /// NOT reassigned, still emits `let`.
    @Fact
    func InBodyLambda_NonReassignedLocal_StillEmitsLet() {
        let (printed, context) = Translate(`
using System;
namespace Demo
{
    public class C
    {
        public Func<int> Make()
        {
            return () => { int i = 0; return i + 1; };
        }
    }
}`)
        Assert.Contains("let i = 0", printed)
        Assert.DoesNotContain(context.Diagnostics, (d TranslationDiagnostic) -> d.IsUnsupported)
    }

    shared {
        private func Translate(source string)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            return (printed, context)
        }
    }
}
