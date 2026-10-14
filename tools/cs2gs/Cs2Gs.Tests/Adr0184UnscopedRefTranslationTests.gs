// <copyright file="Adr0184UnscopedRefTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Threading.Tasks
import Xunit

/// ADR-0184: `[UnscopedRef]` survives translation from BOTH C# spellings.
/// C# accepts it on the property/indexer or on the `get` accessor and
/// treats the two identically; G# spells it only at the member level, and
/// `PropertyAccessor` has no attribute slot at all, so the accessor-level
/// spelling used to vanish silently. Witness of discrimination: before the
/// hoist, `UnscopedRefOnAccessor_*` printed a `prop this[...]` with
/// no `@UnscopedRef` and the round-trip bind failed with GS0589 — which
/// is exactly how PR #4288's fixture regression reached the self-migration
/// gate.
open class Adr0184UnscopedRefTranslationTests {
    @Fact
    func UnscopedRefOnIndexerAccessor_IsHoistedToTheMember() {
        let (printed, diagnostics) = TranslateUnitWithDiagnostics(`
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
}`)
        Assert.Contains("@UnscopedRef", printed)
        Assert.DoesNotContain(
            diagnostics,
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId
        )
    }

    @Fact
    func UnscopedRefOnPropertyAccessor_IsHoistedToTheMember() {
        let (printed, diagnostics) = TranslateUnitWithDiagnostics(`
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
}`)
        Assert.Contains("@UnscopedRef", printed)
        Assert.DoesNotContain(
            diagnostics,
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId
        )
    }

