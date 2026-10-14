// <copyright file="Issue538ForInEnumerableEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection
import System.Reflection.Emit
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import Xunit

/// Regression tests for issue #538: `for x in expr` where `expr` is
/// typed as an interface (`IReadOnlyList<T>`, `IEnumerable<T>`,
/// `ICollection<T>`) silently crashed the emit phase with MSB4181
/// because the lowerer could not resolve `GetEnumerator()` on interface types.
///
/// The fix teaches `MemberLookup.ResolveGetEnumerator` to search implemented
/// interfaces when the type itself does not directly declare the method.
open class Issue538ForInEnumerableEmitTests {
    @Fact
    func ForIn_IReadOnlyList_String_CountAndContents() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue538_rolist_").FullName
        try {
            let helperPath = BuildProbeAssembly(tempDir)
            let source = `package P
import System
import Probe

var items = EnumerableSource.GetReadOnlyList()
var n = 0
for s in items {
  Console.WriteLine(s)
  n = n + 1
}
Console.WriteLine(n)`
            let output = CompileAndRunWithHelper(source, tempDir, helperPath)
            Assert.Equal(
                "alpha${Environment.NewLine}beta${Environment.NewLine}gamma${Environment.NewLine}3${Environment.NewLine}",
                output
            )
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ForIn_IEnumerable_Int_TypedValueType() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue538_ienum_").FullName
        try {
            let helperPath = BuildProbeAssembly(tempDir)
            let source = `package P
import System
import Probe

var nums = EnumerableSource.GetNumbers()
var sum = 0
for n in nums {
  sum = sum + n
}
Console.WriteLine(sum)`
            let output = CompileAndRunWithHelper(source, tempDir, helperPath)
            Assert.Equal("15${Environment.NewLine}", output)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ForIn_ICollection_String() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue538_icoll_").FullName
        try {
            let helperPath = BuildProbeAssembly(tempDir)
            let source = `package P
import System
import Probe

var coll = EnumerableSource.GetCollection()
var n = 0
for s in coll {
  Console.WriteLine(s)
  n = n + 1
}
Console.WriteLine(n)`
            let output = CompileAndRunWithHelper(source, tempDir, helperPath)
            Assert.Equal("x${Environment.NewLine}y${Environment.NewLine}2${Environment.NewLine}", output)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ForIn_EmptyIReadOnlyList_ZeroIterations() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue538_empty_").FullName
        try {
            let helperPath = BuildProbeAssembly(tempDir)
            let source = `package P
import System
import Probe

var items = EnumerableSource.GetEmptyReadOnlyList()
var n = 0
for s in items { n = n + 1 }
Console.WriteLine(n)`
            let output = CompileAndRunWithHelper(source, tempDir, helperPath)
            Assert.Equal("0${Environment.NewLine}", output)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ForIn_CustomIEnumerable_DispatchesCorrectly() {
        let tempDir = Directory.CreateTempSubdirectory("gs_issue538_custom_").FullName
        try {
            let helperPath = BuildProbeAssembly(tempDir)
            let source = `package P
import System
import Probe

var custom = EnumerableSource.GetCustomEnumerable()
var n = 0
for v in custom {
  Console.WriteLine(v)
  n = n + 1
}
Console.WriteLine(n)`
            let output = CompileAndRunWithHelper(source, tempDir, helperPath)
            Assert.Equal(
                "10${Environment.NewLine}20${Environment.NewLine}30${Environment.NewLine}3${Environment.NewLine}",
                output
            )
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ForIn_ConcreteList_RegressionGuard() {
        // Concrete List<T> should still use the existing fast path.
        let source = `package P
import System
import System.Collections.Generic

var list = List[string]()
list.Add("a")
list.Add("b")
var n = 0
for s in list {
  Console.WriteLine(s)
  n = n + 1
}
Console.WriteLine(n)`
        let output = CompileAndRun(source)
        Assert.Equal("a${Environment.NewLine}b${Environment.NewLine}2${Environment.NewLine}", output)
    }

    @Fact
    func ForIn_ClrArray_RegressionGuard() {
        let source = `package P
import System

var arr = "hello world".Split(' ')
for s in arr {
  Console.WriteLine(s)
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}world${Environment.NewLine}", output)
    }

    @Fact
    func ForIn_String_RegressionGuard() {
        let source = `package P
import System

for c in "abc" {
  Console.WriteLine(int32(c))
}`
        let output = CompileAndRun(source)
        Assert.Equal("97${Environment.NewLine}98${Environment.NewLine}99${Environment.NewLine}", output)
    }

    shared {
        /// Builds the Probe.dll assembly with:
        /// - EnumerableSource.GetReadOnlyList() -> IReadOnlyList<string>
        /// - EnumerableSource.GetNumbers() -> IEnumerable<int>
        /// - EnumerableSource.GetCollection() -> ICollection<string>
        /// - EnumerableSource.GetEmptyReadOnlyList() -> IReadOnlyList<string>
        /// - EnumerableSource.GetCustomEnumerable() -> IEnumerable<int> (custom impl)
        private func BuildProbeAssembly(dir string) string {
            // Build the probe in a subdirectory to avoid interaction between the
            // project file, intermediate build artifacts, and the test files that
            // are written into `dir` by CompileAndRunImpl. This matches the
            // pattern used by Issue529 tests which reliably passes on CI (Linux).
            let csDir = Path.Combine(dir, "csref")
            Directory.CreateDirectory(csDir)
            let csSource = `using System;
using System.Collections;
using System.Collections.Generic;

namespace Probe
{
    public static class EnumerableSource
    {
        public static IReadOnlyList<string> GetReadOnlyList()
            => new[] { "alpha", "beta", "gamma" };

        public static IEnumerable<int> GetNumbers()
            => new[] { 1, 2, 3, 4, 5 };

        public static ICollection<string> GetCollection()
            => ["x", "y"];

        public static IReadOnlyList<string> GetEmptyReadOnlyList()
            => Array.Empty<string>();

        public static IEnumerable<int> GetCustomEnumerable()
            => new CustomEnumerable();
    }

    public class CustomEnumerable : IEnumerable<int>
    {
        private readonly int[] data = new[] { 10, 20, 30 };

        public IEnumerator<int> GetEnumerator() => new CustomEnumerator(data);

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public class CustomEnumerator : IEnumerator<int>
    {
        private readonly int[] data;
        private int index = -1;

        public CustomEnumerator(int[] data) { this.data = data; }

        public int Current => data[index];

        object IEnumerator.Current => Current;

        public bool MoveNext() => ++index < data.Length;

        public void Reset() => index = -1;

        public void Dispose() { }
    }
}`
            File.WriteAllText(Path.Combine(csDir, "Probe.cs"), csSource)
            File.WriteAllText(Path.Combine(csDir, "Probe.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Library</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <AssemblyName>Probe</AssemblyName>
    <RootNamespace>Probe</RootNamespace>
  </PropertyGroup>
</Project>`)
            RunDotnet(csDir, "restore")
            RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore")
            let probeDll = Path.Combine(csDir, "bin", "Release", "net10.0", "Probe.dll")
            Assert.True(File.Exists(probeDll), "Probe.dll not found at $probeDll")
            return probeDll
        }

        private func RunDotnet(workingDir string, args ...string) {
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = workingDir
            }
            for a in args {
                psi.ArgumentList.Add(a)
            }
            using let proc = Process.Start(psi) ??
                throw InvalidOperationException("failed to start dotnet ${string.Join(" ", args)}")
            let stdout = proc.StandardOutput.ReadToEnd()
            let stderr = proc.StandardError.ReadToEnd()
            Assert.True(proc.WaitForExit(120_000), "dotnet ${args[0]} timed out")
            Assert.True(
                proc.ExitCode == 0,
                (`dotnet ` + "${string.Join(" ", args)}" + ` failed (exit ` + "${proc.ExitCode}" + `)
stdout:
` + "$stdout" + `
stderr:
` + "$stderr")
            )
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue538_").FullName
            try {
                return CompileAndRunImpl(source, tempDir, helperPath: nil)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunWithHelper(source string, tempDir string, helperPath string) string {
            return CompileAndRunImpl(source, tempDir, helperPath)
        }

        private func CompileAndRunImpl(source string, tempDir string, helperPath string?) string {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            if helperPath != nil {
                args.Add("/reference:" + helperPath)
                for reference in TrustedPlatformAssemblies() {
                    args.Add("/reference:" + reference)
                }
                args.Add("/nowarn:GS9100")
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            let extraRefs[]?string = if helperPath != nil {
                []string{helperPath}
            } else {
                default([]?string)
            }
            IlVerifier.Verify(outPath, extraRefs)
            // Copy the helper assembly next to the output so the runtime can
            // resolve it when `dotnet exec` loads the compiled test assembly.
            if helperPath != nil {
                File.Copy(helperPath, Path.Combine(tempDir, Path.GetFileName(helperPath)), overwrite: true)
            }
            let psi = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir
            }
            psi.ArgumentList.Add("exec")
            psi.ArgumentList.Add("--runtimeconfig")
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
            psi.ArgumentList.Add(outPath)
            using let proc Process? = Process.Start(psi)
            let stdout = proc!!.StandardOutput.ReadToEnd()
            let stderr = proc!!.StandardError.ReadToEnd()
            Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc!!.ExitCode == 0, (`exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine)
        }

        private func TrustedPlatformAssemblies() sequence[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                yield break
            }
            for path in tpa.Split(Path.PathSeparator) {
                if !string.IsNullOrWhiteSpace(path) && File.Exists(path) {
                    yield path
                }
            }
        }
    }
}
