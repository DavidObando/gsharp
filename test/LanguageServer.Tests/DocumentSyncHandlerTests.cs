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
}
