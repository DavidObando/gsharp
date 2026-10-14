// <copyright file="Issue2370ExplicitInterfaceEventIndexerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// ADR-0149 follow-up (issue #2362/PR #2370): generalizes the
/// explicit-interface `(IFoo)` qualifier clause — previously supported
/// for methods (#2010/#2181) and properties (#2362) only — to EVENTS and
/// INDEXERS, and corrects the emitted accessor `MethodAttributes` for
/// every explicit-clause member kind to be private/virtual/newslot/final
/// (matching real C# explicit-interface-implementation semantics) instead of
/// the previously hardcoded `Public`.
///
/// Also exercises the new interface-INDEXER declaration support itself
/// (`prop this[...] T` is now legal inside an `interface` block, whereas it
/// was previously rejected outright), since explicit indexer implementation
/// requires an interface indexer contract to resolve against.
open class Issue2370ExplicitInterfaceEventIndexerEmitTests {
    @Fact
    func ExplicitEventImpl_Compiles_EmitsMethodImplRows_IlVerifies() {
        let dllPath = CompileLibrary(EventReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let counter = FindType(reader, "Counter")
            Assert.Equal(1, CountMethodsNamed(reader, counter, "GapCheck.ICounter.add_Changed"))
            Assert.Equal(1, CountMethodsNamed(reader, counter, "GapCheck.ICounter.remove_Changed"))
            // One MethodImpl row per accessor (add + remove).
            Assert.Equal(2, CountMethodImplRows(reader, counter))
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func ExplicitEventImpl_AccessorsArePrivateVirtualNewSlotFinal_OrdinarySiblingStaysPublic() {
        let dllPath = CompileLibrary(EventReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let counter = FindType(reader, "Counter")
            let explicitAdd = GetMethod(reader, counter, "GapCheck.ICounter.add_Changed")
            AssertExplicitAccessorAttributes(explicitAdd.Attributes)
            let explicitRemove = GetMethod(reader, counter, "GapCheck.ICounter.remove_Changed")
            AssertExplicitAccessorAttributes(explicitRemove.Attributes)
            // The ordinary (non-explicit) sibling event's accessors must be
            // unaffected — still public, as before this fix.
            let ordinaryAdd = GetMethod(reader, counter, "add_Changed")
            Assert.True(
                (ordinaryAdd.Attributes & MethodAttributes.Public) != 0,
                "ordinary add_Changed must remain public"
            )
            Assert.True(
                (ordinaryAdd.Attributes & MethodAttributes.Private) == 0,
                "ordinary add_Changed must not be private"
            )
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func ExplicitEventImpl_DispatchesThroughInterface_AddAndRemove() {
        // Dispatch is verified here via reflection, invoking the explicit
        // accessor's own mangled add/remove methods directly — proving the
        // MethodImpl bridge itself is wired correctly. See
        // ExplicitEventImpl_DispatchesThroughInterfaceTypedReceiver_AddAndRemove
        // below for the follow-up fix that also proves dispatch through a
        // REAL interface-typed receiver (`asIface.Changed += h`), which used
        // to fail with GS0158 for ANY interface event (explicit or not) and
        // is now fixed generally in ExpressionBinder.Async.cs.
        let assembly = CompileToAssembly(EventDispatchReproSource)
        let counterType = assembly.GetTypes().Single((t Type) -> t.Name == "Counter")
        let instance = Activator.CreateInstance(counterType)!!
        let publicAdd = counterType.GetMethod("add_Changed")!!
        let explicitAdd = counterType.GetMethod(
            "GapCheck.ICounter.add_Changed",
            BindingFlags.NonPublic | BindingFlags.Instance
        )!!
        let publicRemove = counterType.GetMethod("remove_Changed")!!
        let explicitRemove = counterType.GetMethod(
            "GapCheck.ICounter.remove_Changed",
            BindingFlags.NonPublic | BindingFlags.Instance
        )!!
        let handler() -> void = () -> { }
        let stdout = CaptureConsoleOut(
            () -> {
                publicAdd.Invoke(instance, []object{handler})
                explicitAdd.Invoke(instance, []object{handler})
                publicRemove.Invoke(instance, []object{handler})
                explicitRemove.Invoke(instance, []object{handler})
            }
        )
        Assert.Equal(
            "pub-add${Environment.NewLine}exp-add${Environment.NewLine}pub-remove${Environment.NewLine}exp-remove${Environment.NewLine}",
            stdout
        )
    }

    @Fact
    func ExplicitIndexerImpl_Compiles_EmitsMethodImplRows_IlVerifies() {
        let dllPath = CompileLibrary(IndexerReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let store = FindType(reader, "Store")
            Assert.Equal(1, CountMethodsNamed(reader, store, "GapCheck.IRepo.get_Item"))
            Assert.Equal(1, CountMethodsNamed(reader, store, "GapCheck.IRepo.set_Item"))
            // One MethodImpl row per accessor (getter + setter).
            Assert.Equal(2, CountMethodImplRows(reader, store))
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func ExplicitIndexerImpl_AccessorsArePrivateVirtualNewSlotFinal() {
        let dllPath = CompileLibrary(IndexerReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let store = FindType(reader, "Store")
            let explicitGetter = GetMethod(reader, store, "GapCheck.IRepo.get_Item")
            AssertExplicitAccessorAttributes(explicitGetter.Attributes)
            let explicitSetter = GetMethod(reader, store, "GapCheck.IRepo.set_Item")
            AssertExplicitAccessorAttributes(explicitSetter.Attributes)
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func ExplicitIndexerImpl_DispatchesThroughInterface_GetAndSet() {
        // This test verifies the MethodImpl bridge dispatches correctly at
        // the CLR level, invoking the explicit accessor's own mangled
        // method directly via reflection. See
        // ExplicitIndexerImpl_DispatchesThroughInterfaceTypedReceiver_GetAndSet
        // below for the follow-up fix that also proves dispatch through a
        // REAL interface-typed receiver (`asIface["k"]`), which used to fail
        // for ANY indexer (explicit or not) since interfaces previously
        // could not even declare an indexer contract, and is now fixed
        // generally in ExpressionBinder.Access.cs.
        let assembly = CompileToAssembly(IndexerReproSource)
        let storeType = assembly.GetTypes().Single((t Type) -> t.Name == "Store")
        let instance = Activator.CreateInstance(storeType)!!
        let publicGetter = storeType.GetMethod("get_Item")!!
        let explicitGetter = storeType.GetMethod(
            "GapCheck.IRepo.get_Item",
            BindingFlags.NonPublic | BindingFlags.Instance
        )!!
        Assert.Equal(1, publicGetter.Invoke(instance, []object{"k"}))
        Assert.Equal(2, explicitGetter.Invoke(instance, []object{"k"}))
    }

    @Fact
    func TwoExplicitIndexersSameSignatureDifferentInterfaces_CoexistAndDispatchIndependently() {
        let dllPath = CompileLibrary(MultiInterfaceIndexerReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let store = FindType(reader, "Store")
            Assert.Equal(1, CountMethodsNamed(reader, store, "GapCheck.IRepoA.get_Item"))
            Assert.Equal(1, CountMethodsNamed(reader, store, "GapCheck.IRepoB.get_Item"))
            // get+set per interface => 4 MethodImpl rows total.
            Assert.Equal(4, CountMethodImplRows(reader, store))
        } finally {
            TryCleanup(dllPath)
        }
        // See the NOTE on ExplicitIndexerImpl_DispatchesThroughInterface_GetAndSet
        // above: interface-typed indexer *access syntax* is a separate,
        // pre-existing gap, so dispatch is verified via reflection here too.
        let assembly = CompileToAssembly(MultiInterfaceIndexerReproSource)
        let storeType = assembly.GetTypes().Single((t Type) -> t.Name == "Store")
        let instance = Activator.CreateInstance(storeType)!!
        let aGetter = storeType.GetMethod("GapCheck.IRepoA.get_Item", BindingFlags.NonPublic | BindingFlags.Instance)!!
        let bGetter = storeType.GetMethod("GapCheck.IRepoB.get_Item", BindingFlags.NonPublic | BindingFlags.Instance)!!
        Assert.Equal(1, aGetter.Invoke(instance, []object{"k"}))
        Assert.Equal(2, bGetter.Invoke(instance, []object{"k"}))
    }

    @Fact
    func TwoExplicitEventsSameNameDifferentInterfaces_CoexistWithFourMethodImplRows() {
        let dllPath = CompileLibrary(MultiInterfaceEventReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let both = FindType(reader, "Both")
            Assert.Equal(1, CountMethodsNamed(reader, both, "GapCheck.IFoo.add_Bar"))
            Assert.Equal(1, CountMethodsNamed(reader, both, "GapCheck.IBaz.add_Bar"))
            // add + remove per interface => 4 MethodImpl rows total.
            Assert.Equal(4, CountMethodImplRows(reader, both))
        } finally {
            TryCleanup(dllPath)
        }
    }

    @Fact
    func GenericInterfaceExplicitEventAndIndexer_Compile_IlVerify() {
        let dllPath = CompileLibrary(GenericInterfaceEventAndIndexerReproSource)
        try {
            using let stream = File.OpenRead(dllPath)
            using let peReader = PEReader(stream)
            let reader = peReader.GetMetadataReader()
            let intObservable = FindType(reader, "IntObservable")
            Assert.Equal(1, CountMethodsNamed(reader, intObservable, "GapCheck.IWatchable[int32].add_Changed"))
            Assert.Equal(1, CountMethodsNamed(reader, intObservable, "GapCheck.IWatchable[int32].get_Item"))
            // add + remove (event) + get (indexer) => 3 MethodImpl rows.
            Assert.Equal(3, CountMethodImplRows(reader, intObservable))
        } finally {
            TryCleanup(dllPath)
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
    @Fact
    func PlainNonExplicitIndexer_DispatchesThroughInterfaceTypedReceiver() {
        const source = `package GapCheck

interface IRepo {
    prop this[key string] int32 { get; set }
}

class Store : IRepo {
    prop this[key string] int32 { get { return 1 } set { } }
}

var store = Store()
var asIface IRepo = store
asIface["key"] = 99
public var result = asIface["key"]`
        Assert.Equal(1, RunAndGetIntResult(source))
    }

    @Fact
    func ExplicitIndexerImpl_DispatchesThroughInterfaceTypedReceiver_GetAndSet() {
        let source = IndexerReproSource + `
var store = Store()
var asIface IRepo = store
asIface["k"] = 99
public var result = asIface["k"] + store["k"]`
        // asIface["k"] (interface-typed receiver) must route to the
        // EXPLICIT accessor (returns 2), while store["k"] (concrete-typed
        // receiver) must keep routing to the ordinary plain indexer
        // (returns 1) — proving the two members remain independently
        // addressable and the new receiver dispatch reaches the correct
        // (explicit) slot rather than falling back to the plain one.
        Assert.Equal(3, RunAndGetIntResult(source))
    }

    @Fact
    func OrdinaryEventImpl_DispatchesThroughInterfaceTypedReceiver_AddAndRemove() {
        const source = `package GapCheck

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
public var result = sink.Hits`
        Assert.Equal(2, RunAndGetIntResult(source))
    }

    @Fact
    func ExplicitEventImpl_DispatchesThroughInterfaceTypedReceiver_AddAndRemove() {
        const source = `package GapCheck

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
public var result = sink.Hits`
        // Subscribing via the interface-typed receiver must reach the
        // EXPLICIT accessor's own backing field, so only the two
        // FireExplicit() calls count; FirePublic() raises the unrelated
        // plain field-like event and must not invoke the same handler.
        Assert.Equal(2, RunAndGetIntResult(source))
    }

    @Fact
    func OrdinaryGenericInterfaceIndexer_DispatchesThroughInterfaceTypedReceiver() {
        const source = `package GapCheck

interface IWatchable[T] {
    prop this[index int32] T { get; }
}

class IntObservable : IWatchable[int32] {
    prop this[index int32] int32 -> index * 2
}

var obs = IntObservable()
var asIface IWatchable[int32] = obs
public var result = asIface[5]`
        Assert.Equal(10, RunAndGetIntResult(source))
    }

    @Fact
    func ExplicitGenericInterfaceIndexer_DispatchesThroughInterfaceTypedReceiver() {
        let source = GenericInterfaceEventAndIndexerReproSource + `
var obs = IntObservable()
var asIface IWatchable[int32] = obs
public var result = asIface[5]`
        Assert.Equal(10, RunAndGetIntResult(source))
    }

    @Fact
    func OrdinaryGenericInterfaceEvent_DispatchesThroughInterfaceTypedReceiver() {
        const source = `package GapCheck

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
public var result = sink.Hits`
        Assert.Equal(1, RunAndGetIntResult(source))
    }

    @Fact
    func ExplicitGenericInterfaceEvent_DispatchesThroughInterfaceTypedReceiver() {
        const source = `package GapCheck

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
public var result = sink.Hits`
        // Exercises the new generic-interface accessor token resolution
        // path in MethodBodyEmitter.Closures.cs's EmitUserEventSubscription
        // (constructed generic interface receiver, explicit member).
        Assert.Equal(2, RunAndGetIntResult(source))
    }

    @Fact
    func ImportedBclInterfaceIndexer_DispatchesThroughInterfaceTypedReceiver() {
        // Proves the fix also covers IMPORTED (BCL) interfaces, not just
        // G#-declared ones: InterfaceSymbol is the single, sealed
        // representation used for both source-declared and imported
        // interfaces, so List[int32]'s IList[int32].this[int32] contract
        // is reachable through an IList[int32]-typed receiver.
        const source = `package GapCheck
import System.Collections.Generic

var xs = List[int32]()
xs.Add(10)
xs.Add(20)
var asIface IList[int32] = xs
asIface[0] = 99
public var result = asIface[0] + asIface[1]`
        Assert.Equal(119, RunAndGetIntResult(source))
    }

    shared {
        private const EventReproSource string = `package GapCheck

interface ICounter {
    event Changed () -> void
}

open class Counter : ICounter {
    open event Changed () -> void { add { } remove { } }

    private event (ICounter) Changed () -> void { add { } remove { } }
}`

        private func AssertExplicitAccessorAttributes(attrs MethodAttributes) {
            Assert.True((attrs & MethodAttributes.Private) != 0, "explicit accessor must be private")
            Assert.True((attrs & MethodAttributes.Virtual) != 0, "explicit accessor must be virtual")
            Assert.True((attrs & MethodAttributes.NewSlot) != 0, "explicit accessor must be newslot")
            Assert.True((attrs & MethodAttributes.Final) != 0, "explicit accessor must be final")
            Assert.True((attrs & MethodAttributes.Public) == 0, "explicit accessor must not be public")
        }

        private const EventDispatchReproSource string = `package GapCheck

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
}`

        private func CaptureConsoleOut(action() -> void) string {
            let prevOut = Console.Out
            using let writer = StringWriter()
            Console.SetOut(writer)
            try {
                action()
            } finally {
                Console.SetOut(prevOut)
            }
            return writer.ToString().ReplaceLineEndings(Environment.NewLine)
        }

        private const IndexerReproSource string = `package GapCheck

interface IRepo {
    prop this[key string] int32 { get; set }
}

class Store : IRepo {
    prop this[key string] int32 { get { return 1 } set { } }

    private prop (IRepo) this[key string] int32 {
        get { return 2 }
        set { }
    }
}`

        private const MultiInterfaceIndexerReproSource string = `package GapCheck

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
}`

        private const MultiInterfaceEventReproSource string = `package GapCheck

interface IFoo {
    event Bar () -> void
}

interface IBaz {
    event Bar () -> void
}

class Both : IFoo, IBaz {
    private event (IFoo) Bar () -> void { add { } remove { } }

    private event (IBaz) Bar () -> void { add { } remove { } }
}`

        private const GenericInterfaceEventAndIndexerReproSource string = `package GapCheck

interface IWatchable[T] {
    event Changed () -> void
    prop this[index int32] T { get; }
}

class IntObservable : IWatchable[int32] {
    private event (IWatchable[int32]) Changed () -> void { add { } remove { } }

    private prop (IWatchable[int32]) this[index int32] int32 -> index * 2
}`

        private func CompileToAssemblyExe(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2370_exe_asm_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }

        private func RunAndGetIntResult(source string) int32 {
            let assembly = CompileToAssemblyExe(source)
            let program = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let entry MethodInfo? = program.GetMethod(
                "<Main>$$",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            let resultField FieldInfo? = program.GetField("result", BindingFlags.Public | BindingFlags.Static)
            entry!!.Invoke(
                nil,
                if entry!!.GetParameters().Length == 0 {
                    default([]?object)
                } else {
                    []object{Array.Empty[string]()}
                }
            )
            return int32(resultField!!.GetValue(nil)!!)
        }

        private func FindType(reader MetadataReader, name string) TypeDefinition {
            for typeHandle in reader.TypeDefinitions {
                let td = reader.GetTypeDefinition(typeHandle)
                if reader.GetString(td.Name) == name {
                    return td
                }
            }
            throw InvalidOperationException("expected to find the $name type")
        }

        private func CountMethodsNamed(reader MetadataReader, type TypeDefinition, name string) int32 {
            var count = 0
            for mh in type.GetMethods() {
                let md = reader.GetMethodDefinition(mh)
                if reader.GetString(md.Name) == name {
                    count++
                }
            }
            return count
        }

        private func GetMethod(reader MetadataReader, type TypeDefinition, name string) MethodDefinition {
            for mh in type.GetMethods() {
                let md = reader.GetMethodDefinition(mh)
                if reader.GetString(md.Name) == name {
                    return md
                }
            }
            throw InvalidOperationException("expected to find method $name")
        }

        private func CountMethodImplRows(reader MetadataReader, type TypeDefinition) int32 {
            var count = 0
            for miHandle in type.GetMethodImplementations() {
                reader.GetMethodImplementation(miHandle)
                count++
            }
            return count
        }

        private func CompileToAssembly(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2370_asm_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
            IlVerifier.Verify(outPath)
            return EmittedFixture.Load(outPath)
        }

        private func CompileLibrary(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2370_lib_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            let args = []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
            using let stdoutWriter = StringWriter()
            using let stderrWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(stdoutWriter)
            Console.SetError(stderrWriter)
            var compileExit int32
            try {
                compileExit = Program.Main(args)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue2370_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }

        private func TryCleanup(dllPath string) {
            try {
                let dir string? = Path.GetDirectoryName(dllPath)
                if dir != nil && Directory.Exists(dir) {
                    Directory.Delete(dir, recursive: true)
                }
            } catch { }
        }
    }
}
