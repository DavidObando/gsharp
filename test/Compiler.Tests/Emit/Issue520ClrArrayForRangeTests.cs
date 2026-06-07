// <copyright file="Issue520ClrArrayForRangeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Regression tests for issue #520 (and the duplicate #536): <c>for x := range coll</c>
/// over a CLR SZ array (<c>T[]</c>) used to walk the array via
/// <see cref="System.Array.GetEnumerator"/>, which returns the non-generic
/// <see cref="System.Collections.IEnumerator"/> whose <c>Current</c> property
/// returns <see cref="object"/>. For value-typed element arrays
/// (<c>Color[]</c>, <c>char[]</c>, <c>int[]</c>) the loop body then stored
/// a boxed reference into a value-typed local — the low 32 bits of the
/// managed pointer surfaced as garbage values (pointer-like integers in the
/// ~900M range) and downstream casts crashed with
/// <see cref="System.AccessViolationException"/>.
///
/// The fix (see <c>Binder.BindForRangeStatement</c>) detects SZ-array
/// <see cref="System.Type.IsArray"/> on the CLR side and routes through the
/// Indexed strategy, which emits <c>ldelem &lt;T&gt;</c> via the array's
/// actual element type — the same lowering Roslyn emits for
/// <c>foreach (T x in arr)</c>.
/// </summary>
public class Issue520ClrArrayForRangeTests
{
    [Fact]
    public void ForRange_OverClrEnumArray_YieldsDeclaredMembersInOrder()
    {
        // The original repro: enumerating a `Region[]` returned by a CLR helper
        // used to surface heap addresses (pointer-like ints in the ~900M range)
        // instead of the enum members. With the indexed lowering it produces
        // ldelem <Region> against the underlying int32 storage, so each load
        // reconstitutes the value-type element exactly.
        var tempDir = Directory.CreateTempSubdirectory("gs_issue520_enum_").FullName;
        try
        {
            var helperPath = BuildClrArrayHelperAssembly(tempDir);

            var source = """
                package P
                import System
                import Probe

                var arr = Helper.GetColors()
                for c := range arr {
                  Console.WriteLine(int32(c))
                }
                """;

            var output = CompileAndRunWithHelper(source, tempDir, helperPath, verifyIl: true);
            Assert.Equal("0\n1\n2\n", output);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ForRange_OverClrEnumArray_EnumIsDefinedHoldsForEveryElement()
    {
        // Tighter check matching the user's `Enum.IsDefined[T](r)` assertion
        // from the issue — under the bug every element was a heap-pointer-cast
        // int, so IsDefined returned false on every iteration.
        var tempDir = Directory.CreateTempSubdirectory("gs_issue520_isdef_").FullName;
        try
        {
            var helperPath = BuildClrArrayHelperAssembly(tempDir);

            var source = """
                package P
                import System
                import Probe

                var arr = Helper.GetColors()
                for c := range arr {
                  if Enum.IsDefined(typeof(Color), c) {
                    Console.WriteLine("ok")
                  } else {
                    Console.WriteLine("bad")
                  }
                }
                """;

            var output = CompileAndRunWithHelper(source, tempDir, helperPath, verifyIl: false);
            Assert.Equal("ok\nok\nok\n", output);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ForRange_OverClrCharArray_YieldsExactChars()
    {
        // Doubles as the issue #536 repro: `for c in charArr` over `char[]`
        // produced garbled values for the same reason — `char` is a value type
        // and the loop variable was holding the boxed-object pointer's low
        // bits. The fix routes char[] through `ldelem.u2`.
        var source = """
            package P
            import System

            var ca = "abc".ToCharArray()
            for c := range ca {
              Console.WriteLine(int32(c))
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("97\n98\n99\n", output);
    }

    [Fact]
    public void ForRange_OverClrIntArray_YieldsExactInts()
    {
        // Value-type element regression guard via `int[]`. Pre-fix this
        // dereferenced a heap address as an int32 and printed garbage.
        var source = """
            package P
            import System
            import System.Linq

            var ia = Enumerable.ToArray[int32](Enumerable.Range(10, 3))
            for i := range ia {
              Console.WriteLine(i)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("10\n11\n12\n", output);
    }

    [Fact]
    public void ForRange_OverClrStringArray_YieldsExactStrings()
    {
        // Reference-type element regression guard — the indexed lowering still
        // has to emit `ldelem.ref` for `string[]`. This pins that we didn't
        // regress the reference-type path while fixing the value-type one.
        var source = """
            package P
            import System

            var sa = "x y z".Split(' ')
            for s := range sa {
              Console.WriteLine(s)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("x\ny\nz\n", output);
    }

    [Fact]
    public void ForRange_OverClrStringArray_FromEnumGetNames_YieldsExactStrings()
    {
        // Tighter regression of the original issue surface area — the user's
        // repro hung off `Enum.GetValues`. We can't bind to the generic
        // `Enum.GetValues<T>()` from G# today, but `Enum.GetNames(typeof(T))`
        // is the same shape (a CLR `string[]`) and exercises the same lowering.
        var source = """
            package P
            import System

            type Region enum { Us, Uk, De, Fr, Es, It, Pt, Pl, Cz, At, Nl }

            var names = Enum.GetNames(typeof(Region))
            for n := range names {
              Console.WriteLine(n)
            }
            """;

        var output = CompileAndRun(source);
        Assert.Equal("Us\nUk\nDe\nFr\nEs\nIt\nPt\nPl\nCz\nAt\nNl\n", output);
    }

    /// <summary>
    /// Builds a tiny CLR helper assembly that declares
    /// <c>Probe.Color { Red=0, Green=1, Blue=2 }</c> and
    /// <c>Probe.Helper.GetColors() : Color[]</c>, returning
    /// <c>new[] { Color.Red, Color.Green, Color.Blue }</c>.
    /// Used by the enum-array tests because G# can't construct a CLR
    /// SZ array of a value type directly — only via a CLR factory.
    /// </summary>
    private static string BuildClrArrayHelperAssembly(string dir)
    {
        var coreAssembly = typeof(object).Assembly;

        var name = new AssemblyName("Probe") { Version = new Version(1, 0, 0, 0) };
        var builder = new PersistedAssemblyBuilder(name, coreAssembly);
        var module = builder.DefineDynamicModule("Probe");

        // public enum Probe.Color : int { Red = 0, Green = 1, Blue = 2 }
        var color = module.DefineEnum("Probe.Color", TypeAttributes.Public, typeof(int));
        color.DefineLiteral("Red", 0);
        color.DefineLiteral("Green", 1);
        color.DefineLiteral("Blue", 2);
        var colorType = color.CreateType();

        // public static class Probe.Helper { public static Color[] GetColors() => new[]{Red,Green,Blue}; }
        var helper = module.DefineType(
            "Probe.Helper",
            TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed | TypeAttributes.Class);
        var getColors = helper.DefineMethod(
            "GetColors",
            MethodAttributes.Public | MethodAttributes.Static,
            colorType.MakeArrayType(),
            Type.EmptyTypes);
        var il = getColors.GetILGenerator();

        // new Color[3] { Red, Green, Blue }
        il.Emit(OpCodes.Ldc_I4_3);
        il.Emit(OpCodes.Newarr, colorType);
        for (var i = 0; i < 3; i++)
        {
            il.Emit(OpCodes.Dup);
            il.Emit(OpCodes.Ldc_I4, i);
            il.Emit(OpCodes.Ldc_I4, i);
            il.Emit(OpCodes.Stelem_I4);
        }

        il.Emit(OpCodes.Ret);
        helper.CreateType();

        var path = Path.Combine(dir, "Probe.dll");
        builder.Save(path);
        return path;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue520_").FullName;
        try
        {
            return CompileAndRunImpl(source, tempDir, helperPath: null, verifyIl: true);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string CompileAndRunWithHelper(string source, string tempDir, string helperPath, bool verifyIl)
    {
        return CompileAndRunImpl(source, tempDir, helperPath, verifyIl);
    }

    private static string CompileAndRunImpl(string source, string tempDir, string helperPath, bool verifyIl)
    {
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };

        if (helperPath != null)
        {
            // Passing /r: switches gsc to closed-world mode (only the explicit
            // refs are loaded), so we also have to enumerate the full BCL
            // closure from the host's TPA. Matches the pattern in
            // XunitAssertOverloadResolutionTests.
            args.Add("/reference:" + helperPath);
            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add("/nowarn:GS9100");
        }

        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

        if (verifyIl)
        {
            var extraRefs = helperPath != null ? new[] { helperPath } : null;
            IlVerifier.Verify(outPath, extraRefs);
        }

        // The helper DLL must sit beside the test exe so the runtime can
        // locate it at load time (we don't ship a deps.json with it).
        if (helperPath != null)
        {
            var target = Path.Combine(tempDir, Path.GetFileName(helperPath));
            if (!File.Exists(target))
            {
                File.Copy(helperPath, target);
            }
        }

        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = tempDir,
        };
        psi.ArgumentList.Add("exec");
        psi.ArgumentList.Add("--runtimeconfig");
        psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
        psi.ArgumentList.Add(outPath);

        using var proc = Process.Start(psi);
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(
            proc.ExitCode == 0,
            $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

        return stdout.Replace("\r\n", "\n");
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
