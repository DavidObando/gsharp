// <copyright file="Issue3907StaticEventTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issues #3911 / #3907, ADR-0052 (amended): a <c>shared</c>-block static event
/// can be READ and RAISED by its bare name inside the declaring type, and
/// subscribed to by its bare name, exactly as an instance event can.
/// </summary>
/// <remarks>
/// <para>Issue #263 shipped static events' declaration, accessors, metadata and
/// the qualified <c>Type.Event += handler</c> subscription. The bare-name half
/// was never wired up: the binder's static bare-name exposure covered static
/// fields, const fields and static properties but not a field-like static
/// event's BACKING FIELD, and the bare <c>+=</c>/<c>-=</c> path walked instance
/// events only. So <c>Static?(nil, args)</c> failed with <c>GS0130 Function
/// 'Static' doesn't exist</c> while the identical instance event worked — which
/// is what the migrated <c>Gsharp.Runtime.Channels</c> hit on
/// <c>GsharpRuntime.RaiseDeferGraceExpired</c>, <c>RaiseScopeStalled</c> and
/// <c>GoroutineRuntime.TryHandle</c>.</para>
/// <para>Every case RUNS the emitted program. Binding-only assertions cannot
/// tell a correct subscription from one that binds and then never fires, cannot
/// see that <c>-=</c> actually detaches, and cannot see that <c>+= nil</c> is
/// the silent no-op C# specifies rather than a throw. ILVerify runs too,
/// because the fix changes which member a bare name binds to and therefore the
/// emitted field/accessor references.</para>
/// </remarks>
public class Issue3907StaticEventTests
{
    [Fact]
    public void StaticEvent_IsRaisedAndReadByBareNameInsideItsDeclaringType()
    {
        // The shape of GsharpRuntime.RaiseDeferGraceExpired: a process-wide
        // diagnostic hook raised through the canonical null-conditional form.
        const string source = @"
package Demo

import System

class Bus {
    shared {
        event Ticked EventHandler[EventArgs]?

        func Raise() {
            Ticked?(nil, EventArgs.Empty)
        }

        func HasSubscribers() bool {
            // The READ half — GoroutineRuntime.TryHandle's `var handlers = E`.
            let handlers = Ticked
            return handlers != nil
        }
    }
}

Console.WriteLine(""before="" + Bus.HasSubscribers().ToString())
Bus.Ticked += func(sender object?, e EventArgs) { Console.WriteLine(""fired"") }
Console.WriteLine(""after="" + Bus.HasSubscribers().ToString())
Bus.Raise()
";

        var lines = CompileVerifyAndRun(source);

        Assert.Contains("before=False", lines);
        Assert.Contains("after=True", lines);

        // The subscriber actually ran. A fix that merely made the raise BIND
        // would pass a binding-only assertion and fail here.
        Assert.Contains("fired", lines);
    }

    [Fact]
    public void StaticEvent_UnsubscribeDetaches_AndSubscribeIsCumulative()
    {
        const string source = @"
package Demo

import System

class Bus {
    shared {
        event Ticked EventHandler[EventArgs]?

        func Raise() {
            Ticked?(nil, EventArgs.Empty)
        }
    }
}

let first = func(sender object?, e EventArgs) { Console.WriteLine(""first"") }
let second = func(sender object?, e EventArgs) { Console.WriteLine(""second"") }

Bus.Ticked += first
Bus.Ticked += second
Console.WriteLine(""--- both ---"")
Bus.Raise()

Bus.Ticked -= first
Console.WriteLine(""--- second only ---"")
Bus.Raise()

Bus.Ticked -= second
Console.WriteLine(""--- none ---"")
Bus.Raise()
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source);
        var text = string.Join("\n", lines);

        // Both handlers ran while both were attached, in subscription order.
        Assert.Contains("--- both ---\nfirst\nsecond\n--- second only ---", text);

        // `-=` genuinely detached the first and left the second.
        Assert.Contains("--- second only ---\nsecond\n--- none ---", text);

