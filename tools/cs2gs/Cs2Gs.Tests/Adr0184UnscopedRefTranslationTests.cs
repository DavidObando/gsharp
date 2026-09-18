// <copyright file="Adr0184UnscopedRefTranslationTests.cs" company="GSharp">
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
/// ADR-0184: <c>[UnscopedRef]</c> survives translation from BOTH C# spellings.
/// C# accepts it on the property/indexer or on the <c>get</c> accessor and
/// treats the two identically; G# spells it only at the member level, and
/// <c>PropertyAccessor</c> has no attribute slot at all, so the accessor-level
/// spelling used to vanish silently. Witness of discrimination: before the
/// hoist, <c>UnscopedRefOnAccessor_*</c> printed a <c>prop this[...]</c> with
/// no <c>@UnscopedRef</c> and the round-trip bind failed with GS0589 — which
/// is exactly how PR #4288's fixture regression reached the self-migration
/// gate.
/// </summary>
public class Adr0184UnscopedRefTranslationTests
{
    [Fact]
    public void UnscopedRefOnIndexerAccessor_IsHoistedToTheMember()
    {
        string printed = TranslateUnit(@"
using System.Diagnostics.CodeAnalysis;

namespace Demo
{
    public ref struct Ring
    {
        private int value;

        public ref int this[int i]
        {
            [UnscopedRef]
            get { return ref this.value; }
        }
    }
}");

        Assert.Contains("@UnscopedRef", printed);
    }

    [Fact]
    public void UnscopedRefOnPropertyAccessor_IsHoistedToTheMember()
    {
        string printed = TranslateUnit(@"
using System.Diagnostics.CodeAnalysis;

namespace Demo
{
    public ref struct Ring
    {
        private int value;

        public ref int Slot
        {
            [UnscopedRef]
            get { return ref this.value; }
        }
    }
}");

        Assert.Contains("@UnscopedRef", printed);
    }

    [Fact]
    public void UnscopedRefOnTheIndexerItself_StillTranslates()
    {
        string printed = TranslateUnit(@"
using System.Diagnostics.CodeAnalysis;

namespace Demo
{
    public ref struct Ring
    {
        private int value;

        [UnscopedRef]
        public ref int this[int i] => ref this.value;
    }
}");

        Assert.Contains("@UnscopedRef", printed);
    }

    [Fact]
    public void UnscopedRefOnAMethod_StillTranslates()
    {
        string printed = TranslateUnit(@"
using System.Diagnostics.CodeAnalysis;

namespace Demo
{
    public struct Acc
    {
        private int total;

        [UnscopedRef]
        public ref int Slot() { return ref this.total; }
    }
}");

        Assert.Contains("@UnscopedRef", printed);
    }

    /// <summary>
    /// The hoist is narrow on purpose: an accessor attribute whose meaning is
    /// accessor-specific must NOT be moved to the property, where it would say
    /// something different. Only <c>[UnscopedRef]</c> — which C# itself treats
    /// as equivalent in both placements — is lifted.
    /// </summary>
    [Fact]
    public void OtherAccessorAttributes_AreNotHoisted()
    {
        string printed = TranslateUnit(@"
using System.Runtime.CompilerServices;

namespace Demo
{
    public sealed class C
    {
        public int Slot
        {
            [MethodImpl(MethodImplOptions.NoInlining)]
            get { return 1; }
        }
    }
}");

        Assert.DoesNotContain("@MethodImpl", printed);
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
