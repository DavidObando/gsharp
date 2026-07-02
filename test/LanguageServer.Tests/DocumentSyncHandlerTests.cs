// <copyright file="DocumentSyncHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.LanguageServer.Tests;

public class DocumentSyncHandlerTests
{
    [Fact]
    public void ComputeDiagnostics_IncludesBindingDiagnosticsWhenRequested()
    {
        const string source = "func F() int32 {\n}\n";

        var fastDiagnostics = DocumentSyncHandler.ComputeDiagnostics(source, skipBinding: true).Diagnostics;
        var fullDiagnostics = DocumentSyncHandler.ComputeDiagnostics(source, skipBinding: false).Diagnostics;

        Assert.DoesNotContain(fastDiagnostics, d => d.Message.Contains("Not all code paths", System.StringComparison.Ordinal));
        Assert.Contains(fullDiagnostics, d => d.Message.Contains("Not all code paths", System.StringComparison.Ordinal));
    }

    [Fact]
    public void ComputeDiagnostics_PassesProjectReferencesToBindProgram()
    {
        // Regression: previously DocumentSyncHandler called Binder.BindProgram(GlobalScope)
        // without compilation.References. The global scope was bound with the project's
        // MetadataLoadContext-backed references (so its types are MLC `Type` instances),
        // but body binding fell back to ReferenceResolver.Default() (host `RuntimeType`
        // instances). The two Type-identity universes diverged and member lookups during
        // body binding failed, producing spurious "cannot find type/member" / "Variable
        // 'null' doesn't exist" errors that dotnet build never reported.
        var tempDir = Path.Combine(Path.GetTempPath(), Path.GetRandomFileName());
        try
        {
            Directory.CreateDirectory(tempDir);
            var sourcePath = Path.Combine(tempDir, "UsesXunit.gs");
            File.WriteAllText(
                sourcePath,
                "package Sample\n\nimport System\nimport Xunit\n\nfunc Sample() {\n    Assert.True(Object.ReferenceEquals(null, null))\n}\n");

            // Pass BOTH the CoreLib path and xunit explicitly so WithReferences loads
            // System.Object via a MetadataLoadContext rather than reusing the host's
            // RuntimeType. Without this, the host fallback and the explicit references
            // resolve to the SAME host RuntimeType and there's no divergence — exactly
            // the test-environment quirk that previously hid this bug.
            var project = new ProjectState(Path.Combine(tempDir, "Sample.gsproj"));
            project.References = new[]
            {
                typeof(object).Assembly.Location,
                typeof(Xunit.FactAttribute).Assembly.Location,
            };
            project.UpdateFile(sourcePath, File.ReadAllText(sourcePath));

            var result = DocumentSyncHandler.ComputeDiagnostics(File.ReadAllText(sourcePath), skipBinding: false, project, sourcePath);

            // The bug surfaces during body binding: without compilation.References, the
            // body binder reports "Variable 'null' doesn't exist" and cannot resolve
            // ReferenceEquals or True. With the fix, those three errors disappear.
            // (A separate import-resolution diagnostic for 'Xunit.Assert' may remain in
            // the test environment due to the host already having Xunit loaded; that
            // path is exercised in the live LSP repro project but is not what this
            // test pins down.)
            var bodyErrors = result.Diagnostics
                .Where(d => d.Severity == Protocol.DiagnosticSeverity.Error)
                .Where(d => d.Message.Contains("Variable 'null'", System.StringComparison.Ordinal)
                    || d.Message.Contains("ReferenceEquals", System.StringComparison.Ordinal)
                    || d.Message.Contains("function True", System.StringComparison.Ordinal))
                .ToList();
            Assert.Empty(bodyErrors);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (IOException) { }
        }
    }

    [Fact]
    public void ComputeDiagnosticsForSnapshot_DoesNotOverwriteNewerProjectTreeOrInvalidateNewerCompilation()
    {
        // Regression for issue #1657: a read-only request (e.g. textDocument/diagnostic pull)
        // captures a SyntaxTree snapshot under the write gate and then binds off-gate. If a
        // didChange lands on the gate between the snapshot capture and the off-gate bind, the
        // pull must never clobber the project's newer tree with its own stale snapshot, and the
        // diagnostics it returns must still reflect exactly the snapshot it was given.
        const string staleText = "func F() int32 {\n}\n";
        const string newerText = "func F() int32 {\n    return 1\n}\n";
        const string filePath = "/test/file1.gs";

        var project = new ProjectState("/test/project.gsproj");
        var staleTree = project.UpdateFile(filePath, staleText);

        // Cache a compilation for the current (stale) tree, mirroring the project's state at the
        // moment the pull captured its snapshot.
        project.GetCompilation();

        // Simulate a concurrent didChange landing on the gate after the pull's snapshot was
        // captured: this both replaces the project's tree and invalidates its cached compilation.
        var newerTree = project.UpdateFile(filePath, newerText);

        // The pull binds against the pre-edit snapshot it captured earlier under the gate.
        var snapshotResult = DocumentSyncHandler.ComputeDiagnosticsForSnapshot(staleTree, skipBinding: false, project, filePath, workspace: null);

        // The returned diagnostics must reflect exactly the stale snapshot text (the missing
        // return statement), not the project's current, already-fixed text.
        Assert.Contains(snapshotResult.Diagnostics, d => d.Message.Contains("Not all code paths", System.StringComparison.Ordinal));

        // The project's own tree must still be the newer one written by UpdateFile: the pull must
        // never have clobbered it with the stale snapshot it was bound against.
        var currentCompilation = project.GetCompilation();
        Assert.Contains(currentCompilation.SyntaxTrees, t => ReferenceEquals(t, newerTree));
        Assert.DoesNotContain(currentCompilation.SyntaxTrees, t => ReferenceEquals(t, staleTree));

        // Rebinding the project's current (fixed) tree must show no missing-return diagnostic,
        // proving the newer compilation was neither corrupted nor left bound to stale content.
        Assert.DoesNotContain(currentCompilation.GlobalScope.Diagnostics, d => d.Message.Contains("Not all code paths", System.StringComparison.Ordinal));
    }
}
