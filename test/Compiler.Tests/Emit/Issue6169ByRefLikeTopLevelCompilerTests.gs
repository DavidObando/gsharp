// <copyright file="Issue6169ByRefLikeTopLevelCompilerTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #6169 (ADR-0228): end-to-end driver (`gsc`), strict `ILVerify`,
/// metadata field verification, and execution tests for top-level by-ref-like
/// bindings.
open class Issue6169ByRefLikeTopLevelCompilerTests {
    @Fact
    func ReadOnlySpanLiteral_TopLevel_VerifiesRunsAndEmitsNoStaticField() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`import System

let view readonly span[byte] = u8"hello"
Console.WriteLine(view.Length)
`, "top-level-u8-span", executable: true)
        IlVerifier.Verify(assembly)
        Assert.Equal("5\n", fixture.Run(assembly))
        Assert.DoesNotContain("view", ReadFieldNames(assembly))
    }

    @Fact
    func MutableSpanAndUserRefStruct_TopLevel_VerifyRunAndEmitNoByRefLikeFields() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`import System

ref struct Counter {
    var Value int32

    func Add(delta int32) {
        Value = Value + delta
    }
}

var a = []int32{1, 2, 3}
var s span[int32] = a
s[0] = 99
var c = Counter{Value: a[0]}
c.Add(1)
Console.WriteLine(c.Value)
`, "top-level-mutable-and-user-ref-struct", executable: true)
        IlVerifier.Verify(assembly)
        Assert.Equal("100\n", fixture.Run(assembly))
        let fields = ReadFieldNames(assembly)
        Assert.Contains("a", fields)
        Assert.DoesNotContain("s", fields)
        Assert.DoesNotContain("c", fields)
    }

    @Fact
    func TopLevelSpan_AsyncBeforeAndAfterAwait_VerifiesAndRuns() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let assembly = fixture.Compile(`import System
import System.Threading.Tasks

let first readonly span[byte] = u8"hi"
Console.WriteLine(first.Length)
await Task.Delay(1)
let second readonly span[byte] = u8"hello"
Console.WriteLine(second.Length)
`, "top-level-async-span", executable: true)
        IlVerifier.Verify(assembly)
        Assert.Equal("2\n5\n", fixture.Run(assembly))
        let fields = ReadFieldNames(assembly)
        Assert.DoesNotContain("first", fields)
        Assert.DoesNotContain("second", fields)
    }

    @Fact
    func TopLevelSpan_InLibraryCompilation_IsRejectedWithGS0219AndGS0285() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`import System

let view readonly span[byte] = u8"hello"
`, "top-level-span-library", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("GS0285", output, StringComparison.Ordinal)
        Assert.Contains("GS0219", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "top-level-span-library.dll")))
    }

    @Fact
    func TopLevelSpan_FunctionLambdaAndLiveAwait_RejectedByDriver() {
        using let fixture = NativeSliceLanguageTests.Fixture()

        let (funcCode, funcOutput) = fixture.TryCompile(`import System

let view readonly span[byte] = u8"hello"
Console.WriteLine(f())
func f() int32 -> view.Length
`, "top-level-span-func", executable: true)
        Assert.NotEqual(0, funcCode)
        Assert.Contains("GS9004", funcOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", funcOutput, StringComparison.Ordinal)

        let (lambdaCode, lambdaOutput) = fixture.TryCompile(`import System

let view readonly span[byte] = u8"hello"
let f = func() int32 { return view.Length }
let g Func[int32] = () -> view.Length
Console.WriteLine(f() + g())
`, "top-level-span-lambda", executable: true)
        Assert.NotEqual(0, lambdaCode)
        Assert.Contains("GS9004", lambdaOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", lambdaOutput, StringComparison.Ordinal)

        let (awaitCode, awaitOutput) = fixture.TryCompile(`import System
import System.Threading.Tasks

let view readonly span[byte] = u8"hello"
await Task.Delay(1)
Console.WriteLine(view.Length)
`, "top-level-span-live-await", executable: true)
        Assert.NotEqual(0, awaitCode)
        Assert.Contains("GS0219", awaitOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", awaitOutput, StringComparison.Ordinal)

        let (writeAwaitCode, writeAwaitOutput) = fixture.TryCompile(`import System
import System.Threading.Tasks

var a = []int32{1, 2, 3}
var s span[int32] = a
await Task.Delay(1)
s[0] = 99
`, "top-level-span-write-await", executable: true)
        Assert.NotEqual(0, writeAwaitCode)
        Assert.Contains("GS0219", writeAwaitOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", writeAwaitOutput, StringComparison.Ordinal)

        let (aliasAwaitCode, aliasAwaitOutput) = fixture.TryCompile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 42}
var p = &c.Value
await Task.Delay(1)
Console.WriteLine(*p)
`, "top-level-ref-struct-alias-await", executable: true)
        Assert.NotEqual(0, aliasAwaitCode)
        Assert.Contains("GS0219", aliasAwaitOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", aliasAwaitOutput, StringComparison.Ordinal)

        let (branchedAliasCode, branchedAliasOutput) = fixture.TryCompile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var p = &c.Value
    await Task.Delay(1)
    if flag {
        Console.WriteLine(*p)
    }
}

run(true).GetAwaiter().GetResult()
`, "func-branched-ref-struct-alias-await", executable: true)
        Assert.NotEqual(0, branchedAliasCode)
        Assert.Contains("GS0219", branchedAliasOutput, StringComparison.Ordinal)
        Assert.DoesNotContain("GS9998", branchedAliasOutput, StringComparison.Ordinal)

        let reseatedAssembly = fixture.Compile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 42}
var x = 1
var p = &c.Value
Console.WriteLine(*p)
await Task.Delay(1)
p = &x
Console.WriteLine(*p)
`, "top-level-reseated-alias-after-await", executable: true)
        IlVerifier.Verify(reseatedAssembly)
        Assert.Equal("42\n1\n", fixture.Run(reseatedAssembly))

        let arrayIndexSafeAssembly = fixture.Compile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var a = []int32{10, 20, 30}
    var c = Counter{Value: 1}
    var p = &a[c.Value]
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`, "func-array-index-ref-struct-safe", executable: true)
        IlVerifier.Verify(arrayIndexSafeAssembly)
        Assert.Equal("20\n", fixture.Run(arrayIndexSafeAssembly))

        let switchReturningSafeAssembly = fixture.Compile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    switch flag {
        case true {
            return
        }
        default {
            p = &x
        }
    }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run(false).GetAwaiter().GetResult()
`, "func-switch-returning-arm-safe", executable: true)
        IlVerifier.Verify(switchReturningSafeAssembly)
        Assert.Equal("1\n", fixture.Run(switchReturningSafeAssembly))

        let tryReseatFinallySafeAssembly = fixture.Compile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    try {
        p = &x
    } finally { }
    await Task.Delay(1)
    Console.WriteLine(*p)
}

run().GetAwaiter().GetResult()
`, "func-try-reseat-finally-safe", executable: true)
        IlVerifier.Verify(tryReseatFinallySafeAssembly)
        Assert.Equal("1\n", fixture.Run(tryReseatFinallySafeAssembly))

        let heapOwnersSafeAssembly = fixture.Compile(`import System
import System.Runtime.CompilerServices
import System.Threading.Tasks

class Box {
    var Value int32
}

ref struct Holder {
    var Values[]int32
    var Box Box
    var ClrBox StrongBox[int32]
}

async func run() Task {
    var h = Holder{
        Values: []int32{11, 22},
        Box: Box{Value: 33},
        ClrBox: StrongBox[int32](44)
    }
    var pArr = &h.Values[0]
    var pBox = &h.Box.Value
    var pClr = &h.ClrBox.Value
    await Task.Delay(1)
    Console.WriteLine("${*pArr},${*pBox},${*pClr}")
}

run().GetAwaiter().GetResult()
`, "func-heap-owner-ref-struct-safe", executable: true)
        IlVerifier.Verify(heapOwnersSafeAssembly)
        Assert.Equal("11,33,44\n", fixture.Run(heapOwnersSafeAssembly))

        let nestedReseatBeforeReadSafeAssembly = fixture.Compile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run() Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    await Task.Delay(1)
    let ignored = {
        p = &x
        Console.WriteLine(*p)
        0
    }
}

