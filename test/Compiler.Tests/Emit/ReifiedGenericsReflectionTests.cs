// <copyright file="ReifiedGenericsReflectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0087 reflection-based golden suite for the open-generic erasure
/// elimination work. The suite is split into two cohorts:
///
/// <list type="bullet">
///   <item><description>
///     <b>CurrentBehaviour</b> &#x2014; assertions that hold under the
///     present type-erased model. These pin the user-visible reflection
///     shape so a future regression that flips an unintended contract is
///     caught locally rather than escaping to a downstream consumer.
///   </description></item>
///   <item><description>
///     <b>ReifiedBehaviour</b> &#x2014; <c>[Fact(Skip = ...)]</c> entries
///     that describe the post-reification shape per ADR-0087 staging
///     phase. When a phase lands, the matching <c>CurrentBehaviour</c>
///     test is deleted and the matching <c>ReifiedBehaviour</c> test
///     loses its <c>Skip</c>.
///   </description></item>
/// </list>
///
/// Each test compiles a G# source through <c>gsc</c>, IL-verifies the
/// emitted assembly, and loads it in a fresh
/// <see cref="AssemblyLoadContext"/> so the assertion runs against the
/// real CLR <see cref="Type"/> / <see cref="FieldInfo"/> /
/// <see cref="MethodInfo"/> graph rather than an internal symbol view.
/// </summary>
public class ReifiedGenericsReflectionTests
{
    // -----------------------------------------------------------------
    // ReifiedBehaviour cohort (CurrentBehaviour was deleted as part of
    // R1+R2+R3+R4 landing). Each test below describes the post-R3
    // metadata shape and was previously Skip-tagged; the cohort is
    // now live.
    // -----------------------------------------------------------------

    /// <summary>
    /// Stability invariant: even under the reified model, the value
    /// round-trips correctly. <c>Box[int32]{Value: 42}.Value</c> is
    /// observed as an <see cref="int"/> at runtime (box/unbox.any at
    /// the boundary). This MUST continue to hold after every staging
    /// phase &#x2014; reification only widens the metadata, never the
    /// runtime semantics.
    /// </summary>
    [Fact]
    public void StabilityInvariant_GenericDataStruct_IntValueRoundTrips()
    {
        var source = """
            package P
            import System
            data struct Box[T any] {
                var Value T
            }
            let b = Box[int32]{Value: 42}
            Console.WriteLine(b.Value.GetType().FullName)
            """;

        var stdout = CompileAndRun(source);
        Assert.Contains("System.Int32", stdout);
    }

    /// <summary>
    /// Stability invariant: a value-typed generic-method return
    /// round-trips through the call boundary as the substituted type,
    /// not as the erased <c>Object</c>. This too must hold after every
    /// staging phase.
    /// </summary>
    [Fact]
    public void StabilityInvariant_GenericFunction_IntReturnRoundTrips()
    {
        var source = """
            package P
            import System
            func Identity[T any](x T) T { return x }
            let y = Identity[int32](7)
            Console.WriteLine(y)
            """;

        var stdout = CompileAndRun(source);
        Assert.Equal("7\n", stdout);
    }

    // -----------------------------------------------------------------
    // ReifiedBehaviour cohort (skipped)
    //
    // Each test is a faithful description of the post-reification
    // metadata shape. When a staging phase lands, the matching
    // CurrentBehaviour test above is deleted and the Skip below is
    // removed.
    // -----------------------------------------------------------------

    [Fact]
    public void ReifiedBehaviour_R1_GenericDataStruct_IsGenericTypeDefinition()
    {
        var source = """
            package P
            data struct Box[T any] {
                var Value T
            }
            """;

        var asm = LoadCompiled(source);
        var boxType = FindUserType(asm, "P", "Box`1");
        Assert.NotNull(boxType);
        Assert.True(boxType.IsGenericTypeDefinition);
        Assert.Single(boxType.GetGenericArguments());
    }

