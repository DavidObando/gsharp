// <copyright file="Issue4677NonVirtualClassMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using System.Threading.Tasks;
using GSharpCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharpSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharpSourceText = GSharp.Core.CodeAnalysis.Text.SourceText;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4677: ordinary methods on G# classes must have the same CLR
/// virtuality metadata as equivalent C# methods. ADR-0017 specifies that
/// methods are non-virtual unless declared <c>open</c>.
/// </summary>
/// <remarks>
/// ADR-0154 witness: on the pre-fix compiler, the two ordinary-method rows
/// failed with <c>Virtual | NewSlot | Final</c> present, while the open-method
/// control passed. The fixed compiler passes all three rows. This fixture
/// compares MethodDef attributes from both compilers.
/// The four iterator rows were red at d664fdaf0: all seven sync / nine async
/// interface methods lacked their virtual slots. They pass with the fix,
/// including interface maps and enumeration through closed generic types.
/// </remarks>
public sealed class Issue4677NonVirtualClassMethodEmitTests
{
    private const string GSharpSource = """
        package MethodParity

        public class Closed {
            public func Plain() int32 { return 1 }
        }

        open class OpenClass {
            public func Plain() int32 { return 1 }
            open func Extensible() int32 { return 2 }
        }
        """;

    private const string CSharpSource = """
        namespace MethodParity;

        public sealed class Closed {
            public int Plain() => 1;
        }

        public class OpenClass {
            public int Plain() => 1;
            public virtual int Extensible() => 2;
        }
        """;

    [Theory]
    [InlineData("Closed", "Plain")]
    [InlineData("OpenClass", "Plain")]
    [InlineData("OpenClass", "Extensible")]
    public void InstanceMethodAttributes_MatchEquivalentCSharp(string typeName, string methodName)
    {
        var gsharp = EmitGSharp();
        var csharp = EmitCSharp();

        var gsharpAttributes = FindMethod(gsharp, typeName, methodName);
        var csharpAttributes = FindMethod(csharp, typeName, methodName);

        Assert.Equal(csharpAttributes, gsharpAttributes);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task IteratorInterfaceMethods_KeepVirtualSlots(bool isAsync, bool generic)
    {
        var element = generic ? "T" : "int32";
        var source = $$"""
            package IteratorSlots
            import System.Threading.Tasks
            {{(isAsync ? "async " : "")}}func Values{{(generic ? "[T]" : "")}}(value {{element}}) sequence[{{element}}] {
                {{(isAsync ? "await Task.Delay(1)" : "")}}
                yield value
            }
            """;
        var image = EmitGSharp(source);

        using (var pe = new PEReader(new MemoryStream(image)))
        {
            var metadata = pe.GetMetadataReader();
            var stateMachine = metadata.TypeDefinitions
                .Select(metadata.GetTypeDefinition)
                .Single(type => metadata.GetString(type.Name).StartsWith("<Values>d__", StringComparison.Ordinal));
            var methods = stateMachine.GetMethods()
                .Select(metadata.GetMethodDefinition)
                .Where(method => metadata.GetString(method.Name) != ".ctor")
                .ToArray();
            Assert.Equal(isAsync ? 9 : 7, methods.Length);
            Assert.All(methods, method => Assert.Equal(
                MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.Virtual
                    | MethodAttributes.NewSlot | MethodAttributes.Final,
                method.Attributes));
        }

        var context = new AssemblyLoadContext(nameof(IteratorInterfaceMethods_KeepVirtualSlots), isCollectible: true);
        try
        {
            using var stream = new MemoryStream(image);
            var assembly = context.LoadFromStream(stream);
            var types = assembly.GetTypes();
            var stateMachine = types.Single(type => type.Name.StartsWith("<Values>d__", StringComparison.Ordinal));
            if (generic)
            {
                stateMachine = stateMachine.MakeGenericType(typeof(int));
            }

            var interfaces = stateMachine.GetInterfaces();
            Assert.Equal(5, interfaces.Length);
            Assert.All(interfaces, type =>
            {
                var targets = stateMachine.GetInterfaceMap(type).TargetMethods;
                Assert.NotEmpty(targets);
                Assert.All(targets, method => Assert.True(method.IsVirtual && method.IsFinal));
            });

            var kickoff = types.Single(type => type.Name == "<Program>").GetMethod("Values");
            Assert.NotNull(kickoff);
            if (generic)
            {
                kickoff = kickoff.MakeGenericMethod(typeof(int));
            }

            var values = new List<int>();
            var result = kickoff.Invoke(null, new object[] { 7 });
            if (isAsync)
            {
                await foreach (var value in Assert.IsAssignableFrom<IAsyncEnumerable<int>>(result))
                {
                    values.Add(value);
                }
            }
            else
            {
                values.AddRange(Assert.IsAssignableFrom<IEnumerable<int>>(result));
            }

            Assert.Equal(new[] { 7 }, values);
        }
        finally
        {
            context.Unload();
        }
    }

    private static byte[] EmitGSharp(string source = GSharpSource)
    {
        using var stream = new MemoryStream();
        var tree = GSharpSyntaxTree.Parse(GSharpSourceText.From(source));
        var result = new GSharpCompilation(tree).Emit(stream);
        Assert.True(
            result.Success,
            "G# fixture should compile: " + string.Join("; ", result.Diagnostics.Select(d => d.ToString())));
        return stream.ToArray();
    }

    private static byte[] EmitCSharp()
    {
        using var stream = new MemoryStream();
        var trustedAssemblies = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        var references = trustedAssemblies?.Split(Path.PathSeparator)
            .Where(File.Exists)
            .Select(path => MetadataReference.CreateFromFile(path))
            .ToArray() ?? new MetadataReference[0];
        Assert.NotEmpty(references);

        var compilation = CSharpCompilation.Create(
            "MethodParity",
            new[] { CSharpSyntaxTree.ParseText(CSharpSource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var result = compilation.Emit(stream);
        Assert.True(
            result.Success,
            "C# fixture should compile: " + string.Join("; ", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => d.ToString())));
        return stream.ToArray();
    }

    private static MethodAttributes FindMethod(byte[] image, string typeName, string methodName)
    {
        using var stream = new MemoryStream(image);
        using var peReader = new PEReader(stream);
        var metadata = peReader.GetMetadataReader();
        var type = metadata.TypeDefinitions
            .Select(metadata.GetTypeDefinition)
            .Single(definition => metadata.GetString(definition.Name) == typeName);
        return type.GetMethods()
            .Select(metadata.GetMethodDefinition)
            .Single(method => metadata.GetString(method.Name) == methodName)
            .Attributes;
    }
}
