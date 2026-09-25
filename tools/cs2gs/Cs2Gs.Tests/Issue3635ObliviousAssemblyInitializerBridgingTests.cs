// <copyright file="Issue3635ObliviousAssemblyInitializerBridgingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translator-fidelity tests for issue #3635: member reads from a
/// nullability-<em>oblivious</em> assembly (e.g. any netstandard2.0 reference,
/// which carries no NRT metadata) used to be imported by gsc as <c>T?</c>
/// (#1354, ADR-0136), so cs2gs bridged a read flowing into a non-nullable slot
/// with <c>!!</c>. The #2113 machinery covered return/receiver/foreach
/// positions but missed FIELD/PROPERTY INITIALIZERS: the migrated
/// netstandard2.0 <c>Gsharp.NET.Sdk</c> failed GS0155 on
/// <c>public string Optimization { get; set; } = bool.TrueString;</c>
/// (oblivious static FIELD read) and GS0156 on
/// <c>public ITaskItem[] References { get; set; } = Array.Empty&lt;ITaskItem&gt;();</c>
/// (oblivious method return in an initializer). Uses the
/// #2113 in-memory oblivious-library pattern; the consumer is
/// nullable-ENABLED, matching Gsharp.NET.Sdk (its own declarations stay
/// non-null <c>T</c>, only the oblivious READ is imported differently).
/// <para>
/// Since ADR-0186 step 3 gsc imports the oblivious read as the platform type
/// <c>T!</c> and checks it itself at the store, so these tests now pin that
/// cs2gs emits no <c>!!</c> on a scalar read (ADR-0186 step 6, PR 0). A
/// container read (the <c>string[]</c> returns) keeps its <c>!!</c>, which is
/// still load-bearing there (#4449). The test names
/// (<c>…Bridged</c>) predate ADR-0186 step 6 and are kept for issue
/// traceability; the assertions state the current contract.
/// </para>
/// </summary>
public class Issue3635ObliviousAssemblyInitializerBridgingTests
{
    // The tiny "external" library compiled WITHOUT a nullable context: every
    // reference-typed member is oblivious (NullableAnnotation.None), exactly
    // like a netstandard2.0 reference assembly (e.g. Microsoft.Build.Framework).
    private const string ObliviousLibrarySource = @"
public class Ext
{
    public static string Name = ""n"";

    public static string Title { get { return ""t""; } }

    public static string[] Items() { return new string[0]; }
}";

