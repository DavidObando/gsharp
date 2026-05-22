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
}
