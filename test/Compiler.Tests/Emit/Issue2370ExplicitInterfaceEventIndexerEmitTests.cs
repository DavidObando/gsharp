// <copyright file="Issue2370ExplicitInterfaceEventIndexerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0149 follow-up (issue #2362/PR #2370): generalizes the
/// explicit-interface <c>(IFoo)</c> qualifier clause — previously supported
/// for methods (#2010/#2181) and properties (#2362) only — to EVENTS and
/// INDEXERS, and corrects the emitted accessor <c>MethodAttributes</c> for
/// every explicit-clause member kind to be private/virtual/newslot/final
/// (matching real C# explicit-interface-implementation semantics) instead of
/// the previously hardcoded <c>Public</c>.
///
/// Also exercises the new interface-INDEXER declaration support itself
/// (`prop this[...] T` is now legal inside an `interface` block, whereas it
/// was previously rejected outright), since explicit indexer implementation
/// requires an interface indexer contract to resolve against.
/// </summary>
public class Issue2370ExplicitInterfaceEventIndexerEmitTests
{
    private const string EventReproSource = """
        package GapCheck

        interface ICounter {
            event Changed () -> void
        }

        open class Counter : ICounter {
            open event Changed () -> void { add { } remove { } }

            private event (ICounter) Changed () -> void { add { } remove { } }
        }
        """;

