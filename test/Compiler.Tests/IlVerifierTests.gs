// <copyright file="IlVerifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit
import Xunit.Sdk

/// Smoke tests for the (cref:IlVerifier) helper itself. These guard the
/// gate: if these break, every Compile…+Verify call elsewhere in this assembly
/// is producing meaningless results.
open class IlVerifierTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func StaticInterfaceDispatch_UnlistedRoslynAndGSharpAssemblies_RunAndVerify(gsharp bool) {
        let dir = Path.Combine(AppContext.BaseDirectory, "static-interface-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileStaticInterface(dir, gsharp)
            let report = StaticInterfaceReport(dll)
            Assert.Contains("[CallAbstract]", report, StringComparison.Ordinal)
            Assert.Contains("[Constrained]", report, StringComparison.Ordinal)
            Assert.True(IlVerifyFalsePositives.OnlyKnown(dll, report), report)
            IlVerifier.Verify(dll)
            let context = AssemblyLoadContext("static-interface-${Guid.NewGuid():N}", isCollectible: true)
            try {
                let assembly = context.LoadFromStream(MemoryStream(File.ReadAllBytes(dll)))
                let program = assembly.GetTypes().Single((t Type) -> t.GetMethod("Apply") != nil)
                let plus = assembly.GetTypes().Single((t Type) -> t.Name == "Plus")
                let method = program.GetMethod("Apply") ?? throw XunitException("Apply not emitted")
                Assert.Equal(
                    7,
                    method.MakeGenericMethod(plus).Invoke(nil, []object{Activator.CreateInstance(plus)!!, 3, 4})
                )
            } finally {
                context.Unload()
            }
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Fact
    func StaticInterfaceDispatch_UnconstrainedCallInSameMethod_StillFails() {
        let dir = Path.Combine(AppContext.BaseDirectory, "static-interface-invalid-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileStaticInterface(dir, gsharp: false)
            let report = StaticInterfaceReport(dll)
            let bytes = File.ReadAllBytes(dll)
            let (codeStart, prefixOffset, callOffset) = StaticInterfaceCallLayout(bytes)
            // Six nops leave the abstract call's offset and token unchanged.

            // A category-wide or method-wide suppression would hide this defect.

            Array.Fill(bytes, uint8(0), codeStart + prefixOffset, 6)
            File.WriteAllBytes(dll, bytes)
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report))
            let error = Assert.Throws[XunitException](() -> IlVerifier.Verify(dll))
            Assert.Contains("[CallAbstract]", error.Message, StringComparison.Ordinal)
            Assert.Contains("[offset 0x${callOffset:X8}]", error.Message, StringComparison.Ordinal)
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Theory
    @InlineData(int32(0))
    @InlineData(int32(1))
    @InlineData(int32(2))
    @InlineData(int32(3))
    func StaticInterfaceDispatch_RejectsWrongSlotMetadataAndConstraint(mutant int32) {
        let dir = Path.Combine(AppContext.BaseDirectory, "static-interface-metadata-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileStaticInterface(dir, gsharp: false)
            let report = StaticInterfaceReport(dll)
            let bytes = File.ReadAllBytes(dll)
            let (codeStart, _, callOffset) = StaticInterfaceCallLayout(bytes)
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            let md = pe.GetMetadataReader()
            let slotHandle = md.MethodDefinitions.Single(
                (h MethodDefinitionHandle) -> md.GetString(md.GetMethodDefinition(h).Name) == "Add" &&
                    (md.GetMethodDefinition(h).Attributes & MethodAttributes.Abstract) != 0
            )
            if mutant < 2 {
                let row = pe.PEHeaders.MetadataStartOffset + md.GetTableMetadataOffset(TableIndex.MethodDef) +
                    (MetadataTokens.GetRowNumber(slotHandle) - 1) * md.GetTableRowSize(TableIndex.MethodDef) + 6
                let flags = BitConverter.ToUInt16(bytes, row)
                let remove = if mutant == 0 {
                    MethodAttributes.Static
                } else {
                    MethodAttributes.Virtual
                }
                let changed = BitConverter.GetBytes(uint16(flags & ~uint16(remove)))
                Array.Copy(changed, 0, bytes, row, 2)
            } else if mutant == 2 {
                // Replace the constrained TypeSpec with a MethodDef token.

                Array.Copy(
                    BitConverter.GetBytes(MetadataTokens.GetToken(slotHandle)),
                    0,
                    bytes,
                    codeStart + callOffset - 4,
                    4
                )
            } else {
                // Give T an unrelated class constraint instead of IAdd.

                Assert.Equal(4, md.GetTableRowSize(TableIndex.GenericParamConstraint))
                let unrelated = md.TypeDefinitions.Single(
                    (h TypeDefinitionHandle) -> md.GetString(md.GetTypeDefinition(h).Name) == "P"
                )
                let row = pe.PEHeaders.MetadataStartOffset + md.GetTableMetadataOffset(
                    TableIndex.GenericParamConstraint
                ) +
                    2
                Array.Copy(BitConverter.GetBytes(uint16(MetadataTokens.GetRowNumber(unrelated) << 2)), 0, bytes, row, 2)
            }
            File.WriteAllBytes(dll, bytes)
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report))
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Fact
    func StaticInterfaceDispatch_RejectsOtherOffsetsErrorsAndUnaccountedOutput() {
        let dir = Path.Combine(AppContext.BaseDirectory, "static-interface-report-${Guid.NewGuid():N}")
        Directory.CreateDirectory(dir)
        try {
            let dll = CompileStaticInterface(dir, gsharp: false)
            let report = StaticInterfaceReport(dll)
            let (_, _, callOffset) = StaticInterfaceCallLayout(File.ReadAllBytes(dll))
            Assert.False(
                IlVerifyFalsePositives.OnlyKnown(dll, report.Replace("0x${callOffset:X8}", "0x${callOffset + 1:X8}"))
            )
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report.Replace("[CallAbstract]", "[StackUnderflow]")))
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report.Replace("2 Error(s)", "3 Error(s)")))
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report + "\nError: unparsed verifier failure"))
            Assert.False(IlVerifyFalsePositives.OnlyKnown(dll, report.Replace("::Apply(", "::Missing(")))
        } finally {
            Directory.Delete(dir, recursive: true)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func VerifyCore_AcceptsNativeAssemblyWithNoncanonicalPath(relative bool) {
        let tempDir = Path.GetFullPath(Directory.CreateTempSubdirectory("gs_ilv_path_").FullName)
        try {
            Directory.CreateDirectory(Path.Combine(tempDir, "nested"))
            let outPath = Path.Combine(tempDir, "valid.dll")
            let compilation = CSharpCompilation.Create(
                "Valid",
                []SyntaxTree{
                    CSharpSyntaxTree.ParseText("public static class Valid { public static int Value() => 42; }")
                },
                []PortableExecutableReference{MetadataReference.CreateFromFile(typeof(object).Assembly.Location)},
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let emit = compilation.Emit(outPath)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            IlVerifier.Verify(outPath)
            let noncanonicalPath = Path.Combine(tempDir, ".", "nested", "..", "valid.dll")
            let assemblyPath = if relative {
                Path.GetRelativePath(IlVerifier.FindRepoRoot(), noncanonicalPath)
            } else {
                noncanonicalPath
            }
            Assert.Equal(outPath, Path.GetFullPath(assemblyPath, IlVerifier.FindRepoRoot()))
            Assert.NotEqual(outPath, assemblyPath)
            IlVerifier.VerifyCore(
                "dotnet",
                []string{"tool", "run", "ilverify"},
                assemblyPath,
                []string{typeof(object).Assembly.Location},
                ignoredErrorCodes: nil,
                includedScope: nil,
                excludedScope: nil
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Theory
    @InlineData(int32(0), "")
    @InlineData(int32(0), "All Classes and Methods Verified.")
    @InlineData(int32(0), "All Classes and Methods in other.dll Verified.")
    @InlineData(int32(1), "matching")
    func VerifyCore_RejectsMissingOrWrongMarkerAndNonzeroExit(exitCode int32, output string) {
        let assemblyPath = typeof(IlVerifierTests).Assembly.Location
        let marker = if output == "matching" {
            "All Classes and Methods in $assemblyPath Verified."
        } else {
            output
        }
        let child = CreateChildProcess(
            "[Console]::Out.Write('${marker.Replace("'", "''")}'); exit $exitCode",
            "printf '%s' '${marker.Replace("'", "'\\''")}'; exit $exitCode"
        )
        let exception = Assert.Throws[XunitException](
            () -> IlVerifier.VerifyCore(
                child.FileName,
                child.ArgumentList.ToArray(),
                assemblyPath,
                Array.Empty[string](),
                ignoredErrorCodes: nil,
                includedScope: nil,
                excludedScope: nil
            )
        )
        Assert.Contains(
            if exitCode == 0 {
                "without confirming verification"
            } else {
                "(exit 1)"
            },
            exception.Message,
            StringComparison.Ordinal
        )
    }

    @Theory
    @InlineData(int32(0), "")
    @InlineData(int32(0), "All Classes and Methods Verified.")
    @InlineData(int32(0), "All Classes and Methods in other.dll Verified.")
    @InlineData(int32(1), "matching")
    func CreateChildProcess_WindowsCommandIsInvokedScriptBlock(exitCode int32, output string) {
        const AssemblyPath = "C:\\verifier fixture\\test.dll"
        let marker = if output == "matching" {
            "All Classes and Methods in $AssemblyPath Verified."
        } else {
            output
        }
        let command = "[Console]::Out.Write('${marker.Replace("'", "''")}'); exit $exitCode"
        let child = CreateChildProcess(command, string.Empty, windows: true)
        child.ArgumentList.Add(AssemblyPath)
        child.ArgumentList.Add("-s")
        child.ArgumentList.Add("System.Private.CoreLib")
        Assert.Equal("powershell.exe", child.FileName)
        Assert.Equal(
            []string{
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "& { $command }",
                AssemblyPath,
                "-s",
                "System.Private.CoreLib"
            },
            child.ArgumentList.ToArray()
        )
    }

    @Fact
    func Verify_AcceptsValidEmittedAssembly_DoesNotThrow() {
        // Compile the smallest possible gs program and verify the result.
        // This is the actual usage pattern for Compile…Verify() helpers, and
        // guards against regressions in IlVerifier itself (e.g., wrong system
        // module name, missing reference probe).
        let tempDir = Directory.CreateTempSubdirectory("gs_ilv_smoke_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "smoke.gs")
            let outPath = Path.Combine(tempDir, "smoke.dll")
            File.WriteAllText(srcPath, `package P

func Main() {
}
`)
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath})
            Assert.Equal(0, exit)
            Assert.True(File.Exists(outPath), "expected output at $outPath")
            IlVerifier.Verify(outPath)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func Verify_MissingAssembly_Throws() {
        let bogus = Path.Combine(Path.GetTempPath(), "does-not-exist-${Guid.NewGuid():N}.dll")
        Assert.Throws[XunitException](() -> IlVerifier.Verify(bogus))
    }

    @Fact
    func Verify_MissingReference_Throws() {
        let bogus = Path.Combine(Directory.GetCurrentDirectory(), "does-not-exist-${Guid.NewGuid():N}.dll")
        let exception = Assert.Throws[XunitException](
            () -> IlVerifier.Verify(typeof(IlVerifierTests).Assembly.Location, []string{bogus})
        )
        Assert.Contains("reference assembly not found", exception.Message, StringComparison.Ordinal)
    }

    @Fact
    func Verify_InvalidMethodBody_ReportsErrors() {
        let tempDir = Directory.CreateTempSubdirectory("gs_ilv_bad_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "bad.gs")
            let outPath = Path.Combine(tempDir, "bad.dll")
            File.WriteAllText(srcPath, `package P

public func Bad() {
}
`)
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath})
            Assert.Equal(0, exit)
            let bytes = File.ReadAllBytes(outPath)
            {
                using let peReader = PEReader(MemoryStream(bytes, writable: false))
                let metadata = peReader.GetMetadataReader()
                let method = metadata
                    .MethodDefinitions
                    .Select(metadata.GetMethodDefinition)
                    .Single((m MethodDefinition) -> metadata.GetString(m.Name) == "Bad")
                let body = peReader.GetMethodBody(method.RelativeVirtualAddress)
                Assert.Equal([]uint8{0x2A}, body.GetILBytes())
                let section = peReader
                    .PEHeaders
                    .SectionHeaders
                    .Single(
                    (s SectionHeader) -> method.RelativeVirtualAddress >= s.VirtualAddress &&
                        method.RelativeVirtualAddress < s.VirtualAddress +
                        s.SizeOfRawData
                )
                let bodyOffset = method.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData
                let headerSize = 1
                bytes[bodyOffset + headerSize] = uint8(0x26)
            }
            File.WriteAllBytes(outPath, bytes)
            let exception = Assert.Throws[XunitException](() -> IlVerifier.Verify(outPath))
            Assert.Contains("Error(s)", exception.Message, StringComparison.Ordinal)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func Verify_RespectsSkipEnvVar() {
        let prev = Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY")
        Environment.SetEnvironmentVariable("GSHARP_SKIP_ILVERIFY", "1")
        try {
            // With the gate disabled, even a missing assembly is a no-op so
            // developers can locally bypass the tool requirement.
            let bogus = Path.Combine(Path.GetTempPath(), "does-not-exist-${Guid.NewGuid():N}.dll")
            IlVerifier.Verify(bogus)
            Assert.False(IlVerifier.IsEnabled)
        } finally {
            Environment.SetEnvironmentVariable("GSHARP_SKIP_ILVERIFY", prev)
        }
    }

    @Fact
    func Verify_MethodScopedIgnore_DoesNotHideSameErrorInAnotherMethod() {
        let tempDir = Directory.CreateTempSubdirectory("gs_ilv_scope_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "scope.gs")
            let outPath = Path.Combine(tempDir, "scope.dll")
            File.WriteAllText(srcPath, `package P

unsafe func Ignored(p *int32) int32 { return *p }
unsafe func Visible(p *int32) int32 { return *p }`)
            let exit = Program.Main([]string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath})
            Assert.Equal(0, exit)
            let exception = Assert.Throws[XunitException](
                () -> IlVerifier.Verify(
                    outPath,
                    ignoredErrorCodes: []string{"UnmanagedPointer", "StackByRef"},
                    ignoredErrorScope: "<Program>\\.Ignored$$"
                )
            )
            Assert.Contains("::Visible(", exception.Message, StringComparison.Ordinal)
            Assert.DoesNotContain("::Ignored(", exception.Message, StringComparison.Ordinal)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func RunProcess_HungChild_TimesOutWithPartialOutput() {
        let assemblyPath = typeof(IlVerifierTests).Assembly.Location
        let stopwatch = Stopwatch.StartNew()
        let exception = Assert.Throws[XunitException](
            func () object? {
                return IlVerifier.RunProcess(
                    CreateChildProcess(
                        "[Console]::Out.Write('timeout-stdout'); [Console]::Error.Write('timeout-stderr'); Start-Sleep -Seconds 6",
                        "printf timeout-stdout; printf timeout-stderr >&2; sleep 6"
                    ),
                    assemblyPath,
                    timeoutMilliseconds: 2_000
                )
            }
        )
        stopwatch.Stop()
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(5), "timeout took ${stopwatch.Elapsed}")
        Assert.Contains("timed out after 2000 ms", exception.Message, StringComparison.Ordinal)
        Assert.Contains(assemblyPath, exception.Message, StringComparison.Ordinal)
        Assert.Contains("timeout-stdout", exception.Message, StringComparison.Ordinal)
        Assert.Contains("timeout-stderr", exception.Message, StringComparison.Ordinal)
    }

    @Fact
    func RunProcess_LargeStdoutAndStderr_DrainsBothPipes() {
        // A regression that blocks in either drain before WaitForExit hangs this test.
        // Starting a drain after the wait instead reaches the 10 s timeout and fails boundedly.
        // xUnit's Fact timeout is unavailable because this assembly disables test
        // parallelization, and RunProcess's timeout cannot cover a deadlock placed
        // before its wait. Treat such a hang as the regression, not a flake.
        const OutputLength = 128 * 1024
        let result = IlVerifier.RunProcess(
            CreateChildProcess(
                "[Console]::Out.Write('o' * $OutputLength); [Console]::Error.Write('e' * $OutputLength)",
                "awk 'BEGIN { for (i = 0; i < $OutputLength; i++) printf \"o\" }'; " +
                    "awk 'BEGIN { for (i = 0; i < $OutputLength; i++) printf \"e\" }' >&2"
            ),
            typeof(IlVerifierTests).Assembly.Location,
            timeoutMilliseconds: 10_000
        )
        Assert.Equal(0, result.ExitCode)
        Assert.Equal(String('o', OutputLength), result.Stdout)
        Assert.Equal(String('e', OutputLength), result.Stderr)
    }

    @Fact
    func TryProbe_LargeStdoutAndStderr_DrainsBothPipes() {
        const OutputLength = 128 * 1024
        Assert.True(
            IlVerifier.TryProbe(
                CreateChildProcess(
                    "[Console]::Out.Write('o' * $OutputLength); [Console]::Error.Write('e' * $OutputLength)",
                    "awk 'BEGIN { for (i = 0; i < $OutputLength; i++) printf \"o\" }'; " +
                        "awk 'BEGIN { for (i = 0; i < $OutputLength; i++) printf \"e\" }' >&2"
                ),
                timeoutMilliseconds: 10_000
            )
        )
    }

    @Fact
    func RunProcess_EscapedDescendantHoldingPipe_TimeoutRemainsBounded() {
        if OperatingSystem.IsWindows() {
            // Process has no portable API for creating a reparented Windows
            // descendant that retains inherited redirected pipe handles.
            return
        }
        let pidPath = Path.Combine(AppContext.BaseDirectory, "ilverify-escaped-${Guid.NewGuid():N}.pid")
        try {
            let stopwatch = Stopwatch.StartNew()
            let exception = Assert.Throws[XunitException](
                func () object? {
                    return IlVerifier.RunProcess(
                        CreateChildProcess(
                            string.Empty,
                            "(sleep 30 2>/dev/null & echo $$! > '$pidPath'); printf escaped-stdout; sleep 6"
                        ),
                        typeof(IlVerifierTests).Assembly.Location,
                        timeoutMilliseconds: 2_000
                    )
                }
            )
            stopwatch.Stop()
            Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(20), "timeout took ${stopwatch.Elapsed}")
            Assert.Contains("process '/bin/sh' timed out after 2000 ms", exception.Message, StringComparison.Ordinal)
            Assert.Contains(
                "<unavailable: output pipe held by a surviving descendant>",
                exception.Message,
                StringComparison.Ordinal
            )
        } finally {
            if File.Exists(pidPath) && int32.TryParse(File.ReadAllText(pidPath), out var pid) {
                try {
                    using let escaped = Process.GetProcessById(pid)
                    escaped.Kill(entireProcessTree: true)
                    escaped.WaitForExit(5_000)
                } catch (ArgumentException) { }
            }
            File.Delete(pidPath)
        }
    }

    shared {
        private func CompileStaticInterface(dir string, gsharp bool) string {
            let dll = Path.Combine(dir, "unlisted.dll")
            if gsharp {
                let source = Path.Combine(dir, "input.gs")
                File.WriteAllText(source, `package P
interface IAdd { shared{func Add(a int32, b int32) int32;} }
class Plus : IAdd { shared { func Add(a int32, b int32) int32 { return a+b } } }
func Apply[T IAdd](w T, a int32, b int32) int32 { return T.Add(a,b) }`)
                Assert.Equal(
                    0,
                    Program.Main([]string{"/out:" + dll, "/target:library", "/targetframework:net10.0", source})
                )
            } else {
                let compilation = CSharpCompilation.Create("unlisted", []SyntaxTree{CSharpSyntaxTree.ParseText(`public interface IAdd { static abstract int Add(int a,int b); }
public class Plus : IAdd { public static int Add(int a,int b) => a+b; }
public class P { public static int Apply<T>(T w,int a,int b) where T:IAdd => T.Add(a,b); }`)}, []PortableExecutableReference{
                        MetadataReference.CreateFromFile(typeof(object).Assembly.Location)
                    }, CSharpCompilationOptions(
                        OutputKind.DynamicallyLinkedLibrary,
                        optimizationLevel: OptimizationLevel.Release
                    ))
                let emit = compilation.Emit(dll)
                Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            }
            return dll
        }

        private func StaticInterfaceReport(dll string) string {
            let startInfo = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for arg in[]string{
                "tool",
                "run",
                "ilverify",
                dll,
                "-s",
                "System.Private.CoreLib",
                "-r",
                Path.Combine(Path.GetDirectoryName(typeof(object).Assembly.Location)!!, "*.dll")
            } {
                startInfo.ArgumentList.Add(arg)
            }
            startInfo.WorkingDirectory = IlVerifier.FindRepoRoot()
            let result = IlVerifier.RunProcess(startInfo, dll, 30_000)
            Assert.Equal(2, result.ExitCode)
            Assert.True(string.IsNullOrWhiteSpace(result.Stderr), result.Stderr)
            return result.Stdout
        }

        private func StaticInterfaceCallLayout(bytes[]uint8)(CodeStart int32, PrefixOffset int32, CallOffset int32) {
            using let pe = PEReader(MemoryStream(bytes, writable: false))
            let md = pe.GetMetadataReader()
            let method = md
                .MethodDefinitions
                .Select(md.GetMethodDefinition)
                .Single((m MethodDefinition) -> md.GetString(m.Name) == "Apply")
            let il = pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes()
            let instructions = IlInstructionReader.Read(il)
            let prefix = instructions.Single((i IlInstruction) -> i.OpCode == OpCodes.Constrained)
            let call = instructions.Single((i IlInstruction) -> i.OpCode == OpCodes.Call)
            Assert.Equal(prefix.Offset + 6, call.Offset)
            let section = pe
                .PEHeaders
                .SectionHeaders
                .Single(
                (s SectionHeader) -> method.RelativeVirtualAddress >= s.VirtualAddress &&
                    method.RelativeVirtualAddress < s.VirtualAddress +
                    s.SizeOfRawData
            )
            let header = method.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData
            let headerSize = if (bytes[header] & uint8(3)) == uint8(2) {
                1
            } else {
                int32(bytes[header + 1] >> 4) * 4
            }
            return (header + headerSize, prefix.Offset, call.Offset)
        }

        private func CreateChildProcess(
            windowsCommand string,
            unixCommand string,
            windows bool? = nil
        ) ProcessStartInfo {
            let isWindows = windows ?? OperatingSystem.IsWindows()
            let startInfo = ProcessStartInfo(
                if isWindows {
                    "powershell.exe"
                } else {
                    "/bin/sh"
                }
            ){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
            if isWindows {
                startInfo.ArgumentList.Add("-NoProfile")
                startInfo.ArgumentList.Add("-NonInteractive")
                startInfo.ArgumentList.Add("-Command")
                // VerifyCore appends verifier arguments; keep them outside the invoked script.
                startInfo.ArgumentList.Add("& { $windowsCommand }")
            } else {
                startInfo.ArgumentList.Add("-c")
                startInfo.ArgumentList.Add(unixCommand)
            }
            return startInfo
        }
    }
}
