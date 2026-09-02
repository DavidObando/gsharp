// <copyright file="Issue3812NestedTypeInitializerScopeTests.cs" company="GSharp">
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
/// Issue #3812: a nested type's field <b>initializer</b> can name the enclosing
/// type's type parameters, the same way its field <b>declaration</b> already
/// could.
/// <para>
/// Issue #1537 gave nested-type member binding the enclosing type parameters by
/// seeding <c>binderCtx.CurrentTypeParameters</c> with
/// <c>CollectEnclosingTypeParameters(...)</c> in
/// <c>BindStructDeclarationBody</c>. Field initializers, however, are bound from
/// a DEFERRED closure (issue #1194) that runs after that scope has unwound and
/// rebuilds it from scratch — and rebuilt it from
/// <c>structSymbol.TypeParameters</c> alone. So
/// <c>class Outer[T] { class Inner { var item T } }</c> bound, while adding an
/// initializer — <c>var item T = default(T)</c> — failed on the initializer
/// only, with <c>GS0113 "Type 'T' doesn't exist"</c>.
/// </para>
/// <para>
/// This is one of the two errors walling
/// <c>bench/concurrency/clr/ClrBaseline</c> out of the issue #3501
/// self-migration gate: its <c>Hchan&lt;T&gt;.Waiter</c> nested class carries
/// <c>internal T item = default!;</c>.
/// </para>
/// <para>
/// Every case EXECUTES: an initializer that silently bound to the WRONG
/// type parameter (an outer/inner shadowing mistake) would still compile and
/// still verify; only the stored value tells them apart.
/// </para>
/// </summary>
public class Issue3812NestedTypeInitializerScopeTests
{
    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The reduction of the defect.
        yield return new object[]
        {
            "nested-initializer-names-enclosing-type-parameter",
            @"
package P
import System

class Outer[T] {
    class Inner {
        var item T = default(T)
    }

    func Fresh() Inner -> Inner()

    func Make(v T) Inner {
        let i = Inner()
        i.item = v
        return i
    }
}

let o = Outer[int32]()
Console.WriteLine(o.Fresh().item.ToString())
Console.WriteLine(o.Make(7).item.ToString())
",
            new[] { "0", "7" },
        };

        // The ClrBaseline shape: an enclosing-parameterised initializer sitting
        // beside a field whose type mentions the nested type itself.
        yield return new object[]
        {
            "hchan-waiter-shape",
            @"
package P
import System
import System.Collections.Generic

class Hchan[T] {
    private let q Queue[Waiter] = Queue[Waiter]()

    class Waiter {
        var next Waiter?
        var item T = default(T)
    }

    func Push(v T) {
        let w = Waiter()
        w.item = v
        q.Enqueue(w)
    }

    func Pop() T -> q.Dequeue().item
}

let h = Hchan[string]()
h.Push(""go"")
Console.WriteLine(h.Pop())
",
            new[] { "go" },
        };

        // ANTI-VACUITY: with BOTH levels generic and DIFFERENT names, each
        // initializer must pick its own level's parameter. A scope that merely
        // "has some type parameters" would pass the first case and fail here.
        yield return new object[]
        {
            "inner-and-outer-parameters-are-distinguished",
            @"
package P
import System

class Outer[T] {
    class Inner[U] {
        var outerItem T = default(T)
        var innerItem U = default(U)

        func Describe() string -> outerItem.ToString()!! + ""|"" + (if innerItem == nil { ""nil"" } else { ""not-nil"" })
    }

    func Describe[U]() string -> Inner[U]().Describe()
}

Console.WriteLine(Outer[int32]().Describe[string]())
",
            new[] { "0|nil" },
        };

        // ANTI-VACUITY: an inner parameter that SHADOWS the outer's name must
        // win inside the nested type — the outermost-first seeding order.
        yield return new object[]
        {
            "inner-parameter-shadows-same-named-outer",
            @"
package P
import System

class Outer[T] {
    class Inner[T] {
        var item T = default(T)

        func Describe() string -> item.ToString()!!
    }

    func Describe[U]() string -> Inner[U]().Describe()
}

Console.WriteLine(Outer[string]().Describe[int32]())
",
            new[] { "0" },
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
    public void NestedTypeInitializer_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3812_").FullName;
        try
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
                $"gsc failed for '{name}' (a GS0113 here is the #3812 deferred-initializer "
                    + $"scope):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

            IlVerifier.Verify(outPath);

            var (exit, output) = RunDotnet(outPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");

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
