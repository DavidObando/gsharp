// <copyright file="Issue3775NilEventHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3775: <c>e += h</c> / <c>e -= h</c> with a nil handler is a silent
/// no-op in C# — the accessor forwards to
/// <see cref="Delegate.Combine(Delegate?, Delegate?)"/> /
/// <see cref="Delegate.Remove(Delegate?, Delegate?)"/>, both of which are
/// defined on a null operand — so a nilable handler is a legal subscription
/// argument. G# rejected exactly that shape with <c>GS0155 Cannot convert type
/// 'System.EventHandler?' to 'System.EventHandler'</c>, leaving <c>h!!</c> as
/// the only spelling, which throws at run time on the very path C# defines as
/// doing nothing.
/// <para>
/// This is the same defect class as #3784 / PR #3787 (the unguarded
/// <c>using</c> cleanup): a position where G#'s handling assumes non-nil while
/// C# defines nil-tolerant behaviour. It surfaces one step earlier — at bind
/// time rather than at run time — but the observable consequence is identical:
/// the program cannot express what C# expresses.
/// </para>
/// <para>
/// Every case EXECUTES and asserts on the program's own output. A
/// binding-only assertion cannot tell a subscription that was accepted from
/// one that was accepted AND wired the surviving handler correctly — the
/// anti-vacuity cases below are the ones that check the second half.
/// </para>
/// </summary>
public class Issue3775NilEventHandlerTests
{
    /// <summary>
    /// Gets the executable cases: each is (name, source, expected stdout lines).
    /// </summary>
    /// <returns>The case data.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The reduction of the defect: a nilable handler on a user-declared
        // event, added and removed. Both statements are no-ops; neither is a
        // conversion error and neither throws.
        yield return new object[]
        {
            "user-event-nilable-handler",
            @"
package P
import System

class Clock {
    event Ticked EventHandler
    func Fire() {
        Ticked?.Invoke(this, EventArgs.Empty)
    }
}

func Run() {
    let c = Clock()
    let h EventHandler? = nil
    c.Ticked += h
    Console.WriteLine(""added"")
    c.Ticked -= h
    Console.WriteLine(""removed"")
    c.Fire()
    Console.WriteLine(""fired"")
}

Run()
",
            new[] { "added", "removed", "fired" },
        };

        // The same on a CLR (imported) event, and with the literal `nil`
        // written directly at the subscription site — the shape cs2gs had to
        // spell `c.PropertyChanged += h!!` to get past the binder.
        yield return new object[]
        {
            "clr-event-nilable-and-literal-nil",
            @"
package P
import System
import System.ComponentModel

class Model : INotifyPropertyChanged {
    event PropertyChanged PropertyChangedEventHandler
}

func Run() {
    let m = Model()
    let h PropertyChangedEventHandler? = nil
    m.PropertyChanged += h
    Console.WriteLine(""clr-added"")
    m.PropertyChanged -= h
    Console.WriteLine(""clr-removed"")
    m.PropertyChanged += nil
    Console.WriteLine(""literal-nil"")
}

Run()
",
            new[] { "clr-added", "clr-removed", "literal-nil" },
        };

        // ANTI-VACUITY: accepting the nil subscription must not disturb the
        // real one. A nil `+=` before and after a genuine handler leaves
        // exactly one subscriber; the nil `-=` removes nothing; the real `-=`
        // removes it. Three fires, and only the middle two print.
        yield return new object[]
        {
            "nil-subscriptions-do-not-disturb-a-real-one",
            @"
package P
import System

class Clock {
    event Ticked EventHandler
    func Fire() {
        Ticked?.Invoke(this, EventArgs.Empty)
    }
}

class Sink {
    func OnTick(sender object?, e EventArgs) {
        Console.WriteLine(""tick"")
    }
}

func Run() {
    let c = Clock()
    let s = Sink()
    let h EventHandler? = nil
    c.Ticked += h
    c.Fire()
    c.Ticked += s.OnTick
    c.Ticked += h
    c.Fire()
    c.Ticked -= h
    c.Fire()
    c.Ticked -= s.OnTick
    c.Fire()
    Console.WriteLine(""done"")
}

Run()
",
            new[] { "tick", "tick", "done" },
        };

        // The other two spellings of the subscription LHS: a bare event name
        // inside the declaring type, and an event reached through a
        // member-access chain, each with a nilable field as the handler.
        yield return new object[]
        {
            "bare-name-and-member-access-handlers",
            @"
package P
import System

class Clock {
    event Ticked EventHandler
    var Stored EventHandler? = nil

    func SubscribeSelf() {
        Ticked += Stored
    }

    func Fire() {
        Ticked?.Invoke(this, EventArgs.Empty)
    }
}

class Holder {
    var Handler EventHandler? = nil
}

func Run() {
    let c = Clock()
    let h = Holder()
    c.Ticked += h.Handler
    Console.WriteLine(""member-access-nil"")
    c.SubscribeSelf()
    Console.WriteLine(""bare-name-nil"")
    c.Fire()
    Console.WriteLine(""fired"")
}

Run()
",
            new[] { "member-access-nil", "bare-name-nil", "fired" },
        };

        // ANTI-VACUITY (passes on main too): a plain non-nilable handler and a
        // lambda handler must keep binding and firing exactly as before. If
        // the relaxation had widened the handler position generally, these
        // would still pass — but if it had BROKEN the ordinary path, this is
        // the case that says so.
        yield return new object[]
        {
            "ordinary-handlers-unchanged",
            @"
package P
import System

class Clock {
    event Ticked EventHandler
    func Fire() {
        Ticked?.Invoke(this, EventArgs.Empty)
    }
}

class Sink {
    func OnTick(sender object?, e EventArgs) {
        Console.WriteLine(""method-group"")
    }
}

func Run() {
    let c = Clock()
    let s = Sink()
    c.Ticked += s.OnTick
    c.Ticked += (sender object?, e EventArgs) -> { Console.WriteLine(""lambda"") }
    c.Fire()
    Console.WriteLine(""done"")
}

Run()
",
            new[] { "method-group", "lambda", "done" },
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
    public void NilEventHandler_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3775_").FullName;
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
                $"gsc failed for '{name}' (a GS0155 here is the #3775 defect: a nil "
                    + $"handler rejected where C# defines a no-op):\nstdout:\n{compileOut}\nstderr:\n{compileErr}");

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
