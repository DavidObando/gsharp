// <copyright file="Issue1736OutOfBodyLambdaMutabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1736 — a lambda translated OUTSIDE any body scope (a field/property
/// initializer, a folded static-ctor RHS, a ctor <c>base(...)</c>/
/// <c>this(...)</c> argument, etc.) left <c>currentBodyScope</c> null, so the
/// mutability scan (<c>IsSymbolReassigned</c>) always answered "never
/// reassigned" for locals declared inside that lambda: a reassigned local
/// wrongly emitted the immutable <c>let</c> binding, producing an illegal
/// <c>i++</c>/assignment against a <c>let</c>. <see cref="TranslateLambda"/>
/// now narrows <c>currentBodyScope</c> to the lambda node itself, fixing every
/// out-of-body position at once.
/// </summary>
public class Issue1736OutOfBodyLambdaMutabilityTests
{
    /// <summary>
    /// A lambda in a FIELD initializer that reassigns a local declared inside
    /// its own block body must emit that local as mutable (`var`), not `let`.
    /// </summary>
    [Fact]
    public void FieldInitializerLambda_ReassignedLocal_EmitsVar()
    {
        (string printed, TranslationContext context) = Translate(@"
using System;
namespace Demo
{
    public class C
    {
        public Func<int> F = () => { int i = 0; i++; return i; };
    }
}");

        Assert.Contains("var i = 0", printed);
        Assert.DoesNotContain("let i", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.IsUnsupported);
    }

    /// <summary>
    /// Regression guard: a lambda in a field initializer whose local is NEVER
    /// reassigned still emits the immutable `let` — the fix must not make
    /// every out-of-body local mutable by default.
    /// </summary>
    [Fact]
    public void FieldInitializerLambda_NonReassignedLocal_StaysLet()
    {
        (string printed, TranslationContext context) = Translate(@"
using System;
namespace Demo
{
    public class C
    {
        public Func<int> F = () => { int i = 0; return i + 1; };
    }
}");

        Assert.Contains("let i = 0", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.IsUnsupported);
    }

    /// <summary>
    /// A lambda in a PROPERTY initializer that reassigns a local declared
    /// inside its own block body must also emit that local as mutable.
    /// </summary>
    [Fact]
    public void PropertyInitializerLambda_ReassignedLocal_EmitsVar()
    {
        (string printed, TranslationContext context) = Translate(@"
using System;
namespace Demo
{
    public class C
    {
        public Func<int> F { get; } = () => { int i = 0; i++; return i; };
    }
}");

        Assert.Contains("var i = 0", printed);
        Assert.DoesNotContain("let i", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.IsUnsupported);
    }

    /// <summary>
    /// Regression guard: a lambda inside a NORMAL method body, whose local is
    /// reassigned, is unaffected by the fix — it was already correctly
    /// classified via the enclosing method's body scope, and the narrower
    /// per-lambda scope (a subset that still contains the lambda's own
    /// reassignment) must not change that outcome.
    /// </summary>
    [Fact]
    public void InBodyLambda_ReassignedLocal_StillEmitsVar()
    {
        (string printed, TranslationContext context) = Translate(@"
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
}");

        Assert.Contains("var i = 0", printed);
        Assert.DoesNotContain("let i", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.IsUnsupported);
    }

    /// <summary>
    /// Regression guard: a lambda inside a NORMAL method body, whose local is
    /// NOT reassigned, still emits `let`.
    /// </summary>
    [Fact]
    public void InBodyLambda_NonReassignedLocal_StillEmitsLet()
    {
        (string printed, TranslationContext context) = Translate(@"
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
}");

        Assert.Contains("let i = 0", printed);
        Assert.DoesNotContain(context.Diagnostics, d => d.IsUnsupported);
    }

    private static (string Printed, TranslationContext Context) Translate(string source)
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
        return (printed, context);
    }
}
