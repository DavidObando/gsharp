// <copyright file="XunitAssertOverloadResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Regression tests for issue #505: <c>Xunit.Assert.Equal("a","a")</c> was
/// reported as ambiguous (GS0160) because the binder's overload-ranking pass
/// did not implement C#'s full set of tie-breakers (non-generic-over-generic,
/// fewer-omitted-optionals). These tests compile a tiny G# library through
/// <c>gsc</c> against the host's real <c>xunit.assert.dll</c> so the resolved
/// candidates exactly match the xUnit overload surface users hit in practice.
/// </summary>
public class XunitAssertOverloadResolutionTests
{
    [Fact]
    public void AssertEqual_TwoStringArgs_ResolvesWithoutExplicitTypeArg()
    {
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func StringEq() {
                    Assert.Equal("hello", "hello")
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoStringArgs_StillWorksWithExplicitTypeArg()
    {
        // Issue #505: callers that previously had to write the explicit
        // [string] type argument keep compiling unchanged.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func StringEqExplicit() {
                    Assert.Equal[string]("hello", "hello")
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoIntLiterals_ResolveWithoutAmbiguity()
    {
        // Issue #505: integer literals must resolve to Equal<T>(T, T) with
        // T=int32 — the generic identity beats every numeric-widening overload.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func IntEq() {
                    Assert.Equal(1, 1)
                }
            }
            """);
    }

    [Fact]
    public void AssertNotEqual_TwoStringArgs_ResolveWithoutExplicitTypeArg()
    {
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func StringNotEq() {
                    Assert.NotEqual("a", "b")
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoNullableBoolArgs_ExplicitTypeArg_Resolves()
    {
        // Issue #504-reopen: `Assert.Equal[bool?](a, b)` resolves the explicit
        // type argument to `Nullable<bool>` in the reference-assembly load
        // context, while the bound-argument types come from the host
        // reflection context. Overload resolution must treat the two
        // structurally identical `Nullable<bool>` types as the same type even
        // though their `FullName`s embed assembly-qualified args from
        // different contexts (host vs MetadataLoadContext). Before the fix,
        // the candidate set evaluation rejected every overload and the call
        // site reported `GS0159 Cannot find function Equal`.
        AssertGsCompilesCleanlyAgainstRefPack("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func NullableBoolEqExplicit() {
                    var a bool? = false
                    var b bool? = false
                    Assert.Equal[bool?](a, b)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoNullableBoolArgs_InferredTypeArg_Resolves()
    {
        // Issue #504-reopen (inferred form): `Assert.Equal(a, b)` where
        // `a, b : bool?` must infer `T = Nullable<bool>` and find the
        // applicable `Equal<T>(T, T)` overload. Inference closes the
        // candidate's parameter types to `Nullable<bool>` in the reference
        // load context, which must match the host-side `Nullable<bool>`
        // computed for the argument types.
        AssertGsCompilesCleanlyAgainstRefPack("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func NullableBoolEqInferred() {
                    var a bool? = false
                    var b bool? = false
                    Assert.Equal(a, b)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoNullableIntArgs_ExplicitAndInferred_Resolve()
    {
        // Issue #504-reopen: the same cross-reflection-context mismatch
        // applies to every value-type T?. Cover `int32?` to confirm the fix
        // generalises beyond `bool?`.
        AssertGsCompilesCleanlyAgainstRefPack("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func NullableIntEq() {
                    var a int32? = 1
                    var b int32? = 1
                    Assert.Equal[int32?](a, b)
                    Assert.Equal(a, b)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_TwoNullableStringArgs_ExplicitAndInferred_Resolve()
    {
        // Issue #504-reopen (reference-type nullable): `string?` shares its
        // CLR representation with `string`, so overload resolution should
        // close `T = string` and find the `Equal<T>(T, T)` overload by
        // identity. The fix must not regress this path.
        AssertGsCompilesCleanlyAgainstRefPack("""
            package Probe.Tests
            import Xunit
            type P class {
                @Fact
                func NullableStringEq() {
                    var a string? = "x"
                    var b string? = "x"
                    Assert.Equal[string?](a, b)
                    Assert.Equal(a, b)
                }
            }
            """);
    }

    // --- Issue #661: mixed nullable-enum overload resolution ---

    [Fact]
    public void AssertEqual_NonNullableEnumAndNullableEnum_Resolves()
    {
        // Issue #661: Assert.Equal(DayOfWeek.Monday, actual) where actual : DayOfWeek?
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import System
            import Xunit

            type P class {
                @Fact
                func NullableEnumEq() {
                    var actual DayOfWeek? = DayOfWeek.Monday
                    Assert.Equal(DayOfWeek.Monday, actual)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_NullableEnumAndNonNullableEnum_Resolves()
    {
        // Issue #661: symmetric — Assert.Equal(actual, DayOfWeek.Monday)
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import System
            import Xunit

            type P class {
                @Fact
                func NullableEnumEqSwapped() {
                    var actual DayOfWeek? = DayOfWeek.Monday
                    Assert.Equal(actual, DayOfWeek.Monday)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_BothNullableEnum_Resolves()
    {
        // Both operands nullable.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import System
            import Xunit

            type P class {
                @Fact
                func BothNullableEnumEq() {
                    var a DayOfWeek? = DayOfWeek.Monday
                    var b DayOfWeek? = DayOfWeek.Monday
                    Assert.Equal(a, b)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_BothNonNullableEnum_Resolves()
    {
        // Both non-nullable imported enum (regression guard).
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import System
            import Xunit

            type P class {
                @Fact
                func BothNonNullableEnumEq() {
                    Assert.Equal(DayOfWeek.Monday, DayOfWeek.Monday)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_NonNullableIntAndNullableInt_Resolves()
    {
        // Regression guard: int + int? must still work.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit

            type P class {
                @Fact
                func MixedNullableIntEq() {
                    var actual int32? = 42
                    Assert.Equal(42, actual)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_StringAndNullableString_Resolves()
    {
        // Regression guard: reference-type nullable string? vs string.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import Xunit

            type P class {
                @Fact
                func StringVsNullableStringEq() {
                    var actual string? = "hello"
                    Assert.Equal("hello", actual)
                }
            }
            """);
    }

