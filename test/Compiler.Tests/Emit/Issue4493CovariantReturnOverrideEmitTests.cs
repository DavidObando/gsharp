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
        AssertCovariantOverrideMetadata(assembly, HandleKind.MethodDefinition);
        AssertCovariantOverrideMetadata(reference, HandleKind.MethodDefinition);
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
        AssertCovariantOverrideMetadata(assembly, HandleKind.MemberReference);
        AssertCovariantOverrideMetadata(reference, HandleKind.MemberReference);
        Assert.Equal("PropertySymbol\n", fixture.Run(assembly));
    }

    private static void AssertCovariantOverrideMetadata(string assemblyPath, HandleKind declarationKind)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var peReader = new PEReader(stream);
        var reader = peReader.GetMetadataReader();
        var derived = FindType(reader, "Derived");
        var getter = FindMethod(reader, derived, "get_Property");
        var getterDefinition = reader.GetMethodDefinition(getter);
        Assert.True((getterDefinition.Attributes & MethodAttributes.Virtual) != 0);
        Assert.True((getterDefinition.Attributes & MethodAttributes.NewSlot) != 0);

        var methodImpl = Assert.Single(
            reader.GetTypeDefinition(derived).GetMethodImplementations(),
            handle => reader.GetMethodImplementation(handle).MethodBody == getter);
        var declaration = reader.GetMethodImplementation(methodImpl).MethodDeclaration;
        Assert.Equal(declarationKind, declaration.Kind);
        if (declarationKind == HandleKind.MemberReference)
        {
            Assert.Equal(
                HandleKind.TypeSpecification,
                reader.GetMemberReference((MemberReferenceHandle)declaration).Parent.Kind);
        }
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
