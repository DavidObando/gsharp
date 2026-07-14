// <copyright file="AnalyzerTestHelper.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Xunit;

namespace GSharp.InternalAnalyzers.Tests;

internal static class AnalyzerTestHelper
{
    public static async Task AssertDiagnosticsAsync(DiagnosticAnalyzer analyzer, string source, params string[] diagnosticIds)
    {
        var expectedLocations = new List<(int Line, int Column)>();
        var cleanSource = StripMarkers(source, expectedLocations);
        var tree = CSharpSyntaxTree.ParseText(cleanSource, new CSharpParseOptions(LanguageVersion.Preview));
        var compilation = CSharpCompilation.Create(
            "AnalyzerTests",
            new[] { tree },
            GetReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var diagnostics = await compilation.WithAnalyzers(ImmutableArray.Create(analyzer)).GetAnalyzerDiagnosticsAsync();
        diagnostics = diagnostics.OrderBy(d => d.Location.SourceSpan.Start).ToImmutableArray();

        Assert.Equal(diagnosticIds, diagnostics.Select(d => d.Id));
        Assert.Equal(expectedLocations.Count, diagnostics.Length);
        for (var i = 0; i < expectedLocations.Count; i++)
        {
            var lineSpan = diagnostics[i].Location.GetLineSpan();
            Assert.Equal(expectedLocations[i].Line, lineSpan.StartLinePosition.Line + 1);
            Assert.Equal(expectedLocations[i].Column, lineSpan.StartLinePosition.Character + 1);
        }
    }

    private static string StripMarkers(string source, List<(int Line, int Column)> expectedLocations)
    {
        var result = new System.Text.StringBuilder(source.Length);
        var line = 1;
        var column = 1;
        for (var i = 0; i < source.Length; i++)
        {
            if (i + 1 < source.Length && source[i] == '[' && source[i + 1] == '|')
            {
                expectedLocations.Add((line, column));
                i++;
                continue;
            }

            if (i + 1 < source.Length && source[i] == '|' && source[i + 1] == ']')
            {
                i++;
                continue;
            }

            result.Append(source[i]);
            if (source[i] == '\n')
            {
                line++;
                column = 1;
            }
            else
            {
                column++;
            }
        }

        return result.ToString();
    }

    private static MetadataReference[] GetReferences()
    {
        var trustedPlatformAssemblies = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES");
        var needed = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "System.Collections.Concurrent.dll",
            "System.Collections.dll",
            "System.Private.CoreLib.dll",
            "System.Reflection.dll",
            "System.Runtime.dll",
        };

        return trustedPlatformAssemblies.Split(Path.PathSeparator)
            .Where(path => needed.Contains(Path.GetFileName(path)))
            .Select(path => MetadataReference.CreateFromFile(path))
            .ToArray();
    }
}
