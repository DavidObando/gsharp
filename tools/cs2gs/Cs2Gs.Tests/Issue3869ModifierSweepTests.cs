// <copyright file="Issue3869ModifierSweepTests.cs" company="GSharp">
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
/// Issue #3869, sibling sweep. Dropping <c>ref</c> from a <c>ref struct</c> was
/// not a one-off typo, it was a whole defect class: a type-declaration modifier
/// that cs2gs silently discards even though G# can express it, and whose loss
/// changes the emitted type's RUNTIME identity. This file pins the behaviour of
/// every other C# type-declaration modifier so the next one cannot regress
/// unnoticed — including the ones that turn out to be fine, which are exactly
/// the assertions that would otherwise never be written.
/// </summary>
public sealed class Issue3869ModifierSweepTests
{
    /// <summary>
    /// <c>partial</c> — preserved (ADR-0145 §C/§D preserve mode). It has no
    /// runtime representation of its own, but losing it in preserve mode would
    /// break the standalone-part contract.
    /// </summary>
    [Fact]
    public void Partial_IsPreservedInPreserveMode()
    {
        string printed = Translate(
            "namespace R { public partial class C { public int X; } }",
            preservePartialParts: true);

        Assert.Contains("partial class C", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// <c>unsafe</c> — preserved (ADR-0122 / issue #1202). The body is an unsafe
    /// context, which is what makes a <c>*T</c> member signature legal.
    /// </summary>
    [Fact]
    public void Unsafe_IsPreserved()
    {
        string printed = Translate("namespace R { public unsafe struct S { public int X; } }");

        Assert.Contains("unsafe struct S", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// <c>sealed</c> — correctly dropped, and this is NOT a fidelity loss: G#
    /// types are closed by default and opt INTO inheritance with <c>open</c>, so
    /// a C# <c>sealed class</c> maps to a plain G# <c>class</c> and the emitted
    /// type still carries the CLR <c>sealed</c> flag. (G#'s own <c>sealed</c>
    /// keyword means a closed hierarchy, a different concept.) Emitting
    /// <c>sealed</c> here would change the meaning, not preserve it.
    /// </summary>
    [Fact]
    public void Sealed_MapsToAPlainClosedGSharpClass()
    {
        string printed = Translate("namespace R { public sealed class C { public int X; } }");

        Assert.Contains("class C", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("open class C", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// <c>abstract</c> — deliberately dropped in favour of <c>open</c>, with an
    /// Info diagnostic recorded (ADR-0115 §B.4: G# has no abstract-class
    /// modifier). Documented and reported, not silent.
    /// </summary>
    [Fact]
    public void Abstract_MapsToOpen_AndIsReported()
    {
        LoadedCSharpProject project = Load("namespace R { public abstract class C { public int X; } }");
        var translator = new CSharpToGSharpTranslator();
        LoadedDocument document = project.Documents.Single();
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(translator.TranslateDocument(document, context));

        Assert.Contains("open class C", printed, StringComparison.Ordinal);
        Assert.Contains(
            context.Diagnostics,
            d => d.Message.Contains("abstract", StringComparison.Ordinal));
    }

    /// <summary>
    /// <c>readonly struct</c> — the <c>readonly</c> IS dropped, and unlike
    /// <c>ref</c> this is a LANGUAGE gap, not a translator gap: G# has no
    /// <c>readonly struct</c> declaration form at all (gsc only stamps
    /// <c>IsReadOnlyAttribute</c> on an <c>inline struct</c>,
    /// <c>TypeDefEmitter</c>). Crucially it is not the #3869 defect class: the
    /// attribute is a defensive-copy hint for C# consumers, not something the CLR
    /// type loader enforces, so the emitted assembly still loads. Pinned here so
    /// the distinction is on record rather than rediscovered.
    /// </summary>
    [Fact]
    public void ReadOnlyStruct_LosesReadOnly_ALanguageGapNotATypeLoadHazard()
    {
        string printed = Translate("namespace R { public readonly struct S { public readonly int X; } }");

        Assert.Contains("struct S", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("readonly struct", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// <c>static class</c> — the class is emitted without a <c>static</c>
    /// modifier (G# has none for aggregates), so the emitted type is not
    /// <c>abstract sealed</c>. That is a shape difference, not a type-load
    /// hazard: nothing in the CLR refuses to load a non-static class of static
    /// members. Pinned so it is a known, deliberate divergence.
    /// </summary>
    [Fact]
    public void StaticClass_LosesStatic_ButRemainsLoadable()
    {
        string printed = Translate(
            "namespace R { public static class Helpers { public static int X() { return 1; } } }");

        Assert.Contains("class Helpers", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("static class", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// <c>ref struct</c> — the #3869 defect itself, and the ONLY modifier in this
    /// sweep whose loss changes runtime type identity to the point of making the
    /// assembly unloadable. Now preserved.
    /// </summary>
    [Fact]
    public void RefStruct_IsPreserved()
    {
        string printed = Translate(
            "using System; namespace R { public ref struct S { public Span<int> V; } }");

        Assert.Contains("ref struct S", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A <c>ref struct</c> nested inside a class keeps its <c>ref</c> too — gsc's
    /// aggregate-head detector accepts the contextual <c>ref</c> at nested
    /// positions, so there is no reason for the translator to special-case them.
    /// </summary>
    [Fact]
    public void NestedRefStruct_IsPreserved()
    {
        string printed = Translate(
            "using System; namespace R { public class Outer { public ref struct Inner { public Span<int> V; } } }");

        Assert.Contains("ref struct Inner", printed, StringComparison.Ordinal);
    }

    private static LoadedCSharpProject Load(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Repro.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }

    private static string Translate(string source, bool preservePartialParts = false)
    {
        LoadedCSharpProject project = Load(source);
        var translator = new CSharpToGSharpTranslator(preservePartialParts: preservePartialParts);
        return string.Join(
            Environment.NewLine,
            project.Documents.Select(document =>
            {
                var context = new TranslationContext(
                    project.Compilation, document.SemanticModel, document.FilePath);
                CompilationUnit unit = translator.TranslateDocument(document, context);
                return GSharpPrinter.Print(unit);
            }));
    }
}