    [Fact]
    public void ExplicitEventImpl_Compiles_EmitsMethodImplRows_IlVerifies()
    {
        var dllPath = CompileLibrary(EventReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition counter = FindType(reader, "Counter");

            Assert.Equal(1, CountMethodsNamed(reader, counter, "GapCheck.ICounter.add_Changed"));
            Assert.Equal(1, CountMethodsNamed(reader, counter, "GapCheck.ICounter.remove_Changed"));

            // One MethodImpl row per accessor (add + remove).
            Assert.Equal(2, CountMethodImplRows(reader, counter));
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void ExplicitEventImpl_AccessorsArePrivateVirtualNewSlotFinal_OrdinarySiblingStaysPublic()
    {
        var dllPath = CompileLibrary(EventReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition counter = FindType(reader, "Counter");

            var explicitAdd = GetMethod(reader, counter, "GapCheck.ICounter.add_Changed");
            AssertExplicitAccessorAttributes(explicitAdd.Attributes);

            var explicitRemove = GetMethod(reader, counter, "GapCheck.ICounter.remove_Changed");
            AssertExplicitAccessorAttributes(explicitRemove.Attributes);

            // The ordinary (non-explicit) sibling event's accessors must be
            // unaffected — still public, as before this fix.
            var ordinaryAdd = GetMethod(reader, counter, "add_Changed");
            Assert.True((ordinaryAdd.Attributes & MethodAttributes.Public) != 0, "ordinary add_Changed must remain public");
            Assert.True((ordinaryAdd.Attributes & MethodAttributes.Private) == 0, "ordinary add_Changed must not be private");
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    private static void AssertExplicitAccessorAttributes(MethodAttributes attrs)
    {
        Assert.True((attrs & MethodAttributes.Private) != 0, "explicit accessor must be private");
        Assert.True((attrs & MethodAttributes.Virtual) != 0, "explicit accessor must be virtual");
        Assert.True((attrs & MethodAttributes.NewSlot) != 0, "explicit accessor must be newslot");
        Assert.True((attrs & MethodAttributes.Final) != 0, "explicit accessor must be final");
        Assert.True((attrs & MethodAttributes.Public) == 0, "explicit accessor must not be public");
    }

    private const string EventDispatchReproSource = """
        package GapCheck

        interface ICounter {
            event Changed () -> void
        }

        open class Counter : ICounter {
            open event Changed () -> void {
                add { Console.WriteLine("pub-add") }
                remove { Console.WriteLine("pub-remove") }
            }

            private event (ICounter) Changed () -> void {
                add { Console.WriteLine("exp-add") }
                remove { Console.WriteLine("exp-remove") }
            }
        }
        """;

    [Fact]
    public void ExplicitEventImpl_DispatchesThroughInterface_AddAndRemove()
    {
        // Dispatch is verified here via reflection, invoking the explicit
        // accessor's own mangled add/remove methods directly — proving the
        // MethodImpl bridge itself is wired correctly. See
        // ExplicitEventImpl_DispatchesThroughInterfaceTypedReceiver_AddAndRemove
        // below for the follow-up fix that also proves dispatch through a
        // REAL interface-typed receiver (`asIface.Changed += h`), which used
        // to fail with GS0158 for ANY interface event (explicit or not) and
        // is now fixed generally in ExpressionBinder.Async.cs.
        var assembly = CompileToAssembly(EventDispatchReproSource);
        var counterType = assembly.GetTypes().Single(t => t.Name == "Counter");
        var instance = Activator.CreateInstance(counterType)!;

        var publicAdd = counterType.GetMethod("add_Changed")!;
        var explicitAdd = counterType.GetMethod(
            "GapCheck.ICounter.add_Changed",
            BindingFlags.NonPublic | BindingFlags.Instance)!;
        var publicRemove = counterType.GetMethod("remove_Changed")!;
        var explicitRemove = counterType.GetMethod(
            "GapCheck.ICounter.remove_Changed",
            BindingFlags.NonPublic | BindingFlags.Instance)!;

        Action handler = () => { };

        var stdout = CaptureConsoleOut(() =>
        {
            publicAdd.Invoke(instance, new object[] { handler });
            explicitAdd.Invoke(instance, new object[] { handler });
            publicRemove.Invoke(instance, new object[] { handler });
            explicitRemove.Invoke(instance, new object[] { handler });
        });

        Assert.Equal("pub-add\nexp-add\npub-remove\nexp-remove\n", stdout);
    }

    private static string CaptureConsoleOut(Action action)
    {
        var prevOut = Console.Out;
        using var writer = new StringWriter();
        Console.SetOut(writer);
        try
        {
            action();
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return writer.ToString().Replace("\r\n", "\n");
    }

    private const string IndexerReproSource = """
        package GapCheck

        interface IRepo {
            prop this[key string] int32 { get; set }
        }

        class Store : IRepo {
            prop this[key string] int32 { get { return 1 } set { } }

            private prop (IRepo) this[key string] int32 {
                get { return 2 }
                set { }
            }
        }
        """;

    [Fact]
    public void ExplicitIndexerImpl_Compiles_EmitsMethodImplRows_IlVerifies()
    {
        var dllPath = CompileLibrary(IndexerReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition store = FindType(reader, "Store");

            Assert.Equal(1, CountMethodsNamed(reader, store, "GapCheck.IRepo.get_Item"));
            Assert.Equal(1, CountMethodsNamed(reader, store, "GapCheck.IRepo.set_Item"));

            // One MethodImpl row per accessor (getter + setter).
            Assert.Equal(2, CountMethodImplRows(reader, store));
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void ExplicitIndexerImpl_AccessorsArePrivateVirtualNewSlotFinal()
    {
        var dllPath = CompileLibrary(IndexerReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition store = FindType(reader, "Store");

            var explicitGetter = GetMethod(reader, store, "GapCheck.IRepo.get_Item");
            AssertExplicitAccessorAttributes(explicitGetter.Attributes);

            var explicitSetter = GetMethod(reader, store, "GapCheck.IRepo.set_Item");
            AssertExplicitAccessorAttributes(explicitSetter.Attributes);
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    [Fact]
    public void ExplicitIndexerImpl_DispatchesThroughInterface_GetAndSet()
    {
        // This test verifies the MethodImpl bridge dispatches correctly at
        // the CLR level, invoking the explicit accessor's own mangled
        // method directly via reflection. See
        // ExplicitIndexerImpl_DispatchesThroughInterfaceTypedReceiver_GetAndSet
        // below for the follow-up fix that also proves dispatch through a
        // REAL interface-typed receiver (`asIface["k"]`), which used to fail
        // for ANY indexer (explicit or not) since interfaces previously
        // could not even declare an indexer contract, and is now fixed
        // generally in ExpressionBinder.Access.cs.
        var assembly = CompileToAssembly(IndexerReproSource);
        var storeType = assembly.GetTypes().Single(t => t.Name == "Store");
        var instance = Activator.CreateInstance(storeType)!;

        var publicGetter = storeType.GetMethod("get_Item")!;
        var explicitGetter = storeType.GetMethod(
            "GapCheck.IRepo.get_Item",
            BindingFlags.NonPublic | BindingFlags.Instance)!;

        Assert.Equal(1, publicGetter.Invoke(instance, new object[] { "k" }));
        Assert.Equal(2, explicitGetter.Invoke(instance, new object[] { "k" }));
    }

    private const string MultiInterfaceIndexerReproSource = """
        package GapCheck

        interface IRepoA {
            prop this[key string] int32 { get; set }
        }

        interface IRepoB {
            prop this[key string] int32 { get; set }
        }

        class Store : IRepoA, IRepoB {
            private prop (IRepoA) this[key string] int32 {
                get { return 1 }
                set { }
            }

            private prop (IRepoB) this[key string] int32 {
                get { return 2 }
                set { }
            }
        }
        """;

    [Fact]
    public void TwoExplicitIndexersSameSignatureDifferentInterfaces_CoexistAndDispatchIndependently()
    {
        var dllPath = CompileLibrary(MultiInterfaceIndexerReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition store = FindType(reader, "Store");

            Assert.Equal(1, CountMethodsNamed(reader, store, "GapCheck.IRepoA.get_Item"));
            Assert.Equal(1, CountMethodsNamed(reader, store, "GapCheck.IRepoB.get_Item"));

            // get+set per interface => 4 MethodImpl rows total.
            Assert.Equal(4, CountMethodImplRows(reader, store));
        }
        finally
        {
            TryCleanup(dllPath);
        }

        // See the NOTE on ExplicitIndexerImpl_DispatchesThroughInterface_GetAndSet
        // above: interface-typed indexer *access syntax* is a separate,
        // pre-existing gap, so dispatch is verified via reflection here too.
        var assembly = CompileToAssembly(MultiInterfaceIndexerReproSource);
        var storeType = assembly.GetTypes().Single(t => t.Name == "Store");
        var instance = Activator.CreateInstance(storeType)!;

        var aGetter = storeType.GetMethod(
            "GapCheck.IRepoA.get_Item",
            BindingFlags.NonPublic | BindingFlags.Instance)!;
        var bGetter = storeType.GetMethod(
            "GapCheck.IRepoB.get_Item",
            BindingFlags.NonPublic | BindingFlags.Instance)!;

        Assert.Equal(1, aGetter.Invoke(instance, new object[] { "k" }));
        Assert.Equal(2, bGetter.Invoke(instance, new object[] { "k" }));
    }

    private const string MultiInterfaceEventReproSource = """
        package GapCheck

        interface IFoo {
            event Bar () -> void
        }

        interface IBaz {
            event Bar () -> void
        }

        class Both : IFoo, IBaz {
            private event (IFoo) Bar () -> void { add { } remove { } }

            private event (IBaz) Bar () -> void { add { } remove { } }
        }
        """;

    [Fact]
    public void TwoExplicitEventsSameNameDifferentInterfaces_CoexistWithFourMethodImplRows()
    {
        var dllPath = CompileLibrary(MultiInterfaceEventReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition both = FindType(reader, "Both");

            Assert.Equal(1, CountMethodsNamed(reader, both, "GapCheck.IFoo.add_Bar"));
            Assert.Equal(1, CountMethodsNamed(reader, both, "GapCheck.IBaz.add_Bar"));

            // add + remove per interface => 4 MethodImpl rows total.
            Assert.Equal(4, CountMethodImplRows(reader, both));
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    private const string GenericInterfaceEventAndIndexerReproSource = """
        package GapCheck

        interface IWatchable[T] {
            event Changed () -> void
            prop this[index int32] T { get; }
        }

        class IntObservable : IWatchable[int32] {
            private event (IWatchable[int32]) Changed () -> void { add { } remove { } }

            private prop (IWatchable[int32]) this[index int32] int32 -> index * 2
        }
        """;

    [Fact]
    public void GenericInterfaceExplicitEventAndIndexer_Compile_IlVerify()
    {
        var dllPath = CompileLibrary(GenericInterfaceEventAndIndexerReproSource);
        try
        {
            using var stream = File.OpenRead(dllPath);
            using var peReader = new PEReader(stream);
            var reader = peReader.GetMetadataReader();

            TypeDefinition intObservable = FindType(reader, "IntObservable");

            Assert.Equal(1, CountMethodsNamed(reader, intObservable, "GapCheck.IWatchable[int32].add_Changed"));
            Assert.Equal(1, CountMethodsNamed(reader, intObservable, "GapCheck.IWatchable[int32].get_Item"));

            // add + remove (event) + get (indexer) => 3 MethodImpl rows.
            Assert.Equal(3, CountMethodImplRows(reader, intObservable));
        }
        finally
        {
            TryCleanup(dllPath);
        }
    }

    // ----------------------------------------------------------------------
    // Follow-up (issue #2362/PR #2370, final completion pass): the two
    // "DispatchesThroughInterface" tests above proved the explicit-member
    // MethodImpl bridge is wired correctly via reflection, but noted a
    // SEPARATE, pre-existing binder gap: NEITHER explicit NOR ordinary
    // interface events/indexers could be reached through a genuine
    // interface-TYPED receiver (`asIface[...]`, `asIface.Event += h`) — every
    // such call site failed to bind at all (GS0158 / "not indexable").
    //
    // That gap is now fixed generally:
    //   * ExpressionBinder.Access.cs gained an InterfaceSymbol-receiver
    //     TryGetUserIndexer overload plus matching read/write bind branches.
    //   * ExpressionBinder.Async.cs gained an InterfaceSymbol branch for the
    //     event `+=`/`-=` compound-assignment binder.
    //   * MethodBodyEmitter.Closures.cs's EmitUserEventSubscription gained
    //     generic-interface-aware accessor token resolution and always
    //     emits `callvirt` when the owner is an interface.
    //
    // The tests below prove REAL end-to-end dispatch through actual
    // interface-typed-receiver source syntax (not just reflection into the
    // mangled CLR method), for both ordinary (non-explicit — the "control"
    // proving the fix is general, not explicit-interface-specific) and
    // explicit-interface members, across source-declared, generic, and
    // imported (BCL) interfaces.
    // ----------------------------------------------------------------------
    [Fact]
    public void PlainNonExplicitIndexer_DoesNotSatisfyInterfaceIndexerContract_ReportsGS0187()
    {
        // ADR-0118 (issue #944): an indexer's CLR name ("Item") is not
        // reachable by ordinary member-name lookup — only through `obj[i]`
        // index syntax — so `TypeMemberModel.TryGetProperty` deliberately
        // excludes indexers, and `VerifyInterfaceImplementations` has no
        // separate by-shape indexer-matching path. By design (pre-existing,
        // unrelated to this fix), only an EXPLICIT `(IFace)` clause indexer
        // implementation can satisfy an interface's indexer contract; a
        // plain non-explicit indexer of the identical shape does not count
        // and GS0187 correctly fires. This is a control confirming the new
        // interface-typed-receiver dispatch work does not (and should not)
        // change that pre-existing, intentional restriction. See
        // ImportedBclInterfaceIndexer_DispatchesThroughInterfaceTypedReceiver
        // below for the genuine "ordinary" (non-G#-explicit-clause) control
        // proving the receiver-dispatch fix itself is general.
        const string source = """
            package GapCheck

            interface IRepo {
                prop this[key string] int32 { get; set }
            }

            class Store : IRepo {
                prop this[key string] int32 { get { return 1 } set { } }
            }
            """;

        var (exitCode, output) = CompileExpectingFailure(source);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0187", output);
    }

    private static (int ExitCode, string Output) CompileExpectingFailure(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2370_fail_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
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

        return (compileExit, stdoutWriter.ToString() + stderrWriter.ToString());
    }

    [Fact]
    public void ExplicitIndexerImpl_DispatchesThroughInterfaceTypedReceiver_GetAndSet()
    {
        var source = IndexerReproSource + """

            var store = Store()
            var asIface IRepo = store
            asIface["k"] = 99
            public var result = asIface["k"] + store["k"]
            """;

        // asIface["k"] (interface-typed receiver) must route to the
        // EXPLICIT accessor (returns 2), while store["k"] (concrete-typed
        // receiver) must keep routing to the ordinary plain indexer
        // (returns 1) — proving the two members remain independently
        // addressable and the new receiver dispatch reaches the correct
        // (explicit) slot rather than falling back to the plain one.
        Assert.Equal(3, RunAndGetIntResult(source));
    }

    [Fact]
    public void OrdinaryEventImpl_DispatchesThroughInterfaceTypedReceiver_AddAndRemove()
    {
        const string source = """
            package GapCheck

            interface ICounter {
                event Changed () -> void
            }

            class Sink {
                var Hits int32
                init() { Hits = 0 }
                func Bump() { Hits = Hits + 1 }
            }

            class Counter : ICounter {
                event Changed () -> void
                func Fire() { Changed?.Invoke() }
            }

            var counter = Counter()
            var asIface ICounter = counter
            var sink = Sink()
            var handler = func() { sink.Bump() }
            asIface.Changed += handler
            counter.Fire()
            counter.Fire()
            asIface.Changed -= handler
            counter.Fire()
            public var result = sink.Hits
            """;

        Assert.Equal(2, RunAndGetIntResult(source));
    }

    [Fact]
    public void ExplicitEventImpl_DispatchesThroughInterfaceTypedReceiver_AddAndRemove()
    {
        const string source = """
            package GapCheck

            interface ICounter {
                event Changed () -> void
            }

            class Sink {
                var Hits int32
                init() { Hits = 0 }
                func Bump() { Hits = Hits + 1 }
            }

            open class Counter : ICounter {
                private var _explicitHandler (() -> void)?
                open event Changed () -> void
                private event (ICounter) Changed () -> void {
                    add { _explicitHandler = value }
                    remove { _explicitHandler = nil }
                }
                func FireExplicit() { _explicitHandler?.Invoke() }
                func FirePublic() { Changed?.Invoke() }
            }

            var counter = Counter()
            var asIface ICounter = counter
            var sink = Sink()
            asIface.Changed += func() { sink.Bump() }
            counter.FireExplicit()
            counter.FireExplicit()
            counter.FirePublic()
            public var result = sink.Hits
            """;

        // Subscribing via the interface-typed receiver must reach the
        // EXPLICIT accessor's own backing field, so only the two
        // FireExplicit() calls count; FirePublic() raises the unrelated
        // plain field-like event and must not invoke the same handler.
        Assert.Equal(2, RunAndGetIntResult(source));
    }

    [Fact]
    public void OrdinaryGenericInterfaceIndexer_DispatchesThroughInterfaceTypedReceiver()
    {
        const string source = """
            package GapCheck

            interface IWatchable[T] {
                prop this[index int32] T { get; }
            }

            class IntObservable : IWatchable[int32] {
                prop this[index int32] int32 -> index * 2
            }

            var obs = IntObservable()
            var asIface IWatchable[int32] = obs
            public var result = asIface[5]
            """;

        Assert.Equal(10, RunAndGetIntResult(source));
    }

    [Fact]
    public void ExplicitGenericInterfaceIndexer_DispatchesThroughInterfaceTypedReceiver()
    {
        var source = GenericInterfaceEventAndIndexerReproSource + """

            var obs = IntObservable()
            var asIface IWatchable[int32] = obs
            public var result = asIface[5]
            """;

        Assert.Equal(10, RunAndGetIntResult(source));
    }

    [Fact]
    public void OrdinaryGenericInterfaceEvent_DispatchesThroughInterfaceTypedReceiver()
    {
        const string source = """
            package GapCheck

            interface IWatchable[T] {
                event Changed () -> void
            }

            class Sink {
                var Hits int32
                init() { Hits = 0 }
                func Bump() { Hits = Hits + 1 }
            }

            class IntObservable : IWatchable[int32] {
                event Changed () -> void
                func Fire() { Changed?.Invoke() }
            }

            var obs = IntObservable()
            var asIface IWatchable[int32] = obs
            var sink = Sink()
            asIface.Changed += func() { sink.Bump() }
            obs.Fire()
            public var result = sink.Hits
            """;

        Assert.Equal(1, RunAndGetIntResult(source));
    }

    [Fact]
    public void ExplicitGenericInterfaceEvent_DispatchesThroughInterfaceTypedReceiver()
    {
        const string source = """
            package GapCheck

            interface IWatchable[T] {
                event Changed () -> void
            }

            class Sink {
                var Hits int32
                init() { Hits = 0 }
                func Bump() { Hits = Hits + 1 }
            }

            class IntObservable : IWatchable[int32] {
                private var _handler (() -> void)?
                private event (IWatchable[int32]) Changed () -> void {
                    add { _handler = value }
                    remove { _handler = nil }
                }
                func Fire() { _handler?.Invoke() }
            }

            var obs = IntObservable()
            var asIface IWatchable[int32] = obs
            var sink = Sink()
            asIface.Changed += func() { sink.Bump() }
            obs.Fire()
            obs.Fire()
            public var result = sink.Hits
            """;

        // Exercises the new generic-interface accessor token resolution
        // path in MethodBodyEmitter.Closures.cs's EmitUserEventSubscription
        // (constructed generic interface receiver, explicit member).
        Assert.Equal(2, RunAndGetIntResult(source));
    }

    [Fact]
    public void ImportedBclInterfaceIndexer_DispatchesThroughInterfaceTypedReceiver()
    {
        // Proves the fix also covers IMPORTED (BCL) interfaces, not just
        // G#-declared ones: InterfaceSymbol is the single, sealed
        // representation used for both source-declared and imported
        // interfaces, so List[int32]'s IList[int32].this[int32] contract
        // is reachable through an IList[int32]-typed receiver.
        const string source = """
            package GapCheck
            import System.Collections.Generic

            var xs = List[int32]()
            xs.Add(10)
            xs.Add(20)
            var asIface IList[int32] = xs
            asIface[0] = 99
            public var result = asIface[0] + asIface[1]
            """;

        Assert.Equal(119, RunAndGetIntResult(source));
    }

    private static Assembly CompileToAssemblyExe(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2370_exe_asm_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
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

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");
        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }

    private static int RunAndGetIntResult(string source)
    {
        var assembly = CompileToAssemblyExe(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField(
            "result",
            BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
        return (int)resultField!.GetValue(null)!;
    }

    private static TypeDefinition FindType(MetadataReader reader, string name)
    {
        foreach (var typeHandle in reader.TypeDefinitions)
        {
            var td = reader.GetTypeDefinition(typeHandle);
            if (reader.GetString(td.Name) == name)
            {
                return td;
            }
        }

        throw new InvalidOperationException($"expected to find the {name} type");
    }

    private static int CountMethodsNamed(MetadataReader reader, TypeDefinition type, string name)
    {
        int count = 0;
        foreach (var mh in type.GetMethods())
        {
            var md = reader.GetMethodDefinition(mh);
            if (reader.GetString(md.Name) == name)
            {
                count++;
            }
        }

        return count;
    }

    private static MethodDefinition GetMethod(MetadataReader reader, TypeDefinition type, string name)
    {
        foreach (var mh in type.GetMethods())
        {
            var md = reader.GetMethodDefinition(mh);
            if (reader.GetString(md.Name) == name)
            {
                return md;
            }
        }

        throw new InvalidOperationException($"expected to find method {name}");
    }

    private static int CountMethodImplRows(MetadataReader reader, TypeDefinition type)
    {
        int count = 0;
        foreach (var miHandle in type.GetMethodImplementations())
        {
            reader.GetMethodImplementation(miHandle);
            count++;
        }

        return count;
    }

    private static Assembly CompileToAssembly(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2370_asm_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
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

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");
        IlVerifier.Verify(outPath);

        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }

    private static string CompileLibrary(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2370_lib_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = new[]
        {
            "/out:" + outPath,
            "/target:library",
            "/targetframework:net10.0",
            srcPath,
        };

        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int compileExit;
        try
        {
            compileExit = Program.Main(args);
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        Assert.True(
            compileExit == 0,
            $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

        IlVerifier.Verify(outPath);
        return outPath;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue2370_exe_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var dllPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new[]
            {
                "/out:" + dllPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            };

            using var stdoutWriter = new StringWriter();
            using var stderrWriter = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdoutWriter);
            Console.SetError(stderrWriter);
            int compileExit;
            try
            {
                compileExit = Program.Main(args);
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{stdoutWriter}\nstderr:\n{stderrWriter}");

            IlVerifier.Verify(dllPath);

            var rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json");
            if (!File.Exists(rtConfig))
            {
                File.WriteAllText(rtConfig, """
                    {
                      "runtimeOptions": {
                        "tfm": "net10.0",
                        "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                      }
                    }
                    """);
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
            psi.ArgumentList.Add(rtConfig);
            psi.ArgumentList.Add(dllPath);

            using var proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Failed to start dotnet exec");
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.Replace("\r\n", "\n");
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void TryCleanup(string dllPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(dllPath);
            if (dir != null && Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
        }
    }
}