    @Fact
    func AliasedMemberUnscopedRef_PreventsDuplicateGetterHoist() {
        let (printed, diagnostics) = TranslateUnitWithDiagnostics(`
using U = System.Diagnostics.CodeAnalysis.UnscopedRefAttribute;

namespace Demo
{
    public ref struct Ring
    {
        private int value;

        [U]
        public ref int Slot
        {
            [System.Diagnostics.CodeAnalysis.UnscopedRef]
            get { return ref this.value; }
        }
    }
}`)
        Assert.Contains("@U", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("@System.Diagnostics.CodeAnalysis.UnscopedRef", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            diagnostics,
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId
        )
    }

    @Fact
    func UnrelatedMemberUnscopedRef_DoesNotSuppressRealGetterHoist() {
        let (printed, diagnostics) = TranslateUnitWithDiagnostics(`
using U = System.Diagnostics.CodeAnalysis.UnscopedRefAttribute;

namespace Demo
{
    [System.AttributeUsage(System.AttributeTargets.Property)]
    public sealed class UnscopedRefAttribute : System.Attribute { }

    public ref struct Ring
    {
        private int value;

        [UnscopedRef]
        public ref int Slot
        {
            [U]
            get { return ref this.value; }
        }
    }
}`)
        Assert.Contains("@UnscopedRef", printed, StringComparison.Ordinal)
        Assert.Contains("@U", printed, StringComparison.Ordinal)
        Assert.DoesNotContain(
            diagnostics,
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId
        )
    }

    @Fact
    func UnscopedRefOnTheIndexerItself_StillTranslates() {
        let printed = TranslateUnit(`
using System.Diagnostics.CodeAnalysis;

namespace Demo
{
    public ref struct Ring
    {
        private int value;

        [UnscopedRef]
        public ref int this[int i] => ref this.value;
    }
}`)
        Assert.Contains("@UnscopedRef", printed)
    }

    @Fact
    func UnscopedRefOnAMethod_StillTranslates() {
        let printed = TranslateUnit(`
using System.Diagnostics.CodeAnalysis;

namespace Demo
{
    public struct Acc
    {
        private int total;

        [UnscopedRef]
        public ref int Slot() { return ref this.total; }
    }
}`)
        Assert.Contains("@UnscopedRef", printed)
    }

    /// The hoist is narrow on purpose: an accessor attribute whose meaning is
    /// accessor-specific must NOT be moved to the property, where it would say
    /// something different. Only `[UnscopedRef]` — which C# itself treats
    /// as equivalent in both placements — is lifted.
    @Fact
    func PropertyAccessorAttribute_IsDroppedWithWarningInsteadOfHoisted() {
        let (printed, diagnostics) = TranslateUnitWithDiagnostics(`
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
}`)
        Assert.DoesNotContain("@MethodImpl", printed)
        let diagnostic = Assert.Single(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId
        )
        Assert.Equal(TranslationSeverity.Warning, diagnostic.Severity)
        Assert.Equal("GetAccessorDeclaration", diagnostic.ConstructKind)
        Assert.Contains("MethodImplAttribute", diagnostic.Message, StringComparison.Ordinal)
        Assert.Contains("property 'Slot'", diagnostic.Message, StringComparison.Ordinal)
        Assert.Equal(
            "MethodImpl(MethodImplOptions.NoInlining)",
            diagnostic.Location!!.SourceTree!!.GetText().ToString(diagnostic.Location!!.SourceSpan)
        )
    }

    @Fact
    func IndexerAccessorAttribute_IsDroppedWithWarningInsteadOfHoisted() {
        let (printed, diagnostics) = TranslateUnitWithDiagnostics(`
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
}`)
        Assert.DoesNotContain("@MethodImpl", printed)
        let diagnostic = Assert.Single(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId
        )
        Assert.Equal(TranslationSeverity.Warning, diagnostic.Severity)
        Assert.Equal("GetAccessorDeclaration", diagnostic.ConstructKind)
        Assert.Contains("MethodImplAttribute", diagnostic.Message, StringComparison.Ordinal)
        Assert.Contains("of indexer", diagnostic.Message, StringComparison.Ordinal)
        Assert.Equal(
            "MethodImpl(MethodImplOptions.NoInlining)",
            diagnostic.Location!!.SourceTree!!.GetText().ToString(diagnostic.Location!!.SourceSpan)
        )
    }

    @Fact
    func InitializedStaticAutoPropertyAccessorAttribute_IsDroppedWithWarning() {
        let (printed, diagnostics) = TranslateUnitWithDiagnostics(`
using System.Runtime.CompilerServices;

namespace Demo
{
    public sealed class C
    {
        public static int Slot
        {
            [MethodImpl(MethodImplOptions.NoInlining)]
            get;
        } = 1;
    }
}`)
        Assert.DoesNotContain("@MethodImpl", printed)
        let diagnostic = Assert.Single(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId
        )
        Assert.Equal("GetAccessorDeclaration", diagnostic.ConstructKind)
        Assert.Contains("property 'Slot'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func ExtensionPropertyAccessorAttribute_IsDroppedWithWarning() {
        let (printed, diagnostics) = TranslateUnitWithDiagnostics(`
using System.Runtime.CompilerServices;

namespace Demo
{
    public static class Extensions
    {
        extension(string value)
        {
            public int Size
            {
                [MethodImpl(MethodImplOptions.NoInlining)]
                get { return value.Length; }
            }
        }
    }
}`)
        Assert.DoesNotContain("@MethodImpl", printed)
        let diagnostic = Assert.Single(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId
        )
        Assert.Equal("GetAccessorDeclaration", diagnostic.ConstructKind)
        Assert.Contains("property 'Size'", diagnostic.Message, StringComparison.Ordinal)
    }

    /// Found in adversarial review of PR #4291: the hoist must read the
    /// `get` accessor only. The member-level G# annotation is emitted on
    /// the PropertyDef, which C# (and gsc's own
    /// `RefCapabilities.IsUnscopedRefIndexerGetter`) reads as the
    /// GETTER's contract — so lifting a `set`-level `[UnscopedRef]`
    /// would silently un-scope a getter the C# source left scoped. Before the
    /// `GetAccessorDeclaration` filter this printed `@UnscopedRef`.
    @Fact
    func UnscopedRefOnTheSetAccessorOnly_IsNotHoisted() {
        let (printed, diagnostics) = TranslateUnitWithDiagnostics(`
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
}`)
        Assert.DoesNotContain("@UnscopedRef", printed)
        let diagnostic = Assert.Single(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId
        )
        Assert.Equal("SetAccessorDeclaration", diagnostic.ConstructKind)
        Assert.Contains("UnscopedRefAttribute", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func SetUnscopedRefWithMemberUnscopedRef_ExplainsWhyTheAccessorPlacementIsDropped() {
        let (printed, diagnostics) = TranslateUnitWithDiagnostics(`
using System.Diagnostics.CodeAnalysis;

namespace Demo
{
    public struct Acc
    {
        private int total;

        [UnscopedRef]
        public int Slot
        {
            get { return this.total; }
            [UnscopedRef]
            set { this.total = value; }
        }
    }
}`)
        Assert.Contains("@UnscopedRef", printed)
        let diagnostic = Assert.Single(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId
        )
        Assert.Contains("already has @UnscopedRef", diagnostic.Message, StringComparison.Ordinal)
        Assert.DoesNotContain("moving it to the member", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    async func AccessorAttributeWarning_ReachesTranslateLogWithoutFailingTheApp() {
        let compiler string? = FindCompiler()
        if compiler == nil {
            return
        }
        let projectDir = NewScratchDir("accessor-attribute-warning")
        let outRoot = NewOutputRoot("accessor-attribute-warning")
        try {
            File.WriteAllText(Path.Combine(projectDir, "Directory.Build.props"), "<Project></Project>")
            let projectPath = Path.Combine(projectDir, "Warned.csproj")
            File.WriteAllText(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
</Project>
`)
            File.WriteAllText(Path.Combine(projectDir, "Warned.cs"), `
using System.Runtime.CompilerServices;

public sealed class Warned
{
    public int Slot
    {
        [MethodImpl(MethodImplOptions.NoInlining)]
        get { return 1; }
    }
}`)
            let options = PipelineOptions{GscPath: compiler, OutputRoot: outRoot}
            let pipeline = MigrationPipeline(options, []IMigrationStage{TranslateStage()})
            let app = CorpusApp("test/AccessorAttributeWarning", projectPath, TargetKind.Library)
            let result = await pipeline.RunAsync([]CorpusApp{app})
            let appResult = Assert.Single(result.Apps)
            Assert.True(appResult.Succeeded, "An accessor-attribute warning must not fail the app.")
            let translateLog = File.ReadAllText(
                Assert.Single(Directory.GetFiles(outRoot, "translate.log", SearchOption.AllDirectories))
            )
            Assert.Contains(CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId, translateLog)
            Assert.Contains("(non-fatal)", translateLog)
            Assert.Contains("MethodImplAttribute", translateLog)
            Assert.Contains("Warned.cs(8,10): GetAccessorDeclaration", translateLog)
            Assert.DoesNotContain(": warning:", translateLog, StringComparison.Ordinal)
            Assert.Equal(1, translateLog.Split("Warned.cs", StringSplitOptions.None).Length - 1)
        } finally {
            DeleteDirectory(projectDir)
            DeleteDirectory(outRoot)
        }
    }

    @Fact
    func ForwardedWarningWithoutSourceLocation_UsesDocumentPathOnce() {
        let diagnostic = TranslationDiagnostic(
            "GetAccessorDeclaration",
            "attribute 'Demo.A' was dropped",
            severity: TranslationSeverity.Warning
        ){DiagnosticId = CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId}
        let rendered = TranslateStage.FormatForwardedTranslationWarning(diagnostic, "C:\\src\\Warned.cs")
        Assert.Equal(
            "CS2GS-ACCESSOR-ATTRIBUTE-DROPPED (non-fatal): GetAccessorDeclaration: attribute 'Demo.A' was dropped [C:\\src\\Warned.cs]",
            rendered
        )
        Assert.DoesNotContain("warning", rendered, StringComparison.Ordinal)
    }

    @Fact
    func ForwardedWarningWithEmptySourcePath_UsesDocumentPath() {
        let tree = CSharpSyntaxTree.ParseText("class C { }")
        let diagnostic = TranslationDiagnostic(
            "GetAccessorDeclaration",
            "attribute 'Demo.A' was dropped",
            tree.GetRoot().GetLocation(),
            TranslationSeverity.Warning
        ){DiagnosticId = CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId}
        let rendered = TranslateStage.FormatForwardedTranslationWarning(diagnostic, "GeneratedDocument.cs")
        Assert.Equal(
            "CS2GS-ACCESSOR-ATTRIBUTE-DROPPED (non-fatal): GeneratedDocument.cs(1,1): GetAccessorDeclaration: attribute 'Demo.A' was dropped",
            rendered
        )
        Assert.StartsWith(
            "CS2GS-ACCESSOR-ATTRIBUTE-DROPPED (non-fatal): <unknown document>(1,1):",
            TranslateStage.FormatForwardedTranslationWarning(diagnostic, string.Empty),
            StringComparison.Ordinal
        )
    }

    @Fact
    func ForwardedWarning_PreservesWarningTextInsideSourcePath() {
        const sourcePath = "/repo/warning: checkout/Warned.cs"
        let (_, diagnostics) = TranslateUnitWithDiagnostics(`
using System.Runtime.CompilerServices;

public sealed class Warned
{
    public int Slot
    {
        [MethodImpl(MethodImplOptions.NoInlining)]
        get { return 1; }
    }
}`, sourcePath)
        let diagnostic = Assert.Single(
            diagnostics,
            (d TranslationDiagnostic) -> d.DiagnosticId == CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId
        )
        let rendered = TranslateStage.FormatForwardedTranslationWarning(diagnostic, sourcePath)
        Assert.StartsWith(
            "CS2GS-ACCESSOR-ATTRIBUTE-DROPPED (non-fatal): /repo/warning: checkout/Warned.cs(",
            rendered,
            StringComparison.Ordinal
        )
        Assert.Equal(1, rendered.Split(sourcePath, StringSplitOptions.None).Length - 1)
        Assert.Contains("GetAccessorDeclaration", rendered, StringComparison.Ordinal)
        Assert.Contains("MethodImplAttribute", rendered, StringComparison.Ordinal)
    }

    shared {
        private func TranslateUnit(source string) string -> TranslateUnitWithDiagnostics(source).Printed

        private func TranslateUnitWithDiagnostics(source string, filePath string = "Snippet.cs")(
            Printed string,
            Diagnostics IReadOnlyList[TranslationDiagnostic]
        ) {
            let project = CSharpProjectLoader.LoadInMemory([](filePath string, source string){(filePath, source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return (printed, context.Diagnostics)
        }

        private func NewOutputRoot(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "pipeline-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func NewScratchDir(label string) string {
            let root = Path.Combine(AppContext.BaseDirectory, "loader-tests", label, Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(root)
            return root
        }

        private func DeleteDirectory(path string) {
            try {
                Directory.Delete(path, recursive: true)
            } catch (IOException) {
                // Best effort: test-host file handles can remain open briefly on Windows.

            } catch (UnauthorizedAccessException) {
                // Best effort, as above.

            }
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
