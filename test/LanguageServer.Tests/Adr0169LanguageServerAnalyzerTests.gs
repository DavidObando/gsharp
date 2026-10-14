// <copyright file="Adr0169LanguageServerAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.LanguageServer
import GSharp.LanguageServer.Protocol
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// ADR-0169: the language server runs the project's G# analyzers in the
/// bind-inclusive diagnostics phase. The analyzer set comes from the
/// MSBuild-emitted `.rsp` (`/gsanalyzer:` lines) and is cached on
/// (cref:ProjectState) until the rsp changes.
open class Adr0169LanguageServerAnalyzerTests {
    @Fact
    func AnalyzerDiagnostics_SurfaceInBindPhase_NotInParseOnlyPhase() {
        using let workspace = TempProject(Source, includeAnalyzer: true)
        let bound = DocumentSyncHandler.ComputeDiagnostics(
            Source,
            skipBinding: false,
            workspace.Project,
            workspace.SourcePath
        )
        let parseOnly = DocumentSyncHandler.ComputeDiagnostics(
            Source,
            skipBinding: true,
            workspace.Project,
            workspace.SourcePath
        )
        Assert.Contains(
            bound.Diagnostics,
            (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Code?.Value?.ToString() == "TESTLSA01"
        )
        Assert.DoesNotContain(
            parseOnly.Diagnostics,
            (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Code?.Value?.ToString() == "TESTLSA01"
        )
    }

    @Fact
    func MissingAnalyzerAssembly_SurfacesGs9301() {
        using let workspace = TempProject(
            Source,
            includeAnalyzer: false,
            extraRspLines: []string{"/gsanalyzer:/nonexistent/analyzer.dll"}
        )
        let bound = DocumentSyncHandler.ComputeDiagnostics(
            Source,
            skipBinding: false,
            workspace.Project,
            workspace.SourcePath
        )
        Assert.Contains(
            bound.Diagnostics,
            (d GSharp.LanguageServer.Protocol.Diagnostic) -> d.Code?.Value?.ToString() == "GS9301"
        )
    }

    @Fact
    func GetGsAnalyzers_CachesUntilRspChanges() {
        using let workspace = TempProject(Source, includeAnalyzer: true)
        let first = workspace.Project.GetGsAnalyzers(out _)
        let second = workspace.Project.GetGsAnalyzers(out _)
        Assert.Single(first)
        Assert.Same(first[0], second[0])
        // Rewrite the rsp without the analyzer and backdate-proof via mtime bump.
        File.WriteAllText(workspace.RspPath, string.Empty)
        File.SetLastWriteTimeUtc(workspace.RspPath, DateTime.UtcNow.AddSeconds(5.0))
        let third = workspace.Project.GetGsAnalyzers(out _)
        Assert.Empty(third)
    }

    private class TempProject : IDisposable {
        private let directory DirectoryInfo

        init(source string, includeAnalyzer bool, extraRspLines[]?string = nil) {
            directory = Directory.CreateTempSubdirectory("gs-ls-analyzer-tests")
            SourcePath = Path.Combine(directory.FullName, "main.gs")
            File.WriteAllText(SourcePath, source)
            RspPath = Path.Combine(directory.FullName, "App.rsp")
            let lines = extraRspLines?.ToList() ?? List[string]()
            if includeAnalyzer {
                lines.Add("/gsanalyzer:${typeof(Adr0169LanguageServerProbeAnalyzer).Assembly.Location}")
            }
            File.WriteAllLines(RspPath, lines)
            Project = ProjectState(Path.Combine(directory.FullName, "App.gsproj")){ReferenceSourcePath = RspPath}
            Project.UpdateFile(SourcePath, source)
        }

        prop SourcePath string {
            get;
        }

        prop RspPath string {
            get;
        }

        prop Project ProjectState {
            get;
        }

        func Dispose() {
            try {
                directory.Delete(recursive: true)
            } catch (IOException) { }
        }
    }

    shared {
        private const Source string = `package App
import System

func Greet() {
    Console.WriteLine("hi")
}

func Main() {
    Greet()
}
`
    }
}

/// The probe analyzer the language server discovers from this test assembly:
/// warns TESTLSA01 on every call expression.
@GSharpDiagnosticAnalyzer
class Adr0169LanguageServerProbeAnalyzer : GSharpDiagnosticAnalyzer {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Initialize(context AnalysisContext) {
        context.RegisterSyntaxNodeAction(
            (ctx SyntaxNodeAnalysisContext) -> ctx.ReportDiagnostic(
                GSharp.Core.CodeAnalysis.Diagnostic.Create(Rule, ctx.Node.Location)
            ),
            SyntaxKind.CallExpression
        )
    }

    shared {
        private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
            "TESTLSA01",
            "LS probe",
            "Probe saw a call expression.",
            "Testing",
            GSharp.Core.CodeAnalysis.DiagnosticSeverity.Warning,
            isEnabledByDefault: true
        )
    }
}
