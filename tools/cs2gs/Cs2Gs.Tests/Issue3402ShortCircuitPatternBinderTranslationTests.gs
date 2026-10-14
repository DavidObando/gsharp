// <copyright file="Issue3402ShortCircuitPatternBinderTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// <summary>
/// Issue #3402: a pattern binder at the start of an && chain remains visible
/// through later conjuncts and the true body. ADR-0166 / issue #3409: the
/// binder is now a native G# pattern variable, so the whole condition — the
/// <c>is</c> designation, the later conjuncts, and an inline <c>out var</c> —
/// keeps its C# shape verbatim instead of an <c>if let</c> lowering.
/// </summary>
open class Issue3402ShortCircuitPatternBinderTranslationTests {
    @Fact
    func PatternBinder_WithLaterOutVar_RemainsInScope() {
        const source = `namespace Demo
{
    public class Base { }
    public sealed class Candidate : Base
    {
        public int Value;
    }

    public static class C
    {
        private static Base Get(Base value) => value;

        private static bool TryRead(out int value)
        {
            value = 2;
            return true;
        }

        public static int Read(Base value)
        {
            if (Get(value) is Candidate candidate
                && candidate.Value > 0
                && TryRead(out var extra)
                && extra > 0)
            {
                return candidate.Value + extra;
            }

            return 0;
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        // ADR-0166 / issue #3409: native pattern variable; `candidate` and the
        // later `out var extra` both stay visible through the chain and the body.
        Assert.Contains(
            "if Get(value) is Candidate candidate && candidate.Value > 0 && TryRead(out var extra) && extra > 0 {",
            rendered,
            StringComparison.Ordinal
        )
        Assert.Contains("return candidate.Value + extra", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("as Candidate", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__spill", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func PatternBinder_AfterOutVarPrefix_RemainsInScope() {
        const source = `namespace Demo
{
    public class Base { }
    public sealed class Candidate : Base
    {
        public int Value;
    }

    public static class C
    {
        private static bool TryGet(Base input, out Base value)
        {
            value = input;
            return true;
        }

        public static int Read(Base input)
        {
            if (TryGet(input, out var value)
                && value is Candidate candidate
                && candidate.Value > 0)
            {
                return candidate.Value;
            }

            return 0;
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        // ADR-0166 / issue #3409: the `out var` prefix and the native pattern
        // variable share one condition; no nested `if let` for the binder.
        Assert.Contains(
            "if TryGet(input, out var value) && value is Candidate candidate && candidate.Value > 0 {",
            rendered,
            StringComparison.Ordinal
        )
        Assert.Contains("return candidate.Value", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("as Candidate", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func TypeOrPattern_PreservesNonNullNarrowing() {
        const source = `#nullable enable
namespace Demo
{
    public class Base { }
    public class A : Base { }
    public class B : Base { }

    public static class C
    {
        private static void Use(Base value) { }

        public static void Read(Base? value)
        {
            if (value is A or B)
            {
                Use(value);
            }
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("if (value is A or B) {", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("value is A || value is B", rendered, StringComparison.Ordinal)
        Assert.Contains("Use(value!!)", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func NonTypeOrPatterns_RetainGSharpFlowNarrowing() {
        const source = `#nullable enable
namespace Demo
{
    public class Base { }
    public class A : Base
    {
        public string Name = "";
    }

    public static class C
    {
        private static void UseBase(Base value) { }
        private static void UseString(string value) { }

        public static void ReadBase(Base? value)
        {
            if (value is A { Name: "x" or "y" })
            {
                UseBase(value);
            }
        }

        public static void ReadString(string? value)
        {
            if (value is "a" or "b")
            {
                UseString(value);
            }
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("UseBase(value)", rendered, StringComparison.Ordinal)
        Assert.Contains("UseString(value)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("UseBase(value!!)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("UseString(value!!)", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func NonConstantOrPatterns_AddRequiredNullAssertion() {
        const source = `#nullable enable
namespace Demo
{
    public class A { }

    public static class C
    {
        private static void UseObject(object value) { }

        public static void ReadObject(object? value)
        {
            if (value is A or 5)
            {
                UseObject(value);
            }
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("UseObject(value!!)", rendered, StringComparison.Ordinal)
        Assert.Contains("value is A or 5", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func NegatedTypeOrPattern_AddsNullAssertionAfterGuard() {
        const source = `#nullable enable
namespace Demo
{
    public class Base { }
    public class A : Base { }
    public class B : Base { }

    public static class C
    {
        private static void Use(Base value) { }

        public static void Read(Base? value)
        {
            if (value is not (A or B))
            {
                return;
            }

            Use(value);
        }
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("Use(value!!)", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func InferredGenericEnumTryParse_RendersExplicitTypeArgument() {
        const source = `using System;

namespace Demo
{
    public static class C
    {
        public static bool Parse<T>(string text, out T result)
            where T : struct, Enum =>
            Enum.TryParse(text, false, out result);
    }
}`
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let rendered = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("Enum.TryParse[T]", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }
}
