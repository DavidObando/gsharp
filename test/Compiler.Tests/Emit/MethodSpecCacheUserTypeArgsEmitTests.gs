// <copyright file="MethodSpecCacheUserTypeArgsEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.IO
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import Xunit

/// Issue #420 (P3-7): regression test verifying that the
/// `ReflectionMetadataEmitter` MethodSpec cache deduplicates rows when the
/// same generic method is referenced multiple times with the same user-defined
/// type as the generic argument. Previously the cache was bypassed entirely
/// whenever any generic argument was a user-type symbol, producing duplicate
/// MethodSpec rows. The metadata was still valid but bloated.
open class MethodSpecCacheUserTypeArgsEmitTests {
    @Fact
    func RepeatedGenericCallWithSameUserTypeArg_EmitsSingleMethodSpecRow() {
        // Three calls to Array.Empty[Clock]() — they must all resolve to the
        // same MethodSpec row, not three distinct rows.
        let source = `package P
import System

class Clock {
    var Ticks int32
}

var a = Array.Empty[Clock]()
var b = Array.Empty[Clock]()
var c = Array.Empty[Clock]()
Console.WriteLine(a.Length + b.Length + c.Length)`
        let outPath = CompileToDll(source)
        using let pe = PEReader(File.OpenRead(outPath))
        let reader = pe.GetMetadataReader()
        // Count MethodSpec rows whose parent MemberRef name is "Empty".
        let emptySpecCount = CountMethodSpecsByName(reader, "Empty")
        Assert.Equal(1, emptySpecCount)
    }

    @Fact
    func DistinctUserTypeArgs_StillProduceDistinctMethodSpecRows() {
        // Two distinct user types as generic args must still emit two
        // separate MethodSpec rows — the cache fix must not over-deduplicate.
        let source = `package P
import System

class ClockA {
    var Ticks int32
}

class ClockB {
    var Ticks int32
}

var a = Array.Empty[ClockA]()
var b = Array.Empty[ClockB]()
Console.WriteLine(a.Length + b.Length)`
        let outPath = CompileToDll(source)
        using let pe = PEReader(File.OpenRead(outPath))
        let reader = pe.GetMetadataReader()
        let emptySpecCount = CountMethodSpecsByName(reader, "Empty")
        Assert.Equal(2, emptySpecCount)
    }

    shared {
        private func CountMethodSpecsByName(reader MetadataReader, name string) int32 {
            var count = 0
            let rowCount = reader.GetTableRowCount(TableIndex.MethodSpec)
            for var rid = 1; rid <= rowCount; rid++ {
                let handle = MetadataTokens.MethodSpecificationHandle(rid)
                let spec = reader.GetMethodSpecification(handle)
                if spec.Method.Kind != HandleKind.MemberReference {
                    continue
                }
                let memberRef = reader.GetMemberReference(MemberReferenceHandle(spec.Method))
                if reader.GetString(memberRef.Name) == name {
                    count++
                }
            }
            return count
        }

        private func CompileToDll(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_methodspec_cache_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return outPath
        }
    }
}
