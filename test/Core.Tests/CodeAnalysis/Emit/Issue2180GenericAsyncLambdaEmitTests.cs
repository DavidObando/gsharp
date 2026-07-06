// <copyright file="Issue2180GenericAsyncLambdaEmitTests.cs" company="GSharp">
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

/// <summary>
/// Issue #2180: a generic async lambda captured inside a generic method used to
/// emit a malformed state machine — the capture-box type argument inside
/// <c>MoveNext</c> referenced a method type-variable (<c>MVar</c>) with no slot
/// in the state-machine context (BadImageFormatException at runtime), and the
/// async result type was erased to <c>object</c> (silently miscompiling a
/// value-type result via a bogus <c>(Task[T])(object)</c> reference-cast). These
/// end-to-end tests run the emitted assembly to prove both the metadata and the
/// returned value are correct.
/// </summary>
public class Issue2180GenericAsyncLambdaEmitTests
{
    [Fact]
    public void GenericAsyncLambda_ValueTypeResult_ReturnsCapturedValue()
    {
        const string Source = @"package R
import System
import System.Threading.Tasks

func RunG[T](val T) Task[T] {
    let f = async () -> {
        return val
    }
    return f()
}

Console.WriteLine(RunG[int32](42).Result)
";
        Assert.Equal("42", CompileAndRun(Source, "Issue2180Value").Trim());
    }

    [Fact]
    public void GenericAsyncLambda_ReferenceTypeResult_ReturnsCapturedValue()
    {
        const string Source = @"package R
import System
import System.Threading.Tasks

func RunG[T](val T) Task[T] {
    let f = async () -> {
        return val
    }
    return f()
}

Console.WriteLine(RunG[String](""hello"").Result)
";
        Assert.Equal("hello", CompileAndRun(Source, "Issue2180Ref").Trim());
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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
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
