// <copyright file="StubTestSupport.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.GeneratorHost.Tests;

/// <summary>
/// Shared helpers for tests that inspect the ADR-0145 §B C# stub: project G#
/// source to the stub, bind the stub the way a generator sees it, and locate the
/// real targeting-pack Regex generator.
/// </summary>
internal static class StubTestSupport
{
    /// <summary>Projects <paramref name="gsSource"/> to the declaration-only C# stub.</summary>
    /// <param name="gsSource">The G# source.</param>
    /// <returns>The rendered stub.</returns>
    public static string Project(string gsSource)
    {
        var compilation = new Compilation(GsSyntaxTree.Parse(SourceText.From(gsSource, "User.gs")));
        return GsToCSharpProjection.ProjectToCSharp(compilation);
    }

    /// <summary>
    /// Binds <paramref name="stub"/> against the runtime references, the same
    /// shape <see cref="GeneratorRunner"/> hands a generator.
    /// </summary>
    /// <param name="stub">The stub C#.</param>
    /// <returns>The C# compilation.</returns>
    public static CSharpCompilation BindStub(string stub)
    {
        var tree = CSharpSyntaxTree.ParseText(stub, new CSharpParseOptions(LanguageVersion.Latest), path: "GsgenStubs.cs");
        return CSharpCompilation.Create(
            "StubUnderTest",
            new[] { tree },
            CSharpProjectLoader.RuntimeReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));
    }

    /// <summary>Asserts that <paramref name="stub"/> parses as C# with no syntax errors.</summary>
    /// <param name="stub">The stub C#.</param>
    public static void AssertParses(string stub)
    {
        var errors = CSharpSyntaxTree.ParseText(stub, new CSharpParseOptions(LanguageVersion.Latest))
            .GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .ToList();
        Assert.True(errors.Count == 0, "Stub did not parse as valid C#:\n" + stub + "\n\n" + string.Join("\n", errors));
    }

    /// <summary>
    /// Returns the path of the <c>System.Text.RegularExpressions.Generator</c>
    /// that ships in the running SDK's <c>Microsoft.NETCore.App.Ref</c>
    /// targeting pack — the same asset the Gsharp.NET.Sdk hands gsgen for a
    /// project that references no package (see e2etests/gsgen-e2e.sh).
    /// </summary>
    /// <returns>The generator assembly path.</returns>
    public static string RegexGeneratorPath()
    {
        // The shared framework lives at {dotnet_root}/shared/Microsoft.NETCore.App/{version}/.
        var runtimeDir = new DirectoryInfo(Path.GetDirectoryName(typeof(object).Assembly.Location));
        var dotnetRoot = runtimeDir.Parent?.Parent?.Parent?.FullName;
        var packs = dotnetRoot == null ? null : Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        var path = packs != null && Directory.Exists(packs)
            ? Directory.GetDirectories(packs)
                .Select(dir => Path.Combine(dir, "analyzers", "dotnet", "cs", "System.Text.RegularExpressions.Generator.dll"))
                .Where(File.Exists)
                .OrderByDescending(candidate => Version.TryParse(Directory.GetParent(candidate).Parent.Parent.Parent.Name.Split('-')[0], out var v) ? v : new Version(0, 0))
                .FirstOrDefault()
            : null;
        Assert.True(path != null, $"no System.Text.RegularExpressions.Generator.dll under '{packs}'");
        return path;
    }
}
