// <copyright file="Issue2392TopLevelProgramPackageHolderEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2392: a multi-package compilation whose package-less (implicit
/// "Default") top-level-statement (TLS) file is NOT the first syntax tree
/// the binder sees emits the synthesized entry point (<c>&lt;Main&gt;$</c>),
/// hoisted top-level local functions, and non-capturing top-level lambdas
/// onto the WRONG package's <c>&lt;Program&gt;</c> holder.
///
/// Root cause: the emitter's "Phase A" TypeDef loop always adds the entry-
/// point/globals-host package's <c>&lt;Program&gt;</c> TypeDef FIRST (issue
/// #191 requires this so its FieldDef range stays monotone), but MethodDef
/// row planning walked <c>packages</c> in raw first-seen-syntax-tree order.
/// ECMA-335 requires TypeDef.MethodList to be non-decreasing down the
/// TypeDef table — the CLR (and ilverify/decompilers) derive each TypeDef's
/// owned method range from consecutive MethodList values — so whenever the
/// entry-point package was not already <c>packages[0]</c>, forcing its
/// TypeDef first while its rows were planned last (or in the middle)
/// produced a non-monotone MethodList sequence. Methods that are really
/// on the entry-point package's <c>&lt;Program&gt;</c> then silently
/// attribute to a sibling package's <c>&lt;Program&gt;</c>, which does not
/// have accessibility into the entry-point package's private/internal
/// members — surfacing as ilverify FieldAccess/MethodAccess failures
/// (discovered migrating the real Oahu.Diagnostics app after issue #2382
/// added native top-level-statement translation).
///
/// The fix (see ReflectionMetadataEmitter.EmitCore) reorders <c>packages</c>
/// once, before row planning, so every package-ordered loop (row planning,
/// method-body emission, and the TypeDef loop itself) shares one
/// entry-point-first order — keeping row planning and TypeDef order
/// consistent regardless of which order the driver handed syntax trees to
/// the binder.
/// </summary>
public class Issue2392TopLevelProgramPackageHolderEmitTests
{
    [Fact]
    public void TwoPackages_EntryPointPackageSecond_HostsEntryPointHoistedFuncAndLambdaOnItsOwnProgram()
    {
        // The package-less (Default) file is passed SECOND, after PackageA —
        // reproducing the exact ordering that triggers issue #2392: the
        // binder's first-seen-syntax-tree order (not argument/package
        // identity) decides `packages[0]`, and Default is not it here.
        var packageA = """
            package PackageA
            import System

            func Compute() int32 {
                return 41
            }
            """;

        // Program.gs: package-less TLS with (1) a top-level global `let`
        // (forces the "globals-host <Program> emitted first" special case),
        // (2) a hoisted-shape top-level local function, and (3) a
        // non-capturing top-level lambda that calls the top-level func and
        // reads the top-level global as a static field (not a real capture)
        // — the exact three synthesized-member kinds issue #2392 reported
        // as misplaced.
        var program = """
            import System

            func Greet(name string) {
                Console.WriteLine("hello ${name}")
            }

            let suffix = "world"

            let handler = (n int32) -> {
                Greet(suffix)
                return n + 1
            }

            Console.WriteLine(handler(41))
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_2392_").FullName;
        try
        {
            var pathA = Path.Combine(tempDir, "PackageA.gs");
            var pathProgram = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(pathA, packageA);
            File.WriteAllText(pathProgram, program);

            var outPath = Path.Combine(tempDir, "test.dll");
            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                pathA,
                pathProgram,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            Assert.True(File.Exists(outPath));

            // Metadata-level assertion: <Main>$, Greet (the hoisted-shape
            // top-level func) and the non-capturing lambda must be owned by
            // Default's <Program> TypeDef (via the CLR's own MethodList
            // range resolution — System.Reflection.Metadata's
            // TypeDefinition.GetMethods() implements that same range logic,
            // so this assertion fails exactly when a real CLR consumer would
            // misattribute ownership); PackageA's <Program> must own none of
            // them.
            using (var pe = new PEReader(File.OpenRead(outPath)))
            {
                var reader = pe.GetMetadataReader();
                var programsByNamespace = reader.TypeDefinitions
                    .Select(reader.GetTypeDefinition)
                    .Where(td => reader.GetString(td.Name) == "<Program>")
                    .ToDictionary(td => reader.GetString(td.Namespace), td => td);

                Assert.True(programsByNamespace.ContainsKey("Default"), "expected a Default <Program>");
                Assert.True(programsByNamespace.ContainsKey("PackageA"), "expected a PackageA <Program>");

                var defaultMethods = programsByNamespace["Default"].GetMethods()
                    .Select(h => reader.GetString(reader.GetMethodDefinition(h).Name))
                    .ToArray();
                var packageAMethods = programsByNamespace["PackageA"].GetMethods()
                    .Select(h => reader.GetString(reader.GetMethodDefinition(h).Name))
                    .ToArray();

                Assert.Contains("<Main>$", defaultMethods);
                Assert.Contains("Greet", defaultMethods);

                Assert.DoesNotContain("<Main>$", packageAMethods);
                Assert.DoesNotContain("Greet", packageAMethods);

                // PackageA's own top-level func must still land correctly on
                // its own <Program> (the fix must not push everything onto
                // Default).
                Assert.Contains("Compute", packageAMethods);
                Assert.DoesNotContain("Compute", defaultMethods);
            }

            IlVerifier.Verify(outPath);

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
            Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
            Assert.Equal("hello world\n42\n", stdout.Replace("\r\n", "\n"));
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    [Fact]
    public void ThreePackages_EntryPointPackageMiddle_HostsEntryPointOnItsOwnProgram()
    {
        // Mirrors the real Oahu.Diagnostics shape more closely: three
        // packages, with the package-less (Default) TLS file bound
        // somewhere in the MIDDLE of syntax-tree order (not first, not
        // last) — proving the fix is not merely "last package" or "first
        // package" special-cased, but genuinely reorders by identity.
        var packageA = """
            package PackageA
            import System

            func ComputeA() int32 {
                return 1
            }
            """;

        var program = """
            import System

            func Hoisted() int32 {
                return 2
            }

            Console.WriteLine(Hoisted())
            """;

        var packageB = """
            package PackageB
            import System

            func ComputeB() int32 {
                return 3
            }
            """;

        var tempDir = Directory.CreateTempSubdirectory("gs_2392b_").FullName;
        try
        {
            var pathA = Path.Combine(tempDir, "PackageA.gs");
            var pathProgram = Path.Combine(tempDir, "Program.gs");
            var pathB = Path.Combine(tempDir, "PackageB.gs");
            File.WriteAllText(pathA, packageA);
            File.WriteAllText(pathProgram, program);
            File.WriteAllText(pathB, packageB);

            var outPath = Path.Combine(tempDir, "test.dll");
            var args = new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                pathA,
                pathProgram,
                pathB,
            };

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            using (var pe = new PEReader(File.OpenRead(outPath)))
            {
                var reader = pe.GetMetadataReader();
                var programsByNamespace = reader.TypeDefinitions
                    .Select(reader.GetTypeDefinition)
                    .Where(td => reader.GetString(td.Name) == "<Program>")
                    .ToDictionary(td => reader.GetString(td.Namespace), td => td);

                Assert.Equal(3, programsByNamespace.Count);

                var defaultMethods = programsByNamespace["Default"].GetMethods()
                    .Select(h => reader.GetString(reader.GetMethodDefinition(h).Name))
                    .ToArray();

                Assert.Contains("<Main>$", defaultMethods);
                Assert.Contains("Hoisted", defaultMethods);

                foreach (var ns in new[] { "PackageA", "PackageB" })
                {
                    var methods = programsByNamespace[ns].GetMethods()
                        .Select(h => reader.GetString(reader.GetMethodDefinition(h).Name))
                        .ToArray();
                    Assert.DoesNotContain("<Main>$", methods);
                    Assert.DoesNotContain("Hoisted", methods);
                }
            }

            IlVerifier.Verify(outPath);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
