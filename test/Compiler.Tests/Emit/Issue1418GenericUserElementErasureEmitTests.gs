// <copyright file="Issue1418GenericUserElementErasureEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit
import Xunit.Sdk

/// Issue #1418 (follow-up to #1344): generalizes user-element preservation
/// across <em>any</em> constructed CLR generic `G[Entry]` surfaced from a
/// property, not just the enumerable-collection (#1328) and channel-reader
/// /writer (#1344) shapes that were previously allow-listed.
///
/// A same-compilation user type used as a CLR generic argument is erased to
/// `System.Object` on the closed type. When a property's open type is a
/// constructed generic over the receiver's type parameter (e.g.
/// `TaskCompletionSource[Entry].Task` -> `Task<TResult>`, or
/// `LinkedList[Entry].First` -> `LinkedListNode<T>`), the closed
/// reflection type reports `Task[object]` / `LinkedListNode[object]`,
/// collapsing the element type for every downstream projection
/// (`await`, `.Result`, chained member access). The fix surfaces the
/// symbolic `[Entry]` projection whenever it carries a same-compilation
/// user type anywhere, while member lookup still resolves against the erased
/// closed shape (proven by #1088).
///
/// These tests compile, IL-verify, and run each repro end-to-end.
open class Issue1418GenericUserElementErasureEmitTests {
    @Fact
    func TaskCompletionSourceTask_UserElement_AwaitBindsAndRuns() {
        // `TaskCompletionSource[Entry].Task` -> `Task[Entry]` is neither an
        // enumerable collection nor a channel; before #1418 it erased to
        // `Task[object]`, so `await tcs.Task` bound the result as `object` and
        // `e.V` failed GS0158.
        let source = `package P
import System
import System.Threading.Tasks

class Issue1418TaskEntry { var V int32 = 0 }

public var total = 0
async func Consume(tcs TaskCompletionSource[Issue1418TaskEntry]) {
    let e = await tcs.Task
    total = total + e.V
}

let tcs = TaskCompletionSource[Issue1418TaskEntry]()
var a = Issue1418TaskEntry()
a.V = 42
tcs.SetResult(a)
Consume(tcs).Wait()
Console.WriteLine(total)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func TaskCompletionSourceTask_UserElement_ResultBindsAndRuns() {
        // The same symbolic `Task[Entry]` flowing through the synchronous
        // `.Result` surface (open type `TResult`, a bare parameter on the now
        // preserved `Task[Entry]`).
        let source = `package P
import System
import System.Threading.Tasks

class Issue1418ResultEntry { var V int32 = 0 }

let tcs = TaskCompletionSource[Issue1418ResultEntry]()
var a = Issue1418ResultEntry()
a.V = 7
tcs.SetResult(a)
let e = tcs.Task.Result
Console.WriteLine(e.V)`
        Assert.Equal("7${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func LinkedListNodeProperty_UserElement_ChainedAccessBindsAndRuns() {
        // `LinkedList[Entry].First` -> `LinkedListNode[Entry]` is a NON-enumerable
        // constructed generic property; before #1418 it erased to
        // `LinkedListNode[object]`, so `node.Value` bound as `object` and
        // `node.Value.V` failed GS0158. (`LinkedList` itself is enumerable, but
        // the `.First` PROPERTY type — `LinkedListNode<T>` — is not.)
        //
        // Issue #3705 family 2: the `nil` guard is new and it is a CORRECTION,
        // not a workaround. `LinkedList<T>.First` is declared `[Nullable(2)]`
        // in the BCL — it returns null for an empty list — so the guard is what
        // the declaration always required. This test used to bind it as non-null
        // only because `GetClrPropertyTypeSymbol`'s symbolic branch dropped the
        // declaration's nullability, which is the unsound direction #3705
        // family 2 exists to close. The test's actual subject — that a
        // constructed generic property type does not erase to
        // `LinkedListNode[object]`, so `.Value.V` resolves to the user member —
        // is unchanged and still asserted by the `11` below.
        let source = `package P
import System
import System.Collections.Generic

class Issue1418NodeEntry { var V int32 = 0 }

let ll = LinkedList[Issue1418NodeEntry]()
var a = Issue1418NodeEntry()
a.V = 11
ll.AddLast(a)
let node = ll.First
if node == nil {
    Console.WriteLine("empty")
} else {
    Console.WriteLine(node.Value.V)
}`
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func ChannelReaderWriter_UserElement_StillBindsAndRuns() {
        // Regression guard: the #1344 channel shape, previously handled by a
        // dedicated allow-list now folded into the general rule, keeps working.
        let source = `package P
import System
import System.Threading.Channels

class Issue1418ChanEntry { var V int32 = 0 }

public var total = 0
async func Consume(ch Channel[Issue1418ChanEntry]) {
    await for m in ch.Reader.ReadAllAsync() {
        total = total + m.V
    }
}

let ch = Channel.CreateUnbounded[Issue1418ChanEntry]()
var a = Issue1418ChanEntry()
a.V = 5
var w1 = ch.Writer.TryWrite(a)
var b = Issue1418ChanEntry()
b.V = 9
var w2 = ch.Writer.TryWrite(b)
ch.Writer.Complete()
Consume(ch).Wait()
Console.WriteLine(total)`
        Assert.Equal("14${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func DictionaryValuesCollection_UserElement_StillBindsAndRuns() {
        // Regression guard: the #1328 enumerable-collection shape
        // (`Dictionary[K, Entry].Values` -> `ValueCollection[K, Entry]`), also
        // folded into the general rule, keeps preserving the element type
        // through the `for … in` surface.
        let source = `package P
import System
import System.Collections.Generic

class Issue1418DictEntry { var V int32 = 0 }

let d = Dictionary[int32, Issue1418DictEntry]()
var a = Issue1418DictEntry()
a.V = 3
d[1] = a
var b = Issue1418DictEntry()
b.V = 8
d[2] = b
var total = 0
for e in d.Values {
    total = total + e.V
}
Console.WriteLine(total)`
        Assert.Equal("11${Environment.NewLine}", CompileAndRun(source))
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue1418_emit_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
                let Ref = func (name string) string {
                    return "/r:" + Path.Combine(runtimeDir, name)
                }
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{
                            "/out:" + outPath,
                            "/target:exe",
                            "/targetframework:net10.0",
                            Ref("System.Private.CoreLib.dll"),
                            Ref("System.Runtime.dll"),
                            Ref("System.Console.dll"),
                            Ref("System.Collections.dll"),
                            Ref("System.Threading.dll"),
                            Ref("System.Threading.Channels.dll"),
                            Ref("System.Threading.Tasks.dll"),
                            srcPath
                        }
                    )
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
                IlVerifier.Verify(outPath)
                let runtimeConfigPath = Path.ChangeExtension(outPath, "runtimeconfig.json")
                File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let psi = ProcessStartInfo("dotnet", "exec \"" + outPath + "\""){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                proc.WaitForExit()
                if proc.ExitCode != 0 {
                    throw XunitException("exited " + proc.ExitCode.ToString() + `
stdout:
` + stdout + `
stderr:
` + stderr)
                }
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch (IOException) { }
            }
        }
    }
}