run().GetAwaiter().GetResult()
`, "func-nested-reseat-before-read-safe", executable: true)
        IlVerifier.Verify(nestedReseatBeforeReadSafeAssembly)
        Assert.Equal("1\n", fixture.Run(nestedReseatBeforeReadSafeAssembly))

        let switchGuardOverwriteSafeAssembly = fixture.Compile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let n = 1
await Task.Delay(1)
let r = switch n {
    case 1 when {
        c = Counter{Value: 42}
        true
    }: c.Value
    default: {
        c = Counter{Value: 1}
        c.Value
    }
}
Console.WriteLine(r)
`, "top-level-switch-guard-overwrite-safe", executable: true)
        IlVerifier.Verify(switchGuardOverwriteSafeAssembly)
        Assert.Equal("42\n", fixture.Run(switchGuardOverwriteSafeAssembly))

        let switchOverwriteComplexPathsSafeAssembly = fixture.Compile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

var c = Counter{Value: 10}
let n = 1
await Task.Delay(1)
let r1 = switch n {
    case _ when {
        c = Counter{Value: 42}
        false
    }: 0
    default: c.Value
}
let ignored = {
    try {
        goto useCounter
    } finally {
        c = Counter{Value: 7}
    }
useCounter:
    Console.WriteLine("${r1},${c.Value}")
    0
}
let r2 = switch n {
    case 1 when {
        c = Counter{Value: 99}
        true
    }: {
        let m = c.Value
        await Task.Delay(1)
        m
    }
    default: 0
}
Console.WriteLine(r2)
`, "top-level-switch-try-overwrite-paths-safe", executable: true)
        IlVerifier.Verify(switchOverwriteComplexPathsSafeAssembly)
        Assert.Equal("42,7\n99\n", fixture.Run(switchOverwriteComplexPathsSafeAssembly))

        let standaloneSwitchAndTerminatingBranchSafeAssembly = fixture.Compile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func run(flag bool) Task {
    var c = Counter{Value: 10}
    await Task.Delay(1)
    let r = if flag {
        return
    } else {
        c = Counter{Value: 42}
        0
    }
    Console.WriteLine(c.Value + r)
}

run(false).GetAwaiter().GetResult()

var topC = Counter{Value: 10}
let n = 1
await Task.Delay(1)
switch n {
    case _ when ({
        topC = Counter{Value: 77}
        false
    }) { }
    default {
        Console.WriteLine(topC.Value)
    }
}
`, "top-level-standalone-switch-and-terminating-branch-safe", executable: true)
        IlVerifier.Verify(standaloneSwitchAndTerminatingBranchSafeAssembly)
        Assert.Equal("42\n77\n", fixture.Run(standaloneSwitchAndTerminatingBranchSafeAssembly))

        let filterAndImpossiblePatternSafeAssembly = fixture.Compile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func checkImpossiblePatterns(n int32) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &x
    let r = switch n {
        case not _ when ({
            p = &c.Value
            true
        }): 0
        default: 5
    }
    switch n {
        case not _ when ({
            p = &c.Value
            true
        }) { }
        default { }
    }
    if n is _ or > ({
        p = &c.Value
        0
    }) { }
    await Task.Delay(1)
    Console.WriteLine("${r},${*p}")
}

