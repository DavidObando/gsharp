// <copyright file="Issue4663OrderingDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import System
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Security.Cryptography
import Xunit

class Issue4663OrderingDriverTests {
    @Fact
    func CrossFileModuleInitializersFollowTheEstablishedMethodDefKey() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let first = Path.Combine(fixture.Directory, "ZFile.gs")
        let last = Path.Combine(fixture.Directory, "AFile.gs")
        File.WriteAllText(first, `package Order4663
import System
import System.Runtime.CompilerServices
partial class Hooks {
    shared {
        @ModuleInitializer
        func AFirst() { Console.Write("A") }
    }
}`)
        File.WriteAllText(last, `package Order4663
import System
import System.Runtime.CompilerServices
partial class Hooks {
    shared {
        @ModuleInitializer
        func ZLast() { Console.Write("B") }
    }
}`)
        const main = `package Order4663
import System
func Main() { Console.WriteLine("M") }
`
        let unrelated = Path.Combine(fixture.Directory, "Unrelated.gs")
        for count in[]int32{1, 7, 23, 61, 157, 401} {
            File.WriteAllText(
                unrelated,
                "package Order4663\n" + string.Concat(
                    Enumerable.Range(0, count).Select(
                        (i int32) -> (`func g` + "$i" + `(x int32) int32 { return x + ` + "$i" + ` }
`)
                    )
                )
            )
            var dll = fixture.Compile(main, "Order4663", true, "/deterministic+", first, last, unrelated)
            let forward = File.ReadAllBytes(dll)
            Assert.Equal([]string{"AFirst", "ZLast"}, ModuleInitializerCalls(forward))
            IlVerifier.Verify(dll)
            Assert.Equal("ABM\n", fixture.Run(dll))
            dll = fixture.Compile(main, "Order4663", true, "/deterministic+", unrelated, last, first)
            let reversed = File.ReadAllBytes(dll)
            Assert.Equal([]string{"AFirst", "ZLast"}, ModuleInitializerCalls(reversed))
            Assert.Equal(MetadataAndIlHash(forward), MetadataAndIlHash(reversed))
            IlVerifier.Verify(dll)
            Assert.Equal("ABM\n", fixture.Run(dll))
        }
    }

    @Fact
    func QualifiedAndRefKindConstructorOverloadsVerifyAndRemainStable() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(`namespace Foo { public class X { } public class Box<T> { } }
namespace Bar { public class X { } public class Box<T> { } }`, "Qualified4663")
        const source = `package Ctors4663
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
}`
        let unrelated = Path.Combine(fixture.Directory, "Unrelated.gs")
        let sourceFile = Path.Combine(fixture.Directory, "Source.gs")
        File.WriteAllText(sourceFile, source)
        File.WriteAllText(
            unrelated,
            "package Ctors4663\n" + string.Concat(
                Enumerable.Range(0, 300).Select(
                    (i int32) -> (`func g` + "$i" + `(x int32) int32 { return x + ` + "$i" + ` }
`)
                )
            )
        )
        var dll = fixture.Compile(
            "package Ctors4663\n",
            "Ctors4663",
            true,
            "/deterministic+",
            "/r:" + library,
            sourceFile,
            unrelated
        )
        let forward = File.ReadAllBytes(dll)
        {
            using let pe = PEReader(MemoryStream(forward))
            let reader = pe.GetMetadataReader()
            let host = Assert.Single(
                reader.TypeDefinitions,
                (h TypeDefinitionHandle) -> reader.GetString(reader.GetTypeDefinition(h).Name) == "Host"
            )
            Assert.Equal(
                4,
                reader
                    .GetTypeDefinition(host)
                    .GetMethods()
                    .Count(
                    (h MethodDefinitionHandle) -> reader.GetString(reader.GetMethodDefinition(h).Name) == ".ctor"
                )
            )
            Assert.Equal(
                2,
                reader.TypeDefinitions.Count(
                    (h TypeDefinitionHandle) -> reader.GetString(reader.GetTypeDefinition(h).Name).StartsWith(
                        "<>__Box_n_",
                        StringComparison.Ordinal
                    )
                )
            )
        }
        IlVerifier.Verify(dll, []string{library})
        Assert.Equal(`2
11
20
30
3
7
generic
42
`, fixture.Run(dll))
        // The same universe, but the unrelated file is now the first tree.
        dll = fixture.Compile(
            "package Ctors4663\n",
            "Ctors4663",
            true,
            "/deterministic+",
            "/r:" + library,
            unrelated,
            sourceFile
        )
        let reversed = File.ReadAllBytes(dll)
        Assert.Equal(MetadataAndIlHash(forward), MetadataAndIlHash(reversed))
        IlVerifier.Verify(dll, []string{library})
        Assert.Equal(`2
11
20
30
3
7
generic
42
`, fixture.Run(dll))
    }

    shared {
        private func ModuleInitializerCalls(image[]uint8)[]string {
            using let pe = PEReader(MemoryStream(image))
            let reader = pe.GetMetadataReader()
            let module = Assert.Single(
                reader.TypeDefinitions,
                (handle TypeDefinitionHandle) -> reader.GetString(reader.GetTypeDefinition(handle).Name) == "<Module>"
            )
            let initializer = Assert.Single(
                reader.GetTypeDefinition(module).GetMethods(),
                (handle MethodDefinitionHandle) -> reader.GetString(reader.GetMethodDefinition(handle).Name) == ".cctor"
            )
            let il[]?uint8 = pe.GetMethodBody(reader.GetMethodDefinition(initializer).RelativeVirtualAddress)
                .GetILBytes()
            Assert.NotNull(il)
            Assert.Equal(11, il!!.Length)
            Assert.Equal(0x28, int32(il!![0]))
            Assert.Equal(0x28, int32(il!![5]))
            Assert.Equal(0x2A, int32(il!![10]))
            return []int32{1, 6}.Select(
                (offset int32) -> {
                    let handle = MetadataTokens.EntityHandle(BitConverter.ToInt32(il!!, offset))
                    Assert.Equal(HandleKind.MethodDefinition, handle.Kind)
                    return reader.GetString(reader.GetMethodDefinition(MethodDefinitionHandle(handle)).Name)
                }
            )
                .ToArray()
        }

        private func MetadataAndIlHash(image[]uint8) string {
            using let pe = PEReader(MemoryStream(image))
            let reader = pe.GetMetadataReader()
            let metadata = image.AsSpan(pe.PEHeaders.MetadataStartOffset, pe.PEHeaders.MetadataSize).ToArray()
            let mvid = reader.GetGuid(reader.GetModuleDefinition().Mvid).ToByteArray()
            Assert.NotEqual(Guid.Empty, reader.GetGuid(reader.GetModuleDefinition().Mvid))
            let offset = metadata.AsSpan().IndexOf(mvid)
            Assert.True(offset >= 0)
            metadata.AsSpan(offset, mvid.Length).Clear()
            using let hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256)
            hash.AppendData(metadata)
            Assert.NotEmpty(reader.MethodDefinitions)
            for handle in reader.MethodDefinitions {
                let rva = reader.GetMethodDefinition(handle).RelativeVirtualAddress
                if rva != 0 {
                    hash.AppendData(pe.GetMethodBody(rva).GetILBytes()!!)
                }
            }
            return Convert.ToHexString(hash.GetHashAndReset())
        }
    }
}
