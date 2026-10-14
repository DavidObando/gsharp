// <copyright file="Issue4489FilterInFinallyIlVerifyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.Emit
import Region = GSharp.Tests.IlVerifyFilterInFinallyRule.Region
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit

/// #4489: the self-migration ilverify stage ignores exactly one ilverify
/// 10.0.8 false positive (upstream dotnet/runtime#134711), a
/// `StackUnderflow` at the start of a filter block that lies inside a
/// `finally`/`fault` handler, and keeps every other stack underflow.
@Collection("IlVerifyPipeline")
open class Issue4489FilterInFinallyIlVerifyTests {
    @Fact
    func TryParse_ReadsTheNightlyLine() {
        Assert.True(
            IlVerifyFilterInFinallyRule.TryParse(
                NightlyLine,
                out var type,
                out var method,
                out var parameterCount,
                out var offset
            )
        )
        Assert.Equal("GSharp.Core.Tests.CodeAnalysis.Binding.EventSubscriptionAccessibilityBinderTests", type)
        Assert.Equal("CompileAgainstLibrary", method)
        Assert.Equal(2, parameterCount)
        Assert.Equal(0x1C6, offset)
        Assert.False(
            IlVerifyFilterInFinallyRule.TryParse(
                NightlyLine.Replace("[StackUnderflow]", "[StackUnexpected]", StringComparison.Ordinal),
                out _,
                out _,
                out _,
                out _
            )
        )
    }

    @Theory
    @InlineData(ExceptionRegionKind(2), int32(20), true)
    @InlineData(ExceptionRegionKind(4), int32(20), true)
    @InlineData(ExceptionRegionKind(2), int32(21), false)
    @InlineData(ExceptionRegionKind(2), int32(12), false)
    @InlineData(ExceptionRegionKind(0), int32(20), false)
    func FilterStartMatcher_RequiresFilterStartWhoseInnermostHandlerIsFinallyOrFault(
        outerHandlerKind ExceptionRegionKind,
        reportedOffset int32,
        expected bool
    ) {
        let regions = List[IlVerifyFilterInFinallyRule.Region]{
            IlVerifyFilterInFinallyRule.Region(outerHandlerKind, 0, 10, 10, 50, -1),
            IlVerifyFilterInFinallyRule.Region(ExceptionRegionKind.Filter, 12, 8, 25, 15, 20)
        }
        Assert.Equal(expected, IlVerifyFilterInFinallyRule.IsFilterStartInsideFinallyOrFault(regions, reportedOffset))
    }

    @Fact
    func FilterStartMatcher_RejectsMethodLevelFilter_AndCatchNestedInFinally() {
        let methodLevel = List[IlVerifyFilterInFinallyRule.Region]{
            IlVerifyFilterInFinallyRule.Region(ExceptionRegionKind.Filter, 0, 8, 13, 5, 8)
        }
        Assert.False(IlVerifyFilterInFinallyRule.IsFilterStartInsideFinallyOrFault(methodLevel, 8))
        // finally [10,70) > catch handler [12,60) > filter start 20: the
        // innermost enclosing handler is the catch, which ILVerify handles.
        let catchInsideFinally = List[IlVerifyFilterInFinallyRule.Region]{
            IlVerifyFilterInFinallyRule.Region(ExceptionRegionKind.Finally, 0, 10, 10, 60, -1),
            IlVerifyFilterInFinallyRule.Region(ExceptionRegionKind.Catch, 10, 2, 12, 48, -1),
            IlVerifyFilterInFinallyRule.Region(ExceptionRegionKind.Filter, 14, 6, 25, 10, 20)
        }
        Assert.False(IlVerifyFilterInFinallyRule.IsFilterStartInsideFinallyOrFault(catchInsideFinally, 20))
        // Same filter directly in the finally handler: matched.
        let direct = List[IlVerifyFilterInFinallyRule.Region]{
            IlVerifyFilterInFinallyRule.Region(ExceptionRegionKind.Finally, 0, 10, 10, 60, -1),
            IlVerifyFilterInFinallyRule.Region(ExceptionRegionKind.Filter, 14, 6, 25, 10, 20)
        }
        Assert.True(IlVerifyFilterInFinallyRule.IsFilterStartInsideFinallyOrFault(direct, 20))
    }