checkImpossiblePatterns(0).GetAwaiter().GetResult()

var topC = Counter{Value: 10}
await Task.Delay(1)
try {
    throw InvalidOperationException()
} catch when ({
    topC = Counter{Value: 88}
    false
}) { } catch {
    Console.WriteLine(topC.Value)
}
`, "top-level-filter-and-impossible-pattern-safe", executable: true)
        IlVerifier.Verify(filterAndImpossiblePatternSafeAssembly)
        let filterAndImpossibleOutput = fixture.Run(filterAndImpossiblePatternSafeAssembly)
        Assert.StartsWith("5,", filterAndImpossibleOutput)
        Assert.EndsWith("\n88\n", filterAndImpossibleOutput)

        let throwingAliasAndFilterReseatSafeAssembly = fixture.Compile(`import System
import System.Threading.Tasks

ref struct Counter {
    var Value int32
}

async func checkThrowingAndFilterReseat(flag bool) Task {
    var c = Counter{Value: 42}
    var x = 1
    var p = &c.Value
    let _ = if flag {
        throw InvalidOperationException()
    } else {
        p = &x
        0
    }
    p = &c.Value
    try {
        throw InvalidOperationException()
    } catch when ({
        p = &x
        false
    }) { } catch { }
    var p2 = &x
    var q2 = &(if !flag {
        *p2
    } else {
        p2 = &c.Value
        x
    })
    await Task.Delay(1)
    Console.WriteLine("${*p},${*q2}")
}

checkThrowingAndFilterReseat(false).GetAwaiter().GetResult()
`, "top-level-throwing-alias-and-filter-reseat-safe", executable: true)
        IlVerifier.Verify(throwingAliasAndFilterReseatSafeAssembly)
        Assert.Equal("1,1\n", fixture.Run(throwingAliasAndFilterReseatSafeAssembly))
    }

    shared {
        private func ReadFieldNames(assemblyPath string) List[string] {
            using let peStream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(peStream)
            let md = peReader.GetMetadataReader()
            return md
                .FieldDefinitions
                .Select(md.GetFieldDefinition)
                .Select((f FieldDefinition) -> md.GetString(f.Name))
                .ToList()
        }
    }
}
