// <copyright file="Issue1354PropertyNullableTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #1354 (the cs2gs part): G# follows
/// Kotlin-style nullability, so a `nil` comparison is only legal on a nullable
/// type. The issue-#1072 null-spillover promotion (`T` rendered `T?` when
/// null-checked) is extended to PROPERTIES, and the flow-proven non-null
/// assertion (`!!`) is extended from receiver positions to VALUE positions
/// (a `return` expression and the arms of a conditional), because G# does not
/// smart-cast a property/field chain. The negative tests pin the precision
/// guards so a property that is never null-checked keeps its non-nullable type
/// and a non-null value is never spuriously asserted.
/// </summary>
public class Issue1354PropertyNullableTranslationTests
{
    [Fact]
    public void NullCheckedSettableProperty_RendersNullableType()
    {
        // A settable auto-property compared against `null` (here via the
        // `is null` pattern) is genuinely nullable and must render `T?`.
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Flags { public int Size => 1; }
    public class C
    {
        public Flags Bits { get; set; } = new Flags();
        public int Size() => Bits is null ? 0 : Bits.Size;
    }
}");

        Assert.Contains("prop Bits Flags?", printed);
    }

    [Fact]
    public void NullCheckedProperty_ReceiverUse_EmitsNonNullAssertion()
    {
        // Once the property is promoted to `T?`, a flow-proven non-null member
        // access on it (after the `is null` guard) needs the `!!` assertion,
        // exactly like the existing field/local receiver pass.
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Flags { public int Size => 1; }
    public class C
    {
        public Flags Bits { get; set; } = new Flags();
        public int Size()
        {
            if (Bits is null) return 0;
            return Bits.Size;
        }
    }
}");

        Assert.Contains("prop Bits Flags?", printed);
        Assert.Contains("Bits!!.Size", printed);
    }

    [Fact]
    public void NullCheckedComputedProperty_ConditionalArm_EmitsNonNullAssertion()
    {
        // A computed get-only property that is `null`-checked promotes to `T?`;
        // the non-null conditional ARM that reads it (a VALUE position, not a
        // receiver) gets the `!!` assertion so the conditional unifies to the
        // non-null result type.
        string printed = TranslateUnit(@"
#nullable enable
using System.Threading.Tasks;
namespace Demo
{
    public class C
    {
        private Task? backing;
        protected virtual Task Work => backing ?? Task.CompletedTask;
        public Task Run() => Work is null ? Task.CompletedTask : Work;
    }
}");

        Assert.Contains("prop Work Task?", printed);
        Assert.Contains("else { Work!! }", printed);
    }

    [Fact]
    public void NullCheckedComputedProperty_ReturnValue_EmitsNonNullAssertion()
    {
        // A bare `return Work` of a promoted `T?` property, where the method
        // returns the non-null `T`, gets the `!!` assertion in value position.
        string printed = TranslateUnit(@"
#nullable enable
using System.Threading.Tasks;
namespace Demo
{
    public class C
    {
        private Task? backing;
        protected virtual Task Work => backing ?? Task.CompletedTask;
        public Task Pick(bool b)
        {
            if (Work is null) return Task.CompletedTask;
            return Work;
        }
    }
}");

        Assert.Contains("prop Work Task?", printed);
        Assert.Contains("return Work!!", printed);
    }

    [Fact]
    public void PropertyNeverNullChecked_StaysNonNullable()
    {
        // Precision guard: a property that is never null-checked nor
        // null-assigned keeps its declared non-nullable type, and a plain read
        // of it is never spuriously asserted.
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class Flags { public int Size => 1; }
    public class C
    {
        public Flags Bits { get; set; } = new Flags();
        public int Size() => Bits.Size;
    }
}");

        Assert.Contains("prop Bits Flags", printed);
        Assert.DoesNotContain("prop Bits Flags?", printed);
        Assert.DoesNotContain("Bits!!", printed);
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
