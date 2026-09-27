// <copyright file="Adr0184UnscopedRefTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Pipeline;
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
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) = TranslateUnitWithDiagnostics(@"
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
        Assert.DoesNotContain(
            diagnostics,
            diagnostic => diagnostic.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId);
    }

    [Fact]
    public void UnscopedRefOnPropertyAccessor_IsHoistedToTheMember()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) = TranslateUnitWithDiagnostics(@"
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
        Assert.DoesNotContain(
            diagnostics,
            diagnostic => diagnostic.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId);
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
    public void PropertyAccessorAttribute_IsDroppedWithWarningInsteadOfHoisted()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) = TranslateUnitWithDiagnostics(@"
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
        TranslationDiagnostic diagnostic = Assert.Single(
            diagnostics,
            d => d.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId);
        Assert.Equal(TranslationSeverity.Warning, diagnostic.Severity);
        Assert.Equal("GetAccessorDeclaration", diagnostic.ConstructKind);
        Assert.Contains("MethodImplAttribute", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains("property 'Slot'", diagnostic.Message, StringComparison.Ordinal);
        Assert.Equal(
            "MethodImpl(MethodImplOptions.NoInlining)",
            diagnostic.Location.SourceTree.GetText().ToString(diagnostic.Location.SourceSpan));
    }

    [Fact]
    public void IndexerAccessorAttribute_IsDroppedWithWarningInsteadOfHoisted()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) = TranslateUnitWithDiagnostics(@"
using System.Runtime.CompilerServices;

namespace Demo
{
    public sealed class C
    {
        public int this[int index]
        {
            [MethodImpl(MethodImplOptions.NoInlining)]
            get { return index; }
        }
    }
}");

        Assert.DoesNotContain("@MethodImpl", printed);
        TranslationDiagnostic diagnostic = Assert.Single(
            diagnostics,
            d => d.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId);
        Assert.Equal(TranslationSeverity.Warning, diagnostic.Severity);
        Assert.Equal("GetAccessorDeclaration", diagnostic.ConstructKind);
        Assert.Contains("MethodImplAttribute", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains("of indexer", diagnostic.Message, StringComparison.Ordinal);
        Assert.Equal(
            "MethodImpl(MethodImplOptions.NoInlining)",
            diagnostic.Location.SourceTree.GetText().ToString(diagnostic.Location.SourceSpan));
    }

    /// <summary>
    /// Found in adversarial review of PR #4291: the hoist must read the
    /// <c>get</c> accessor only. The member-level G# annotation is emitted on
    /// the PropertyDef, which C# (and gsc's own
    /// <c>RefCapabilities.IsUnscopedRefIndexerGetter</c>) reads as the
    /// GETTER's contract — so lifting a <c>set</c>-level <c>[UnscopedRef]</c>
    /// would silently un-scope a getter the C# source left scoped. Before the
    /// <c>GetAccessorDeclaration</c> filter this printed <c>@UnscopedRef</c>.
    /// </summary>
    [Fact]
    public void UnscopedRefOnTheSetAccessorOnly_IsNotHoisted()
    {
        (string printed, IReadOnlyList<TranslationDiagnostic> diagnostics) = TranslateUnitWithDiagnostics(@"
using System.Diagnostics.CodeAnalysis;

namespace Demo
{
    public struct Acc
    {
        private int total;

        public int Slot
        {
            get { return this.total; }
            [UnscopedRef]
            set { this.total = value; }
        }
    }
}");

        Assert.DoesNotContain("@UnscopedRef", printed);
        TranslationDiagnostic diagnostic = Assert.Single(
            diagnostics,
            d => d.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId);
        Assert.Equal("SetAccessorDeclaration", diagnostic.ConstructKind);
        Assert.Contains("UnscopedRefAttribute", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AccessorAttributeWarning_ReachesTranslateLogWithoutFailingTheApp()
    {
        string compiler = FindCompiler();
        if (compiler is null)
        {
            return;
        }

        string projectDir = NewScratchDir("accessor-attribute-warning");
        File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>");
        string projectPath = Path.Combine(projectDir, "Warned.csproj");
        File.WriteAllText(projectPath, @"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
");
        File.WriteAllText(Path.Combine(projectDir, "Warned.cs"), @"
using System.Runtime.CompilerServices;

public sealed class Warned
{
    public int Slot
    {
        [MethodImpl(MethodImplOptions.NoInlining)]
        get { return 1; }
    }
}");

        string outRoot = NewOutputRoot("accessor-attribute-warning");
        var options = new PipelineOptions { GscPath = compiler, OutputRoot = outRoot };
        var pipeline = new MigrationPipeline(options, new IMigrationStage[] { new TranslateStage() });
        var app = new CorpusApp("test/AccessorAttributeWarning", projectPath, TargetKind.Library);

        RunResult result = await pipeline.RunAsync(new[] { app });
        AppResult appResult = Assert.Single(result.Apps);
        Assert.True(appResult.Succeeded, "An accessor-attribute warning must not fail the app.");

        string translateLog = File.ReadAllText(
            Assert.Single(Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories)));
        Assert.Contains(CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId, translateLog);
        Assert.Contains("MethodImplAttribute", translateLog);
        Assert.Contains("Warned.cs(8,10): warning: GetAccessorDeclaration", translateLog);
    }

    private static string TranslateUnit(string source)
        => TranslateUnitWithDiagnostics(source).Printed;

    private static (string Printed, IReadOnlyList<TranslationDiagnostic> Diagnostics)
        TranslateUnitWithDiagnostics(string source)
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
        return (printed, context.Diagnostics);
    }

    private static string NewOutputRoot(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string NewScratchDir(string label)
    {
        string root = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
