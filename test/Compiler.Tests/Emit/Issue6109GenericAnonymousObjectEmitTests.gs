// <copyright file="Issue6109GenericAnonymousObjectEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text
import Xunit

/// Issue #6109: anonymous object literals (`object { ... }`, `data object { ... }`,
/// and rich `object { ... }`) referencing generic type parameters from generic
/// local functions or nested generic enclosing scopes must reify their synthesized
/// backing types over those type parameters so emitted metadata is valid and verifiable.
open class Issue6109GenericAnonymousObjectEmitTests {
    private data struct AnonTypeInfo(Name string, Params[]string)

    @Fact
    func GenericLocal_AnonymousObject_ExactRepro_AndInstantiations() {
        const source = `import System

data struct Pair(X int32, Y string)

func Run() int32 {
    let inner[U] = func(value U) U {
        let item = object { let Value = value }
        return item.Value
    }
    Console.WriteLine(inner(42))
    Console.WriteLine(inner("hello"))
    Console.WriteLine(inner(Pair(7, "p")))
    return inner(42)
}

func Main() {
    Console.WriteLine(Run())
}
`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(source, "Issue6109Repro", executable: true)
        IlVerifier.Verify(program)
        let expected = "42${Environment.NewLine}hello${Environment.NewLine}Pair { X = 7, Y = p }${Environment.NewLine}42${Environment.NewLine}"
        Assert.Equal(Encoding.UTF8.GetBytes(expected), fixture.RunBytes(program))
    }

    @Fact
    func GenericLocal_AnonymousObject_DeduplicationAndValueSemantics() {
        const source = `import System

func Check[U](first U, second U) string {
    let plainA = object { let Value = first }
    let plainB = object { let Value = first }
    let plainC = object { let Value = second }
    let dataA = data object { let Value = first }
    let dataB = dataA with { Value = second }
    let (deconstructed) = plainA
    return "${plainA == plainB}:${plainA == plainC}:${plainA.GetHashCode() == plainB.GetHashCode()}:${plainA}:${deconstructed}:${dataA.Equals(dataB)}:${dataB}"
}

func Run() string {
    let local[U] = func(first U, second U) string {
        let a = object { let Value = first }
        let b = object { let Value = first }
        let c = data object { let Value = first }
        let d = c with { Value = second }
        return "${a == b}:${a.GetHashCode() == b.GetHashCode()}:${c == d}:${d}"
    }
    return local(1, 2) + "|" + local("x", "y") + "|" + Check(10, 20)
}

func Main() {
    Console.WriteLine(Run())
}
`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(source, "Issue6109Semantics", executable: true)
        IlVerifier.Verify(program)
        let anonTypes = ReadAnonymousTypeGenericParams(program)
        Assert.NotEmpty(anonTypes)
        Assert.Equal(4, anonTypes.Count)
        Assert.All(anonTypes, (entry AnonTypeInfo) -> Assert.Single(entry.Params))
        let expected = "True:True:False:{ Value = 2 }|True:True:False:{ Value = y }|True:False:True:{ Value = 10 }:10:False:{ Value = 20 }${Environment.NewLine}"
        Assert.Equal(Encoding.UTF8.GetBytes(expected), fixture.RunBytes(program))
    }

    @Fact
    func GenericEnclosingScopes_AnonymousObject_VerifiesAndRuns() {
        const source = `import System
import System.Collections.Generic

data struct Tag(Id int32)

class Outer[T] {
    func ClassOnly(value T) T {
        let item = object { let Value = value }
        return item.Value
    }

    func MethodAndClass[V](t T, v V) string {
        let inner[U] = func(t2 T, v2 V, u U) string {
            let plain = object { let A = t2; let B = v2; let C = u }
            let record = data object { let A = t2; let B = v2; let C = u }
            let rich = object {
                let A = t2
                let B = v2
                let C = u
                func Show() string -> "${A}:${B}:${C}"
            }
            let wrap = object { let Items = List[U](){u} }
            return "${plain.A},${plain.B},${plain.C}|${record}|${rich.Show()}|${wrap.Items[0]}"
        }
        return inner(t, v, Tag(9))
    }
}

func NestedGenericLocals() string {
    let outer[U1] = func(a U1) string {
        let inner[U2] = func(x U1, b U2) string {
            let item = object { let First = x; let Second = b }
            return "${item.First}-${item.Second}"
        }
        return inner(a, "two")
    }
    return outer(99)
}

func Main() {
    let o = Outer[int32]()
    let o2 = Outer[string]()
    Console.WriteLine(o.ClassOnly(7))
    Console.WriteLine(o.MethodAndClass(11, true))
    Console.WriteLine(o2.MethodAndClass("s", false))
    Console.WriteLine(NestedGenericLocals())
}
`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(source, "Issue6109Scopes", executable: true)
        IlVerifier.Verify(program)
        let anonTypes = ReadAnonymousTypeGenericParams(program)
        Assert.NotEmpty(anonTypes)
        Assert.Contains(
            anonTypes,
            (entry AnonTypeInfo) -> entry
                .Params
                .Length == 3 &&
                entry.Params[0] == "T" &&
                entry.Params[1] == "V" &&
                entry.Params[2] == "U"
        )
        let expected = "7${Environment.NewLine}11,True,Tag { Id = 9 }|{ A = 11, B = True, C = Tag { Id = 9 } }|11:True:Tag { Id = 9 }|Tag { Id = 9 }${Environment.NewLine}s,False,Tag { Id = 9 }|{ A = s, B = False, C = Tag { Id = 9 } }|s:False:Tag { Id = 9 }|Tag { Id = 9 }${Environment.NewLine}99-two${Environment.NewLine}"
        Assert.Equal(Encoding.UTF8.GetBytes(expected), fixture.RunBytes(program))
    }