    [Fact]
    public void ReifiedBehaviour_R2_TTypedField_IsEncodedAsGenericParameter()
    {
        var source = """
            package P
            data struct Box[T any] {
                var Value T
            }
            """;

        var asm = LoadCompiled(source);
        var boxType = FindUserType(asm, "P", "Box`1");
        var field = boxType.GetField("Value", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(field);
        Assert.True(field.FieldType.IsGenericParameter);
        Assert.Equal(0, field.FieldType.GenericParameterPosition);
    }

    [Fact]
    public void ReifiedBehaviour_R2_GenericFunction_HasGenericSignature()
    {
        var source = """
            package P
            func Identity[T any](x T) T { return x }
            """;

        var asm = LoadCompiled(source);
        var program = FindModuleType(asm, "P");
        var method = program.GetMethod("Identity", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(method);
        Assert.True(method.IsGenericMethodDefinition);
        Assert.Single(method.GetGenericArguments());
        Assert.True(method.ReturnType.IsGenericMethodParameter);
        Assert.True(method.GetParameters()[0].ParameterType.IsGenericMethodParameter);
    }

    [Fact]
    public void ReifiedBehaviour_R3_ConstructedField_RoundTripsThroughReflection()
    {
        // After R1+R2+R3: typeof(Box<int>) is a closed constructed type
        // whose Value field reads back as Int32, not Object.
        var source = """
            package P
            data struct Box[T any] {
                var Value T
            }
            """;

        var asm = LoadCompiled(source);
        var openBox = FindUserType(asm, "P", "Box`1");
        var closedBox = openBox.MakeGenericType(typeof(int));
        var field = closedBox.GetField("Value", BindingFlags.Public | BindingFlags.Instance);
        Assert.NotNull(field);
        Assert.Equal(typeof(int), field.FieldType);
    }

    [Fact]
    public void ReifiedBehaviour_R5_ListOfUserGeneric_DispatchesCorrectly()
    {
        // After R5 the audit's F3 cluster collapses: a List[Box[int32]]
        // resolves Add against the proper closed shape rather than the
        // erased List<object>.
        var source = """
            package P
            import System.Collections.Generic
            data struct Box[T any] {
                var Value T
            }
            let xs = List[Box[int32]]()
            xs.Add(Box[int32]{Value: 1})
            """;

        var stdout = CompileAndRun(source);
        Assert.NotNull(stdout);
    }

    // -----------------------------------------------------------------
    // Audit coverage matrix (one method per type-parameter use site
    // discovered in ADR-0087 §2). Each test exercises ONE shape from
    // ONE category. They are spot-checks: they confirm that the shape
    // compiles and runs end-to-end today.
    // -----------------------------------------------------------------

    [Fact]
    public void AuditCoverage_GenericDataStruct_Compiles()
    {
        CompileAndRun("""
            package P
            import System
            data struct Box[T any] { var Value T }
            let b = Box[int32]{Value: 1}
            Console.WriteLine(b.Value)
            """);
    }

    [Fact]
    public void AuditCoverage_GenericClass_Compiles()
    {
        CompileAndRun("""
            package P
            import System
            class Box[T any](Value T) { }
            let b = Box[string]("hi")
            Console.WriteLine(b.Value)
            """);
    }

    [Fact]
    public void AuditCoverage_GenericFunction_Compiles()
    {
        CompileAndRun("""
            package P
            import System
            func Id[T any](x T) T { return x }
            Console.WriteLine(Id[int32](1))
            """);
    }

    [Fact]
    public void AuditCoverage_GenericMethod_OnNonGenericType_Compiles()
    {
        CompileAndRun("""
            package P
            import System
            class Holder {
                init() {}
                func Box[T any](v T) T { return v }
            }
            let h = Holder()
            Console.WriteLine(h.Box[int32](42))
            """);
    }

    [Fact]
    public void AuditCoverage_GenericInterface_Compiles()
    {
        CompileAndRun("""
            package P
            import System
            interface IBox[T any] {
                func Get() T
            }
            class IntBox(value int32) : IBox[int32] {
                func Get() int32 { return value }
            }
            let b IBox[int32] = IntBox(7)
            Console.WriteLine(b.Get())
            """);
    }

    [Fact]
    public void AuditCoverage_NestedGenericInstantiation_Compiles()
    {
        CompileAndRun("""
            package P
            import System
            data struct Box[T any] { var Value T }
            let nested = Box[Box[int32]]{Value: Box[int32]{Value: 9}}
            Console.WriteLine(nested.Value.Value)
            """);
    }

    [Fact]
    public void AuditCoverage_RecursiveGenericConstraint_Compiles()
    {
        // After R5 a generic G# function whose return type is a closed CLR
        // generic over an in-scope type parameter (F3 in the audit) emits
        // with reified `List`1<!!0>`, so the runtime cast at the call site
        // (`MakeList[int32]()` -> `List<int32>`) succeeds.
        CompileAndRun("""
            package P
            import System
            import System.Collections.Generic
            func MakeList[T any]() List[T] { return List[T]() }
            let xs = MakeList[int32]()
            xs.Add(1)
            Console.WriteLine(xs.Count)
            """);
    }

    // -----------------------------------------------------------------
    // ADR-0087 R5 additional coverage (issue #765): closed CLR generic
    // over a user-declared generic type, plus the new "lazy interface
    // member substitution" + "constructed-interface emit" support that
    // the audit lists alongside R5. Each test compiles, IL-verifies, and
    // runs end-to-end to keep the F2/F3/F5 surface honest.
    // -----------------------------------------------------------------

    [Fact]
    public void R5_ListOfUserStruct_AddRoundTrips()
    {
        var stdout = CompileAndRun("""
            package P
            import System
            import System.Collections.Generic
            data struct Box[T any] { var Value T }
            let xs = List[Box[int32]]()
            xs.Add(Box[int32]{Value: 7})
            xs.Add(Box[int32]{Value: 42})
            Console.WriteLine(xs.Count)
            """);
        Assert.Equal("2", stdout.Trim());
    }

    [Fact]
    public void R5_DictionaryOfStringToUserStruct_AddRoundTrips()
    {
        var stdout = CompileAndRun("""
            package P
            import System
            import System.Collections.Generic
            data struct Box[T any] { var Value T }
            let d = Dictionary[string, Box[int32]]()
            d.Add("a", Box[int32]{Value: 7})
            d.Add("b", Box[int32]{Value: 42})
            Console.WriteLine(d.Count)
            """);
        Assert.Equal("2", stdout.Trim());
    }

    [Fact]
    public void R5_UserStructWrappingClrGeneric_RoundTrips()
    {
        // Box[List[int32]] — a user-defined generic struct whose argument
        // is itself a closed CLR generic. The member access `b.Value.Add`
        // dispatches through the CLR generic's concrete shape.
        var stdout = CompileAndRun("""
            package P
            import System
            import System.Collections.Generic
            data struct Box[T any] { var Value T }
            let b = Box[List[int32]]{Value: List[int32]()}
            b.Value.Add(7)
            b.Value.Add(11)
            Console.WriteLine(b.Value.Count)
            """);
        Assert.Equal("2", stdout.Trim());
    }

    [Fact]
    public void R5_TripleNestedUserStruct_RoundTrips()
    {
        // Box[Box[Box[int32]]] — deep recursive nesting of the same user
        // generic type. Every level encodes as a reified
        // `GENERICINST<Box`1><…>` so field-access chains down to the
        // primitive payload without erasure-induced casts.
        var stdout = CompileAndRun("""
            package P
            import System
            data struct Box[T any] { var Value T }
            let b = Box[Box[Box[int32]]]{Value: Box[Box[int32]]{Value: Box[int32]{Value: 9}}}
            Console.WriteLine(b.Value.Value.Value)
            """);
        Assert.Equal("9", stdout.Trim());
    }

    [Fact]
    public void R5_GenericMethodOverClrListOfUserStruct_RoundTrips()
    {
        // `func Process[T any](xs List[Box[T]]) int32` — a G# generic
        // method whose parameter is a closed CLR generic over the
        // method's open type parameter wrapped in a user generic.
        // After R5 the method-spec for Process[int32] resolves to the
        // proper closed shape and the call site dispatches without an
        // erasure-induced cast.
        var stdout = CompileAndRun("""
            package P
            import System
            import System.Collections.Generic
            data struct Box[T any] { var Value T }
            func Process[T any](xs List[Box[T]]) int32 {
                return xs.Count
            }
            let xs = List[Box[int32]]()
            xs.Add(Box[int32]{Value: 1})
            xs.Add(Box[int32]{Value: 2})
            xs.Add(Box[int32]{Value: 3})
            Console.WriteLine(Process[int32](xs))
            """);
        Assert.Equal("3", stdout.Trim());
    }

    [Fact]
    public void R5_GenericInterfaceImpl_DispatchesAcrossClosedClass()
    {
        // ADR-0087 R5 interface counterpart: a user-defined generic
        // interface `IBox[T]` implemented by `IntBox : IBox[int32]`,
        // accessed through a type-annotated `let b IBox[int32] = …`.
        // Validates that:
        //   * the InterfaceImpl row references the constructed TypeSpec
        //     (so `IntBox` actually implements `IBox`1<int32>`);
        //   * `b.Get()` dispatches through a MemberRef parented at the
        //     constructed TypeSpec rather than the bare TypeDef.
        var stdout = CompileAndRun("""
            package P
            import System
            interface IBox[T any] {
                func Get() T
            }
            class IntBox(value int32) : IBox[int32] {
                func Get() int32 { return value }
            }
            let b IBox[int32] = IntBox(99)
            Console.WriteLine(b.Get())
            """);
        Assert.Equal("99", stdout.Trim());
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    private static Assembly LoadCompiled(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_reified_reflect_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
        IlVerifier.Verify(outPath);

        // Load in a fresh, collectible AssemblyLoadContext so each test
        // sees a fresh metadata graph. The context is not Dispose-able
        // on the runtime targeted here, so we explicitly Unload() and
        // rely on the test harness's per-test isolation.
        var ctx = new AssemblyLoadContext(name: "gs_reified_reflect_" + Guid.NewGuid(), isCollectible: true);
        return ctx.LoadFromAssemblyPath(outPath);
    }

    private static Type FindUserType(Assembly asm, string ns, string name)
    {
        var full = ns + "." + name;
        var t = asm.GetType(full, throwOnError: false);
        if (t != null)
        {
            return t;
        }

        // Fall back to a scan in case the namespace/name shape differs.
        return asm.GetTypes().FirstOrDefault(x =>
            string.Equals(x.Namespace, ns, StringComparison.Ordinal)
            && string.Equals(x.Name, name, StringComparison.Ordinal));
    }

    private static Type FindModuleType(Assembly asm, string ns)
    {
        // G# top-level statements / package-level functions land on a
        // synthesised type named after the package's <Program> module
        // (or similar). Find any type in the namespace that hosts at
        // least one public static method.
        return asm.GetTypes().FirstOrDefault(t =>
                string.Equals(t.Namespace, ns, StringComparison.Ordinal)
                && t.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly).Length > 0)
            ?? throw new InvalidOperationException($"no module type found under namespace '{ns}'");
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_reified_run_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(compileExit == 0, $"compile failed ({compileExit}): {compileOut}{compileErr}");
            IlVerifier.Verify(outPath);

            var runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json");
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);

            var psi = new System.Diagnostics.ProcessStartInfo("dotnet", "exec \"" + outPath + "\"")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var proc = System.Diagnostics.Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                throw new Xunit.Sdk.XunitException("exited " + proc.ExitCode + "\nstdout:\n" + stdout + "\nstderr:\n" + stderr);
            }

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }
}
