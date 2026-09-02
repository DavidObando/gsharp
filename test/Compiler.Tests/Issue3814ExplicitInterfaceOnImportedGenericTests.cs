// <copyright file="Issue3814ExplicitInterfaceOnImportedGenericTests.cs" company="GSharp">
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
/// Issue #3814 / ADR-0149: a class may explicitly implement the SAME member on
/// two different instantiations of one imported generic interface.
/// <para>
/// <c>StructSymbol.GetMethodsIncludingInherited</c> deduplicated the overload
/// set with <c>BoundScope.FunctionSignaturesEqual</c>, which — correctly for
/// ordinary overloads — ignores the return type. Two explicit implementations of
/// <c>IAsyncEnumerable[T].GetAsyncEnumerator(CancellationToken)</c> differ ONLY
/// in their return type, so the second was dropped from the overload set as if
/// it were an override of the first, and the interface-implementation check then
/// reported that interface unimplemented (GS0187). The dropped method was
/// whichever was declared second, so the diagnostic followed declaration order.
/// </para>
/// <para>
/// Every case EXECUTES and dispatches THROUGH the interface, because binding
/// alone cannot see whether the two <c>MethodImpl</c> rows landed on the right
/// slots — wiring both interface slots to one method is still verifiable IL.
/// </para>
/// </summary>
public class Issue3814ExplicitInterfaceOnImportedGenericTests
{
    private const string Preamble = @"
package P
import System
import System.Collections.Generic
import System.Threading
import System.Threading.Tasks

class EmptyEnum[T] : IAsyncEnumerator[T] {
    var cur T
    prop Current T { get { return cur } }
    func MoveNextAsync() ValueTask[bool] { return ValueTask[bool](false) }
    func DisposeAsync() ValueTask { return ValueTask() }
}
";

    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The test/Core.Tests shape, reduced: two explicit implementations of
        // GetAsyncEnumerator, one per instantiation. The program dispatches
        // through EACH interface and the method itself reports which slot ran,
        // so a mis-wired MethodImpl row is observable.
        yield return new object[]
        {
            "two-instantiations-of-one-imported-generic-interface",
            Preamble + @"
class Fwd : IAsyncEnumerable[int32], IAsyncEnumerable[string] {
    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        Console.WriteLine(""int-slot"")
        return EmptyEnum[int32]()
    }

    func (IAsyncEnumerable[string]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[string] {
        Console.WriteLine(""string-slot"")
        return EmptyEnum[string]()
    }
}

let f = Fwd()
let a IAsyncEnumerable[int32] = f
let b IAsyncEnumerable[string] = f
let _ea = a.GetAsyncEnumerator(CancellationToken.None)
let _eb = b.GetAsyncEnumerator(CancellationToken.None)
",
            new[] { "int-slot", "string-slot" },
        };

        // The declaration order is reversed: on `origin/main` the diagnostic
        // followed whichever method came SECOND, so both orders must be proved.
        yield return new object[]
        {
            "two-instantiations-reversed-declaration-order",
            Preamble + @"
class Fwd : IAsyncEnumerable[int32], IAsyncEnumerable[string] {
    func (IAsyncEnumerable[string]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[string] {
        Console.WriteLine(""string-slot"")
        return EmptyEnum[string]()
    }

    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        Console.WriteLine(""int-slot"")
        return EmptyEnum[int32]()
    }
}

let f = Fwd()
let a IAsyncEnumerable[int32] = f
let b IAsyncEnumerable[string] = f
let _ea = a.GetAsyncEnumerator(CancellationToken.None)
let _eb = b.GetAsyncEnumerator(CancellationToken.None)
",
            new[] { "int-slot", "string-slot" },
        };

        // Three instantiations: the hiding rule dropped every method after the
        // first, so a two-case fix that only special-cased a pair would fail.
        yield return new object[]
        {
            "three-instantiations-of-one-imported-generic-interface",
            Preamble + @"
class Fwd3 : IAsyncEnumerable[int32], IAsyncEnumerable[int64], IAsyncEnumerable[string] {
    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        Console.WriteLine(""i32"")
        return EmptyEnum[int32]()
    }

    func (IAsyncEnumerable[int64]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int64] {
        Console.WriteLine(""i64"")
        return EmptyEnum[int64]()
    }

    func (IAsyncEnumerable[string]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[string] {
        Console.WriteLine(""str"")
        return EmptyEnum[string]()
    }
}

let f = Fwd3()
let a IAsyncEnumerable[int32] = f
let b IAsyncEnumerable[int64] = f
let c IAsyncEnumerable[string] = f
let _ea = a.GetAsyncEnumerator(CancellationToken.None)
let _eb = b.GetAsyncEnumerator(CancellationToken.None)
let _ec = c.GetAsyncEnumerator(CancellationToken.None)
",
            new[] { "i32", "i64", "str" },
        };