    @Fact
    func GenericLocal_AnonymousObject_InsideLambdaAsyncIteratorAndConstrained() {
        const source = `import System
import System.Threading.Tasks

func RunLambda() string {
    let inner[U] = func(value U) string {
        let fn = () -> object { let Value = value }
        return "${fn().Value}"
    }
    return inner(123) + ":" + inner("abc")
}

func RunAsync() string {
    let inner[U IComparable[U]] = async func(value U, other U) Task[string] {
        let item = object { let Val = value }
        await Task.Yield()
        return "${item.Val.CompareTo(other)}:${item}"
    }
    return inner(10, 20).GetAwaiter().GetResult()
}

func RunIterator() string {
    let inner[U] = func(value U) sequence[U] {
        let item = object { let Val = value }
        yield item.Val
    }
    var acc = ""
    for x in inner("iter") {
        acc += x
    }
    return acc
}

func Main() {
    Console.WriteLine(RunLambda())
    Console.WriteLine(RunAsync())
    Console.WriteLine(RunIterator())
}
`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(source, "Issue6109AsyncIter", executable: true)
        IlVerifier.Verify(program)
        let expected = "123:abc${Environment.NewLine}-1:{ Val = 10 }${Environment.NewLine}iter${Environment.NewLine}"
        Assert.Equal(Encoding.UTF8.GetBytes(expected), fixture.RunBytes(program))
    }

    @Fact
    func GenericLocal_AnonymousObject_NegativeDiagnosticsPreserveLocations() {
        const duplicateMemberSource = `func Run() int32 {
    let inner[U] = func(value U) int32 {
        let item = object { let Value = value; let Value = value }
        return 0
    }
    return inner(1)
}
func Main() {}
`
        const captureEnclosingTypeParamSource = `func Outer[T](t T) int32 {
    let captured = 1
    let inner[U] = func(u U) int32 {
        let item = object { let A = t; let B = u; let C = captured }
        return item.C
    }
    return inner(2)
}
func Main() {}
`
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (dupCode, dupOutput) = fixture.TryCompile(duplicateMemberSource, "Issue6109Dup", executable: true)
        Assert.NotEqual(0, dupCode)
        Assert.Contains("(3,52,3,57): error GS0102:", dupOutput, StringComparison.Ordinal)

        let (capCode, capOutput) = fixture.TryCompile(
            captureEnclosingTypeParamSource,
            "Issue6109Capture",
            executable: true
        )
        Assert.NotEqual(0, capCode)
        Assert.Contains("(3,9,3,14): error GS0468:", capOutput, StringComparison.Ordinal)
    }

    shared {
        private func ReadAnonymousTypeGenericParams(assemblyPath string) List[AnonTypeInfo] {
            let result = List[AnonTypeInfo]()
            using let stream = File.OpenRead(assemblyPath)
            using let pe = PEReader(stream)
            let reader = pe.GetMetadataReader()
            for handle in reader.TypeDefinitions {
                let typeDef = reader.GetTypeDefinition(handle)
                let name = reader.GetString(typeDef.Name)
                if name.StartsWith("<>AnonymousType", StringComparison.Ordinal) {
                    let gpNames = typeDef
                        .GetGenericParameters()
                        .Select(
                        (gpHandle GenericParameterHandle) -> reader.GetString(reader.GetGenericParameter(gpHandle).Name)
                    )
                        .ToArray()
                    result.Add(AnonTypeInfo(name, gpNames))
                }
            }
            return result
        }
    }
}
