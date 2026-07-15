// <copyright file="StructuralProjectionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>Validates emitted ADR-0148 projection behavior.</summary>
public class StructuralProjectionEmitTests
{
    [Fact]
    public void ProjectionEmitsConstructorSafeSingleEvaluationCode()
    {
        var output = CompileAndRun(@"
import System
class Source { var Value int32 }
class Target {
    var Value int32
    private var Secret int32 = 91
    func ReadSecret() int32 { return Secret }
}
func Make() Source {
    creates = creates + 1
    return Source{Value: 7}
}
var creates = 0
let target Target = Make()
let changed = Target{ ...target, Value: 9 }
Console.WriteLine(target.Value)
Console.WriteLine(changed.Value)
Console.WriteLine(changed.ReadSecret())
Console.WriteLine(creates)
");

        Assert.Equal(
            "7" + Environment.NewLine
            + "9" + Environment.NewLine
            + "91" + Environment.NewLine
            + "1" + Environment.NewLine,
            output);
    }

    private static string CompileAndRun(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        peStream.Position = 0;

        var context = new AssemblyLoadContext("projection-run", isCollectible: true);
        try
        {
            var assembly = context.LoadFromStream(peStream);
            var programType = assembly.GetTypes().First(t => t.Name == "<Program>");
            var entry = programType.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            var savedOut = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry.Invoke(
                    null,
                    entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(savedOut);
            }

            return captured.ToString();
        }
        finally
        {
            context.Unload();
        }
    }
}
