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
