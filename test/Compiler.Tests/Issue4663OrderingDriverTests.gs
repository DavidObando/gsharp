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

    @Fact
    func Issue4739_SourceQualifiedAndConstructedOverloads_VerifyAndRemainDeterministic() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let fooFile = Path.Combine(fixture.Directory, "Foo.gs")
        let barFile = Path.Combine(fixture.Directory, "Bar.gs")
        let hostFile = Path.Combine(fixture.Directory, "Host.gs")
        File.WriteAllText(fooFile, `package Foo
class X { }
class Box[T] { }
`)
        File.WriteAllText(barFile, `package Bar
class X { }
class Box[T] { }
`)
        File.WriteAllText(hostFile, `package Ctors4739
import System
import System.Collections.Generic

class OuterA {
    public class Inner { }
}

class OuterB {
    public class Inner { }
}

class OuterGeneric[T] {
    public class Inner { }
}

class Host {
    var Tag int32
    init(x Foo.X) { Tag = 1 }
    init(x Bar.X) { Tag = 2 }
    init(x Foo.Box[int32]) { Tag = 3 }
    init(x Bar.Box[int32]) { Tag = 4 }
    init(xs List[Foo.X]) { Tag = 5 }
    init(xs List[Bar.X]) { Tag = 6 }
    init(x OuterA.Inner) { Tag = 7 }
    init(x OuterB.Inner) { Tag = 8 }
    init(x OuterGeneric[Foo.X].Inner) { Tag = 9 }
    init(x OuterGeneric[Bar.X].Inner) { Tag = 10 }

    func Describe(x Foo.X) int32 -> Tag + 100
    func Describe(x Bar.X) int32 -> Tag + 200
    func Describe(xs List[Foo.X]) int32 -> Tag + 300
    func Describe(xs List[Bar.X]) int32 -> Tag + 400
}

func Main() {
    let h1 = Host(Foo.X())
    let h2 = Host(Bar.X())
    let h3 = Host(Foo.Box[int32]())
    let h4 = Host(Bar.Box[int32]())
    let h5 = Host(List[Foo.X]())
    let h6 = Host(List[Bar.X]())
    let h7 = Host(OuterA.Inner())
    let h8 = Host(OuterB.Inner())
    let h9 = Host(OuterGeneric[Foo.X].Inner())
    let h10 = Host(OuterGeneric[Bar.X].Inner())
    Console.WriteLine("${h1.Tag},${h2.Tag},${h3.Tag},${h4.Tag},${h5.Tag},${h6.Tag},${h7.Tag},${h8.Tag},${h9.Tag},${h10.Tag}")
    Console.WriteLine("${h1.Describe(Foo.X())},${h2.Describe(Bar.X())},${h5.Describe(List[Foo.X]())},${h6.Describe(List[Bar.X]())}")
}
`)
        let unrelated = Path.Combine(fixture.Directory, "Unrelated4739.gs")
        File.WriteAllText(
            unrelated,
            "package Ctors4739\n" + string.Concat(
                Enumerable.Range(0, 300).Select(
                    (i int32) -> (`func g` + "$i" + `(x int32) int32 { return x + ` + "$i" + ` }
`)
                )
            )
        )
        var dll = fixture.Compile(
            "package Ctors4739\n",
            "Ctors4739",
            true,
            "/deterministic+",
            fooFile,
            barFile,
            hostFile,
            unrelated
        )
        let forwardBytes = File.ReadAllBytes(dll)
        IlVerifier.Verify(dll)
        Assert.Equal("1,2,3,4,5,6,7,8,9,10\n101,202,305,406\n", fixture.Run(dll))

        dll = fixture.Compile(
            "package Ctors4739\n",
            "Ctors4739",
            true,
            "/deterministic+",
            unrelated,
            fooFile,
            barFile,
            hostFile
        )
        let reversedBytes = File.ReadAllBytes(dll)
        Assert.Equal(MetadataAndIlHash(forwardBytes), MetadataAndIlHash(reversedBytes))
        IlVerifier.Verify(dll)
        Assert.Equal("1,2,3,4,5,6,7,8,9,10\n101,202,305,406\n", fixture.Run(dll))
    }

    @Fact
    func Issue4739_DuplicateQualifiedConstructorSignatures_StillReportGS0264() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let fooFile = Path.Combine(fixture.Directory, "FooDup.gs")
        File.WriteAllText(fooFile, `package Foo
class X { }
class Box[T] { }
`)
        let (code, output) = fixture.TryCompile(`package Ctors4739Dup
import System.Collections.Generic

class OuterA {
    public class Inner { }
}

class Host {
    init(x Foo.X) { }
    init(y Foo.X) { }
    init(x Foo.Box[int32]) { }
    init(y Foo.Box[int32]) { }
    init(xs List[Foo.X]) { }
    init(ys List[Foo.X]) { }
    init(x OuterA.Inner) { }
    init(y OuterA.Inner) { }
}
`, "Ctors4739Dup", false, fooFile)
        Assert.Equal(1, code)
        Assert.Contains("(10,5,10,9): error GS0264:", output, StringComparison.Ordinal)
        Assert.Contains("(12,5,12,9): error GS0264:", output, StringComparison.Ordinal)
        Assert.Contains("(14,5,14,9): error GS0264:", output, StringComparison.Ordinal)
        Assert.Contains("(16,5,16,9): error GS0264:", output, StringComparison.Ordinal)
    }

    @Fact
    func Issue4740_ValueAndByRefConstructorOverloads_CompileVerifyAndRun() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package Ctors4740