    /// Real ilverify on the issue's C# compiled by Roslyn (which emits the same
    /// layout gsc does): the filter-in-finally method, declared on a nested
    /// type with two parameters, is reported by ilverify yet dropped by the
    /// stage's runner, and runs correctly. The same assembly with a genuine
    /// underflow patched into another method still fails verification.
    @Fact
    func Runner_DropsFilterInFinallyUnderflow_KeepsRealUnderflow() {
        if !IlVerifyRunner.IsEnabled || !IlVerifyRunner().EnsureToolAvailable() {
            return
        }
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "pipeline-tests",
            "issue4489",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let clean = Path.Combine(directory, "Clean.dll")
            let image = CompileFixture()
            File.WriteAllBytes(clean, image)
            let cleanResult = IlVerifyRunner().Verify(clean)
            Assert.Contains("[StackUnderflow]", cleanResult.Output, StringComparison.Ordinal)
            Assert.Contains("Demo.Outer+Inner::Run(string, int32)", cleanResult.Output, StringComparison.Ordinal)
            Assert.True(cleanResult.Succeeded, cleanResult.Output)
            Assert.Empty(cleanResult.Errors)
            let context = AssemblyLoadContext("issue4489-" + Guid.NewGuid().ToString("N"), isCollectible: true)
            try {
                let inner Type? = context.LoadFromStream(MemoryStream(image)).GetType(
                    "Demo.Outer+Inner",
                    throwOnError: true
                )
                Assert.Equal("x", inner!!.GetMethod("Run")!!.Invoke(nil, []object{"x", 1}))
            } finally {
                context.Unload()
            }
            // Broken(): `ldnull; call GC.KeepAlive; ret` -> `pop; ...`, a real
            // underflow at offset 0 of a method with no exception regions.
            let broken = Path.Combine(directory, "Broken.dll")
            File.WriteAllBytes(broken, PatchIl(image, "Broken", atFilterStart: false, expected: 0x14, []uint8{0x26}))
            let brokenResult = IlVerifyRunner().Verify(broken)
            Assert.False(brokenResult.Succeeded, brokenResult.Output)
            Assert.Contains("Demo.Outer+Inner::Run(string, int32)", brokenResult.Output, StringComparison.Ordinal)
            let remaining = Assert.Single(brokenResult.Errors)
            Assert.Equal("StackUnderflow", remaining.Code)
            Assert.Equal("Demo.Outer+Inner::Broken()", remaining.Method)
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    /// Thread 1 (fail closed on the opcode): the same exact-offset layout, but
    /// the filter's first instruction is patched from `isinst` to
    /// `add`, which pops two values and so underflows even with the
    /// exception object present. Real ilverify reports it and the rule keeps it.
    @Fact
    func FilterStartingWithTwoPopOpcode_IsStillReported() {
        Assert.True(IlVerifyFilterInFinallyRule.PopsExactlyOne([]uint8{0x75, 0, 0, 0, 0}, 0))
        Assert.False(IlVerifyFilterInFinallyRule.PopsExactlyOne([]uint8{0x58}, 0))
        let directory = NewDirectory()
        try {
            // isinst <token> (5 bytes) -> add; nop x4
            let path = Path.Combine(directory, "AddFilter.dll")
            File.WriteAllBytes(
                path,
                PatchIl(CompileFixture(), "Run", atFilterStart: true, expected: 0x75, []uint8{0x58, 0, 0, 0, 0})
            )
            Assert.False(
                IlVerifyFilterInFinallyRule.Load(path).Matches("StackUnderflow", RunLine(FilterOffset(path, "Run")))
            )
            if IlVerifyRunner.IsEnabled && IlVerifyRunner().EnsureToolAvailable() {
                let result = IlVerifyRunner().Verify(path)
                Assert.False(result.Succeeded, result.Output)
                let error = Assert.Single(result.Errors)
                Assert.Equal("StackUnderflow", error.Code)
                Assert.Equal("Demo.Outer+Inner::Run(string, int32)", error.Method)
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    /// Thread 2 (ambiguous identity): with a same-arity overload
    /// `Run(string, long)` the ilverify line cannot say which MethodDef it
    /// means, so the rule suppresses nothing for that identity.
    @Fact
    func SameArityOverloads_AreNeverSuppressed() {
        const Overload = "public static string Run(string s, long n) { return s; }"
        let directory = NewDirectory()
        try {
            let single = Path.Combine(directory, "Single.dll")
            File.WriteAllBytes(single, CompileFixture())
            let offset = FilterOffset(single, "Run")
            Assert.True(IlVerifyFilterInFinallyRule.Load(single).Matches("StackUnderflow", RunLine(offset)))
            let path = Path.Combine(directory, "Overloads.dll")
            File.WriteAllBytes(path, CompileFixture(Overload))
            Assert.Equal(offset, FilterOffset(path, "Run"))
            Assert.False(IlVerifyFilterInFinallyRule.Load(path).Matches("StackUnderflow", RunLine(offset)))
            if IlVerifyRunner.IsEnabled && IlVerifyRunner().EnsureToolAvailable() {
                let result = IlVerifyRunner().Verify(path)
                Assert.False(result.Succeeded, result.Output)
                Assert.Equal("Demo.Outer+Inner::Run(string, int32)", Assert.Single(result.Errors).Method)
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        // The exact nightly line from #4489.
        private const NightlyLine string = "[IL]: Error [StackUnderflow]: [GSharp.Core.Tests.dll : GSharp.Core.Tests.CodeAnalysis.Binding." +
            "EventSubscriptionAccessibilityBinderTests::CompileAgainstLibrary(string, System.Func`2<string,string>)]" +
            "[offset 0x000001C6] Stack underflow."

        private func RunLine(
            offset int32
        ) string -> "[IL]: Error [StackUnderflow]: [/abs/Demo.dll : Demo.Outer+Inner::Run(string, int32)]" +
            "[offset 0x${offset:X8}] Stack underflow."

        private func FilterOffset(path string, methodName string) int32 {
            using let pe = PEReader(File.OpenRead(path))
            let md = pe.GetMetadataReader()
            let method = md
                .MethodDefinitions
                .Select(md.GetMethodDefinition)
                .First(
                (m MethodDefinition) -> md.GetString(m.Name) == methodName &&
                    pe
                    .GetMethodBody(m.RelativeVirtualAddress)
                    .ExceptionRegions
                    .Length > 0
            )
            return pe
                .GetMethodBody(method.RelativeVirtualAddress)
                .ExceptionRegions
                .Single((r ExceptionRegion) -> r.Kind == ExceptionRegionKind.Filter)
                .FilterOffset
        }

        private func NewDirectory() string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "pipeline-tests",
                "issue4489",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            return directory
        }

        private func CompileFixture(extraMembers string = "")[]uint8 {
            let source = `namespace Demo
{
    public static class Outer
    {
        public static class Inner
        {
            public static string Run(string s, int n)
            {
                try
                {
                    return s;
                }
                finally
                {
                    try
                    {
                        System.GC.KeepAlive(s);
                    }
                    catch (System.Exception ex) when (ex is System.IO.IOException)
                    {
                    }
                }
            }

            public static void Broken()
            {
                System.GC.KeepAlive(null);
            }

            EXTRA_MEMBERS
        }
    }
}`.Replace("EXTRA_MEMBERS", extraMembers, StringComparison.Ordinal)
            let runtimeDir string? = Path.GetDirectoryName(typeof(object).Assembly.Location)
            let compilation = CSharpCompilation.Create(
                "Issue4489Fixture" + Guid.NewGuid().ToString("N"),
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                []PortableExecutableReference{
                    MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
                    MetadataReference.CreateFromFile(Path.Combine(runtimeDir!!, "System.Runtime.dll"))
                },
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    optimizationLevel: OptimizationLevel.Release
                )
            )
            using let stream = MemoryStream()
            let emit = compilation.Emit(stream)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            return stream.ToArray()
        }

        private func PatchIl(
            image[]uint8,
            methodName string,
            atFilterStart bool,
            expected uint8,
            replacement[]uint8
        )[]uint8 {
            let bytes = cast[[]uint8](image.Clone())
            using let pe = PEReader(MemoryStream(image, writable: false))
            let md = pe.GetMetadataReader()
            let method = md
                .MethodDefinitions
                .Select(md.GetMethodDefinition)
                .Single((m MethodDefinition) -> md.GetString(m.Name) == methodName)
            let body = pe.GetMethodBody(method.RelativeVirtualAddress)
            var ilOffset = 0
            if atFilterStart {
                ilOffset = body
                    .ExceptionRegions
                    .Single((r ExceptionRegion) -> r.Kind == ExceptionRegionKind.Filter)
                    .FilterOffset
            } else {
                Assert.Empty(body.ExceptionRegions)
            }
            Assert.Equal(expected, body.GetILBytes()!![ilOffset])
            let section = pe
                .PEHeaders
                .SectionHeaders
                .Single(
                (h SectionHeader) -> method.RelativeVirtualAddress >= h.VirtualAddress &&
                    method.RelativeVirtualAddress < h.VirtualAddress +
                    h.SizeOfRawData
            )
            let header = method.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData
            let tiny = (int32(bytes[header]) & 0x3) == 0x2
            let code = header +
                (
                if tiny {
                    1
                } else {
                    (int32(bytes[header + 1]) >> 4) * 4
                }
            )
            replacement.CopyTo(bytes, code + ilOffset)
            return bytes
        }
    }
}
