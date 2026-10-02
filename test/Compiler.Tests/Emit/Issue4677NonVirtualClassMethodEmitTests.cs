// <copyright file="Issue4677NonVirtualClassMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
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

    private static byte[] EmitGSharp()
    {
        using var stream = new MemoryStream();
        var tree = GSharpSyntaxTree.Parse(GSharpSourceText.From(GSharpSource));
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
