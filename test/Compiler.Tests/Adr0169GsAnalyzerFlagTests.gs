// <copyright file="Adr0169GsAnalyzerFlagTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// ADR-0169: gsc's `/gsanalyzer:<path>` flag loads G# diagnostic
/// analyzers in-process and runs them after binding; `/gsdiag:` applies
/// per-diagnostic severity overrides in the same post-hoc pass as
/// `/nowarn`. The probe analyzer lives in this test assembly, whose
/// on-disk path is passed to `/gsanalyzer:` — the host's load context
/// unifies it with the already-loaded copy, so the driver sees the same types.
open class Adr0169GsAnalyzerFlagTests {
    @Theory
    @InlineData("Debug.WriteLine(Compute(value))", false)
    @InlineData("Debug.WriteLine(Compute(value))", true)
    @InlineData("Build(value).LogSlice(Compute(value))", false)
    @InlineData("Build(value).LogSlice(Compute(value))", true)
    func GsAnalyzer_ReportsRetainedBoundOperandLocations(call string, enabled bool) {
        let source = "import System.Diagnostics\n" +
            (
            if enabled {
                "@file:DefineSymbol(\"DEBUG\")\n"
            } else {
                ""
            }
        ) +
            `@Conditional("DEBUG") func (self slice[int32]) LogSlice(value int32) {}
func Compute(value int32) int32 -> value
func Build(value int32) slice[int32] -> slice[int32]{value}
func Read(value int32) {
    CALL
    @If(false) { Missing(Compute(absent)) }
}`.Replace("CALL", call, StringComparison.Ordinal)
        let (exit, output, error) = RunGsc(source, "/gsanalyzer:$ProbeAssemblyPath")
        Assert.True(exit == 0, output + error)
        let diagnostics = output
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Where((line string) -> line.Contains("warning TESTGSA02:", StringComparison.Ordinal))
            .ToArray()
        let computeStart = source.IndexOf("Compute(value)", StringComparison.Ordinal)
        let expected = []string{
            "Bound active source at " + computeStart.ToString() + " with length " + "Compute(value)".Length.ToString() +
                ".",
            "Bound active source at " + (computeStart + "Compute(".Length).ToString() +
                " with length " +
                "value".Length.ToString() + "."
        }
        Assert.Equal(expected.Length, diagnostics.Length)
        for message in expected {
            Assert.Single(diagnostics.Where((line string) -> line.EndsWith(message, StringComparison.Ordinal)))
        }
    }

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
            let directory = Directory.CreateDirectory(
                Path.Combine(AppContext.BaseDirectory, "gsanalyzer-tests-" + Guid.NewGuid().ToString("N"))
            )
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

    /// Reports exact active operand locations through gsc's bound-node analyzer dispatch.
    @GSharpDiagnosticAnalyzer
    class Adr0169BoundOperandProbeAnalyzer : GSharpDiagnosticAnalyzer {
        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> ImmutableArray.Create(Rule)

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func Initialize(context AnalysisContext) {
            context.RegisterBoundNodeAction(Analyze, BoundNodeKind.CallExpression, BoundNodeKind.VariableExpression)
        }

        private func Analyze(context BoundNodeAnalysisContext) {
            if context.ContainingFunction?.Name != "Read" {
                return
            }
            var report = false
            if context.BoundNode is BoundCallExpression call {
                report = call.Function.Name == "Compute"
            } else if context.BoundNode is BoundVariableExpression variable &&
                variable.Variable.Name == "value" &&
                variable.Syntax?.Parent is CallExpressionSyntax parent {
                report = parent.Identifier.Text == "Compute"
            }
            if report {
                let syntax = context.BoundNode.Syntax!!
                context.ReportDiagnostic(
                    Diagnostic.Create(Rule, syntax.Location, syntax.Span.Start, syntax.Span.Length)
                )
            }
        }

        shared {
            private let Rule DiagnosticDescriptor = DiagnosticDescriptor(
                "TESTGSA02",
                "Bound operand probe",
                "Bound active source at {0} with length {1}.",
                "Testing",
                DiagnosticSeverity.Warning,
                isEnabledByDefault: true
            )
        }
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
