// <copyright file="Issue2899ThrowDeadCodeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2899: throw followed by dead code must emit valid IL when
/// definite-return accepts the enclosing non-void function.
/// </summary>
public class Issue2899ThrowDeadCodeEmitTests
{
    [Fact]
    public void ThrowFollowedByDeadCode_VerifiesLoadsAndRuns()
    {
        const string Source = """
            package Issue2899.Emit
            import System

            func Value() int32 {
                throw Exception("value")
                var dead = 1
            }

            func Assign(out value int32) {
                throw Exception("assign")
                value = 1
            }

            func Conditional(condition bool) int32 {
                if condition {
                    return 1
                }
                throw Exception("conditional")
                var dead = 2
            }

            public var result = 0
            try {
                Value()
            } catch (ex Exception) {
                result += 1
            }

            try {
                var value = 0
                Assign(out value)
            } catch (ex Exception) {
                result += 2
            }

            result += Conditional(true)
            try {
                Conditional(false)
            } catch (ex Exception) {
                result += 4
            }
            """;

        var assembly = CompileAndRun(Source);
        Assert.Equal(8, GetField(assembly, "result"));
    }

    private static Assembly CompileAndRun(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString())));

        var assemblyPath = Path.Combine(
            Directory.GetCurrentDirectory(),
            $"Issue2899_{Guid.NewGuid():N}.dll");
        try
        {
            File.WriteAllBytes(assemblyPath, peStream.ToArray());
            IlVerifier.Verify(assemblyPath);
        }
        finally
        {
            File.Delete(assemblyPath);
        }

        var assembly = EmittedFixture.Load(peStream.ToArray());
        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        var entry = program.GetMethod("<Main>$", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
        return assembly;
    }

    private static int GetField(Assembly assembly, string name)
    {
        var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
        return (int)program.GetField(name, BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
    }
}