    [Fact]
    public void Enabled_AutoPropertyInitializer_ObliviousStaticFieldRead_Bridged()
    {
        // The Gsharp.NET.Sdk GS0155 shape: `= bool.TrueString` on an instance
        // auto-property, whose lowered backing field stays non-null `string`.
        string printed = TranslateEnabledWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Optimization { get; set; } = Ext.Name;
    }
}");

        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Ext.Name", printed);
        Assert.DoesNotContain("Ext.Name!!", printed);
    }

    [Fact]
    public void Enabled_AutoPropertyInitializer_ObliviousMethodReturn_Bridged()
    {
        // The Gsharp.NET.Sdk GS0156 shape: `= Array.Empty<ITaskItem>()` on an
        // instance auto-property — an oblivious method RETURN in an initializer.
        string printed = TranslateEnabledWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string[] References { get; set; } = Ext.Items();
    }
}");

        // A container read keeps its `!!` (ADR-0186 step 6, PR 0): the oblivious
        // `string[]` return reads as `[]!string!`, and only the `!!` lets it
        // convert to the enabled `[]string` slot (#4449).
        Assert.Contains("Ext.Items()!!", printed);
    }

    [Fact]
    public void Enabled_AutoPropertyInitializer_ObliviousStaticPropertyRead_Bridged()
    {
        // Nearby shape: an oblivious static PROPERTY read in an initializer,
        // handled like the field read.
        string printed = TranslateEnabledWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Title { get; set; } = Ext.Title;
    }
}");

        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Ext.Title", printed);
        Assert.DoesNotContain("Ext.Title!!", printed);
    }

    [Fact]
    public void Enabled_FieldInitializer_ObliviousMethodReturn_Bridged()
    {
        // Plain C# field initializer (not an auto-property lowering) with an
        // oblivious method return, which takes the pre-existing field path.
        string printed = TranslateEnabledWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        private string[] items = Ext.Items();

        public int Count() { return this.items.Length; }
    }
}");

        // A container read keeps its `!!` (ADR-0186 step 6, PR 0): the oblivious
        // `string[]` return reads as `[]!string!`, and only the `!!` lets it
        // convert to the enabled `[]string` slot (#4449).
        Assert.Contains("Ext.Items()!!", printed);
    }

    [Fact]
    public void Enabled_GetOnlyAutoPropertyInitializer_LiftedToConstructor_Bridged()
    {
        // A get-only auto-property initializer is lifted into the explicit
        // constructor body (OD-T1); the lifted assignment targets the
        // property's non-null `string`.
        string printed = TranslateEnabledWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public C(int unused)
        {
        }

        public string Name { get; } = Ext.Name;
    }
}");

        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Ext.Name", printed);
        Assert.DoesNotContain("Ext.Name!!", printed);
    }

    [Fact]
    public void Enabled_ConstructorAssignment_ObliviousMethodReturn_Bridged()
    {
        // Nearby shape: an oblivious return assigned in a constructor body.
        string printed = TranslateEnabledWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string[] Items { get; set; }

        public C()
        {
            this.Items = Ext.Items();
        }
    }
}");

        // A container read keeps its `!!` (ADR-0186 step 6, PR 0): the oblivious
        // `string[]` return reads as `[]!string!`, and only the `!!` lets it
        // convert to the enabled `[]string` slot (#4449).
        Assert.Contains("Ext.Items()!!", printed);
    }

    [Fact]
    public void Oblivious_AutoPropertyInitializer_ObliviousStaticFieldRead_Bridged()
    {
        // Same GS0155 shape but with a nullable-OBLIVIOUS consumer (a project
        // with no <Nullable> setting at all): the untainted auto-property
        // renders non-null `string`.
        string printed = TranslateObliviousWithObliviousLibrary(@"
namespace Demo
{
    public class C
    {
        public string Optimization { get; set; } = Ext.Name;
    }
}");

        // ADR-0186 step 6 (PR 0): gsc reads oblivious CLR metadata as the platform
        // type `T!` and checks it itself at this coercion, so cs2gs no longer
        // emits `!!` here (a `!!` on `T!` only duplicated that check).
        Assert.Contains("Ext.Name", printed);
        Assert.DoesNotContain("Ext.Name!!", printed);
    }

    [Fact]
    public void Enabled_AutoPropertyInitializer_AnnotatedNonNullRead_NotBridged()
    {
        // Precision guard: `bool.TrueString` resolved against the ANNOTATED
        // modern runtime (non-null `string`) must NOT grow a `!!` (neither does
        // an oblivious read now; this guard predates ADR-0186 step 6). This
        // consumer references no oblivious library, so its emitted G# binds.
        string printed = TranslateEnabled(@"
namespace Demo
{
    public class C
    {
        public string Optimization { get; set; } = bool.TrueString;
    }
}");

        Assert.Contains("bool.TrueString", printed);
        Assert.DoesNotContain("bool.TrueString!!", printed);
    }

    private static string TranslateEnabledWithObliviousLibrary(string source) =>
        TranslateWithObliviousLibrary(source, NullableContextOptions.Enable);

    private static string TranslateObliviousWithObliviousLibrary(string source) =>
        TranslateWithObliviousLibrary(source, NullableContextOptions.Disable);

    private static string TranslateWithObliviousLibrary(
        string source,
        NullableContextOptions consumerNullability)
    {
        var libTree = CSharpSyntaxTree.ParseText(
            ObliviousLibrarySource,
            new CSharpParseOptions(LanguageVersion.Latest));
        var libCompilation = CSharpCompilation.Create(
            "ObliviousLib",
            new[] { libTree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Disable));
        using var peStream = new System.IO.MemoryStream();
        Microsoft.CodeAnalysis.Emit.EmitResult emit = libCompilation.Emit(peStream);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
        peStream.Position = 0;
        MetadataReference libReference = MetadataReference.CreateFromStream(peStream);

        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.ObliviousAssemblyInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences().Append(libReference).ToImmutableArray(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(consumerNullability)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(
            new CSharpToGSharpTranslator().TranslateDocument(document, context),
            "Consumer-only fixture omits the referenced C# metadata library from emitted G#.");
    }

    private static string TranslateEnabled(string source)
    {
        var parseOptions = new CSharpParseOptions(LanguageVersion.Latest);
        SyntaxTree tree = CSharpSyntaxTree.ParseText(source, parseOptions, path: "Snippet.cs");
        var compilation = CSharpCompilation.Create(
            "Cs2Gs.EnabledInMemory",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable)
                .WithAllowUnsafe(true));

        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            d => d.Severity == DiagnosticSeverity.Error);

        SemanticModel model = compilation.GetSemanticModel(tree);
        var document = new LoadedDocument("Snippet.cs", tree, model);
        var context = new TranslationContext(compilation, model, document.FilePath);
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit, string roundTripOnlyReason = null)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = roundTripOnlyReason is null
            ? TranslationTestValidation.AssertBinds(printed)
            : TranslationTestValidation.ValidateRoundTripOnly(printed, roundTripOnlyReason);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
