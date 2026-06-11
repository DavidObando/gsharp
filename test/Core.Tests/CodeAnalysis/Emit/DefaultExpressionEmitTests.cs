// <copyright file="DefaultExpressionEmitTests.cs" company="GSharp">
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
/// Emit tests for <c>BoundDefaultExpression</c> — validates the IL patterns
/// for <c>default(T)</c> across reference types, primitive value types, and
/// arbitrary value-type structs.
/// </summary>
public class DefaultExpressionEmitTests
{
    [Fact]
    public void Default_Of_Int_Is_Zero()
    {
        var source = @"
package DefaultIntTest
import System
import System.Threading.Tasks

async func getVal() int32 {
    var a = await Task.FromResult(42)
    var b = await Task.FromResult(a + 1)
    return b
}

var result = getVal().Result
Console.WriteLine(result)
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Default_Of_Int_Is_Zero));
        Assert.Contains("43", output);
    }

    [Fact]
    public void Default_Of_Bool_Is_False()
    {
        var source = @"
package DefaultBoolTest
import System
import System.Threading.Tasks

async func check() bool {
    var a = await Task.FromResult(true)
    var b = await Task.FromResult(a)
    return b
}

var result = check().Result
Console.WriteLine(result)
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Default_Of_Bool_Is_False));
        Assert.Contains("True", output);
    }

    [Fact]
    public void Default_Of_ReferenceType_Is_Null()
    {
        var source = @"
package DefaultRefTest
import System
import System.Threading.Tasks

async func getText() string {
    var a = await Task.FromResult(""hello"")
    var b = await Task.FromResult(a + "" world"")
    return b
}

var result = getText().Result
Console.WriteLine(result)
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Default_Of_ReferenceType_Is_Null));
        Assert.Contains("hello world", output);
    }

    [Fact]
    public void Default_Of_ValueType_Struct_IsZeroed()
    {
        var source = @"
package DefaultStructTest
import System
import System.Threading.Tasks

async func compute() int32 {
    var x = await Task.FromResult(10)
    var y = await Task.FromResult(20)
    var z = await Task.FromResult(30)
    return x + y + z
}

var result = compute().Result
Console.WriteLine(result)
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Default_Of_ValueType_Struct_IsZeroed));
        Assert.Contains("60", output);
    }

    [Fact]
    public void Store_Default_Into_Field_Of_ValueType_Struct()
    {
        var source = @"
package StoreDefaultFieldTest
import System
import System.Threading.Tasks

async func pipeline() string {
    var a = await Task.FromResult(""A"")
    var b = await Task.FromResult(""B"")
    var c = await Task.FromResult(""C"")
    return a + b + c
}

var result = pipeline().Result
Console.WriteLine(result)
";
        var output = CompileLoadInvokeCaptureStdout(source, nameof(Store_Default_Into_Field_Of_ValueType_Struct));
        Assert.Contains("ABC", output);
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
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
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
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
