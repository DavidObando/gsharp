// <copyright file="Issue4663OrderingDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class Issue4663OrderingDriverTests
{
    [Fact]
    public void CrossFileModuleInitializersFollowTheEstablishedMethodDefKey()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var first = Path.Combine(fixture.Directory, "ZFile.gs");
        var last = Path.Combine(fixture.Directory, "AFile.gs");
        File.WriteAllText(first, """
            package Order4663
            import System
            import System.Runtime.CompilerServices
            partial class Hooks {
                shared {
                    @ModuleInitializer
                    func AFirst() { Console.Write("A") }
                }
            }
            """);
        File.WriteAllText(last, """
            package Order4663
            import System
            import System.Runtime.CompilerServices
            partial class Hooks {
                shared {
                    @ModuleInitializer
                    func ZLast() { Console.Write("B") }
                }
            }
            """);
        const string main = "package Order4663\nimport System\nfunc Main() { Console.WriteLine(\"M\") }\n";
        var unrelated = Path.Combine(fixture.Directory, "Unrelated.gs");
        foreach (var count in new[] { 1, 7, 23, 61, 157, 401 })
        {
            File.WriteAllText(unrelated, "package Order4663\n" + string.Concat(
                Enumerable.Range(0, count).Select(i => $"func g{i}(x int32) int32 {{ return x + {i} }}\n")));
            var dll = fixture.Compile(main, "Order4663", true, "/deterministic+", first, last, unrelated);
            var forward = File.ReadAllBytes(dll);
            Assert.Equal(new[] { "AFirst", "ZLast" }, ModuleInitializerCalls(forward));
            IlVerifier.Verify(dll);
            Assert.Equal("ABM\n", fixture.Run(dll));

            dll = fixture.Compile(main, "Order4663", true, "/deterministic+", unrelated, last, first);
            var reversed = File.ReadAllBytes(dll);
            Assert.Equal(new[] { "AFirst", "ZLast" }, ModuleInitializerCalls(reversed));
            Assert.Equal(MetadataAndIlHash(forward), MetadataAndIlHash(reversed));
            IlVerifier.Verify(dll);
            Assert.Equal("ABM\n", fixture.Run(dll));
        }
    }

    [Fact]
    public void QualifiedAndRefKindConstructorOverloadsVerifyAndRemainStable()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var library = fixture.CompileCSharp("""
            namespace Foo { public class X { } public class Box<T> { } }
            namespace Bar { public class X { } public class Box<T> { } }
            """, "Qualified4663");
        const string source = """
            package Ctors4663
            import System
            class Host {
                var Tag int32
                init(x Foo.X) {
                    var n = 1
                    let bump = func() { n++ }
                    bump()
                    Tag = n
                }
                init(x Bar.X) {
                    var n = 10
                    let bump = func() { n++ }
                    bump()
                    Tag = n
                }
                init(x Foo.Box[int32]) { Tag = 20 }
                init(x Bar.Box[int32]) { Tag = 30 }
            }
            class RefHost {
                init(x int32) { }
                init(ref x int32) { x++ }
            }
            class OutHost {
                init(x int32) { }
                init(out x int32) { x = 7 }
            }
            class Generic[T](Value T) { }
            struct Counter {
                var Value int32
                init(x int32) { Value = x }
            }
            func Main() {
                Console.WriteLine(Host(Foo.X()).Tag)
                Console.WriteLine(Host(Bar.X()).Tag)
                Console.WriteLine(Host(Foo.Box[int32]()).Tag)
                Console.WriteLine(Host(Bar.Box[int32]()).Tag)
                var x = 2
                let byRef = RefHost(ref x)
                Console.WriteLine(x)
                let byOut = OutHost(out x)
                Console.WriteLine(x)
                Console.WriteLine(Generic[string]("generic").Value)
                Console.WriteLine(Counter(42).Value)
            }
            """;
        var unrelated = Path.Combine(fixture.Directory, "Unrelated.gs");
        var sourceFile = Path.Combine(fixture.Directory, "Source.gs");
        File.WriteAllText(sourceFile, source);
        File.WriteAllText(unrelated, "package Ctors4663\n" + string.Concat(
            Enumerable.Range(0, 300).Select(i => $"func g{i}(x int32) int32 {{ return x + {i} }}\n")));
        var dll = fixture.Compile("package Ctors4663\n", "Ctors4663", true,
            "/deterministic+", "/r:" + library, sourceFile, unrelated);
        var forward = File.ReadAllBytes(dll);
        using (var pe = new PEReader(new MemoryStream(forward)))
        {
            var reader = pe.GetMetadataReader();
            var host = Assert.Single(reader.TypeDefinitions, h => reader.GetString(reader.GetTypeDefinition(h).Name) == "Host");
            Assert.Equal(4, reader.GetTypeDefinition(host).GetMethods().Count(h =>
                reader.GetString(reader.GetMethodDefinition(h).Name) == ".ctor"));
            Assert.Equal(2, reader.TypeDefinitions.Count(h =>
                reader.GetString(reader.GetTypeDefinition(h).Name).StartsWith("<>__Box_n_", StringComparison.Ordinal)));
        }

        IlVerifier.Verify(dll, new[] { library });
        Assert.Equal("2\n11\n20\n30\n3\n7\ngeneric\n42\n", fixture.Run(dll));
        // The same universe, but the unrelated file is now the first tree.
        dll = fixture.Compile("package Ctors4663\n", "Ctors4663", true,
            "/deterministic+", "/r:" + library, unrelated, sourceFile);
        var reversed = File.ReadAllBytes(dll);
        Assert.Equal(MetadataAndIlHash(forward), MetadataAndIlHash(reversed));
        IlVerifier.Verify(dll, new[] { library });
        Assert.Equal("2\n11\n20\n30\n3\n7\ngeneric\n42\n", fixture.Run(dll));
    }

    private static string[] ModuleInitializerCalls(byte[] image)
    {
        using var pe = new PEReader(new MemoryStream(image));
        var reader = pe.GetMetadataReader();
        var module = Assert.Single(reader.TypeDefinitions, handle =>
            reader.GetString(reader.GetTypeDefinition(handle).Name) == "<Module>");
        var initializer = Assert.Single(reader.GetTypeDefinition(module).GetMethods(), handle =>
            reader.GetString(reader.GetMethodDefinition(handle).Name) == ".cctor");
        var il = pe.GetMethodBody(reader.GetMethodDefinition(initializer).RelativeVirtualAddress).GetILBytes();
        Assert.NotNull(il);
        Assert.Equal(11, il.Length);
        Assert.Equal(0x28, il[0]);
        Assert.Equal(0x28, il[5]);
        Assert.Equal(0x2A, il[10]);
        return new[] { 1, 6 }.Select(offset =>
        {
            var handle = MetadataTokens.EntityHandle(BitConverter.ToInt32(il, offset));
            Assert.Equal(HandleKind.MethodDefinition, handle.Kind);
            return reader.GetString(reader.GetMethodDefinition((MethodDefinitionHandle)handle).Name);
        }).ToArray();
    }

    private static string MetadataAndIlHash(byte[] image)
    {
        using var pe = new PEReader(new MemoryStream(image));
        var reader = pe.GetMetadataReader();
        var metadata = image.AsSpan(pe.PEHeaders.MetadataStartOffset, pe.PEHeaders.MetadataSize).ToArray();
        var mvid = reader.GetGuid(reader.GetModuleDefinition().Mvid).ToByteArray();
        Assert.NotEqual(Guid.Empty, reader.GetGuid(reader.GetModuleDefinition().Mvid));
        var offset = metadata.AsSpan().IndexOf(mvid);
        Assert.True(offset >= 0);
        metadata.AsSpan(offset, mvid.Length).Clear();
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(metadata);
        Assert.NotEmpty(reader.MethodDefinitions);
        foreach (var handle in reader.MethodDefinitions)
        {
            var rva = reader.GetMethodDefinition(handle).RelativeVirtualAddress;
            if (rva != 0)
            {
                hash.AppendData(pe.GetMethodBody(rva).GetILBytes());
            }
        }

        return Convert.ToHexString(hash.GetHashAndReset());
    }
}
