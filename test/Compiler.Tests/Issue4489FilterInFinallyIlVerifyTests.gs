// <copyright file="Issue4489FilterInFinallyIlVerifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit
import Xunit.Sdk

/// #4489: ilverify 10.0.8 reports `StackUnderflow` at the first
/// instruction of a `catch … when` filter whose start lies inside a
/// `finally` handler (upstream dotnet/runtime#134711). The IL is valid;
/// the test (cref:IlVerifier) must accept exactly that shape and keep
/// reporting every other stack underflow.
open class Issue4489FilterInFinallyIlVerifyTests {
    @Fact
    func FilterInFinally_CompilesRunsAndVerifies() {
        let dir = Directory.CreateTempSubdirectory("gs_ilv_4489_").FullName
        try {
            let dll = Compile(dir)
            let context = AssemblyLoadContext("issue4489-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                let program = context.LoadFromStream(MemoryStream(File.ReadAllBytes(dll))).GetType("P.<Program>") ??
                    throw XunitException("P.<Program> not emitted")
                let a = program.GetMethod("A") ?? throw XunitException("A not emitted")
                let b = program.GetMethod("B") ?? throw XunitException("B not emitted")
                Assert.Equal("a", a.Invoke(nil, nil))
                Assert.Equal("b!", b.Invoke(nil, []object{"b"}))
            } finally {
                context.Unload()
            }
            // Both the top-level function and the closure body carry the
            // layout; before #4489 this threw with two StackUnderflow lines.
            IlVerifier.Verify(dll)
        } finally {
            TryDelete(dir)
        }
    }

    @Fact
    func RealStackUnderflowElsewhereInSameMethod_IsStillReported() {
        if !IlVerifier.IsEnabled {
            return
        }
        let dir = Directory.CreateTempSubdirectory("gs_ilv_4489_neg_").FullName
        try {
            let dll = Compile(dir)
            // Corrupt A's first instruction (the 1-byte `ldnull` that seeds
            // its result local) into `pop`: a genuine underflow at offset 0, in
            // the same method whose filter start the rule accepts.
            let bytes = File.ReadAllBytes(dll)
            {
                using let pe = PEReader(MemoryStream(bytes, writable: false))
                let md = pe.GetMetadataReader()
                let a = md
                    .MethodDefinitions
                    .Select(md.GetMethodDefinition)
                    .Single((m MethodDefinition) -> md.GetString(m.Name) == "A")
                let body = pe.GetMethodBody(a.RelativeVirtualAddress)
                Assert.Contains(body.ExceptionRegions, (r ExceptionRegion) -> r.Kind == ExceptionRegionKind.Filter)
                let il = body.GetILBytes() ?? throw XunitException("A has no IL body")
                Assert.Equal(0x14, int32(il[0]))
                let section = pe
                    .PEHeaders
                    .SectionHeaders
                    .Single(
                    (s SectionHeader) -> a.RelativeVirtualAddress >= s.VirtualAddress &&
                        a.RelativeVirtualAddress < s.VirtualAddress +
                        s.SizeOfRawData
                )
                let headerOffset = a.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData
                let headerSize = (int32(bytes[headerOffset + 1]) >> 4) * 4 // fat header (method has EH)
                let code = headerOffset + headerSize
                bytes[code] = uint8(0x26)
            }
            File.WriteAllBytes(dll, bytes)
            let error = Assert.Throws[XunitException](() -> IlVerifier.Verify(dll))
            Assert.Contains(
                "<Program>::A()][offset 0x00000000] Stack underflow",
                error.Message,
                StringComparison.Ordinal
            )
        } finally {
            TryDelete(dir)
        }
    }

    @Fact
    func Rule_MatchesOnlyTheFilterStart_OfTheRealAssembly() {
        let dir = Directory.CreateTempSubdirectory("gs_ilv_4489_rule_").FullName
        try {
            let dll = Compile(dir)
            var filterOffset int32
            {
                using let pe = PEReader(File.OpenRead(dll))
                let md = pe.GetMetadataReader()
                let a = md
                    .MethodDefinitions
                    .Select(md.GetMethodDefinition)
                    .Single((m MethodDefinition) -> md.GetString(m.Name) == "A")
                filterOffset = pe
                    .GetMethodBody(a.RelativeVirtualAddress)
                    .ExceptionRegions
                    .Single((r ExceptionRegion) -> r.Kind == ExceptionRegionKind.Filter)
                    .FilterOffset
            }
            let rule = IlVerifyFilterInFinallyRule.Load(dll)
            Assert.True(rule.Matches("StackUnderflow", Line("StackUnderflow", "P.<Program>::A()", filterOffset)))
            Assert.False(rule.Matches("StackUnderflow", Line("StackUnderflow", "P.<Program>::A()", filterOffset + 1)))
            Assert.False(rule.Matches("StackUnderflow", Line("StackUnderflow", "P.<Program>::A()", 0)))
            Assert.False(rule.Matches("StackUnderflow", Line("StackUnderflow", "P.<Program>::B(string)", filterOffset)))
            Assert.False(rule.Matches("StackUnderflow", Line("StackUnderflow", "P.<Program>::A(string)", filterOffset)))
            Assert.False(rule.Matches("StackUnexpected", Line("StackUnexpected", "P.<Program>::A()", filterOffset)))
        } finally {
            TryDelete(dir)
        }
    }

    shared {
        private const Source string = `package P

import System
import System.IO

public func A() string {
    try {
        return "a"
    } finally {
        try {
            Console.WriteLine("cleanup")
        } catch (ex Exception) when ex is IOException {
        }
    }
}

public func B(prefix string) string {
    let suffix = "!"
    let f = func() string {
        try {
            return prefix + suffix
        } finally {
            try {
                Console.WriteLine("cleanup2")
            } catch (ex Exception) when ex is IOException {
            }
        }
    }
    return f()
}`

        private func Line(
            code string,
            member string,
            offset int32
        ) string -> "[IL]: Error [$code]: [/abs/x.dll : $member][offset 0x${offset:X8}] Stack underflow."

        private func Compile(dir string) string {
            let src = Path.Combine(dir, "repro.gs")
            let dll = Path.Combine(dir, "repro.dll")
            File.WriteAllText(src, Source)
            let exit = Program.Main([]string{"/out:" + dll, "/target:library", "/targetframework:net10.0", src})
            Assert.Equal(0, exit)
            return dll
        }

        private func TryDelete(dir string) {
            try {
                Directory.Delete(dir, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