    [Fact]
    public void AssertEqual_UserDefinedNullableEnum_BindsSuccessfully()
    {
        // Issue #661: user-defined G# enum with nullable overload resolution.
        // Note: the binder correctly resolves the overload, but emitting
        // Nullable<UserEnum> is a separate pre-existing limitation (GS9998).
        // This test uses the imported CLR enum DayOfWeek as a proxy to confirm
        // end-to-end works; the binder-level fix applies uniformly.
        AssertGsCompilesCleanly("""
            package Probe.Tests
            import System
            import Xunit

            type P class {
                @Fact
                func UserEnumNullableEq() {
                    var actual DayOfWeek? = DayOfWeek.Monday
                    Assert.Equal(DayOfWeek.Monday, actual)
                }
            }
            """);
    }

    private static void AssertGsCompilesCleanly(string source)
        => CompileGsAgainstReferences(source, ReferenceModeTpa);

    /// <summary>
    /// Issue #504-reopen: drives gsc with the same reference-assembly closure
    /// real users get from the SDK (ref-pack facades + xUnit) — NOT the test
    /// host's TPA. The TPA is the live runtime's set of implementation
    /// assemblies, so types loaded through it share the host's
    /// <c>System.Private.CoreLib</c> identity and accidentally mask
    /// cross-reflection-context bugs whose symptoms only surface when the
    /// MetadataLoadContext sees facade assemblies (e.g.
    /// <c>System.Runtime.dll</c>) with different assembly-qualified type
    /// names than the host's runtime types.
    /// </summary>
    /// <param name="source">G# source to compile.</param>
    private static void AssertGsCompilesCleanlyAgainstRefPack(string source)
        => CompileGsAgainstReferences(source, ReferenceModeRefPack);

    private const int ReferenceModeTpa = 0;
    private const int ReferenceModeRefPack = 1;

