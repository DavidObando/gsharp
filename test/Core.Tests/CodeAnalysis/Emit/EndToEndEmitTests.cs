// <copyright file="EndToEndEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Phase 1 end-to-end emit tests: compile a tiny GSharp program, load the
/// produced PE bytes, and invoke the synthesized entry point. These pin the
/// behavior of <c>ReflectionMetadataEmitter</c> against real .NET load/execute
/// rather than just checking metadata shapes.
/// </summary>
public class EndToEndEmitTests
{
    private const string HelloWorldSource =
        "package HelloWorld\nimport System\nConsole.WriteLine(\"Hello, world!\")\n";

    [Fact]
    public void Emits_Valid_PE_For_HelloWorld()
    {
        using var peStream = new MemoryStream();
        var result = Compile(HelloWorldSource, peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        Assert.True(peReader.HasMetadata);

        var md = peReader.GetMetadataReader();
        Assert.True(md.IsAssembly);

        // <Module> + <Program>.
        Assert.Equal(2, md.TypeDefinitions.Count);

        // Entry point must be set in the corheader.
        var corHeader = peReader.PEHeaders.CorHeader;
        Assert.NotNull(corHeader);
        Assert.NotEqual(0, corHeader!.EntryPointTokenOrRelativeVirtualAddress);
    }

    [Fact]
    public void HelloWorld_Loads_And_Invokes_Entry_Point()
    {
        using var peStream = new MemoryStream();
        var result = Compile(HelloWorldSource, peStream);
        Assert.True(result.Success);

        peStream.Position = 0;

        var loadContext = new AssemblyLoadContext("EndToEndEmitTests-Hello", isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);

            var allTypes = asm.GetTypes();
            var programType = allTypes.FirstOrDefault(t => t.Name == "<Program>");
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

            Assert.Contains("Hello, world!", captured.ToString());
        }
        finally
        {
            loadContext.Unload();
        }
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

    [Fact]
    public void Emits_Arithmetic_With_Locals_And_BinaryOps()
    {
        const string Source = @"package Arith
import System
var x = 2 + 3 * 4
Console.WriteLine(x)
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Arith");
        Assert.Contains("14", output);
    }

    [Fact]
    public void Emits_User_Defined_Function_With_Digit_In_Param_Names()
    {
        // Exercises both BoundCallExpression emit AND issue #32 (digits in identifiers).
        const string Source = @"package UserFn
import System
func add(num1 int, num2 int) int {
    return num1 + num2
}
Console.WriteLine(add(2, 3))
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-UserFn");
        Assert.Contains("5", output);
    }

    [Fact]
    public void Emits_For_Loop_With_Branching()
    {
        const string Source = @"package Loop
import System
var sum = 0
for i := 1 ... 5 {
    sum = sum + i
}
Console.WriteLine(sum)
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Loop");
        Assert.Contains("10", output);
    }

    [Fact]
    public void Emits_If_Statement_With_Comparison()
    {
        const string Source = @"package Cond
import System
var x = 7
if x > 5 {
    Console.WriteLine(""big"")
} else {
    Console.WriteLine(""small"")
}
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Cond");
        Assert.Contains("big", output);
    }

    [Fact]
    public void Emits_String_Concatenation_With_Variable()
    {
        const string Source = @"package Concat
import System
var name = ""world""
Console.WriteLine(""hi "" + name)
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Concat");
        Assert.Contains("hi world", output);
    }

    [Fact]
    public void Emits_Recursive_User_Function()
    {
        const string Source = @"package Recurse
import System
func factorial(n int) int {
    if n <= 1 {
        return 1
    }
    return n * factorial(n - 1)
}
Console.WriteLine(factorial(5))
";
        var output = CompileLoadInvokeCaptureStdout(Source, "EndToEndEmitTests-Recurse");
        Assert.Contains("120", output);
    }

    [Fact]
    public void Emit_Is_Deterministic_For_Same_Source()
    {
        using var first = new MemoryStream();
        using var second = new MemoryStream();

        Assert.True(Compile(HelloWorldSource, first).Success);
        Assert.True(Compile(HelloWorldSource, second).Success);

        var firstBytes = first.ToArray();
        var secondBytes = second.ToArray();

        Assert.Equal(firstBytes.Length, secondBytes.Length);
        Assert.True(
            firstBytes.AsSpan().SequenceEqual(secondBytes),
            "two emits of the same source must produce byte-identical PEs (deterministic MVID + timestamp).");
    }

    [Fact]
    public void Emit_Produces_NonZero_Mvid_Derived_From_Content()
    {
        using var first = new MemoryStream();
        using var second = new MemoryStream();

        Assert.True(Compile(HelloWorldSource, first).Success);
        Assert.True(
            Compile(HelloWorldSource.Replace("Hello, world!", "Hi, world!"), second).Success);

        first.Position = 0;
        second.Position = 0;

        using var firstPe = new PEReader(first, PEStreamOptions.LeaveOpen);
        using var secondPe = new PEReader(second, PEStreamOptions.LeaveOpen);

        var firstMvid = firstPe.GetMetadataReader().GetGuid(firstPe.GetMetadataReader().GetModuleDefinition().Mvid);
        var secondMvid = secondPe.GetMetadataReader().GetGuid(secondPe.GetMetadataReader().GetModuleDefinition().Mvid);

        Assert.NotEqual(Guid.Empty, firstMvid);
        Assert.NotEqual(firstMvid, secondMvid);

        // Deterministic emit zeros out the PE TimeDateStamp (the content id's
        // stamp goes into the COFF header; both should differ across content).
        Assert.NotEqual(
            firstPe.PEHeaders.CoffHeader.TimeDateStamp,
            secondPe.PEHeaders.CoffHeader.TimeDateStamp);
    }

    [Fact]
    public void Emit_Reference_Assembly_Has_No_Method_Bodies_And_Carries_RefAsmAttribute()
    {
        const string Source = @"package RefAsm
import System
func add(a int, b int) int { return a + b }
Console.WriteLine(add(2, 3))
";
        using var peStream = new MemoryStream();
        using var refStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream, refStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        refStream.Position = 0;
        using var refPe = new PEReader(refStream, PEStreamOptions.LeaveOpen);
        var md = refPe.GetMetadataReader();

        // No entry point should be set on a metadata-only PE.
        Assert.Equal(0, refPe.PEHeaders.CorHeader.EntryPointTokenOrRelativeVirtualAddress);

        // Every method definition must have RVA 0 — no IL body.
        foreach (var mdh in md.MethodDefinitions)
        {
            var method = md.GetMethodDefinition(mdh);
            Assert.Equal(0, method.RelativeVirtualAddress);
        }

        // The assembly must carry [ReferenceAssemblyAttribute].
        var assembly = md.GetAssemblyDefinition();
        var foundRefAsm = false;
        foreach (var cah in assembly.GetCustomAttributes())
        {
            var ca = md.GetCustomAttribute(cah);
            var ctor = ca.Constructor;
            string typeName = null;
            if (ctor.Kind == HandleKind.MemberReference)
            {
                var mr = md.GetMemberReference((MemberReferenceHandle)ctor);
                if (mr.Parent.Kind == HandleKind.TypeReference)
                {
                    var tr = md.GetTypeReference((TypeReferenceHandle)mr.Parent);
                    typeName = md.GetString(tr.Namespace) + "." + md.GetString(tr.Name);
                }
            }

            if (typeName == "System.Runtime.CompilerServices.ReferenceAssemblyAttribute")
            {
                foundRefAsm = true;
                break;
            }
        }

        Assert.True(foundRefAsm, "metadata-only emit must mark the assembly with ReferenceAssemblyAttribute.");

        // The runtime PE should still carry IL and an entry point.
        peStream.Position = 0;
        using var runtimePe = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        Assert.NotEqual(0, runtimePe.PEHeaders.CorHeader.EntryPointTokenOrRelativeVirtualAddress);
    }
}
