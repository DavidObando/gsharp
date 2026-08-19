// <copyright file="Adr0169GsAnalyzerFlagTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// ADR-0169: gsc's <c>/gsanalyzer:&lt;path&gt;</c> flag loads G# diagnostic
/// analyzers in-process and runs them after binding; <c>/gsdiag:</c> applies
/// per-diagnostic severity overrides in the same post-hoc pass as
/// <c>/nowarn</c>. The probe analyzer lives in this test assembly, whose
/// on-disk path is passed to <c>/gsanalyzer:</c> — the host's load context
/// unifies it with the already-loaded copy, so the driver sees the same types.
/// </summary>
public class Adr0169GsAnalyzerFlagTests
{
    private static readonly string ProbeAssemblyPath = typeof(Adr0169ProbeAnalyzer).Assembly.Location;

    private const string Source = @"package P
func Ping() int32 {
    return Pong()
}

func Pong() int32 {
    return 42
}
";

    [Fact]
    public void GsAnalyzer_MissingValue_ReturnsError()
    {
        var (exit, _, err) = RunGsc(Source, "/gsanalyzer:");
        Assert.NotEqual(0, exit);
        Assert.Contains("/gsanalyzer requires a path", err);
    }

    [Fact]
    public void GsAnalyzer_ReportsAnalyzerWarning_AndSucceeds()
    {
        var (exit, output, _) = RunGsc(Source, $"/gsanalyzer:{ProbeAssemblyPath}");
        Assert.Equal(0, exit);
        Assert.Contains("TESTGSA01", output);
    }

    [Fact]
    public void GsAnalyzer_NoWarn_SilencesAnalyzerDiagnostic()
    {
        var (exit, output, _) = RunGsc(Source, $"/gsanalyzer:{ProbeAssemblyPath}", "/nowarn:TESTGSA01");
        Assert.Equal(0, exit);
        Assert.DoesNotContain("TESTGSA01", output);
    }

    [Fact]
    public void GsDiag_None_SuppressesAnalyzerDiagnostic()
    {
        var (exit, output, _) = RunGsc(Source, $"/gsanalyzer:{ProbeAssemblyPath}", "/gsdiag:TESTGSA01=none");
        Assert.Equal(0, exit);
        Assert.DoesNotContain("TESTGSA01", output);
    }

    [Fact]
    public void GsDiag_Error_PromotesAnalyzerDiagnosticAndFailsBuild()
    {
        var (exit, output, _) = RunGsc(Source, $"/gsanalyzer:{ProbeAssemblyPath}", "/gsdiag:TESTGSA01=error");
        Assert.NotEqual(0, exit);
        Assert.Contains("TESTGSA01", output);
        Assert.Contains("error", output);
    }

    [Fact]
    public void GsDiag_UnknownSeverity_ReturnsError()
    {
        var (exit, _, err) = RunGsc(Source, "/gsdiag:TESTGSA01=loud");
        Assert.NotEqual(0, exit);
        Assert.Contains("unknown severity", err);
    }

    [Fact]
    public void GsAnalyzer_MissingAssembly_ReportsGs9301AndFails()
    {
        var (exit, output, _) = RunGsc(Source, "/gsanalyzer:/nonexistent/analyzer.dll");
        Assert.NotEqual(0, exit);
        Assert.Contains("GS9301", output);
    }

    [Fact]
    public void GsAnalyzer_AssemblyWithoutAnalyzers_ReportsGs9301()
    {
        // GSharp.Core.dll is loadable but declares no analyzers.
        var corePath = typeof(Diagnostic).Assembly.Location;
        var (exit, output, _) = RunGsc(Source, $"/gsanalyzer:{corePath}");
        Assert.NotEqual(0, exit);
        Assert.Contains("GS9301", output);
    }

    private static (int ExitCode, string Output, string ErrorOutput) RunGsc(string source, params string[] extraArgs)
    {
        var directory = Directory.CreateTempSubdirectory("gsanalyzer-tests");
        var sourcePath = Path.Combine(directory.FullName, "app.gs");
        File.WriteAllText(sourcePath, source);
        var outputPath = Path.Combine(directory.FullName, "app.dll");

        var args = new string[extraArgs.Length + 3];
        args[0] = sourcePath;
        args[1] = $"/out:{outputPath}";
        args[2] = "/target:library";
        Array.Copy(extraArgs, 0, args, 3, extraArgs.Length);

        var prevOut = Console.Out;
        var prevErr = Console.Error;
        using var output = new StringWriter();
        using var error = new StringWriter();
        Console.SetOut(output);
        Console.SetError(error);
        try
        {
            var exit = Program.Main(args);
            return (exit, output.ToString(), error.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
            try
            {
                directory.Delete(recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }
}

/// <summary>
/// The probe analyzer gsc discovers from this test assembly: warns TESTGSA01
/// on every call expression.
/// </summary>
[GSharpDiagnosticAnalyzer]
public sealed class Adr0169ProbeAnalyzer : GSharpDiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTGSA01",
        "Probe",
        "Probe saw a call expression.",
        "Testing",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true);

    /// <inheritdoc/>
    public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics => ImmutableArray.Create(Rule);

    /// <inheritdoc/>
    public override void Initialize(AnalysisContext context)
    {
        context.RegisterSyntaxNodeAction(
            ctx => ctx.ReportDiagnostic(Diagnostic.Create(Rule, ctx.Node.Location)),
            SyntaxKind.CallExpression);
    }
}
