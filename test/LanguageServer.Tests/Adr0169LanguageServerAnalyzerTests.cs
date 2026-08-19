// <copyright file="Adr0169LanguageServerAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Analyzers;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer;
using Xunit;

namespace GSharp.LanguageServer.Tests;

/// <summary>
/// ADR-0169: the language server runs the project's G# analyzers in the
/// bind-inclusive diagnostics phase. The analyzer set comes from the
/// MSBuild-emitted <c>.rsp</c> (<c>/gsanalyzer:</c> lines) and is cached on
/// <see cref="ProjectState"/> until the rsp changes.
/// </summary>
public class Adr0169LanguageServerAnalyzerTests
{
    private const string Source = @"package App
import System

func Greet() {
    Console.WriteLine(""hi"")
}

func Main() {
    Greet()
}
";

    [Fact]
    public void AnalyzerDiagnostics_SurfaceInBindPhase_NotInParseOnlyPhase()
    {
        using var workspace = new TempProject(Source, includeAnalyzer: true);

        var bound = DocumentSyncHandler.ComputeDiagnostics(Source, skipBinding: false, workspace.Project, workspace.SourcePath);
        var parseOnly = DocumentSyncHandler.ComputeDiagnostics(Source, skipBinding: true, workspace.Project, workspace.SourcePath);

        Assert.Contains(bound.Diagnostics, d => d.Code?.Value?.ToString() == "TESTLSA01");
        Assert.DoesNotContain(parseOnly.Diagnostics, d => d.Code?.Value?.ToString() == "TESTLSA01");
    }

    [Fact]
    public void MissingAnalyzerAssembly_SurfacesGs9301()
    {
        using var workspace = new TempProject(Source, includeAnalyzer: false, extraRspLines: new[] { "/gsanalyzer:/nonexistent/analyzer.dll" });

        var bound = DocumentSyncHandler.ComputeDiagnostics(Source, skipBinding: false, workspace.Project, workspace.SourcePath);

        Assert.Contains(bound.Diagnostics, d => d.Code?.Value?.ToString() == "GS9301");
    }

    [Fact]
    public void GetGsAnalyzers_CachesUntilRspChanges()
    {
        using var workspace = new TempProject(Source, includeAnalyzer: true);

        var first = workspace.Project.GetGsAnalyzers(out _);
        var second = workspace.Project.GetGsAnalyzers(out _);
        Assert.Single(first);
        Assert.Same(first[0], second[0]);

        // Rewrite the rsp without the analyzer and backdate-proof via mtime bump.
        File.WriteAllText(workspace.RspPath, string.Empty);
        File.SetLastWriteTimeUtc(workspace.RspPath, DateTime.UtcNow.AddSeconds(5));

        var third = workspace.Project.GetGsAnalyzers(out _);
        Assert.Empty(third);
    }

    private sealed class TempProject : IDisposable
    {
        private readonly DirectoryInfo directory;

        public TempProject(string source, bool includeAnalyzer, string[] extraRspLines = null)
        {
            directory = Directory.CreateTempSubdirectory("gs-ls-analyzer-tests");
            SourcePath = Path.Combine(directory.FullName, "main.gs");
            File.WriteAllText(SourcePath, source);

            RspPath = Path.Combine(directory.FullName, "App.rsp");
            var lines = extraRspLines?.ToList() ?? new System.Collections.Generic.List<string>();
            if (includeAnalyzer)
            {
                lines.Add($"/gsanalyzer:{typeof(Adr0169LanguageServerProbeAnalyzer).Assembly.Location}");
            }

            File.WriteAllLines(RspPath, lines);

            Project = new ProjectState(Path.Combine(directory.FullName, "App.gsproj"))
            {
                ReferenceSourcePath = RspPath,
            };
            Project.UpdateFile(SourcePath, source);
        }

        public string SourcePath { get; }

        public string RspPath { get; }

        public ProjectState Project { get; }

        public void Dispose()
        {
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
/// The probe analyzer the language server discovers from this test assembly:
/// warns TESTLSA01 on every call expression.
/// </summary>
[GSharpDiagnosticAnalyzer]
public sealed class Adr0169LanguageServerProbeAnalyzer : GSharpDiagnosticAnalyzer
{
    private static readonly DiagnosticDescriptor Rule = new(
        "TESTLSA01",
        "LS probe",
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
            ctx => ctx.ReportDiagnostic(GSharp.Core.CodeAnalysis.Diagnostic.Create(Rule, ctx.Node.Location)),
            SyntaxKind.CallExpression);
    }
}