import System

open class RefHost {
    public var Tag int32
    init(x int32) { Tag = x + 10 }
    init(ref x int32) {
        x += 1
        Tag = x + 100
    }
}

class OutHost {
    var Tag int32
    init(x int32) { Tag = x + 20 }
    init(out x int32) {
        x = 7
        Tag = 200
    }
}

class InHost {
    var Tag int32
    init(x int32) { Tag = x + 30 }
    init(in x int32) { Tag = x + 300 }
}

class WidenRefHost {
    var Tag int64
    init(x int64) { Tag = x + 40 }
    init(ref x int32) {
        x += 10
        Tag = x + 400
    }
}

class GenericRefHost[T] {
    var Value T
    var ByRef bool
    init(x T) {
        Value = x
        ByRef = false
    }
    init(ref x T) {
        Value = x
        ByRef = true
    }
}

class ChainedRefHost {
    var Tag int32
    init(x int32) { Tag = x + 50 }
    init(ref x int32) {
        x += 5
        Tag = x + 500
    }
    convenience init(x int32, marker string) {
        init(x)
    }
    convenience init(ref x int32, marker string) {
        init(ref x)
    }
}

class DerivedRefHost : RefHost {
    init(x int32) : base(x) { }
    init(ref x int32) : base(ref x) { }
}

func Main() {
    var x = 2
    let v1 = RefHost(x)
    let r1 = RefHost(ref x)
    let r2 = RefHost(&x)
    Console.WriteLine("${v1.Tag},${r1.Tag},${r2.Tag},${x}")

    var y = 5
    let oVal = OutHost(y)
    let oRef = OutHost(out y)
    let oInline = OutHost(out var z)
    Console.WriteLine("${oVal.Tag},${oRef.Tag},${y},${oInline.Tag},${z}")

    var k = 3
    let iVal = InHost(k)
    let iExplicit = InHost(in k)
    Console.WriteLine("${iVal.Tag},${iExplicit.Tag}")

    var w = 4
    let wVal = WidenRefHost(w)
    let wRef = WidenRefHost(ref w)
    Console.WriteLine("${wVal.Tag},${wRef.Tag},${w}")

    var g = 9
    let gVal = GenericRefHost(g)
    let gRef = GenericRefHost(ref g)
    let gAddr = GenericRefHost(&g)
    Console.WriteLine("${gVal.Value}:${gVal.ByRef},${gRef.Value}:${gRef.ByRef},${gAddr.Value}:${gAddr.ByRef}")

    var c = 6
    let cVal = ChainedRefHost(c, "v")
    let cRef = ChainedRefHost(ref c, "r")
    Console.WriteLine("${cVal.Tag},${cRef.Tag},${c}")

    var d = 8
    let dVal = DerivedRefHost(d)
    let dRef = DerivedRefHost(ref d)
    Console.WriteLine("${dVal.Tag},${dRef.Tag},${d}")
}
`, "Ctors4740", true)
        IlVerifier.Verify(dll)
        Assert.Equal(`12,103,104,4
25,200,7,200,7
33,303
44,414,14
9:False,9:True,9:True
56,511,11
18,109,9
`, fixture.Run(dll))
    }

    @Fact
    func Issue4740_RefOnlyConstructorCalledByValue_ReportsGS0235() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package Ctors4740Err

class OnlyRef {
    init(ref x int32) { x++ }
}

func Main() {
    var x = 1
    let a = OnlyRef(x)
    let b = OnlyRef(out x)
}
`, "Ctors4740Err", true)
        Assert.Equal(1, code)
        Assert.Contains("(9,21,9,22): error GS0235:", output, StringComparison.Ordinal)
        Assert.Contains("(10,21,10,26): error GS0235:", output, StringComparison.Ordinal)
    }

    @Fact
    func Issue4740_BaseConstructorByRefNullabilityAndReadOnlyDiagnostics_AreReported() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (nullabilityCode, nullabilityOutput) = fixture.TryCompile(`package Ctors4740BaseNull

open class BaseRef {
    init(ref x string) { }
}

class DerivedRef : BaseRef {
    init(ref x string?) : base(ref x) { }
}
`, "Ctors4740BaseNull", false, "/warnaserror+")
        Assert.Equal(1, nullabilityCode)
        Assert.Contains("GS0612", nullabilityOutput, StringComparison.Ordinal)

        let (readOnlyCode, readOnlyOutput) = fixture.TryCompile(`package Ctors4740BaseReadOnly

open class BaseMut {
    init(ref x int32) { x++ }
}

class DerivedInAsRef : BaseMut {
    init(in x int32) : base(ref x) { }
}

class DerivedInModifierToRef : BaseMut {
    init(in x int32) : base(in x) { }
}

class DerivedOutModifierToRef : BaseMut {
    init(ref x int32) : base(out x) { }
}
`, "Ctors4740BaseReadOnly", false)
        Assert.Equal(1, readOnlyCode)
        Assert.Contains("GS9005", readOnlyOutput, StringComparison.Ordinal)
        Assert.Contains("(12,24,12,28): error GS0214:", readOnlyOutput, StringComparison.Ordinal)
        Assert.Contains("(16,25,16,29): error GS0214:", readOnlyOutput, StringComparison.Ordinal)
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