        // Removing the last handler leaves the backing field nil and the
        // null-conditional raise is a no-op rather than a NullReferenceException.
        Assert.Contains("--- none ---\ndone", text);
    }

    [Fact]
    public void StaticEvent_BareNameSubscriptionInsideTheDeclaringType_RoutesThroughTheAccessors()
    {
        // Exercises the bare `Ticked += handler` spelling from inside the type.
        // This must reach the add/remove ACCESSORS, not a compound assignment on
        // the backing field the read half now also exposes: the accessors carry
        // the issue-#256 Interlocked.CompareExchange loop, so a compound-assign
        // lowering would silently drop the concurrency guarantee.
        const string source = @"
package Demo

import System

class Bus {
    shared {
        event Ticked EventHandler[EventArgs]?

        func Attach(h EventHandler[EventArgs]) {
            Ticked += h
        }

        func Detach(h EventHandler[EventArgs]) {
            Ticked -= h
        }

        func Raise() {
            Ticked?(nil, EventArgs.Empty)
        }
    }
}

let h = func(sender object?, e EventArgs) { Console.WriteLine(""bare-fired"") }
Bus.Attach(h)
Bus.Raise()
Bus.Detach(h)
Console.WriteLine(""--- detached ---"")
Bus.Raise()
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source);
        var text = string.Join("\n", lines);

        Assert.Contains("bare-fired", lines);
        Assert.Contains("--- detached ---\ndone", text);
    }

    [Fact]
    public void StaticEvent_NilHandlerSubscriptionIsASilentNoOp()
    {
        // Issue #3775 / PR #3793 established that C#'s `e += null` is a silent
        // no-op (add_E forwards to Delegate.Combine, which returns the other
        // operand unchanged) and fixed the divergence for INSTANCE events. The
        // static path must not reintroduce it: this must neither fail to
        // compile (GS0155) nor throw at run time.
        const string source = @"
package Demo

import System

class Bus {
    shared {
        event Ticked EventHandler[EventArgs]?

        func Raise() {
            Ticked?(nil, EventArgs.Empty)
        }
    }
}

let absent EventHandler[EventArgs]? = nil

Bus.Ticked += absent
Console.WriteLine(""added-nil"")
Bus.Raise()

Bus.Ticked += func(sender object?, e EventArgs) { Console.WriteLine(""real"") }
Bus.Ticked += absent
Bus.Raise()

Bus.Ticked -= absent
Bus.Raise()
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source);
        var text = string.Join("\n", lines);

        Assert.Contains("added-nil", lines);

        // The nil subscription left the invocation list untouched: the real
        // handler still fires exactly once per raise, both after a nil `+=`
        // and after a nil `-=`.
        Assert.Contains("added-nil\nreal\nreal\ndone", text);
    }

    [Fact]
    public void StaticAndInstanceEventsOfTheSameNameCoexist()
    {
        // Guards the shadowing precedence the bare-name exposure must preserve:
        // the instance member is exposed first, so a same-named static event
        // must not displace it, and each must still raise its own subscribers.
        const string source = @"
package Demo

import System

class Bus {
    event Ticked EventHandler[EventArgs]?

    func RaiseInstance() {
        Ticked?(nil, EventArgs.Empty)
    }

    shared {
        event Shared EventHandler[EventArgs]?

        func RaiseShared() {
            Shared?(nil, EventArgs.Empty)
        }
    }
}

let b = Bus()
b.Ticked += func(sender object?, e EventArgs) { Console.WriteLine(""instance"") }
Bus.Shared += func(sender object?, e EventArgs) { Console.WriteLine(""static"") }

b.RaiseInstance()
Bus.RaiseShared()
Console.WriteLine(""done"")
";

        var lines = CompileVerifyAndRun(source);
        var text = string.Join("\n", lines);

        Assert.Contains("instance\nstatic\ndone", text);
    }

    private static string[] CompileVerifyAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3907_staticevent_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "Program.gs");
            File.WriteAllText(srcPath, source);
            var outPath = Path.Combine(tempDir, "Program.dll");

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
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
            Assert.True(
                proc.ExitCode == 0,
                $"sample exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout
                .ReplaceLineEndings("\n")
                .Split('\n', StringSplitOptions.RemoveEmptyEntries);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
