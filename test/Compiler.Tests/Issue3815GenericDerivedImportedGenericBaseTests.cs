// <copyright file="Issue3815GenericDerivedImportedGenericBaseTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3815: inside a GENERIC class deriving from an imported generic base
/// (<c>class Wrap[T] : Channel[T]</c>), the base's inherited members must be
/// seen at the derived type's own type arguments.
/// <para>
/// The base's arguments are carried symbolically on
/// <c>StructSymbol.ImportedBaseType</c>; its reflected <c>ClrType</c> is the
/// ERASED <c>Channel&lt;object&gt;</c>. The inherited-member WRITE paths
/// (issues #319/#1582) reflected the member off that erased type and read its
/// type straight from metadata, with no receiver to project through, so
/// <c>Reader</c> bound as <c>ChannelReader[object]</c> and the assignment failed
/// with GS0155. The read path already projected correctly
/// (<c>GetInheritedClrMemberType</c>); the two now agree.
/// </para>
/// <para>
/// Every case EXECUTES and round-trips a value through the BASE-typed
/// reference, so a setter that wrote the wrong slot — or a store that type-
/// checked only because both sides had been erased to <c>object</c> — is
/// observable.
/// </para>
/// </summary>
public class Issue3815GenericDerivedImportedGenericBaseTests
{
    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The ClrBaseline shape: `GoChan[T] : Channel[T]` installing the
        // inner channel's reader/writer through the base's protected setters.
        yield return new object[]
        {
            "generic-derived-from-imported-generic-base",
            @"
package P
import System
import System.Threading.Channels

class Wrap[T] : Channel[T] {
    init(inner Channel[T]) {
        Reader = inner.Reader
        Writer = inner.Writer
    }
}

let inner = Channel.CreateUnbounded[int32]()
let w = Wrap[int32](inner)
let asBase Channel[int32] = w
asBase.Writer.TryWrite(41)
var got = 0
if asBase.Reader.TryRead(&got) {
    Console.WriteLine((got + 1).ToString())
}
",
            new[] { "42" },
        };

        // The `this.`-qualified write is a different binder path than the bare
        // name; both must project the inherited member through the base.
        yield return new object[]
        {
            "generic-derived-this-qualified-write",
            @"
package P
import System
import System.Threading.Channels

class Wrap[T] : Channel[T] {
    init(inner Channel[T]) {
        this.Reader = inner.Reader
        this.Writer = inner.Writer
    }
}

let inner = Channel.CreateUnbounded[string]()
let w = Wrap[string](inner)
let asBase Channel[string] = w
asBase.Writer.TryWrite(""hi"")
var got = """"
if asBase.Reader.TryRead(&got) {
    Console.WriteLine(got)
}
",
            new[] { "hi" },
        };

        // The same generic definition instantiated at TWO different arguments in
        // one program: each construction must see its own T, not a shared
        // erasure.
        yield return new object[]
        {
            "one-generic-definition-two-instantiations",
            @"
package P
import System
import System.Threading.Channels

class Wrap[T] : Channel[T] {
    init(inner Channel[T]) {
        Reader = inner.Reader
        Writer = inner.Writer
    }
}

let wi Channel[int32] = Wrap[int32](Channel.CreateUnbounded[int32]())
wi.Writer.TryWrite(7)
var gotI = 0
if wi.Reader.TryRead(&gotI) {
    Console.WriteLine(gotI.ToString())
}

let ws Channel[string] = Wrap[string](Channel.CreateUnbounded[string]())
ws.Writer.TryWrite(""seven"")
var gotS = """"
if ws.Reader.TryRead(&gotS) {
    Console.WriteLine(gotS)
}
",
            new[] { "7", "seven" },
        };

