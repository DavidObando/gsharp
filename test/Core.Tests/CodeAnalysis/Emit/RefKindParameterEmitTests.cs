// <copyright file="RefKindParameterEmitTests.cs" company="GSharp">
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
/// ADR-0060: end-to-end emit tests for user-defined functions with <c>ref</c>,
/// <c>out</c>, and <c>in</c> parameters. Each test compiles a G# program that
/// declares a ref-kind-parameter function and exercises it through the various
/// call-site argument forms (lvalue, <c>out var</c>, <c>out let</c>, <c>out _</c>),
/// then asserts both runtime behaviour and emitted-metadata shape.
/// </summary>
public class RefKindParameterEmitTests
{
    [Fact]
    public void RefParameter_Increment_Updates_CallerVariable()
    {
        const string Source = @"package RefIncrement
import System

func bump(ref counter int32, by int32) {
    counter = counter + by
}

var n = 5
bump(&n, 10)
Console.WriteLine(n)
";
        var output = CompileAndRun(Source, "RefIncrement");
        Assert.Contains("15", output);
    }

    [Fact]
    public void OutParameter_AssignedFromBody_FlowsBackToCaller()
    {
        const string Source = @"package OutAssign
import System

func setTo42(out result int32) {
    result = 42
}

var r = 0
setTo42(&r)
Console.WriteLine(r)
";
        var output = CompileAndRun(Source, "OutAssign");
        Assert.Contains("42", output);
    }

    [Fact]
    public void OutVar_InlineDeclaration_ScopedToCallerBody()
    {
        const string Source = @"package OutVar
import System

func produce(out value int32) {
    value = 7
}

produce(out var x)
Console.WriteLine(x)
";
        var output = CompileAndRun(Source, "OutVar");
        Assert.Contains("7", output);
    }

    [Fact]
    public void OutLet_InlineDeclaration_ProducesReadOnlyLocal()
    {
        const string Source = @"package OutLet
import System

func produce(out value int32) {
    value = 99
}

produce(out let x)
Console.WriteLine(x)
";
        var output = CompileAndRun(Source, "OutLet");
        Assert.Contains("99", output);
    }

    [Fact]
    public void OutDiscard_DropsValueWithoutBinding()
    {
        const string Source = @"package OutDiscard
import System

func produce(out value int32) {
    value = 123
}

produce(out _)
Console.WriteLine(""ok"")
";
        var output = CompileAndRun(Source, "OutDiscard");
        Assert.Contains("ok", output);
    }

    [Fact]
    public void InParameter_ReadFromBody_SeesCallerValue()
    {
        const string Source = @"package InRead
import System

func doubleIt(in source int32) int32 {
    return source + source
}

var v = 21
Console.WriteLine(doubleIt(in v))
";
        var output = CompileAndRun(Source, "InRead");
        Assert.Contains("42", output);
    }

    [Fact]
    public void RefParameter_MetadataShape_IsByRef_NotOutNotIn()
    {
        const string Source = @"package RefMeta
import System

func touch(ref x int32) {
    x = 0
}

var n = 0
touch(&n)
";
        var asm = CompileToAssembly(Source, "RefMeta");
        var touch = FindStatic(asm, "touch");
        var p = touch.GetParameters()[0];
        Assert.True(p.ParameterType.IsByRef, "ref parameter must be ByRef");
        Assert.False(p.IsOut, "ref parameter must not be [Out]");
        Assert.False(p.IsIn, "ref parameter must not be [In]");
    }

    [Fact]
    public void OutParameter_MetadataShape_IsByRef_AndOut()
    {
        const string Source = @"package OutMeta
import System

func produce(out x int32) {
    x = 1
}

var n = 0
produce(&n)
";
        var asm = CompileToAssembly(Source, "OutMeta");
        var produce = FindStatic(asm, "produce");
        var p = produce.GetParameters()[0];
        Assert.True(p.ParameterType.IsByRef, "out parameter must be ByRef");
        Assert.True(p.IsOut, "out parameter must carry [Out]");
        Assert.False(p.IsIn, "out parameter must not carry [In]");
    }

    [Fact]
    public void InParameter_MetadataShape_IsByRef_AndIn_AndIsReadOnlyModreq()
    {
        const string Source = @"package InMeta
import System

func consume(in x int32) int32 {
    return x
}

var n = 5
Console.WriteLine(consume(in n))
";
        var asm = CompileToAssembly(Source, "InMeta");
        var consume = FindStatic(asm, "consume");
        var p = consume.GetParameters()[0];
        Assert.True(p.ParameterType.IsByRef, "in parameter must be ByRef");
        Assert.True(p.IsIn, "in parameter must carry [In]");
        Assert.False(p.IsOut, "in parameter must not carry [Out]");

        // ADR-0060 §6 / Roslyn parity: `in` parameters carry a
        // modreq(System.Runtime.CompilerServices.IsReadOnlyAttribute) on the
        // by-ref signature element. GetRequiredCustomModifiers surfaces it.
        var modreqs = p.GetRequiredCustomModifiers();
        Assert.Contains(modreqs, t => t.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute");
    }

    [Fact]
    public void RefAndOut_Compose_With_PlainParameters_InSameSignature()
    {
        const string Source = @"package Mixed
import System

func compute(a int32, ref b int32, out c int32, d int32) {
    c = a + b + d
    b = b * 2
}

var bIn = 3
var cOut = 0
compute(1, &bIn, &cOut, 5)
Console.WriteLine(bIn)
Console.WriteLine(cOut)
";
        var output = CompileAndRun(Source, "Mixed");
        Assert.Contains("6", output);
        Assert.Contains("9", output);
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
                entry!.Invoke(null, parameters: null);
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

    private static Assembly CompileToAssembly(string source, string contextName)
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
        return loadContext.LoadFromStream(peStream);
    }

    private static MethodInfo FindStatic(Assembly asm, string name)
    {
        foreach (var t in asm.GetTypes())
        {
            var m = t.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (m != null)
            {
                return m;
            }
        }

        throw new InvalidOperationException($"No static method named '{name}' in emitted assembly.");
    }
}
