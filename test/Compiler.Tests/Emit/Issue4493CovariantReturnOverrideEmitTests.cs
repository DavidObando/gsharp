// <copyright file="Issue4493CovariantReturnOverrideEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4493CovariantReturnOverrideEmitTests
{
    [Fact]
    public void SourcePropertyCovariantReturn_LoadsAndDispatchesThroughBaseSlot()
    {
        const string source = """
            package i4493
            import System

            open class Symbol { }
            class PropertySymbol : Symbol { }

            open class Base {
                open prop Property Symbol {
                    get;
                }
            }

            class Derived : Base {
                private var value PropertySymbol = PropertySymbol()
                override prop Property PropertySymbol -> this.value
            }

            func Main() {
                let value Base = Derived()
                Console.WriteLine(value.Property.GetType().Name)
            }
            """;

        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "issue4493.ref.dll");
        var assembly = fixture.Compile(source, "issue4493", executable: true, "/refout:" + reference);
        IlVerifier.Verify(assembly);
        AssertCovariantOverrideMetadata(assembly, "Derived", HandleKind.MethodDefinition);
        AssertCovariantOverrideMetadata(reference, "Derived", HandleKind.MethodDefinition);
        Assert.Equal("PropertySymbol\n", fixture.Run(assembly));
    }

    [Fact]
    public void ConstructedGenericBaseProperty_UsesTypeSpecMemberRefAndRuns()
    {
        const string source = """
            package i4493generic
            import System

            open class Symbol { }
            class PropertySymbol : Symbol { }

            open class Base[T] {
                open prop Property T {
                    get;
                }
            }

            class Derived : Base[Symbol] {
                private var value PropertySymbol = PropertySymbol()
                override prop Property PropertySymbol -> this.value
            }

            func Main() {
                let value Base[Symbol] = Derived()
                Console.WriteLine(value.Property.GetType().Name)
            }
            """;

        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "issue4493generic.ref.dll");
        var assembly = fixture.Compile(
            source,
            "issue4493generic",
            executable: true,
            "/refout:" + reference);
        IlVerifier.Verify(assembly);
        AssertCovariantOverrideMetadata(assembly, "Derived", HandleKind.MemberReference);
        AssertCovariantOverrideMetadata(reference, "Derived", HandleKind.MemberReference);
        Assert.Equal("PropertySymbol\n", fixture.Run(assembly));
    }

    [Fact]
    public void ThreeLevelCovariantPropertyChain_DispatchesToLeaf()
    {
        const string source = """
            package i4493chain
            import System

            open class Symbol { }
            open class MiddleSymbol : Symbol { }
            class LeafSymbol : MiddleSymbol { }

            open class Base {
                open prop Property Symbol {
                    get;
                }
            }

            open class Middle : Base {
                open override prop Property MiddleSymbol -> MiddleSymbol()
            }

            class Leaf : Middle {
                override prop Property LeafSymbol -> LeafSymbol()
            }

            func Main() {
                let baseValue Base = Leaf()
                let middleValue Middle = Leaf()
                Console.WriteLine(baseValue.Property.GetType().Name)
                Console.WriteLine(middleValue.Property.GetType().Name)
            }
            """;

        using var fixture = new NativeSliceLanguageTests.Fixture();
        var assembly = fixture.Compile(source, "issue4493chain", executable: true);
        IlVerifier.Verify(assembly);
        AssertCovariantOverrideMetadata(assembly, "Middle", HandleKind.MethodDefinition);
        AssertCovariantOverrideMetadata(assembly, "Leaf", HandleKind.MethodDefinition);
        Assert.Equal("LeafSymbol\nLeafSymbol\n", fixture.Run(assembly));
    }

    [Theory]
    [InlineData("""
        open class Base {
            open prop Property int32 {
                get;
            }
        }
        class Derived : Base {
            override prop Property string -> ""
        }
        """)]
    [InlineData("""
        open class Symbol { }
        class PropertySymbol : Symbol { }
        open class Base {
            open prop Property Symbol {
                get;
                set;
            }
        }
        class Derived : Base {
            override prop Property PropertySymbol {
                get;
                set;
            }
        }
        """)]
    public void InvalidCovariantPropertyShapes_ReportGS0185(string declarations)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            "package i4493invalid\n" + declarations,
            "issue4493invalid",
            executable: false);
        Assert.NotEqual(0, code);
        Assert.Equal(1, CountOccurrences(output, "error GS0185:"));
    }

    private static void AssertCovariantOverrideMetadata(
        string assemblyPath,
        string typeName,
        HandleKind declarationKind)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var derived = FindType(reader, typeName);
        var getter = FindMethod(reader, derived, "get_Property");
        var getterDefinition = reader.GetMethodDefinition(getter);
        Assert.True((getterDefinition.Attributes & MethodAttributes.Virtual) != 0);
        Assert.True((getterDefinition.Attributes & MethodAttributes.NewSlot) != 0);

        var methodImpl = Assert.Single(
            reader.GetTypeDefinition(derived).GetMethodImplementations(),
            handle => reader.GetMethodImplementation(handle).MethodBody == getter);
        var declaration = reader.GetMethodImplementation(methodImpl).MethodDeclaration;
        Assert.Equal(declarationKind, declaration.Kind);
        Assert.True(HasPreserveBaseOverridesAttribute(reader, getter));
        if (declarationKind == HandleKind.MemberReference)
        {
            Assert.Equal(
                HandleKind.TypeSpecification,
                reader.GetMemberReference((MemberReferenceHandle)declaration).Parent.Kind);
        }
    }

    private static bool HasPreserveBaseOverridesAttribute(
        MetadataReader reader,
        MethodDefinitionHandle method)
    {
        foreach (var attributeHandle in reader.GetMethodDefinition(method).GetCustomAttributes())
        {
            var attribute = reader.GetCustomAttribute(attributeHandle);
            if (attribute.Constructor.Kind != HandleKind.MemberReference)
            {
                continue;
            }

            var constructor = reader.GetMemberReference((MemberReferenceHandle)attribute.Constructor);
            if (constructor.Parent.Kind != HandleKind.TypeReference)
            {
                continue;
            }

            var attributeType = reader.GetTypeReference((TypeReferenceHandle)constructor.Parent);
            if (reader.GetString(attributeType.Namespace) == "System.Runtime.CompilerServices"
                && reader.GetString(attributeType.Name) == "PreserveBaseOverridesAttribute")
            {
                return true;
            }
        }

        return false;
    }

    private static int CountOccurrences(string text, string value)
    {
        var count = 0;
        for (var index = 0; (index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0; index += value.Length)
        {
            count++;
        }

        return count;
    }

    private static TypeDefinitionHandle FindType(MetadataReader reader, string name)
    {
        foreach (var handle in reader.TypeDefinitions)
        {
            if (reader.GetString(reader.GetTypeDefinition(handle).Name) == name)
            {
                return handle;
            }
        }

        throw new InvalidOperationException($"Type '{name}' was not emitted.");
    }

    private static MethodDefinitionHandle FindMethod(
        MetadataReader reader,
        TypeDefinitionHandle type,
        string name)
    {
        foreach (var handle in reader.GetTypeDefinition(type).GetMethods())
        {
            if (reader.GetString(reader.GetMethodDefinition(handle).Name) == name)
            {
                return handle;
            }
        }

        throw new InvalidOperationException($"Method '{name}' was not emitted.");
    }
}
