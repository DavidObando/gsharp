// <copyright file="CatchElidedVariableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Regression tests for issue #420 (P3-6): <c>ReflectionMetadataEmitter.EmitCatchClauses</c>
/// previously assumed <c>BoundCatchClause.Variable</c> was non-null and had a
/// local slot allocated. If a future binder pass elides an unused catch
/// variable, the emitter would NRE and/or leave the exception object on the
/// evaluation stack producing unverifiable IL. These tests verify both the
/// normal positive path and the defensive <c>pop</c> path.
/// </summary>
public class CatchElidedVariableEmitTests
{
    [Fact]
    public void Normal_Catch_With_Variable_Still_Works()
    {
        const string Source = @"package CatchNormal
import System

func run() int32 {
    var result = 0
    try {
        var n = Int32.Parse(""bad"")
        result = n
    } catch (e Exception) {
        result = 42
    }
    return result
}

Console.WriteLine(run())
";
        var output = CompileAndRun(Source, "CatchNormal");
        Assert.Contains("42", output);
    }

    [Fact]
    public void Catch_With_Elided_Variable_Emits_Pop_And_Runs()
    {
        // Simulate a future binder pass that elides the catch variable: bind the
        // program normally then mutate every BoundCatchClause to drop its
        // Variable before emitting. Without the defensive Pop in EmitCatchClauses
        // this would either NRE during emit (Variable == null) or produce
        // unverifiable IL (exception object left on the evaluation stack on
        // handler entry).
        const string Source = @"package CatchElided
import System

func run() int32 {
    var result = 0
    try {
        var n = Int32.Parse(""bad"")
        result = n
    } catch (e Exception) {
        result = 42
    }
    return result
}

Console.WriteLine(run())
";
        var output = CompileAndRunMutated(Source, "CatchElided");
        Assert.Contains("42", output);
    }

    private static string CompileAndRun(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        return LoadAndExecute(peStream, contextName);
    }

    private static string CompileAndRunMutated(string source, string contextName)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        var syntaxDiagnostics = compilation.GlobalScope.Diagnostics;
        Assert.False(
            syntaxDiagnostics.Any(d => d.IsError),
            "no syntax errors: " + string.Join("; ", syntaxDiagnostics.Select(d => d.Message)));

        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope);
        Assert.False(
            program.Diagnostics.Any(d => d.IsError),
            "no binding errors: " + string.Join("; ", program.Diagnostics.Select(d => d.Message)));

        var mutated = 0;
        foreach (var body in program.Functions.Values)
        {
            var walker = new CatchClauseElider();
            walker.Visit(body);
            mutated += walker.MutatedCount;
        }

        Assert.True(mutated > 0, "expected to find at least one catch clause to mutate");

        using var peStream = new MemoryStream();
        ReflectionMetadataEmitter.Emit(program, peStream);
        return LoadAndExecute(peStream, contextName);
    }

    private sealed class CatchClauseElider : BoundTreeWalker
    {
        private static readonly FieldInfo VariableBackingField =
            typeof(BoundCatchClause).GetField(
                "<Variable>k__BackingField",
                BindingFlags.Instance | BindingFlags.NonPublic)!;

        public int MutatedCount { get; private set; }

        protected override void VisitTryStatement(BoundTryStatement node)
        {
            foreach (var clause in node.CatchClauses)
            {
                Assert.NotNull(VariableBackingField);
                if (VariableBackingField.GetValue(clause) is not null)
                {
                    VariableBackingField.SetValue(clause, null);
                    this.MutatedCount++;
                }
            }

            base.VisitTryStatement(node);
        }
    }

    private static string LoadAndExecute(MemoryStream peStream, string contextName)
    {
        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            catch (TargetInvocationException tie)
            {
                Console.SetOut(stdout);
                throw new Exception(
                    $"Entry point threw: {tie.InnerException?.GetType().Name}: {tie.InnerException?.Message}",
                    tie.InnerException);
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
