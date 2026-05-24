// <copyright file="AspirationalSamplesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.LanguageConformance;

/// <summary>
/// Phase 5 exit / ADR-0010 (aspirational samples). Every <c>*.gs</c> under
/// <c>samples/aspirational/</c> that has a sibling <c>*.golden</c> is parsed,
/// bound, and evaluated through the interpreter; captured stdout is compared
/// bit-for-bit against the golden.
/// </summary>
/// <remarks>
/// The conformance harness in <c>test/Compiler.Tests</c> compiles top-level
/// <c>samples/*.gs</c> through <c>gsc</c> and runs the emitted assembly. That
/// harness explicitly skips <c>aspirational/</c> because the features
/// exercised there (Phase 5 concurrency / async) have emit deferred per
/// ADR-0022 §Consequences and ADR-0023 §Emit. The interpreter is the
/// authoritative semantic backend (per the design doc D10 cross-cutting
/// rule), so coverage of these samples lives here.
/// </remarks>
public class AspirationalSamplesTests
{
    public static IEnumerable<object[]> Samples()
    {
        var dir = LocateAspirationalDirectory();
        if (dir is null)
        {
            yield break;
        }

        foreach (var gs in Directory.EnumerateFiles(dir, "*.gs", SearchOption.TopDirectoryOnly).OrderBy(p => p))
        {
            var golden = Path.ChangeExtension(gs, ".golden");
            if (File.Exists(golden))
            {
                yield return new object[] { Path.GetFileName(gs) };
            }
        }
    }

    [Theory]
    [MemberData(nameof(Samples))]
    public void Sample_RunsOnInterpreter_MatchesGolden(string sampleName)
    {
        var dir = LocateAspirationalDirectory();
        Assert.NotNull(dir);

        var samplePath = Path.Combine(dir!, sampleName);
        var goldenPath = Path.ChangeExtension(samplePath, ".golden");
        Assert.True(File.Exists(samplePath), $"missing sample at {samplePath}");
        Assert.True(File.Exists(goldenPath), $"missing golden at {goldenPath}");

        var source = File.ReadAllText(samplePath);
        var expected = File.ReadAllText(goldenPath).Replace("\r\n", "\n");

        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        var prevOut = Console.Out;
        var captured = new StringWriter();
        Console.SetOut(captured);
        EvaluationResult result;
        try
        {
            result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        Assert.True(
            result.Diagnostics.IsEmpty,
            $"sample {sampleName} produced diagnostics:\n  " +
            string.Join("\n  ", result.Diagnostics.Select(d => d.ToString())));
        var actual = captured.ToString().Replace("\r\n", "\n");
        Assert.Equal(expected, actual);
    }

    private static string LocateAspirationalDirectory()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(AspirationalSamplesTests).Assembly.Location) !);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "samples", "aspirational");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
