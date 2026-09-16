// <copyright file="Issue1886GenericLocalFunctionEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #1886: a generic local function (`T First&lt;T&gt;(a, b) { ... }` in C#)
/// could not be represented in G# because function literals had no way to
/// declare type parameters — `let First = func (a T, b T) T { ... }` fails
/// with GS0113 (`T` doesn't exist). These tests exercise the new
/// `let Name[T, ...] = func (...) ... { ... }` generic function-literal
/// syntax end to end: parse, bind, emit, and run, for both single and
/// multi type-parameter shapes, plus capture behavior for a generic local
/// function that reads and mutates an outer variable.
/// </summary>
public class Issue1886GenericLocalFunctionEmitTests
{
    [Fact]
    public void GenericLocalFunction_SingleTypeParameter_CalledWithDifferentTypeArguments()
    {
        var source = """
            package P

            let First[T] = func (a T, b T) T {
                return a
            }
            Console.WriteLine(First(1, 2))
            Console.WriteLine(First("x", "y"))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"1{Environment.NewLine}x{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_MultipleTypeParameters_InferredFromArguments()
    {
        var source = """
            package P

            let Combine[T, U] = func (a T, b U) string {
                return a.ToString() + b.ToString()
            }
            Console.WriteLine(Combine(1, "y"))
            Console.WriteLine(Combine(3, 4))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"1y{Environment.NewLine}34{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_NestedInsideAnOrdinaryFunction_Works()
    {
        var source = """
            package P

            func Foo() int32 {
                let Identity[T] = func (a T) T {
                    return a
                }
                return Identity(42)
            }
            Console.WriteLine(Foo())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"42{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_NestedInsideAClassSharedMethod_Works()
    {
        // Regression: ClosureEmitter.SynthesizeClosures reroutes every
        // non-capturing lambda lexically declared inside a non-generic user
        // type into a nested (fieldless) display class (issue #1469), but the
        // direct-call emission path for a real FunctionSymbol (which is how a
        // generic local function resolves) never consults that rerouting map
        // — only the delegate-value indirect-call path does. That mismatch
        // threw "Call to function 'First' has no emitted MethodDef." at
        // compile time when a generic local function lived inside a class's
        // `shared` method (surfaced by the cs2gs grid corpus fixtures).
        var source = """
            package P

            class Fixture {
                shared {
                    func Run() {
                        let First[T] = func (a T, b T) T {
                            return a
                        }
                        Console.WriteLine(First(1, 2))
                        Console.WriteLine(First("x", "y"))
                    }
                }
            }
            Fixture.Run()
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"1{Environment.NewLine}x{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_CapturingOuterVariable_SharesStateAcrossInstantiations()
    {
        var source = """
            package P

            func Foo() int32 {
                var count = 0
                let Add[T] = func (value T) T {
                    count = count + 1
                    return value
                }
                Add(1)
                Add("a")
                return count
            }
            Console.WriteLine(Foo())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"2{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_CapturingParameter_SeesCallerArgument()
    {
        // Definition-of-done: a captured *parameter* of the enclosing
        // function, not just a `var`-declared local. G# parameters are
        // read-only bindings (GS0127 on reassignment), so this reads the
        // captured parameter from each differently-typed call and
        // accumulates into a separate outer `var`.
        var source = """
            package P

            func Foo(seed int32) int32 {
                var total = 0
                let Bump[T] = func (v T) T {
                    total = total + seed
                    return v
                }
                Bump(1)
                Bump("a")
                return total
            }
            Console.WriteLine(Foo(10))
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"20{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_CapturingThis_MutatesInstanceField()
    {
        // Definition-of-done: captured `this` composes with a generic local
        // function's own environment — both the field read and the field
        // write must reach the same instance across differently-typed calls.
        var source = """
            package P

            class Counter {
                var count int32
                func Bump() int32 {
                    let Add[T] = func (value T) T {
                        this.count = this.count + 1
                        return value
                    }
                    Add(1)
                    Add("a")
                    return this.count
                }
            }
            var c = Counter{}
            Console.WriteLine(c.Bump())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"2{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_CapturingMutableReferenceType_SharesIdentity()
    {
        // Definition-of-done: a captured mutable reference-type value (not
        // just a value-type `var`) shares identity across instantiations —
        // both the generic local and the enclosing function observe the
        // same object's mutated field.
        var source = """
            package P

            class Box {
                var value int32
            }
            func Foo() int32 {
                var b = Box{}
                b.value = 10
                let Bump[T] = func (v T) T {
                    b.value = b.value + 1
                    return v
                }
                Bump(1)
                Bump("x")
                return b.value
            }
            Console.WriteLine(Foo())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"12{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_NestedLocalFunctionCapture_ReachesOuterVariable()
    {
        // Definition-of-done: a plain local function declared INSIDE a
        // generic local function's body still reaches the outer variable
        // captured by the enclosing generic local.
        var source = """
            package P

            func Foo() int32 {
                var count = 0
                let Outer[T] = func (v T) T {
                    let Inner = func (x int32) int32 {
                        count = count + x
                        return x
                    }
                    Inner(1)
                    return v
                }
                Outer(1)
                Outer("a")
                return count
            }
            Console.WriteLine(Foo())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"2{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_CallsEarlierSiblingThatCaptures_PropagatesTransitively()
    {
        // Issue #4221 follow-up: `first[T]` never reads `outer` itself — it
        // only calls `second`, a sibling generic local function declared
        // EARLIER that captures `outer` directly. Before the fix, building
        // `second`'s closure instance at the `second(x)` call site inside
        // `first`'s body crashed with GS9998 ("Variable 'outer' has no local
        // slot"), because `first`'s own environment had no field for `outer`
        // — nothing had ever propagated that transitive need into `first`'s
        // own captured-variable set.
        var source = """
            package P

            func Foo() int32 {
                var outer = 0
                let Second[U] = func (x U) int32 {
                    outer = outer + 1
                    return outer
                }
                let First[T] = func (x T) int32 {
                    return Second(0)
                }
                First(9)
                First("z")
                return outer
            }
            Console.WriteLine(Foo())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"2{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_CallsLaterSiblingThatCaptures_PropagatesTransitively()
    {
        // Same as above, but `Second` (the capturing callee) is declared
        // AFTER `First` (the caller) — a forward reference. Consecutive
        // generic local-function declarations register every sibling's
        // signature before any body binds (#4219), so the call itself
        // resolves either way; only capture-set propagation was
        // order-sensitive before this fix.
        var source = """
            package P

            func Foo() int32 {
                var outer = 0
                let First[T] = func (x T) int32 {
                    return Second(0)
                }
                let Second[U] = func (x U) int32 {
                    outer = outer + 1
                    return outer
                }
                First(9)
                First("z")
                return outer
            }
            Console.WriteLine(Foo())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"2{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_MutuallyRecursiveCapturingSiblings_ShareState()
    {
        // A call CYCLE between two capturing generic local functions. The
        // fixed-point reconciliation must converge (and terminate) even when
        // the two members call each other, not just when the call graph is
        // acyclic.
        var source = """
            package P

            func Foo() int32 {
                var n = 0
                let First[T] = func (x T) int32 {
                    n = n + 1
                    if n < 3 {
                        return Second(x)
                    }
                    return n
                }
                let Second[U] = func (x U) int32 {
                    n = n + 1
                    if n < 3 {
                        return First(x)
                    }
                    return n
                }
                return First(1)
            }
            Console.WriteLine(Foo())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"3{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_InsideGenericClassMethod_ComposesWithEnclosingTypeParameter()
    {
        // Definition-of-done: a generic local function that captures ordinary
        // outer state still works when it is lexically nested inside a
        // method of a generic class (an enclosing type parameter in scope),
        // as long as the local function's own body never references that
        // enclosing type parameter (the separate enclosing-type-parameter
        // workstream, #4223, covers actually referencing it).
        var source = """
            package P

            class Box[T] {
                var seed T
                func Run() int32 {
                    var n = 0
                    let Add[U] = func (v U) U {
                        n = n + 1
                        return v
                    }
                    Add(1)
                    Add("x")
                    return n
                }
            }
            var b = Box[int32]{seed: 0}
            Console.WriteLine(b.Run())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"2{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_NestedLocalFunctionCallsForwardSiblingThatCaptures_PropagatesTransitively()
    {
        // Issue #4221 follow-up (gap found reviewing PR #4261): a plain,
        // non-generic local function declared INSIDE a generic local
        // function's own body — `Inner`, nested inside `First` — calls a
        // sibling of `First` (`Second`, declared LATER, a forward reference)
        // that captures `outer`. `Inner` never reads `outer` itself.
        //
        // `ReconcileGenericLocalFunctionGroupCaptures` originally only
        // re-walked the group's own top-level members (`First`, `Second`),
        // not a literal nested inside one of their bodies. `Inner`'s own
        // captured-variable set is fixed the moment it is bound — before
        // `Second`'s capture of `outer` exists in the shared map, since
        // `Second` is declared afterward — and folding a nested literal's
        // captures into its enclosing member only ever consults that
        // already-cached set (it does not re-descend into `Inner`'s body).
        // So `First`'s own re-walk during reconciliation kept missing the
        // transitive need for `outer`, and building `Second`'s closure
        // instance at the `Second(x)` call site inside `Inner`'s body
        // crashed emission with GS9998 ("Variable 'outer' has no local
        // slot"), exactly like the sibling-call case #4261 fixed, just one
        // level of nesting deeper.
        var source = """
            package P

            func Foo() int32 {
                var outer = 0
                let First[T] = func (v T) int32 {
                    let Inner = func (x int32) int32 {
                        return Second(x)
                    }
                    return Inner(1)
                }
                let Second[U] = func (v U) int32 {
                    outer = outer + 1
                    return outer
                }
                First(1)
                First("z")
                return outer
            }
            Console.WriteLine(Foo())
            """;

        var output = CompileAndRun(source);
        Assert.Equal($"2{Environment.NewLine}", output);
    }

    [Fact]
    public void GenericLocalFunction_CapturingByRefLikeVariable_ReportsGS0219()
    {
        // A `ref struct` (Span[T]) capture is still rejected for a generic
        // local function, same as for an ordinary closure — hoisting it into
        // the closure's display class would violate the ref-struct's
        // stack-only lifetime.
        var source = """
            package P

            func Foo(s Span[int32]) {
                let Bad[T] = func (a T) T {
                    var y = s
                    return a
                }
                Bad(1)
            }
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0219", stdout + stderr);
    }

    [Fact]
    public void GenericLocalFunction_CapturingManagedPointer_ReportsGS9004()
    {
        // A managed pointer (*T / &x) capture is rejected — the closure may
        // outlive the pointed-to stack variable.
        var source = """
            package P

            func Foo() {
                var x = 10
                var p = &x
                let Bad[T] = func (a T) T {
                    var y = *p
                    return a
                }
                Bad(1)
            }
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS9004", stdout + stderr);
    }

    [Fact]
    public void GenericLocalFunction_CapturingFixedPointer_ReportsGS9008()
    {
        // An unmanaged pointer bound by `fixed` is rejected — the pin is
        // released when the enclosing `fixed` block exits.
        var source = """
            package P

            unsafe func Foo() {
                var buf = []uint8{uint8(1), uint8(2), uint8(3)}
                fixed pD *uint8 = buf {
                    let Bad[T] = func (a T) T {
                        var y = pD[0]
                        return a
                    }
                    Bad(1)
                }
            }
            """;

        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: false);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS9008", stdout + stderr);
    }

    private static string CompileAndRun(string source)
    {
        var (exitCode, stdout, stderr) = CompileAndRunRaw(source, expectSuccess: true);
        Assert.True(
            exitCode == 0,
            $"exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static (int ExitCode, string Stdout, string Stderr) CompileAndRunRaw(
        string source,
        bool expectSuccess)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_1886_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var bcl in BclReferences.Value)
            {
                args.Add("/r:" + bcl);
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

            if (!expectSuccess)
            {
                return (compileExit, compileOut.ToString(), compileErr.ToString());
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath);
            if (source.Contains("let Add[T]", StringComparison.Ordinal))
            {
                AssertGenericLocalClosureShape(outPath);
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

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            return (proc.ExitCode, stdout.ReplaceLineEndings(Environment.NewLine), stderr.ReplaceLineEndings(Environment.NewLine));
        }

        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void AssertGenericLocalClosureShape(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var reader = pe.GetMetadataReader();
        var closure = reader.TypeDefinitions
            .Select(handle => (handle, definition: reader.GetTypeDefinition(handle)))
            .FirstOrDefault(pair => reader.GetString(pair.definition.Name).StartsWith("<closure_Add_", StringComparison.Ordinal));
        Assert.False(closure.handle.IsNil);
        Assert.Empty(closure.definition.GetGenericParameters());

        var invoke = closure.definition.GetMethods()
            .Select(handle => reader.GetMethodDefinition(handle))
            .Single(method => reader.GetString(method.Name) == "Invoke");
        Assert.Single(invoke.GetGenericParameters());
    }

    private static readonly Lazy<IReadOnlyList<string>> BclReferences = new(() =>
    {
        var runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location);
        if (string.IsNullOrEmpty(runtimeDir) || !Directory.Exists(runtimeDir))
        {
            return Array.Empty<string>();
        }

        return Directory.EnumerateFiles(runtimeDir, "*.dll", SearchOption.TopDirectoryOnly)
            .Where(p =>
            {
                var name = Path.GetFileName(p);
                return name.StartsWith("System.", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "mscorlib.dll", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "netstandard.dll", StringComparison.OrdinalIgnoreCase);
            })
            .ToList();
    });
}
