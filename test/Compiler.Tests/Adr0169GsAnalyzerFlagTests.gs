// <copyright file="Adr0169GsAnalyzerFlagTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.IO
import Xunit

/// ADR-0169: gsc's `/gsanalyzer:<path>` flag loads G# diagnostic
/// analyzers in-process and runs them after binding; `/gsdiag:` applies
/// per-diagnostic severity overrides in the same post-hoc pass as
/// `/nowarn`. The probe analyzer lives in this test assembly, whose
/// on-disk path is passed to `/gsanalyzer:` — the host's load context
/// unifies it with the already-loaded copy, so the driver sees the same types.
open class Adr0169GsAnalyzerFlagTests {
    @Fact
    func GsAnalyzer_MissingValue_ReturnsError() {
        let (exit, _, err) = RunGsc(Source, "/gsanalyzer:")
        Assert.NotEqual(0, exit)
        Assert.Contains("/gsanalyzer requires a path", err)
    }

    @Fact
    func GsAnalyzer_ReportsAnalyzerWarning_AndSucceeds() {
        let (exit, output, _) = RunGsc(Source, "/gsanalyzer:$ProbeAssemblyPath")
        Assert.Equal(0, exit)
        Assert.Contains("TESTGSA01", output)
    }

    @Fact
    func GsAnalyzer_NoWarn_SilencesAnalyzerDiagnostic() {
        let (exit, output, _) = RunGsc(Source, "/gsanalyzer:$ProbeAssemblyPath", "/nowarn:TESTGSA01")
        Assert.Equal(0, exit)
        Assert.DoesNotContain("TESTGSA01", output)
    }

    @Fact
    func GsDiag_None_SuppressesAnalyzerDiagnostic() {
        let (exit, output, _) = RunGsc(Source, "/gsanalyzer:$ProbeAssemblyPath", "/gsdiag:TESTGSA01=none")
        Assert.Equal(0, exit)
        Assert.DoesNotContain("TESTGSA01", output)
    }

    @Fact
    func GsDiag_Error_PromotesAnalyzerDiagnosticAndFailsBuild() {
        let (exit, output, _) = RunGsc(Source, "/gsanalyzer:$ProbeAssemblyPath", "/gsdiag:TESTGSA01=error")
        Assert.NotEqual(0, exit)
        Assert.Contains("TESTGSA01", output)
        Assert.Contains("error", output)
    }

    @Fact
    func GsDiag_UnknownSeverity_ReturnsError() {
        let (exit, _, err) = RunGsc(Source, "/gsdiag:TESTGSA01=loud")
        Assert.NotEqual(0, exit)
        Assert.Contains("unknown severity", err)
    }

    @Fact
    func GsAnalyzer_MissingAssembly_ReportsGs9301AndFails() {
        let (exit, output, _) = RunGsc(Source, "/gsanalyzer:/nonexistent/analyzer.dll")
        Assert.NotEqual(0, exit)
        Assert.Contains("GS9301", output)
    }

    @Fact
    func GsAnalyzer_AssemblyWithoutAnalyzers_ReportsGs9301() {
        // GSharp.Core.dll is loadable but declares no analyzers.
        let corePath = typeof(Diagnostic).Assembly.Location
        let (exit, output, _) = RunGsc(Source, "/gsanalyzer:$corePath")
        Assert.NotEqual(0, exit)
        Assert.Contains("GS9301", output)
    }

    shared {
        private let ProbeAssemblyPath string = typeof(Adr0169ProbeAnalyzer).Assembly.Location

        private const Source string = `package P
func Ping() int32 {
    return Pong()
}

func Pong() int32 {
    return 42
}
`

        private func RunGsc(source string, extraArgs ...string)(ExitCode int32, Output string, ErrorOutput string) {
            let directory = Directory.CreateTempSubdirectory("gsanalyzer-tests")
            let sourcePath = Path.Combine(directory.FullName, "app.gs")
            File.WriteAllText(sourcePath, source)
            let outputPath = Path.Combine(directory.FullName, "app.dll")
            let args = [extraArgs.Length + 3]string
            args[0] = sourcePath
            args[1] = "/out:$outputPath"
            args[2] = "/target:library"
            Array.Copy(extraArgs, 0, args, 3, extraArgs.Length)
            let prevOut = Console.Out
            let prevErr = Console.Error
            using let output = StringWriter()
            using let error = StringWriter()
            Console.SetOut(output)
            Console.SetError(error)
            try {
                let exit = Program.Main(args)
                return (exit, output.ToString(), error.ToString())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
                try {
                    directory.Delete(recursive: true)
                } catch (IOException) { }
            }
        }
    }
}

/// The probe analyzer gsc discovers from this test assembly: warns TESTGSA01
/// on every call expression.
@GSharpDiagnosticAnalyzer
class Adr0169ProbeAnalyzer : GSharpDiagnosticAnalyzer {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Initialize(context AnalysisContext) {
        context.RegisterSyntaxNodeAction(
            (ctx SyntaxNodeAnalysisContext) -> ctx.ReportDiagnostic(Diagnostic.Create(Rule, ctx.Node.Location)),
            SyntaxKind.CallExpression
        )
    }

    shared {
        private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
            "TESTGSA01",
            "Probe",
            "Probe saw a call expression.",
            "Testing",
            DiagnosticSeverity.Warning,
            isEnabledByDefault: true
        )
    }
}
