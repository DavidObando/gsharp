// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

open class Issue5037SuspendingForInDisposalTests {
    @Theory
    @InlineData(false)
    @InlineData(true)
    func SuspendedLoops_RunCleanupThroughTheRealDriver(useReferencePack bool) {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue5037", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let references = ReferenceClosure.RefPackAssemblies().ToArray()
            let contractPath = Path.Combine(directory, "DisposalContract.dll")
            let contract = CSharpCompilation.Create(
                "DisposalContract",
                []SyntaxTree{CSharpSyntaxTree.ParseText(ContractSource)},
                references.Select((path string) -> MetadataReference.CreateFromFile(path)),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let stream = File.Create(contractPath)
                let emitted = contract.Emit(stream)
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            }
            // The contract must use targeting-pack identities, not host implementation assemblies.
            {
                using let stream = File.OpenRead(contractPath)
                using let pe = PEReader(stream)
                let metadata = pe.GetMetadataReader()
                let names = metadata
                    .AssemblyReferences
                    .Select(
                    (handle AssemblyReferenceHandle) -> metadata.GetString(metadata.GetAssemblyReference(handle).Name)
                )
                    .ToArray()
                Assert.Contains("System.Runtime", names)
                Assert.DoesNotContain("System.Private.CoreLib", names)
            }
            let sourcePath = Path.Combine(directory, "probe.gs")
            let outputPath = Path.Combine(directory, "probe.dll")
            File.WriteAllText(sourcePath, Source)
            let args = List[string]{"/target:library", "/out:" + outputPath, "/nowarn:GS9100"}
            if useReferencePack {
                args.Add("/targetframework:net10.0")
                args.AddRange(references.Select((path string) -> "/reference:" + path))
            }
            args.Add(sourcePath)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                Assert.True(Program.Main(args.ToArray()) == 0, "$stdout${Environment.NewLine}$stderr")
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            IlVerifier.Verify(outputPath)
            let assemblies = EmittedFixture.LoadTogether(contractPath, outputPath)
            let probe = assemblies[1].GetType("Issue5037.Forwarder")!!
            let control = assemblies[0].GetType("DisposalContract")!!
            let run = control.GetMethod("Run")!!
            let cases = [](Scenario string, Expected string){
                ("normal", "Y1,Y2,Douter"),
                ("early", "Y1,P,Douter"),
                ("never", ""),
                ("move-before", "Douter,Xmove"),
                ("move-after", "Y1,Douter,Xmove"),
                ("current-before", "Douter,Xcurrent"),
                ("current-after", "Y1,Douter,Xcurrent"),
                ("body-before", "Douter,Xbody"),
                ("body-after", "Y1,Douter,Xbody"),
                ("nested-normal", "Y11,Y12,Dinner,Y21,Y22,Dinner,Douter"),
                ("nested-early", "Y11,P,Dinner,Douter"),
                ("nested-acquire", "Douter,Xacquire"),
                ("nested-dispose", "Y11,P,Dinner,Douter,Xdispose"),
                ("nested-exhaust-dispose", "Y11,Y12,Dinner,Douter,Xdispose"),
                ("continue-break", "Y1,Y2,Douter"),
                ("async-normal", "P0,Douter,R3"),
                ("async-throw", "P0,Douter,Xbody"),
                ("async-iterator-normal", "P0,Y1,Y2,Douter"),
                ("async-iterator-early", "P0,Y1,Douter"),
                ("async-iterator-throw", "P0,Douter,Xbody"),
                ("async-iterator-inline-early", "P0,Y1,Douter"),
                ("async-iterator-inline-normal", "P0,Y1,Y2,Douter")
            }
            let failures = List[string]()
            for entry in cases {
                Assert.Equal(entry.Expected, cast[string](run.Invoke(nil, []object{control, entry.Scenario})))
                let actual = cast[string](run.Invoke(nil, []object{probe, entry.Scenario}))
                if actual != entry.Expected {
                    failures.Add("${entry.Scenario}: expected '${entry.Expected}', actual '$actual'")
                }
            }
            Assert.True(failures.Count == 0, string.Join(Environment.NewLine, failures))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private const Source string = `package Issue5037
import System
import System.Collections.Generic
import System.Threading.Tasks

shared class Forwarder {
    func Forward(values IEnumerable[int32]) sequence[int32] {
        for value in values {
            yield value
        }
    }

    func BodyBefore(values IEnumerable[int32]) sequence[int32] {
        for value in values {
            if value > 0 {
                throw InvalidOperationException("body")
            }
            yield value
        }
    }

    func BodyAfter(values IEnumerable[int32]) sequence[int32] {
        for value in values {
            yield value
            throw InvalidOperationException("body")
        }
    }

    func Nested(outer IEnumerable[int32], inner IEnumerable[int32]) sequence[int32] {
        for a in outer {
            for b in inner {
                yield a * 10 + b
            }
        }
    }

    func ContinueBreak(values IEnumerable[int32]) sequence[int32] {
        for value in values {
            yield value
            if value == 1 {
                continue
            }
            break
        }
    }

    async func AwaitBody(values IEnumerable[int32], gate Task, fail bool) Task[int32] {
        var sum = 0
        for value in values {
            await gate
            if fail {
                throw InvalidOperationException("body")
            }
            sum = sum + value
        }
        return sum
    }

    async func AsyncForward(values IEnumerable[int32], gate Task, fail bool) async sequence[int32] {
        for value in values {
            await gate
            if fail {
                throw InvalidOperationException("body")
            }
            yield value
        }
    }
}`

        // Roslyn compiles this contract against the same explicit ref pack passed to gsc.
        // The C# controls and the emitted G# methods share the lifecycle oracle below.
        private const ContractSource string = `using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Threading.Tasks;

public static class DisposalContract
{
    public static IEnumerable<int> Forward(IEnumerable<int> values)
    {
        foreach (int value in values) yield return value;
    }
    public static IEnumerable<int> BodyBefore(IEnumerable<int> values)
    {
        foreach (int value in values)
        {
            if (value > 0) throw new InvalidOperationException("body");
            yield return value;
        }
    }
    public static IEnumerable<int> BodyAfter(IEnumerable<int> values)
    {
        foreach (int value in values)
        {
            yield return value;
            throw new InvalidOperationException("body");
        }
    }
    public static IEnumerable<int> Nested(IEnumerable<int> outer, IEnumerable<int> inner)
    {
        foreach (int a in outer)
            foreach (int b in inner)
                yield return a * 10 + b;
    }
    public static IEnumerable<int> ContinueBreak(IEnumerable<int> values)
    {
        foreach (int value in values)
        {
            yield return value;
            if (value == 1) continue;
            break;
        }
    }
    public static async Task<int> AwaitBody(IEnumerable<int> values, Task gate, bool fail)
    {
        int sum = 0;
        foreach (int value in values)
        {
            await gate;
            if (fail) throw new InvalidOperationException("body");
            sum += value;
        }
        return sum;
    }
    public static async IAsyncEnumerable<int> AsyncForward(IEnumerable<int> values, Task gate, bool fail)
    {
        foreach (int value in values)
        {
            await gate;
            if (fail) throw new InvalidOperationException("body");
            yield return value;
        }
    }

    public static string Run(Type type, string scenario)
    {
        var log = new List<string>();
        var outer = new Counted("outer", log);
        var inner = new Counted("inner", log);
        string method = scenario.StartsWith("nested-") ? "Nested" : "Forward";
        if (scenario == "move-before") outer.ThrowMove = 1;
        if (scenario == "move-after") outer.ThrowMove = 2;
        if (scenario == "current-before") outer.ThrowCurrent = 1;
        if (scenario == "current-after") outer.ThrowCurrent = 2;
        if (scenario == "body-before") method = "BodyBefore";
        if (scenario == "body-after") method = "BodyAfter";
        if (scenario == "continue-break") method = "ContinueBreak";
        if (scenario == "nested-acquire") inner.ThrowAcquire = true;
        if (scenario.Contains("dispose")) inner.ThrowDispose = true;
        try
        {
            if (scenario.StartsWith("async-iterator-"))
            {
                var gate = new TaskCompletionSource();
                var values = (IAsyncEnumerable<int>)type.GetMethod("AsyncForward").Invoke(null,
                    new object[] { outer, gate.Task, scenario == "async-iterator-throw" });
                if (scenario.StartsWith("async-iterator-inline-"))
                {
                    var consumer = ConsumeInline(values, log, scenario.EndsWith("-early"));
                    if (consumer.IsCompleted) throw new Exception("consumer did not await pending MoveNextAsync");
                    log.Add("P" + log.Count);
                    gate.SetResult();
                    consumer.GetAwaiter().GetResult();
                    return string.Join(",", log);
                }
                var cursor = values.GetAsyncEnumerator();
                try
                {
                    var pending = cursor.MoveNextAsync().AsTask();
                    if (pending.IsCompleted) throw new Exception("iterator await did not suspend");
                    log.Add("P" + log.Count);
                    gate.SetResult();
                    while (pending.GetAwaiter().GetResult())
                    {
                        log.Add("Y" + cursor.Current);
                        if (scenario == "async-iterator-early") break;
                        pending = cursor.MoveNextAsync().AsTask();
                    }
                }
                finally
                {
                    try { cursor.DisposeAsync().GetAwaiter().GetResult(); }
                    finally { cursor.DisposeAsync().GetAwaiter().GetResult(); }
                }
            }
            else if (scenario.StartsWith("async-"))
            {
                var gate = new TaskCompletionSource();
                var task = (Task<int>)type.GetMethod("AwaitBody").Invoke(null,
                    new object[] { outer, gate.Task, scenario == "async-throw" });
                if (task.IsCompleted) throw new Exception("await did not suspend");
                log.Add("P" + log.Count);
                gate.SetResult();
                log.Add("R" + task.GetAwaiter().GetResult());
            }
            else
            {
                var arguments = method == "Nested" ? new object[] { outer, inner } : new object[] { outer };
                var values = (IEnumerable<int>)type.GetMethod(method).Invoke(null, arguments);
                var cursor = values.GetEnumerator();
                try
                {
                    if (scenario != "never")
                    {
                        while (cursor.MoveNext())
                        {
                            log.Add("Y" + cursor.Current);
                            if (scenario == "early" || scenario == "nested-early" || scenario == "nested-dispose")
                            {
                                log.Add("P");
                                break;
                            }
                        }
                    }
                }
                finally
                {
                    // Dispose must be idempotent, including after a failing cleanup.
                    try { cursor.Dispose(); }
                    finally { cursor.Dispose(); }
                }
                if (cursor.MoveNext()) throw new Exception("resumed after Dispose");
            }
        }
        catch (InvalidOperationException error) { log.Add("X" + error.Message); }
        return string.Join(",", log);
    }

    private static async Task ConsumeInline(IAsyncEnumerable<int> values, List<string> log, bool early)
    {
        var cursor = values.GetAsyncEnumerator();
        try
        {
            while (await cursor.MoveNextAsync().ConfigureAwait(false))
            {
                log.Add("Y" + cursor.Current);
                if (early) break;
            }
        }
        finally { await cursor.DisposeAsync().ConfigureAwait(false); }
    }

    private sealed class Counted : IEnumerable<int>
    {
        private readonly string name;
        private readonly List<string> log;
        public int ThrowMove, ThrowCurrent;
        public bool ThrowAcquire, ThrowDispose;
        public Counted(string name, List<string> log) { this.name = name; this.log = log; }
        public IEnumerator<int> GetEnumerator()
        {
            if (ThrowAcquire) throw new InvalidOperationException("acquire");
            return new Cursor(this);
        }
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
        private sealed class Cursor : IEnumerator<int>
        {
            private readonly Counted owner;
            private int position;
            public Cursor(Counted owner) { this.owner = owner; }
            public int Current => position == owner.ThrowCurrent
                ? throw new InvalidOperationException("current") : position;
            object IEnumerator.Current => Current;
            public bool MoveNext()
            {
                if (++position == owner.ThrowMove) throw new InvalidOperationException("move");
                return position <= 2;
            }
            public void Dispose()
            {
                owner.log.Add("D" + owner.name);
                if (owner.ThrowDispose) throw new InvalidOperationException("dispose");
            }
            public void Reset() => throw new NotSupportedException();
        }
    }
}`
    }
}
