// <copyright file="Issue3775NilEventHandlerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #3775: `e += h` / `e -= h` with a nil handler is a silent
/// no-op in C# — the accessor forwards to
/// (cref:Delegate.Combine(Delegate?, Delegate?)) /
/// (cref:Delegate.Remove(Delegate?, Delegate?)), both of which are
/// defined on a null operand — so a nilable handler is a legal subscription
/// argument. G# rejected exactly that shape with `GS0155 Cannot convert type
/// 'System.EventHandler?' to 'System.EventHandler'`, leaving `h!!` as
/// the only spelling, which throws at run time on the very path C# defines as
/// doing nothing.
///
/// This is the same defect class as #3784 / PR #3787 (the unguarded
/// `using` cleanup): a position where G#'s handling assumes non-nil while
/// C# defines nil-tolerant behaviour. It surfaces one step earlier — at bind
/// time rather than at run time — but the observable consequence is identical:
/// the program cannot express what C# expresses.
///
/// Every case EXECUTES and asserts on the program's own output. A
/// binding-only assertion cannot tell a subscription that was accepted from
/// one that was accepted AND wired the surviving handler correctly — the
/// anti-vacuity cases below are the ones that check the second half.
open class Issue3775NilEventHandlerTests {
    /// Compiles each case to an executable, IL-verifies it, runs it, and
    /// asserts the program's own output.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("Cases")
    func NilEventHandler_CompilesVerifiesAndRuns(name string, source string, expectedLines[]string) {
        let tempDir = Directory.CreateTempSubdirectory("gs_3775_").FullName
        try {
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, name + ".dll")
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, "gsc failed for '$name' (a GS0155 here is the #3775 defect: a nil " + (`handler rejected where C# defines a no-op):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            let (exit, output) = RunDotnet(outPath)
            Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
            let lines = output
                .Split('\n')
                .Select((line string) -> line.TrimEnd('\r'))
                .Where((line string) -> line.Length > 0)
                .ToArray()
            Assert.Equal(expectedLines, lines)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        /// Gets the executable cases: each is (name, source, expected stdout lines).
        /// @returns The case data.
        func Cases() sequence[[]object] {
            // The reduction of the defect: a nilable handler on a user-declared
            // event, added and removed. Both statements are no-ops; neither is a
            // conversion error and neither throws.
            yield[]object{"user-event-nilable-handler", `
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
    Console.WriteLine("added")
    c.Ticked -= h
    Console.WriteLine("removed")
    c.Fire()
    Console.WriteLine("fired")
}

Run()
`, []string{"added", "removed", "fired"}}
            // The same on a CLR (imported) event, and with the literal `nil`
            // written directly at the subscription site — the shape cs2gs had to
            // spell `c.PropertyChanged += h!!` to get past the binder.
            yield[]object{"clr-event-nilable-and-literal-nil", `
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
    Console.WriteLine("clr-added")
    m.PropertyChanged -= h
    Console.WriteLine("clr-removed")
    m.PropertyChanged += nil
    Console.WriteLine("literal-nil")
}

Run()
`, []string{"clr-added", "clr-removed", "literal-nil"}}
            // cs2gs maps a C# named delegate declaration/reference to a structural
            // arrow type. The nullable arrow must receive the same nil-tolerant
            // event-site conversion as a nullable named delegate.
            yield[]object{"clr-event-nilable-arrow-handler", `
package P
import System
import System.Diagnostics

func Run() {
    let p = Process()
    let h ((object, DataReceivedEventArgs) -> void)? = nil
    p.OutputDataReceived += h
    Console.WriteLine("arrow-added")
    p.OutputDataReceived -= h
    Console.WriteLine("arrow-removed")
}

Run()
`, []string{"arrow-added", "arrow-removed"}}
            yield[]object{"clr-event-nilable-arrow-member", `
package P
import System
import System.Diagnostics

class Holder {
    var Handler ((object, DataReceivedEventArgs) -> void)? = nil
}

func Run() {
    let p = Process()
    let holder = Holder()
    p.OutputDataReceived += holder.Handler
    Console.WriteLine("member-added")
    p.OutputDataReceived -= holder.Handler
    Console.WriteLine("member-removed")
}

Run()
`, []string{"member-added", "member-removed"}}
            // ANTI-VACUITY: accepting the nil subscription must not disturb the
            // real one. A nil `+=` before and after a genuine handler leaves
            // exactly one subscriber; the nil `-=` removes nothing; the real `-=`
            // removes it. Three fires, and only the middle two print.
            yield[]object{"nil-subscriptions-do-not-disturb-a-real-one", `
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
        Console.WriteLine("tick")
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
    Console.WriteLine("done")
}

Run()
`, []string{"tick", "tick", "done"}}
            // The other two spellings of the subscription LHS: a bare event name
            // inside the declaring type, and an event reached through a
            // member-access chain, each with a nilable field as the handler.
            yield[]object{"bare-name-and-member-access-handlers", `
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
    Console.WriteLine("member-access-nil")
    c.SubscribeSelf()
    Console.WriteLine("bare-name-nil")
    c.Fire()
    Console.WriteLine("fired")
}

Run()
`, []string{"member-access-nil", "bare-name-nil", "fired"}}
            // ANTI-VACUITY (passes on main too): a plain non-nilable handler and a
            // lambda handler must keep binding and firing exactly as before. If
            // the relaxation had widened the handler position generally, these
            // would still pass — but if it had BROKEN the ordinary path, this is
            // the case that says so.
            yield[]object{"ordinary-handlers-unchanged", `
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
        Console.WriteLine("method-group")
    }
}

func Run() {
    let c = Clock()
    let s = Sink()
    c.Ticked += s.OnTick
    c.Ticked += (sender object?, e EventArgs) -> { Console.WriteLine("lambda") }
    c.Fire()
    Console.WriteLine("done")
}

Run()
`, []string{"method-group", "lambda", "done"}}
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let output = StringBuilder()
            output.Append(process.StandardOutput.ReadToEnd())
            output.Append(process.StandardError.ReadToEnd())
            process.WaitForExit()
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