        // ANTI-VACUITY (passes on `origin/main` too): a SINGLE explicit clause
        // on an imported generic interface already worked — only the second
        // same-signature sibling was dropped. It must keep working.
        yield return new object[]
        {
            "single-explicit-clause-on-imported-generic-still-works",
            Preamble + @"
class One : IAsyncEnumerable[int32] {
    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        Console.WriteLine(""only-slot"")
        return EmptyEnum[int32]()
    }
}

let f = One()
let a IAsyncEnumerable[int32] = f
let _ea = a.GetAsyncEnumerator(CancellationToken.None)
",
            new[] { "only-slot" },
        };

        // The clause names an imported generic interface closed over the
        // declaring class's OWN type parameter. `target.ClrType` is the erased
        // `IEquatable[object]`, so the slot search saw `Equals(object)` against a
        // declaration saying `Equals(T)` and reported GS0494; the resolver now
        // matches through the open definition with the symbolic argument.
        yield return new object[]
        {
            "clause-on-imported-generic-closed-over-own-type-parameter",
            @"
package P
import System

class Value[T] : IEquatable[T] {
    private func (IEquatable[T]) Equals(other T) bool -> true
}

let v = Value[int32]()
let e IEquatable[int32] = v
Console.WriteLine(e.Equals(1).ToString())
",
            new[] { "True" },
        };

        // The `List[T]` shape from the real corpus: an explicit non-generic
        // `IEnumerable.GetEnumerator()` alongside two generic instantiations,
        // reached through an inherited interface (`IReadOnlyCollection[T]`).
        yield return new object[]
        {
            "two-instantiations-reached-through-an-inherited-interface",
            @"
package P
import System
import System.Collections
import System.Collections.Generic

class Conflict : IReadOnlyCollection[int32], IReadOnlyCollection[string] {
    prop Count int32 { get { return 0 } }

    func (IEnumerable[int32]) GetEnumerator() IEnumerator[int32] {
        return List[int32]().GetEnumerator()
    }

    func (IEnumerable[string]) GetEnumerator() IEnumerator[string] {
        return List[string]().GetEnumerator()
    }

    func (IEnumerable) GetEnumerator() IEnumerator {
        return List[int32]().GetEnumerator()
    }
}

let c = Conflict()
let a IReadOnlyCollection[int32] = c
let b IReadOnlyCollection[string] = c
Console.WriteLine(a.Count.ToString())
Console.WriteLine(b.Count.ToString())
",
            new[] { "0", "0" },
        };

        // ANTI-VACUITY (passes on `origin/main` too): the hiding rule the fix
        // narrows is what makes a real OVERRIDE replace its base method rather
        // than sit beside it as an ambiguous overload. A derived override must
        // still win, and the base entry must stay hidden.
        yield return new object[]
        {
            "derived-override-still-hides-the-base-method",
            @"
package P
import System

open class Base {
    open func Speak() string { return ""base"" }
}

class Derived : Base {
    override func Speak() string { return ""derived"" }
}

let d = Derived()
Console.WriteLine(d.Speak())
let b Base = d
Console.WriteLine(b.Speak())
",
            new[] { "derived", "derived" },
        };
    }

    /// <summary>
    /// Gets the cases that must still be REJECTED, so the narrowed hiding rule
    /// did not open up plain duplicate overloads. Each is (name, source).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // ANTI-VACUITY: two same-signature methods with NO explicit-interface
        // clause are still a duplicate overload (GS0264). The fix keys strictly
        // on the clause target.
        yield return new object[]
        {
            "plain-duplicate-overloads-still-rejected",
            @"
package P
import System

class Dup {
    func M(x int32) int32 { return x }
    func M(x int32) string { return ""no"" }
}

Console.WriteLine(""unreachable"")
",
        };

        // ANTI-VACUITY: two clauses naming the SAME interface instantiation are
        // still duplicates — the clause target has to actually differ.
        yield return new object[]
        {
            "two-clauses-on-the-same-instantiation-still-rejected",
            Preamble + @"
class SameTwice : IAsyncEnumerable[int32] {
    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        return EmptyEnum[int32]()
    }

    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        return EmptyEnum[int32]()
    }
}

Console.WriteLine(""unreachable"")
",
        };

        // ANTI-VACUITY: a clause naming a member the imported generic interface
        // does NOT declare is still GS0494 — the symbolic slot search widened
        // which signatures match, not whether a match is required.
        yield return new object[]
        {
            "clause-naming-a-nonexistent-member-still-rejected",
            @"
package P
import System

class Value[T] : IEquatable[T] {
    func (IEquatable[T]) Equals(other T) bool -> true
    func (IEquatable[T]) NotAMember(other T) bool -> true
}

Console.WriteLine(""unreachable"")
",
        };

        // ANTI-VACUITY: an interface instantiation left with NO implementation
        // at all is still reported unimplemented — the fix must not have made
        // GS0187 unreachable for this shape.
        yield return new object[]
        {
            "unimplemented-second-instantiation-still-rejected",
            Preamble + @"
class Missing : IAsyncEnumerable[int32], IAsyncEnumerable[string] {
    func (IAsyncEnumerable[int32]) GetAsyncEnumerator(ct CancellationToken) IAsyncEnumerator[int32] {
        return EmptyEnum[int32]()
    }
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
    public void ExplicitInterfaceOnImportedGeneric_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3814_").FullName;
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
    /// Asserts the guard rails: shapes the narrowed hiding rule must NOT admit.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void InvalidShape_IsStillRejected(string name, string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3814_neg_").FullName;
        try
        {
            var (exit, stdout, stderr) = Compile(tempDir, name, source);
            Assert.True(
                exit != 0,
                $"'{name}' must NOT compile — the #3814 fix is scoped to explicit-interface "
                    + $"clauses naming DIFFERENT interface instantiations.\nstdout:\n{stdout}\nstderr:\n{stderr}");
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
