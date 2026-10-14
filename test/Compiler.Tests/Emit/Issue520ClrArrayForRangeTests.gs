// <copyright file="Issue520ClrArrayForRangeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection
import System.Reflection.Emit
import Xunit

/// Regression tests for issue #520 (and the duplicate #536): `for x := range coll`
/// over a CLR SZ array (`T[]`) used to walk the array via
/// (cref:System.Array.GetEnumerator), which returns the non-generic
/// (cref:System.Collections.IEnumerator) whose `Current` property
/// returns (cref:object). For value-typed element arrays
/// (`Color[]`, `char[]`, `int[]`) the loop body then stored
/// a boxed reference into a value-typed local — the low 32 bits of the
/// managed pointer surfaced as garbage values (pointer-like integers in the
/// ~900M range) and downstream casts crashed with
/// (cref:System.AccessViolationException).
///
/// The fix (see `Binder.BindForRangeStatement`) detects SZ-array
/// (cref:System.Type.IsArray) on the CLR side and routes through the
/// Indexed strategy, which emits `ldelem <T>` via the array's
/// actual element type — the same lowering Roslyn emits for
/// `foreach (T x in arr)`.
open class Issue520ClrArrayForRangeTests {
    @Fact
    func ForRange_OverClrEnumArray_YieldsDeclaredMembersInOrder() {
        // The original repro: enumerating a `Region[]` returned by a CLR helper
        // used to surface heap addresses (pointer-like ints in the ~900M range)
        // instead of the enum members. With the indexed lowering it produces
        // ldelem <Region> against the underlying int32 storage, so each load
        // reconstitutes the value-type element exactly.
        let tempDir = Directory.CreateTempSubdirectory("gs_issue520_enum_").FullName
        try {
            let helperPath = BuildClrArrayHelperAssembly(tempDir)
            let source = `package P
import System
import Probe

var arr = Helper.GetColors()!!
for c in arr {
  Console.WriteLine(int32(c))
}`
            let output = CompileAndRunWithHelper(source, tempDir, helperPath, verifyIl: true)
            Assert.Equal("0${Environment.NewLine}1${Environment.NewLine}2${Environment.NewLine}", output)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ForRange_OverClrEnumArray_EnumIsDefinedHoldsForEveryElement() {
        // Tighter check matching the user's `Enum.IsDefined[T](r)` assertion
        // from the issue — under the bug every element was a heap-pointer-cast
        // int, so IsDefined returned false on every iteration.
        let tempDir = Directory.CreateTempSubdirectory("gs_issue520_isdef_").FullName
        try {
            let helperPath = BuildClrArrayHelperAssembly(tempDir)
            let source = `package P
import System
import Probe

var arr = Helper.GetColors()!!
for c in arr {
  if Enum.IsDefined(typeof(Color), c) {
    Console.WriteLine("ok")
  } else {
    Console.WriteLine("bad")
  }
}`
            let output = CompileAndRunWithHelper(source, tempDir, helperPath, verifyIl: false)
            Assert.Equal("ok${Environment.NewLine}ok${Environment.NewLine}ok${Environment.NewLine}", output)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ForRange_OverClrCharArray_YieldsExactChars() {
        // Doubles as the issue #536 repro: `for c in charArr` over `char[]`
        // produced garbled values for the same reason — `char` is a value type
        // and the loop variable was holding the boxed-object pointer's low
        // bits. The fix routes char[] through `ldelem.u2`.
        let source = `package P
import System

var ca = "abc".ToCharArray()
for c in ca {
  Console.WriteLine(int32(c))
}`
        let output = CompileAndRun(source)
        Assert.Equal("97${Environment.NewLine}98${Environment.NewLine}99${Environment.NewLine}", output)
    }

    @Fact
    func ForRange_OverClrIntArray_YieldsExactInts() {
        // Value-type element regression guard via `int[]`. Pre-fix this
        // dereferenced a heap address as an int32 and printed garbage.
        let source = `package P
import System
import System.Linq

var ia = Enumerable.ToArray[int32](Enumerable.Range(10, 3))
for i in ia {
  Console.WriteLine(i)
}`
        let output = CompileAndRun(source)
        Assert.Equal("10${Environment.NewLine}11${Environment.NewLine}12${Environment.NewLine}", output)
    }

    @Fact
    func ForRange_OverClrStringArray_YieldsExactStrings() {
        // Reference-type element regression guard — the indexed lowering still
        // has to emit `ldelem.ref` for `string[]`. This pins that we didn't
        // regress the reference-type path while fixing the value-type one.
        let source = `package P
import System

var sa = "x y z".Split(' ')
for s in sa {
  Console.WriteLine(s)
}`
        let output = CompileAndRun(source)
        Assert.Equal("x${Environment.NewLine}y${Environment.NewLine}z${Environment.NewLine}", output)
    }

    @Fact
    func ForRange_OverClrStringArray_FromEnumGetNames_YieldsExactStrings() {
        // Tighter regression of the original issue surface area — the user's
        // repro hung off `Enum.GetValues`. We can't bind to the generic
        // `Enum.GetValues<T>()` from G# today, but `Enum.GetNames(typeof(T))`
        // is the same shape (a CLR `string[]`) and exercises the same lowering.
        let source = `package P
import System

enum Region { Us, Uk, De, Fr, Es, It, Pt, Pl, Cz, At, Nl }

var names = Enum.GetNames(typeof(Region))
for n in names {
  Console.WriteLine(n)
}`
        let output = CompileAndRun(source)
        Assert.Equal(
            "Us${Environment.NewLine}Uk${Environment.NewLine}De${Environment.NewLine}Fr${Environment.NewLine}Es${Environment.NewLine}It${Environment.NewLine}Pt${Environment.NewLine}Pl${Environment.NewLine}Cz${Environment.NewLine}At${Environment.NewLine}Nl${Environment.NewLine}",
            output
        )
    }

    shared {
        /// Builds a tiny CLR helper assembly that declares
        /// `Probe.Color { Red=0, Green=1, Blue=2 }` and
        /// `Probe.Helper.GetColors() : Color[]`, returning
        /// `new[] { Color.Red, Color.Green, Color.Blue }`.
        /// Used by the enum-array tests because G# can't construct a CLR
        /// SZ array of a value type directly — only via a CLR factory.
        private func BuildClrArrayHelperAssembly(dir string) string {
            let coreAssembly = typeof(object).Assembly
            let name = AssemblyName("Probe"){Version = Version(1, 0, 0, 0)}
            let builder = PersistedAssemblyBuilder(name, coreAssembly)
            let module = builder.DefineDynamicModule("Probe")
            // public enum Probe.Color : int { Red = 0, Green = 1, Blue = 2 }
            let color = module.DefineEnum("Probe.Color", TypeAttributes.Public, typeof(int32))
            color.DefineLiteral("Red", 0)
            color.DefineLiteral("Green", 1)
            color.DefineLiteral("Blue", 2)
            let colorType = color.CreateType()
            // public static class Probe.Helper { public static Color[] GetColors() => new[]{Red,Green,Blue}; }
            let helper = module.DefineType(
                "Probe.Helper",
                TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed | TypeAttributes.Class
            )
            let getColors = helper.DefineMethod(
                "GetColors",
                MethodAttributes.Public | MethodAttributes.Static,
                colorType.MakeArrayType(),
                Type.EmptyTypes
            )
            let il = getColors.GetILGenerator()
            // new Color[3] { Red, Green, Blue }
            il.Emit(OpCodes.Ldc_I4_3)
            il.Emit(OpCodes.Newarr, colorType)
            for var i = 0; i < 3; i++ {
                il.Emit(OpCodes.Dup)
                il.Emit(OpCodes.Ldc_I4, i)
                il.Emit(OpCodes.Ldc_I4, i)
                il.Emit(OpCodes.Stelem_I4)
            }
            il.Emit(OpCodes.Ret)
            helper.CreateType()
            let path = Path.Combine(dir, "Probe.dll")
            builder.Save(path)
            return path
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue520_").FullName
            try {
                return CompileAndRunImpl(source, tempDir, helperPath: nil, verifyIl: true)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func CompileAndRunWithHelper(source string, tempDir string, helperPath string, verifyIl bool) string {
            return CompileAndRunImpl(source, tempDir, helperPath, verifyIl)
        }

        private func CompileAndRunImpl(source string, tempDir string, helperPath string?, verifyIl bool) string {
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            if helperPath != nil {
                // Passing /r: switches gsc to closed-world mode (only the explicit
                // refs are loaded), so we also have to enumerate the full BCL
                // closure from the host's TPA. Matches the pattern in
                // XunitAssertOverloadResolutionTests.
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
            if verifyIl {
                let extraRefs[]?string = if helperPath != nil {
                    []string{helperPath}
                } else {
                    default([]?string)
                }
                IlVerifier.Verify(outPath, extraRefs)
            }
            // The helper DLL must sit beside the test exe so the runtime can
            // locate it at load time (we don't ship a deps.json with it).
            if helperPath != nil {
                let target = Path.Combine(tempDir, Path.GetFileName(helperPath))
                if !File.Exists(target) {
                    File.Copy(helperPath, target)
                }
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
