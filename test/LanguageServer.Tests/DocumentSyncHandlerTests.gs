// <copyright file="DocumentSyncHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.IO
import System.Linq
import Xunit

open class DocumentSyncHandlerTests {
    @Fact
    func ComputeDiagnostics_IncludesBindingDiagnosticsWhenRequested() {
        const source = `func F() int32 {
}
`
        let fastDiagnostics = DocumentSyncHandler.ComputeDiagnostics(source, skipBinding: true).Diagnostics
        let fullDiagnostics = DocumentSyncHandler.ComputeDiagnostics(source, skipBinding: false).Diagnostics
        Assert.DoesNotContain(
            fastDiagnostics,
            (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Message.Contains(
                "Not all code paths",
                StringComparison.Ordinal
            )
        )
        Assert.Contains(
            fullDiagnostics,
            (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Message.Contains(
                "Not all code paths",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func ComputeDiagnostics_SkipBindingReportsOnlySyntaxDiagnostics() {
        const source = `import System

func F(value MissingType) {
`
        let diagnostics = DocumentSyncHandler.ComputeDiagnostics(source, skipBinding: true).Diagnostics
        Assert.NotEmpty(diagnostics)
        Assert.All(diagnostics, (d GSharp.LanguageServer.Protocol.Diagnostic) -> Assert.Equal("Syntax", d.Code!!.Value))
    }

    @Fact
    func ComputeDiagnostics_PassesProjectReferencesToBindProgram() {
        // Regression: previously DocumentSyncHandler called Binder.BindProgram(GlobalScope)
        // without compilation.References. The global scope was bound with the project's
        // MetadataLoadContext-backed references (so its types are MLC `Type` instances),
        // but body binding fell back to ReferenceResolver.Default() (host `RuntimeType`
        // instances). The two Type-identity universes diverged and member lookups during
        // body binding failed, producing spurious "cannot find type/member" / "Variable
        // 'null' doesn't exist" errors that dotnet build never reported.
        let tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName())
        try {
            Directory.CreateDirectory(tempDir)
            let sourcePath = Path.Combine(tempDir, "UsesXunit.gs")
            File.WriteAllText(sourcePath, `package Sample

import System
import Xunit

func Sample() {
    Assert.True(Object.ReferenceEquals(null, null))
}
`)
            // Pass BOTH the CoreLib path and xunit explicitly so WithReferences loads
            // System.Object via a MetadataLoadContext rather than reusing the host's
            // RuntimeType. Without this, the host fallback and the explicit references
            // resolve to the SAME host RuntimeType and there's no divergence — exactly
            // the test-environment quirk that previously hid this bug.
            let project = ProjectState(Path.Combine(tempDir, "Sample.gsproj"))
            project.References = []string{typeof(object).Assembly.Location, typeof(FactAttribute).Assembly.Location}
            project.UpdateFile(sourcePath, File.ReadAllText(sourcePath))
            let result = DocumentSyncHandler.ComputeDiagnostics(
                File.ReadAllText(sourcePath),
                skipBinding: false,
                project,
                sourcePath
            )
            // The bug surfaces during body binding: without compilation.References, the
            // body binder reports "Variable 'null' doesn't exist" and cannot resolve
            // ReferenceEquals or True. With the fix, those three errors disappear.
            // (A separate import-resolution diagnostic for 'Xunit.Assert' may remain in
            // the test environment due to the host already having Xunit loaded; that
            // path is exercised in the live LSP repro project but is not what this
            // test pins down.)
            let bodyErrors = result
                .Diagnostics
                .Where(
                (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Severity == GSharp
                    .LanguageServer
                    .Protocol
                    .DiagnosticSeverity
                    .Error
            )
                .Where(
                (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Message.Contains(
                    "Variable 'null'",
                    StringComparison.Ordinal
                ) ||
                    d
                    .Message
                    .Contains("ReferenceEquals", StringComparison.Ordinal) || d.Message.Contains(
                    "function True",
                    StringComparison.Ordinal
                )
            )
                .ToList()
            Assert.Empty(bodyErrors)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }

    @Fact
    func ComputeDiagnosticsForSnapshot_DoesNotOverwriteNewerProjectTreeOrInvalidateNewerCompilation() {
        // Regression for issue #1657: a read-only request (e.g. textDocument/diagnostic pull)
        // captures a SyntaxTree snapshot under the write gate and then binds off-gate. If a
        // didChange lands on the gate between the snapshot capture and the off-gate bind, the
        // pull must never clobber the project's newer tree with its own stale snapshot, and the
        // diagnostics it returns must still reflect exactly the snapshot it was given.
        const staleText = `func F() int32 {
}
`
        const newerText = `func F() int32 {
    return 1
}
`
        const filePath = "/test/file1.gs"
        let project = ProjectState("/test/project.gsproj")
        let staleTree = project.UpdateFile(filePath, staleText)
        // Cache a compilation for the current (stale) tree, mirroring the project's state at the
        // moment the pull captured its snapshot.
        project.GetCompilation()
        // Simulate a concurrent didChange landing on the gate after the pull's snapshot was
        // captured: this both replaces the project's tree and invalidates its cached compilation.
        let newerTree = project.UpdateFile(filePath, newerText)
        // The pull binds against the pre-edit snapshot it captured earlier under the gate.
        let snapshotResult = DocumentSyncHandler.ComputeDiagnosticsForSnapshot(
            staleTree,
            skipBinding: false,
            project,
            filePath,
            workspace: nil
        )
        // The returned diagnostics must reflect exactly the stale snapshot text (the missing
        // return statement), not the project's current, already-fixed text.
        Assert.Contains(
            snapshotResult.Diagnostics,
            (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Message.Contains(
                "Not all code paths",
                StringComparison.Ordinal
            )
        )
        // The project's own tree must still be the newer one written by UpdateFile: the pull must
        // never have clobbered it with the stale snapshot it was bound against.
        let currentCompilation = project.GetCompilation()
        Assert.Contains(currentCompilation.SyntaxTrees, (t SyntaxTree) -> object.ReferenceEquals(t, newerTree))
        Assert.DoesNotContain(currentCompilation.SyntaxTrees, (t SyntaxTree) -> object.ReferenceEquals(t, staleTree))
        // Rebinding the project's current (fixed) tree must show no missing-return diagnostic,
        // proving the newer compilation was neither corrupted nor left bound to stale content.
        Assert.DoesNotContain(
            currentCompilation.GlobalScope.Diagnostics,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Message.Contains(
                "Not all code paths",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func ComputeDiagnostics_HonoursSuppressDiagnosticForCompilerWarnings() {
        // ADR-0175 amendment (issue #4422): the language server reports what
        // gsc reports — a GS0612 inside an @SuppressDiagnostic("GS0612") block
        // is dropped, the same warning outside it is not.
        const source = "func R(ref s string) { s = \"r\" }\n" +
            "func F() {\n" +
            "    var a string? = nil\n" +
            "    @SuppressDiagnostic(\"GS0612\") {\n" +
            "        R(&a)\n" +
            "    }\n" +
            "    R(&a)\n" +
            "}\n"
        let diagnostics = DocumentSyncHandler.ComputeDiagnostics(source, skipBinding: false).Diagnostics
        let gs0612 = Assert.Single(
            diagnostics,
            (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Message.Contains(
                "differs from the parameter type",
                StringComparison.Ordinal
            )
        )
        Assert.Equal(6, gs0612.Range.Start.Line)
    }

    @Theory
    @InlineData(true)
    @InlineData(false)
    func ComputeDiagnostics_HonoursSuppressDiagnosticForParserWarnings(skipBinding bool) {
        // Review finding (#4422): gsc drops a parser warning inside an
        // @SuppressDiagnostic scope, and the language server must too.
        const source = "@SuppressDiagnostic(\"GS0303\")\n" +
            "func Quiet(cb func(int32) int32) int32 -> cb(1)\n" +
            "func Loud(cb func(int32) int32) int32 -> cb(1)\n"
        let diagnostics = DocumentSyncHandler.ComputeDiagnostics(source, skipBinding).Diagnostics
        let deprecated = Assert.Single(
            diagnostics,
            (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Message.Contains(
                "is deprecated",
                StringComparison.Ordinal
            )
        )
        Assert.Equal(2, deprecated.Range.Start.Line)
    }

    @Fact
    func ComputeDiagnostics_KeepsThePhaseCodesAndTheOrderOfTheirSources() {
        // ADR-0212 S6: the wire code of a compiler diagnostic names its phase, and one query now supplies all
        // phases. Pin the code of each phase and the order parse, declaration, body.
        const source = "func Loud(cb func(int32) int32) int32 -> cb(1)\n" +
            "func Declared() Undefined {\n" +
            "    return nil\n" +
            "}\n" +
            "func Body() int32 {\n" +
            "    return \"x\"\n" +
            "}\n"
        let diagnostics = DocumentSyncHandler.ComputeDiagnostics(source, skipBinding: false).Diagnostics
        let codes = diagnostics.Select((d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Code!!.Value).ToArray()
        Assert.Equal("Syntax", codes[0])
        Assert.Equal("Binding", codes[codes.Length - 1])
        Assert.Contains("Semantic", codes)
        let firstBinding = Array.IndexOf(codes, "Binding")
        let lastSemantic = Array.LastIndexOf(codes, "Semantic")
        Assert.True(lastSemantic < firstBinding)
        Assert.All(codes, (code string) -> Assert.Contains(code, []string{"Syntax", "Semantic", "Binding"}))
    }

    @Fact
    func ComputeDiagnostics_HidesDocumentationWarningsWhileTheProjectHasAnError() {
        // ADR-0212 Q14, the one listed behaviour change of S6: the server follows gsc, which validates
        // documentation only when no diagnostic is an error. Before S6 the warning showed beside the error.
        const documented = "/// Gets a value.\n" +
            "/// @return the value\n" +
            "func Get() int32 {\n" +
            "    return 0\n" +
            "}\n"
        let clean = DocumentSyncHandler.ComputeDiagnostics(documented, skipBinding: false).Diagnostics
        Assert.Single(clean, (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Code!!.Value == "GS0231")
        let broken = DocumentSyncHandler.ComputeDiagnostics(
            documented + "func Bad() int32 {\n    return \"x\"\n}\n",
            skipBinding: false
        )
            .Diagnostics
        Assert.Contains(broken, (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Code!!.Value == "Binding")
        Assert.DoesNotContain(broken, (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Code!!.Value == "GS0231")
    }

    @Fact
    func ComputeDiagnostics_HidesDocumentationWarningsOfOneFileWhenAnotherFileHasAnError() {
        let tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName())
        try {
            Directory.CreateDirectory(tempDir)
            let documentedPath = Path.Combine(tempDir, "Documented.gs")
            let brokenPath = Path.Combine(tempDir, "Broken.gs")
            const documented = "package Lib\n/// Gets a value.\n/// @return the value\nfunc Get() int32 {\n    return 0\n}\n"
            const broken = "package Lib\nfunc Bad() int32 {\n    return \"x\"\n}\n"
            let project = ProjectState(Path.Combine(tempDir, "Lib.gsproj"))
            project.UpdateFile(documentedPath, documented)
            project.UpdateFile(brokenPath, broken)
            let withError = DocumentSyncHandler.ComputeDiagnostics(
                documented,
                skipBinding: false,
                project,
                documentedPath
            )
            Assert.DoesNotContain(
                withError.Diagnostics,
                (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Code!!.Value == "GS0231"
            )
            project.UpdateFile(brokenPath, broken.Replace("\"x\"", "1"))
            let fixed_ = DocumentSyncHandler.ComputeDiagnostics(documented, skipBinding: false, project, documentedPath)
            Assert.Single(
                fixed_.Diagnostics,
                (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Code!!.Value == "GS0231"
            )
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch (IOException) { }
        }
    }
}
