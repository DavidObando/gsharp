// <copyright file="Issue2304InterfaceObjectMemberTests.cs" company="GSharp">
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

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2304: <c>System.Object</c>'s universal instance members
/// (<c>ToString</c>, <c>GetHashCode</c>, <c>Equals(object)</c>, <c>GetType</c>)
/// were not resolvable through an INTERFACE-typed receiver — neither a
/// source-declared <see cref="InterfaceSymbol"/> nor an imported interface (an
/// <see cref="ImportedTypeSymbol"/> whose <c>ClrType.IsInterface</c> is
/// <see langword="true"/>) — even though every interface implicitly derives
/// from <c>System.Object</c> for member-access purposes at the CLR/C# layer.
/// The call previously dead-ended at <c>GS0159</c> ("Cannot find function").
/// These tests cover both a source interface and an imported (cross-assembly)
/// interface, mirroring a class-typed receiver (which already worked) as a
/// baseline sanity check.
/// </summary>
public class Issue2304InterfaceObjectMemberTests
{
    [Fact]
    public void SourceInterface_ToString_Binds()
    {
        const string source = """
            package t
            interface IThing {
                prop Id int32
            }
            func Describe(x IThing) string {
                return x.ToString()
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void SourceInterface_GetHashCode_Binds()
    {
        const string source = """
            package t
            interface IThing {
                prop Id int32
            }
            func HashOf(x IThing) int32 {
                return x.GetHashCode()
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void SourceInterface_Equals_Binds()
    {
        const string source = """
            package t
            interface IThing {
                prop Id int32
            }
            func AreEqual(x IThing, y IThing) bool {
                return x.Equals(y)
            }
            """;
        Assert.Empty(Bind(source));
    }

    [Fact]
    public void SourceInterface_ObjectMembers_ProduceExpectedValuesAtRuntime()
    {
        const string source = """
            package t
            import System
            interface IThing {
                prop Id int32
            }
            class Widget : IThing {
                prop Id int32
            }
            func Main() {
                var w IThing = Widget{ Id: 7 }
                Console.WriteLine(w.ToString())
                Console.WriteLine(w.Equals(w))
                Console.WriteLine(w.GetHashCode() == w.GetHashCode())
            }
            """;

        var output = CompileLoadInvokeCaptureStdout(source, "Issue2304-SourceInterface");
        var lines = output.Split(new[] { Environment.NewLine, "\n" }, StringSplitOptions.RemoveEmptyEntries);
        Assert.Contains("Widget", lines[0]);
        Assert.Equal("True", lines[1]);
        Assert.Equal("True", lines[2]);
    }

    [Fact]
    public void ImportedInterface_ToString_GetHashCode_Equals_Bind()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.ImportedInterface_ToString_GetHashCode_Equals_Bind),
            "namespace MyLib { public interface IThing { int Id { get; } } public class Entity { public int Id { get; set; } } }");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import MyLib

                func I1(x IThing) string {
                    return x.ToString()
                }

                func I2(x IThing) int32 {
                    return x.GetHashCode()
                }

                func I3(x IThing, y IThing) bool {
                    return x.Equals(y)
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void ImportedInterface_ObjectMembers_ProduceExpectedValuesAtRuntime()
    {
        var libraryPath = EmitCSharpLibrary(
            nameof(this.ImportedInterface_ObjectMembers_ProduceExpectedValuesAtRuntime),
            "namespace MyLib { public interface IThing { int Id { get; } } public class Entity : IThing { public int Id { get; set; } } }");

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        resolver.CurrentAssemblyName = "Consumer";

        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package Consumer
                import System
                import MyLib

                func Main() {
                    var e = Entity{ Id: 3 }
                    var x IThing = e
                    Console.WriteLine(x.ToString())
                    Console.WriteLine(x.Equals(x))
                    Console.WriteLine(x.GetHashCode() == x.GetHashCode())
                }
                """)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Consumer");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext("Issue2304-ImportedInterface", isCollectible: true);
        try
        {
            var libraryLoadContext = new AssemblyLoadContext("Issue2304-ImportedInterface-Lib", isCollectible: true);
            try
            {
                libraryLoadContext.LoadFromAssemblyPath(libraryPath);
                var libraryAssemblyName = Path.GetFileNameWithoutExtension(libraryPath);
                loadContext.Resolving += (ctx, name) => string.Equals(name.Name, libraryAssemblyName, StringComparison.Ordinal)
                    ? libraryLoadContext.LoadFromAssemblyPath(libraryPath)
                    : null;

                var asm = loadContext.LoadFromStream(peStream);
                var entry = asm.EntryPoint;
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

                var lines = captured.ToString().Split(new[] { Environment.NewLine, "\n" }, StringSplitOptions.RemoveEmptyEntries);
                Assert.Contains("Entity", lines[0]);
                Assert.Equal("True", lines[1]);
                Assert.Equal("True", lines[2]);
            }
            finally
            {
                libraryLoadContext.Unload();
            }
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static System.Collections.Generic.IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = GsSyntaxTree.Parse(SourceText.From(source));
        var compilation = new GsCompilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = GsSyntaxTree.Parse(SourceText.From(source));
        var compilation = new GsCompilation(tree);
        var result = compilation.Emit(peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var entry = asm.EntryPoint;
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

    private static string EmitCSharpLibrary(string caseName, string source)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2304", caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "MyLib2304.dll");

        var syntaxTree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "MyLib2304",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using (var peStream = File.Create(libraryPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        return libraryPath;
    }
}