        // Reading the inherited member inside the generic derived type must
        // give `ChannelReader[T]`, not `ChannelReader[object]` — proved by
        // handing it to a T-typed local and round-tripping the value.
        yield return new object[]
        {
            "inherited-member-read-inside-the-generic-derived-type",
            @"
package P
import System
import System.Threading.Channels

class Wrap[T] : Channel[T] {
    init(inner Channel[T]) {
        Reader = inner.Reader
        Writer = inner.Writer
    }

    func Echo(value T) T {
        let w ChannelWriter[T] = Writer
        let r ChannelReader[T] = Reader
        w.TryWrite(value)
        var got T
        if r.TryRead(&got) {
            return got
        }

        return value
    }
}

let w = Wrap[int32](Channel.CreateUnbounded[int32]())
Console.WriteLine(w.Echo(99).ToString())
",
            new[] { "99" },
        };

        // ANTI-VACUITY (passes on `origin/main` too, since #3813): the
        // NON-generic derived class already worked and must keep working.
        yield return new object[]
        {
            "non-generic-derived-from-constructed-imported-base-still-works",
            @"
package P
import System
import System.Threading.Channels

class Wrap : Channel[int32] {
    init(inner Channel[int32]) {
        Reader = inner.Reader
        Writer = inner.Writer
    }
}

let inner = Channel.CreateUnbounded[int32]()
let w = Wrap(inner)
let asBase Channel[int32] = w
asBase.Writer.TryWrite(41)
var got = 0
if asBase.Reader.TryRead(&got) {
    Console.WriteLine((got + 1).ToString())
}
",
            new[] { "42" },
        };
    }

    /// <summary>
    /// Gets the cases that must still be REJECTED, so the projection did not
    /// silently widen what an inherited member accepts. Each is (name, source).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // The whole point: the inherited member is `ChannelReader[T]`, so a
        // `ChannelReader[string]` must NOT be assignable to it inside
        // `Wrap[T]`. Before the fix both sides were `object`-erased, which is
        // exactly the unsound direction this could have been "fixed" into.
        yield return new object[]
        {
            "wrong-instantiation-still-rejected",
            @"
package P
import System
import System.Threading.Channels

class Wrap[T] : Channel[T] {
    init(other Channel[string]) {
        Reader = other.Reader
    }
}

Console.WriteLine(""unreachable"")
",
        };

        // ANTI-VACUITY: `protected` stays out of reach from a NON-derived type
        // (the #3813 guard rail, re-asserted for the generic shape).
        yield return new object[]
        {
            "protected-setter-not-reachable-from-outside",
            @"
package P
import System
import System.Threading.Channels

func Break[T](c Channel[T]) {
    c.Reader = nil
}

Console.WriteLine(""unreachable"")
",
        };
    }

    /// <summary>
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void GenericDerivedFromImportedGenericBase_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3815_").FullName;
        try
        {
            var outPath = CompileOrThrow(tempDir, name, source);
            IlVerifier.Verify(outPath);

            var (exit, output) = RunDotnet(outPath);
            Assert.True(
                exit == 0,
                $"'{name}' must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    /// <summary>
    /// Asserts the guard rails: shapes the projection must NOT admit.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void InvalidShape_IsStillRejected(string name, string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3815_neg_").FullName;
        try
        {
            var (exit, stdout, stderr) = Compile(tempDir, name, source);
            Assert.True(
                exit != 0,
                $"'{name}' must NOT compile — the #3815 projection recovers the base's real "
                    + $"type arguments, it does not erase them.\nstdout:\n{stdout}\nstderr:\n{stderr}");
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string CompileOrThrow(string tempDir, string name, string source)
    {
        var (exit, stdout, stderr) = Compile(tempDir, name, source);
        Assert.True(exit == 0, $"gsc failed for '{name}':\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return Path.Combine(tempDir, name + ".dll");
    }

    private static (int Exit, string Stdout, string Stderr) Compile(string tempDir, string name, string source)
    {
        var srcPath = Path.Combine(tempDir, "Program.gs");
        File.WriteAllText(srcPath, source);
        var outPath = Path.Combine(tempDir, name + ".dll");

        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        foreach (var reference in TrustedPlatformAssemblies())
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
        try
        {
            return (Program.Main(args.ToArray()), compileOut.ToString(), compileErr.ToString());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
