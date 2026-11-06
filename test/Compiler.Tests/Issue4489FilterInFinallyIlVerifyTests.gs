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
import System.Reflection.Metadata.Ecma335
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

    @Fact
    func Issue5115_InvalidFilterTailOrHandlerAfterFilterStart_IsRejectedByIlVerifier() {
        if !IlVerifier.IsEnabled {
            return
        }
        let dir = Directory.CreateTempSubdirectory("gs_ilv_5115_").FullName
        try {
            let dll = Compile(dir)
            let originalBytes = File.ReadAllBytes(dll)
            var code int32
            var filterOffset int32
            var handlerOffset int32
            {
                using let pe = PEReader(MemoryStream(originalBytes, writable: false))
                let md = pe.GetMetadataReader()
                let a = md
                    .MethodDefinitions
                    .Select(md.GetMethodDefinition)
                    .Single((m MethodDefinition) -> md.GetString(m.Name) == "A")
                let body = pe.GetMethodBody(a.RelativeVirtualAddress)
                let filter = body.ExceptionRegions.Single((r ExceptionRegion) -> r.Kind == ExceptionRegionKind.Filter)
                filterOffset = filter.FilterOffset
                handlerOffset = filter.HandlerOffset
                let section = pe
                    .PEHeaders
                    .SectionHeaders
                    .Single(
                    (s SectionHeader) -> a.RelativeVirtualAddress >= s.VirtualAddress &&
                        a.RelativeVirtualAddress < s.VirtualAddress +
                        s.SizeOfRawData
                )
                let headerOffset = a.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData
                let headerSize = (int32(originalBytes[headerOffset + 1]) >> 4) * 4
                code = headerOffset + headerSize
            }
            // 1) #5115 repro: keep `isinst <token>` at FilterOffset intact, replace remainder of filter
            // with `pop; pop; nop...; ldc.i4.0; endfilter`.
            let filterTailBytes = cast[[]uint8](originalBytes.Clone())
            Array.Fill(filterTailBytes, uint8(0), code + filterOffset + 5, handlerOffset - filterOffset - 5)
            filterTailBytes[code + filterOffset + 5] = uint8(0x26) // pop
            filterTailBytes[code + filterOffset + 6] = uint8(0x26) // pop (underflow!)
            filterTailBytes[code + handlerOffset - 3] = uint8(0x16) // ldc.i4.0
            filterTailBytes[code + handlerOffset - 2] = uint8(0xFE)
            filterTailBytes[code + handlerOffset - 1] = uint8(0x11) // endfilter
            let filterTailDll = Path.Combine(dir, "filter-tail.dll")
            File.WriteAllBytes(filterTailDll, filterTailBytes)
            Assert.False(
                IlVerifyFilterInFinallyRule.Load(filterTailDll).Matches(
                    "StackUnderflow",
                    Line("StackUnderflow", "P.<Program>::A()", filterOffset)
                )
            )
            let tailError = Assert.Throws[XunitException](() -> IlVerifier.Verify(filterTailDll))
            Assert.Contains("Stack underflow", tailError.Message, StringComparison.Ordinal)

            // 2) Keep the filter region itself 100% valid, but corrupt the catch handler start (`pop; leave ...`)
            // by adding a second `pop` over the `leave` instruction so only shadow-patched re-verification catches it.
            let handlerBytes = cast[[]uint8](originalBytes.Clone())
            Assert.Equal(uint8(0x26), handlerBytes[code + handlerOffset])
            handlerBytes[code + handlerOffset + 1] = uint8(0x26) // second pop at HandlerOffset + 1
            let handlerDll = Path.Combine(dir, "handler-underflow.dll")
            File.WriteAllBytes(handlerDll, handlerBytes)
            let handlerError = Assert.Throws[XunitException](() -> IlVerifier.Verify(handlerDll))
            Assert.Contains("Error(s)", handlerError.Message, StringComparison.Ordinal)

            // 3) Balanced stack height with incompatible receiver type after `isinst`:
            // change `isinst System.IO.IOException` at FilterOffset in `C` to `isinst System.Object` while
            // the filter body still invokes `IOException`-specific / `Exception::get_Message` on the result.
            let wrongTypeBytes = cast[[]uint8](originalBytes.Clone())
            var cHeaderOffset int32
            var cCode int32
            var cFilterOffset int32
            var objectTypeToken int32
            {
                using let pe = PEReader(MemoryStream(originalBytes, writable: false))
                let md = pe.GetMetadataReader()
                let c = md
                    .MethodDefinitions
                    .Select(md.GetMethodDefinition)
                    .Single((m MethodDefinition) -> md.GetString(m.Name) == "C")
                let body = pe.GetMethodBody(c.RelativeVirtualAddress)
                let filter = body.ExceptionRegions.Single((r ExceptionRegion) -> r.Kind == ExceptionRegionKind.Filter)
                cFilterOffset = filter.FilterOffset
                let section = pe
                    .PEHeaders
                    .SectionHeaders
                    .Single(
                    (s SectionHeader) -> c.RelativeVirtualAddress >= s.VirtualAddress &&
                        c.RelativeVirtualAddress < s.VirtualAddress +
                        s.SizeOfRawData
                )
                cHeaderOffset = c.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData
                let headerSize = (int32(originalBytes[cHeaderOffset + 1]) >> 4) * 4
                cCode = cHeaderOffset + headerSize
                let objRef = md.TypeReferences.Single(
                    (h TypeReferenceHandle) -> {
                        let tr = md.GetTypeReference(h)
                        return md.GetString(tr.Namespace) == "System" && md.GetString(tr.Name) == "Object"
                    }
                )
                objectTypeToken = MetadataTokens.GetToken(objRef)
            }
            Assert.Equal(uint8(0x75), wrongTypeBytes[cCode + cFilterOffset])
            Array.Copy(BitConverter.GetBytes(objectTypeToken), 0, wrongTypeBytes, cCode + cFilterOffset + 1, 4)
            let wrongTypeDll = Path.Combine(dir, "wrong-filter-type.dll")
            File.WriteAllBytes(wrongTypeDll, wrongTypeBytes)
            let wrongTypeError = Assert.Throws[XunitException](() -> IlVerifier.Verify(wrongTypeDll))
            Assert.Contains("Error(s)", wrongTypeError.Message, StringComparison.Ordinal)

            // 4) Non-entity user-string token (`0x70000001`) on `isinst` must return false without throwing ArgumentException.
            let badTokenBytes = cast[[]uint8](originalBytes.Clone())
            Array.Copy(BitConverter.GetBytes(int32(0x70000001)), 0, badTokenBytes, cCode + cFilterOffset + 1, 4)
            let badTokenDll = Path.Combine(dir, "bad-token-filter.dll")
            File.WriteAllBytes(badTokenDll, badTokenBytes)
            Assert.False(
                IlVerifyFilterInFinallyRule.Load(badTokenDll).Matches(
                    "StackUnderflow",
                    Line("StackUnderflow", "P.<Program>::C(object)", cFilterOffset)
                )
            )
            Assert.False(IlVerifyFilterInFinallyRule.TryWritePatchedAssembly(badTokenDll, Path.Combine(dir, "out.dll")))

            // 5) False arm `pop; ldc.i4.0; br M` jumping to `matched` instead of `endfilter` must be rejected.
            let badFalseBranchBytes = cast[[]uint8](originalBytes.Clone())
            // In `C`, `filterOffset + 5` is `dup` (`0x25`), followed by 5-byte `brtrue matched` (`0x3A <int32>`),
            // `pop` (`0x26`), `ldc.i4.0` (`0x16`), and 5-byte `br done` (`0x38 <int32>`).
            // Setting `br done`'s delta to `0` makes it jump to `matched` (`cursor + 0`) instead of `endfilter`.
            let brDoneOperandOffset = cCode + cFilterOffset + 5 + 1 + 5 + 2 + 1
            Array.Copy(BitConverter.GetBytes(int32(0)), 0, badFalseBranchBytes, brDoneOperandOffset, 4)
            let badFalseBranchDll = Path.Combine(dir, "bad-false-branch.dll")
            File.WriteAllBytes(badFalseBranchDll, badFalseBranchBytes)
            Assert.False(
                IlVerifyFilterInFinallyRule.Load(badFalseBranchDll).Matches(
                    "StackUnderflow",
                    Line("StackUnderflow", "P.<Program>::C(object)", cFilterOffset)
                )
            )

            // 6) Lowering `.maxstack` of `C` to `1` while the filter prelude uses `isinst; dup` (depth 2) must be rejected.
            let lowMaxStackBytes = cast[[]uint8](originalBytes.Clone())
            Array.Copy(BitConverter.GetBytes(uint16(1)), 0, lowMaxStackBytes, cHeaderOffset + 2, 2)
            let lowMaxStackDll = Path.Combine(dir, "low-maxstack.dll")
            File.WriteAllBytes(lowMaxStackDll, lowMaxStackBytes)
            Assert.False(
                IlVerifyFilterInFinallyRule.Load(lowMaxStackDll).Matches(
                    "StackUnderflow",
                    Line("StackUnderflow", "P.<Program>::C(object)", cFilterOffset)
                )
            )
            Assert.False(
                IlVerifyFilterInFinallyRule.TryWritePatchedAssembly(lowMaxStackDll, Path.Combine(dir, "out-max.dll"))
            )
            let lowMaxError = Assert.Throws[XunitException](() -> IlVerifier.Verify(lowMaxStackDll))
            Assert.Contains("Error(s)", lowMaxError.Message, StringComparison.Ordinal)
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
}

public func C(o object) string {
    try {
        return o.ToString() ?? ""
    } finally {
        try {
            Console.WriteLine("cleanup3")
        } catch (ex IOException) when ex.Message.Length > 0 {
        }
    }
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