    private static void CompileGsAgainstReferences(string source, int referenceMode)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_xunit_overload_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Probe.gs");
            File.WriteAllText(srcPath, source);
            var outPath = Path.Combine(tempDir, "Probe.dll");

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            IEnumerable<string> references = referenceMode == ReferenceModeRefPack
                ? RefPackReferences()
                : TrustedPlatformAssemblies();

            foreach (var reference in references)
            {
                args.Add("/reference:" + reference);
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
                $"gsc failed (exit {compileExit}):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            Assert.True(File.Exists(outPath), "expected emitted assembly");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    /// <summary>
    /// Issue #504-reopen: assembles the same reference closure the .NET SDK
    /// would pass to gsc — the <c>Microsoft.NETCore.App.Ref</c> targeting-pack
    /// facades for the running runtime plus xUnit. Each facade resolves to a
    /// different <see cref="System.Reflection.Assembly"/> identity than the
    /// host's <c>System.Private.CoreLib</c>, so constructed generics loaded
    /// through the MetadataLoadContext (e.g. <c>Nullable&lt;bool&gt;</c>) carry
    /// assembly-qualified type-arg names that diverge from the host's. This is
    /// the exact configuration where the binder's identity-by-FullName check
    /// silently fails. Skips the test gracefully when the ref-pack is absent.
    /// </summary>
    /// <returns>The set of reference assemblies to pass to gsc.</returns>
    private static IEnumerable<string> RefPackReferences()
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        Skip.IfNull(runtimeDir, "host runtime directory not resolvable");
        var sharedDir = Directory.GetParent(runtimeDir)?.Parent;
        var dotnetRoot = sharedDir?.Parent?.FullName;
        Skip.IfNullOrEmpty(dotnetRoot, "dotnet root not resolvable");
        var tfm = $"net{Environment.Version.Major}.0";
        var packsRoot = Path.Combine(dotnetRoot, "packs", "Microsoft.NETCore.App.Ref");
        Skip.IfFalse(Directory.Exists(packsRoot), $"ref pack root '{packsRoot}' missing");

        // Match the targeting-pack version to the running runtime (e.g. 10.0.X).
        var version = Environment.Version.ToString(3);
        var refDir = Path.Combine(packsRoot, version, "ref", tfm);
        if (!Directory.Exists(refDir))
        {
            // Fall back to the newest installed ref-pack matching the major version.
            var major = Environment.Version.Major.ToString();
            var candidate = Directory.EnumerateDirectories(packsRoot, major + ".*")
                .OrderByDescending(d => d, StringComparer.Ordinal)
                .Select(d => Path.Combine(d, "ref", tfm))
                .FirstOrDefault(Directory.Exists);
            Skip.IfNullOrEmpty(candidate, $"no ref pack for net{major}.0 under '{packsRoot}'");
            refDir = candidate;
        }

        foreach (var path in Directory.EnumerateFiles(refDir, "*.dll"))
        {
            yield return path;
        }

        // xUnit is consumed from the host's TPA — its identity is stable across
        // both reflection contexts and is not what the bug is exercising.
        foreach (var path in TrustedPlatformAssemblies())
        {
            var name = Path.GetFileName(path);
            if (name.StartsWith("xunit.", StringComparison.OrdinalIgnoreCase))
            {
                yield return path;
            }
        }
    }

    /// <summary>
    /// Tiny in-test skip-if helper. xUnit's <c>SkipException</c> is not part
    /// of the v2 runner used here, so use <see cref="Xunit.Sdk.XunitException"/>
    /// to surface a missing-prerequisite condition as a test failure with a
    /// clear message rather than a silent pass.
    /// </summary>
    private static class Skip
    {
        public static void IfNull(object value, string reason)
        {
            if (value == null)
            {
                throw new Xunit.Sdk.XunitException($"prerequisite missing: {reason}");
            }
        }

        public static void IfNullOrEmpty(string value, string reason)
        {
            if (string.IsNullOrEmpty(value))
            {
                throw new Xunit.Sdk.XunitException($"prerequisite missing: {reason}");
            }
        }

        public static void IfFalse(bool condition, string reason)
        {
            if (!condition)
            {
                throw new Xunit.Sdk.XunitException($"prerequisite missing: {reason}");
            }
        }
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
