// <copyright file="Issue2410ImportedDelegateAssignmentEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Runtime.Loader;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public class Issue2410ImportedDelegateAssignmentEmitTests
{
    [Fact]
    public void ImportedStaticDelegateFieldAndProperty_UntypedLambdas_RunAndVerify()
    {
        var output = CompileAndRun(
            """
            package App
            import System
            import Lib2410Emit

            func Main() {
                Holder.StaticField = (x) -> x + 1
                Holder.StaticProperty = (x) -> x + 2
                Console.WriteLine(Holder.InvokeStaticField(10))
                Console.WriteLine(Holder.InvokeStaticProperty(10))
            }
            """,
            nameof(ImportedStaticDelegateFieldAndProperty_UntypedLambdas_RunAndVerify));

        Assert.Equal("11\n12\n", output);
    }

    [Fact]
    public void ImportedDelegateAssignment_SiblingMemberPaths_RunAndVerify()
    {
        var output = CompileAndRun(
            """
            package App
            import System
            import Lib2410Emit

            func Same(h Holder) Holder -> h

            func Main() {
                let h = Holder()
                h.InstanceField = (x) -> x + 3
                Same(h).InstanceProperty = (x) -> x + 4
                GenericHolder[int32].StaticField = (x) -> x + 5
                GenericHolder[int32].StaticProperty = (x) -> x + 6
                Console.WriteLine(h.InvokeInstanceField(10))
                Console.WriteLine(h.InvokeInstanceProperty(10))
                Console.WriteLine(GenericHolder[int32].InvokeStaticField(10))
                Console.WriteLine(GenericHolder[int32].InvokeStaticProperty(10))
            }
            """,
            nameof(ImportedDelegateAssignment_SiblingMemberPaths_RunAndVerify));

        Assert.Equal("13\n14\n15\n16\n", output);
    }

    private static string CompileAndRun(string source, string caseName)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue2410Emit", caseName);
        Directory.CreateDirectory(directory);
        var libraryPath = EmitCSharpLibrary(directory);
        var consumerPath = Path.Combine(directory, "Consumer.dll");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)));
        using (var stream = File.Create(consumerPath))
        {
            var result = compilation.Emit(stream, pdbStream: null, refStream: null, assemblyName: "Issue2410." + caseName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var context = new AssemblyLoadContext("Issue2410." + caseName, isCollectible: true);
        try
        {
            context.Resolving += (_, name) => name.Name == "Lib2410Emit"
                ? context.LoadFromAssemblyPath(libraryPath)
                : null;
            var assembly = context.LoadFromAssemblyPath(consumerPath);
            var output = Console.Out;
            using var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                assembly.EntryPoint!.Invoke(null, null);
            }
            finally
            {
                Console.SetOut(output);
            }

            return captured.ToString().Replace("\r\n", "\n");
        }
        finally
        {
            context.Unload();
        }
    }

    private static string EmitCSharpLibrary(string directory)
    {
        var libraryPath = Path.Combine(directory, "Lib2410Emit.dll");
        const string source = """
            namespace Lib2410Emit
            {
                public delegate int Mapper(int value);

                public sealed class Holder
                {
                    public static Mapper StaticField;
                    public static Mapper StaticProperty { get; set; }
                    public Mapper InstanceField;
                    public Mapper InstanceProperty { get; set; }

                    public static int InvokeStaticField(int value) => StaticField(value);
                    public static int InvokeStaticProperty(int value) => StaticProperty(value);
                    public int InvokeInstanceField(int value) => InstanceField(value);
                    public int InvokeInstanceProperty(int value) => InstanceProperty(value);
                }

                public sealed class GenericHolder<T>
                {
                    public static Mapper StaticField;
                    public static Mapper StaticProperty { get; set; }
                    public static int InvokeStaticField(int value) => StaticField(value);
                    public static int InvokeStaticProperty(int value) => StaticProperty(value);
                }
            }
            """;

        var syntaxTree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest));
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "Lib2410Emit",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var stream = File.Create(libraryPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return libraryPath;
    }
}
