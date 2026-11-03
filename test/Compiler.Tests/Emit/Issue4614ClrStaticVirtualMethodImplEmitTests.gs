// <copyright file="Issue4614ClrStaticVirtualMethodImplEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Text
import Xunit

/// Issue #4614: a G# type implementing an imported CLR interface's static
/// abstract / static virtual members gets `MethodImpl` rows binding each
/// slot to its static member, as csc emits them.
/// @remarks <b>The defect.</b> The CLR never binds a static-virtual slot by name,
/// and gsc emitted `MethodImpl` rows for the static-virtual slots of
/// G#-declared interfaces only. For every imported interface the slots were
/// left unbound: a direct implementer (`struct SD : IS`) failed to load
/// (`TypeLoadException`), a defaulted static virtual silently kept the
/// interface's default, and a type re-listing such an interface over an
/// imported base that already implements it (`class DZ : BaseS, IS2`)
/// silently ran the base's member. The inherited shape the issue reports is
/// the one that failed silently; the gap covered every imported slot.
///
/// <b>The fix.</b> `InterfaceImplEmitter.EmitClrStaticVirtualMethodImpls`
/// binds every static-virtual method, property-accessor and event-accessor slot of the
/// type's imported interface closure (the same `ClrInterfaceClosure` its
/// `InterfaceImpl` rows come from, #4601) to the type's own static
/// member of the same name and signature. A slot the type does not implement
/// gets no row, so an imported base's implementation or the slot's default
/// still applies.
///
/// <b>Discrimination witness (ADR-0154).</b> Reverting
/// `src/Core/CodeAnalysis/Emit/InterfaceImplEmitter.cs` to its parent
/// state fails every `StaticVirtualSlot_BindsToTheStaticMember` row
/// (a `TypeLoadException`, or the base's / default's value) and leaves
/// every `AGreenNeighbour_KeepsItsBinding` row passing.
open class Issue4614ClrStaticVirtualMethodImplEmitTests {
    /// Each static-virtual slot binds to the type's own static member.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("UnboundSlotCases")
    func StaticVirtualSlot_BindsToTheStaticMember(
        name string,
        source string,
        expectedLines[]string
    ) -> CompileVerifyAndRun(name, source, expectedLines)

    /// Explicit-clause members never satisfy another interface's slot by name.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("ExplicitClauseCases")
    func ExplicitClauseMember_IsNotAnImplicitImplementation(
        name string,
        source string,
        expectedLines[]string
    ) -> CompileVerifyAndRun(name, source, expectedLines)

    /// A type that declares only an explicit-clause member for another
    /// interface does not implement this one: the binder reports the missing
    /// static-virtual implementation (GS0331), because it applies the same
    /// implicit-candidate rule the emitter does. Before, the explicit member
    /// was silently bound to this interface's slot.
    @Fact
    func ExplicitClauseMemberOnly_ReportsTheMissingImplementation() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4614_missing_").FullName
        try {
            let appPath = Path.Combine(tempDir, "missing.dll")
            let log = Compile(tempDir, "App.gs", `package P
import System

interface IA {
    shared {
        func Z() int32;
    }
}
interface IB {
    shared {
        func Z() int32;
    }
}
struct W : IA, IB {
    shared {
        func (IB) Z() int32 { return 4 }
    }
}

Console.WriteLine("ran")`, appPath, "/target:exe")
            Assert.Contains("GS0331", log, StringComparison.Ordinal)
            Assert.Contains("'IA", log, StringComparison.Ordinal)
            Assert.DoesNotContain("'IB", log, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Shapes without a member keep their inherited or default binding.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("GreenNeighbours")
    func AGreenNeighbour_KeepsItsBinding(name string, source string, expectedLines[]string) -> CompileVerifyAndRun(
        name,
        source,
        expectedLines
    )

    /// Issue #4620: static members inherited from a G# base class bind to
    /// static-virtual interface slots through a synthesized private static
    /// bridge on the derived class.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("InheritedFromGSharpBaseCases")
    func InheritedStaticMember_FromGSharpBaseClass_BindsThroughBridge(
        name string,
        source string,
        expectedLines[]string
    ) -> CompileVerifyAndRun(name, source, expectedLines)

    /// Issue #4626: symbolic CLR interface signature matching handles async
    /// `Task<T>` / `ValueTask<T>` / `IAsyncEnumerable<T>` returns, tuple
    /// positions (including 8+ elements and open generic `NativeRows[T]`),
    /// function/delegate types, pointers, nested `Nullable<V>`, and `map`/`sequence`
    /// across instance, explicit, and static-virtual slots.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines.
    @Theory
    @MemberData("SymbolicSignatureMatcherCases")
    func SymbolicSignatureMatcher_BindsAndExecutes(
        name string,
        source string,
        expectedLines[]string
    ) -> CompileVerifyAndRun(name, source, expectedLines)

    /// Issue #4626: a non-vector rank-1 array (`T[*]`) in a CLR interface slot
    /// does not match a G# slice (`[]Shape`) candidate in parameter, return, or
    /// nested generic positions.
    @Fact
    func NonVectorRankOneArraySlot_DoesNotMatchSliceCandidate() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4626_nonsz_").FullName
        try {
            let libPath = Path.Combine(tempDir, "NonSzLib.dll")
            let metadata = MetadataBuilder()
            metadata.AddModule(
                0,
                metadata.GetOrAddString("NonSzLib.dll"),
                metadata.GetOrAddGuid(Guid.NewGuid()),
                GuidHandle(),
                GuidHandle()
            )
            metadata.AddAssembly(
                metadata.GetOrAddString("NonSzLib"),
                Version(1, 0, 0, 0),
                StringHandle(),
                BlobHandle(),
                cast[AssemblyFlags](0),
                AssemblyHashAlgorithm.None
            )
            metadata.AddTypeDefinition(
                cast[TypeAttributes](0),
                StringHandle(),
                metadata.GetOrAddString("<Module>"),
                EntityHandle(),
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )
            let ifaceHandle = metadata.AddTypeDefinition(
                TypeAttributes.Public | TypeAttributes.Interface | TypeAttributes.Abstract,
                metadata.GetOrAddString("NonSzLib"),
                metadata.GetOrAddString("INonSz`1"),
                EntityHandle(),
                MetadataTokens.FieldDefinitionHandle(1),
                MetadataTokens.MethodDefinitionHandle(1)
            )
            metadata.AddGenericParameter(ifaceHandle, GenericParameterAttributes.None, metadata.GetOrAddString("T"), 0)
            let encodeRankOneNonSzArray = (typeEncoder SignatureTypeEncoder) -> {
                typeEncoder.Array(
                    (element SignatureTypeEncoder) -> element.GenericTypeParameter(0),
                    (shape ArrayShapeEncoder) -> shape.Shape(
                        1,
                        ImmutableArray[int32].Empty,
                        ImmutableArray[int32].Empty
                    )
                )
            }
            let instanceSig = BlobBuilder()
            BlobEncoder(instanceSig).MethodSignature(isInstanceMethod: true).Parameters(
                1,
                (ret ReturnTypeEncoder) -> ret.Type().Int32(),
                (pars ParametersEncoder) -> encodeRankOneNonSzArray(pars.AddParameter().Type())
            )
            metadata.AddMethodDefinition(
                MethodAttributes.Public | MethodAttributes.Abstract | MethodAttributes.Virtual | MethodAttributes.HideBySig | MethodAttributes.NewSlot,
                MethodImplAttributes.IL,
                metadata.GetOrAddString("M"),
                metadata.GetOrAddBlob(instanceSig),
                -1,
                MetadataTokens.ParameterHandle(1)
            )
            let returnSig = BlobBuilder()
            BlobEncoder(returnSig).MethodSignature(isInstanceMethod: true).Parameters(
                0,
                (ret ReturnTypeEncoder) -> encodeRankOneNonSzArray(ret.Type()),
                (pars ParametersEncoder) -> { }
            )
            metadata.AddMethodDefinition(
                MethodAttributes.Public | MethodAttributes.Abstract | MethodAttributes.Virtual | MethodAttributes.HideBySig | MethodAttributes.NewSlot,
                MethodImplAttributes.IL,
                metadata.GetOrAddString("R"),
                metadata.GetOrAddBlob(returnSig),
                -1,
                MetadataTokens.ParameterHandle(1)
            )
            let staticSig = BlobBuilder()
            BlobEncoder(staticSig).MethodSignature(isInstanceMethod: false).Parameters(
                1,
                (ret ReturnTypeEncoder) -> ret.Type().Int32(),
                (pars ParametersEncoder) -> encodeRankOneNonSzArray(pars.AddParameter().Type())
            )
            metadata.AddMethodDefinition(
                MethodAttributes.Public | MethodAttributes.Static | MethodAttributes.Abstract | MethodAttributes.Virtual | MethodAttributes.HideBySig,
                MethodImplAttributes.IL,
                metadata.GetOrAddString("MS"),
                metadata.GetOrAddBlob(staticSig),
                -1,
                MetadataTokens.ParameterHandle(1)
            )
            let encodeNestedRankOneNonSzArray = (typeEncoder SignatureTypeEncoder) -> {
                typeEncoder.Array(
                    (outer SignatureTypeEncoder) -> encodeRankOneNonSzArray(outer),
                    (shape ArrayShapeEncoder) -> shape.Shape(
                        1,
                        ImmutableArray[int32].Empty,
                        ImmutableArray[int32].Empty
                    )
                )
            }
            let nestedInstanceSig = BlobBuilder()
            BlobEncoder(nestedInstanceSig).MethodSignature(isInstanceMethod: true).Parameters(
                1,
                (ret ReturnTypeEncoder) -> ret.Type().Int32(),
                (pars ParametersEncoder) -> encodeNestedRankOneNonSzArray(pars.AddParameter().Type())
            )
            metadata.AddMethodDefinition(
                MethodAttributes.Public | MethodAttributes.Abstract | MethodAttributes.Virtual | MethodAttributes.HideBySig | MethodAttributes.NewSlot,
                MethodImplAttributes.IL,
                metadata.GetOrAddString("MNested"),
                metadata.GetOrAddBlob(nestedInstanceSig),
                -1,
                MetadataTokens.ParameterHandle(1)
            )
            let nestedReturnSig = BlobBuilder()
            BlobEncoder(nestedReturnSig).MethodSignature(isInstanceMethod: true).Parameters(
                0,
                (ret ReturnTypeEncoder) -> encodeNestedRankOneNonSzArray(ret.Type()),
                (pars ParametersEncoder) -> { }
            )
            metadata.AddMethodDefinition(
                MethodAttributes.Public | MethodAttributes.Abstract | MethodAttributes.Virtual | MethodAttributes.HideBySig | MethodAttributes.NewSlot,
                MethodImplAttributes.IL,
                metadata.GetOrAddString("RNested"),
                metadata.GetOrAddBlob(nestedReturnSig),
                -1,
                MetadataTokens.ParameterHandle(1)
            )
            let peBlob = BlobBuilder()
            ManagedPEBuilder(
                PEHeaderBuilder.CreateLibraryHeader(),
                MetadataRootBuilder(metadata),
                BlobBuilder()
            ).Serialize(peBlob)
            File.WriteAllBytes(libPath, peBlob.ToArray())

            let appPath = Path.Combine(tempDir, "App.dll")
            let log = Compile(tempDir, "App.gs", `package P
import System
import NonSzLib

class Shape { }
class BadNonSz : INonSz[Shape] {
    func M(xs []Shape) int32 { return xs.Length }
    func R() []Shape { return []Shape{} }
    shared {
        func MS(xs []Shape) int32 { return xs.Length }
    }
}
Console.WriteLine("x")`, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(
                File.Exists(appPath),
                "Non-vector rank-1 array mismatch must not emit an assembly. Log:\n" + log
            )
            Assert.Contains("error GS0187:", log, StringComparison.Ordinal)
            Assert.Contains("INonSz[Shape].M", log, StringComparison.Ordinal)
            Assert.Contains("INonSz[Shape].R", log, StringComparison.Ordinal)
            Assert.Contains("error GS0331:", log, StringComparison.Ordinal)

            let mismatchPath = Path.Combine(tempDir, "Mismatch.dll")
            let mismatchLog = Compile(tempDir, "Mismatch.gs", `package P
import System
import NonSzLib

func Check(x INonSz[Tuple[int32, int32]], y INonSz[Tuple[string, string]]) int32 {
    let ok = x.M(x.R())
    return ok + x.M(y.R())
}
Console.WriteLine("x")`, mismatchPath, "/target:exe", "/reference:" + libPath)
            Assert.False(
                File.Exists(mismatchPath),
                "Projected rank-1 non-SZ arrays with different element types must not unify. Log:\n" + mismatchLog
            )
            Assert.Contains(" error GS", mismatchLog, StringComparison.Ordinal)

            let nullableMismatchPath = Path.Combine(tempDir, "NullableMismatch.dll")
            let nullableMismatchLog = Compile(tempDir, "NullableMismatch.gs", `package P
import System
import NonSzLib

func CheckNullable(x INonSz[int32?], y INonSz[int32]) int32 {
    let ok = x.M(x.R())
    return ok + x.M(y.R())
}
Console.WriteLine("x")`, nullableMismatchPath, "/target:exe", "/reference:" + libPath)
            Assert.False(
                File.Exists(nullableMismatchPath),
                "Projected rank-1 non-SZ array over int32? must not unify with int32[*]. Log:\n" + nullableMismatchLog
            )
            Assert.Contains(" error GS", nullableMismatchLog, StringComparison.Ordinal)

            let userMismatchPath = Path.Combine(tempDir, "UserMismatch.dll")
            let userMismatchLog = Compile(tempDir, "UserMismatch.gs", `package P
import System
import NonSzLib

class ShapeA { }
class ShapeB { }
func CheckUser(x INonSz[ShapeA], y INonSz[ShapeB]) int32 {
    let ok = x.M(x.R())
    return ok + x.M(y.R())
}
Console.WriteLine("x")`, userMismatchPath, "/target:exe", "/reference:" + libPath)
            Assert.False(
                File.Exists(userMismatchPath),
                "Projected rank-1 non-SZ arrays over distinct user types must not convert. Log:\n" + userMismatchLog
            )
            Assert.Contains(" error GS", userMismatchLog, StringComparison.Ordinal)

            let sliceMismatchPath = Path.Combine(tempDir, "SliceMismatch.dll")
            let sliceMismatchLog = Compile(tempDir, "SliceMismatch.gs", `package P
import System
import NonSzLib

func CheckSlice(x INonSz[int32]) []int32 {
    return x.R()
}
Console.WriteLine("x")`, sliceMismatchPath, "/target:exe", "/reference:" + libPath)
            Assert.False(
                File.Exists(sliceMismatchPath),
                "Projected rank-1 non-SZ array must not convert to a G# slice. Log:\n" + sliceMismatchLog
            )
            Assert.Contains(" error GS", sliceMismatchLog, StringComparison.Ordinal)

            let nestedUserMismatchPath = Path.Combine(tempDir, "NestedUserMismatch.dll")
            let nestedUserMismatchLog = Compile(tempDir, "NestedUserMismatch.gs", `package P
import System
import NonSzLib

class ShapeA { }
class ShapeB { }
func CheckNestedUser(x INonSz[ShapeA], y INonSz[ShapeB]) int32 {
    let ok = x.MNested(x.RNested())
    return ok + x.MNested(y.RNested())
}
Console.WriteLine("x")`, nestedUserMismatchPath, "/target:exe", "/reference:" + libPath)
            Assert.False(
                File.Exists(nestedUserMismatchPath),
                "Nested rank-1 non-SZ arrays T[*][*] over distinct user types must not convert. Log:\n" +
                    nestedUserMismatchLog
            )
            Assert.Contains(" error GS", nestedUserMismatchLog, StringComparison.Ordinal)

            let listUserMismatchPath = Path.Combine(tempDir, "ListUserMismatch.dll")
            let listUserMismatchLog = Compile(tempDir, "ListUserMismatch.gs", `package P
import System
import System.Collections.Generic
import NonSzLib

class ShapeA { }
class ShapeB { }
func CheckListUser(x INonSz[ShapeA], y INonSz[ShapeB]) int32 {
    var xs = List(){x.R()}
    xs = List(){y.R()}
    return xs.Count
}
Console.WriteLine("x")`, listUserMismatchPath, "/target:exe", "/reference:" + libPath)
            Assert.False(
                File.Exists(listUserMismatchPath),
                "List<T[*]> over distinct user types must not convert. Log:\n" + listUserMismatchLog
            )
            Assert.Contains(" error GS", listUserMismatchLog, StringComparison.Ordinal)

            let validPath = Path.Combine(tempDir, "ValidNonSz.dll")
            let validLog = Compile(tempDir, "ValidNonSz.gs", `package P
import System
import NonSzLib

public class Shape { }
public func Forward(x INonSz[Shape]) int32 {
    let arr = x.R()
    return x.M(arr)
}
public func ForwardNested(x INonSz[Shape]) int32 {
    let arr = x.RNested()
    return x.MNested(arr)
}
public func ForwardNullable(x INonSz[int32?]) int32 {
    let arr = x.R()
    return x.M(arr)
}
Console.WriteLine("ok")`, validPath, "/target:exe", "/reference:" + libPath)
            Assert.DoesNotContain(" error ", validLog, StringComparison.Ordinal)
            Assert.True(
                File.Exists(validPath),
                "Valid rank-1 non-SZ array local and call must compile. Log:\n" + validLog
            )
            IlVerifier.Verify(validPath, []string{libPath})
            let (exit, output) = RunDotnet(validPath)
            Assert.True(exit == 0, "ValidNonSz must run. Output:\n" + output)
            Assert.Equal("ok", output.Trim())
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    /// Issue #4618: a missing or mismatched implementation of an imported
    /// interface's static abstract member is diagnosed at compile time.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedDiagnosticId The expected diagnostic ID.
    /// @param expectedFragment A substring expected in the diagnostic message.
    @Theory
    @MemberData("MissingOrMismatchedClrStaticCases")
    func MissingOrMismatchedClrStaticSlot_ReportsDiagnostic(
        name string,
        source string,
        expectedDiagnosticId string,
        expectedFragment string
    ) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4618_").FullName
        try {
            let libPath = CompileCSharpLibrary(tempDir)
            let appPath = Path.Combine(tempDir, name + ".dll")
            let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
            Assert.False(File.Exists(appPath), (`'` + "$name" + `' must not emit an assembly. Log:
` + "$log"))
            Assert.Contains("error " + expectedDiagnosticId + ":", log, StringComparison.Ordinal)
            Assert.Contains(expectedFragment, log, StringComparison.Ordinal)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const RunTimeout int32 = 60_000

        private const LibrarySource string = `namespace Clib;

public interface IS { static abstract int Z(); }
public interface IS2 : IS { }
public class BaseS : IS { public static int Z() => 1; }

public interface ISV { static virtual int V() => 100; }
public interface ISV2 : ISV { }

public interface IP { static abstract int P { get; } }
public interface IP2 : IP { }
public interface IPV { static virtual int P { get => 1; set { } } }
public interface IPS { static abstract int Q { get; set; } }

public interface IGen { static abstract int Count<U>(U u); }

public interface IH<T> { static abstract int H(T x); }
public interface IH2<T> : IH<T> { }

public interface IEv { static abstract event System.Action Changed; }
public interface IEv2 : IEv { }

public interface IM2<T> { static abstract int M<U>(T x, U y); }
public interface IInst<T> { int N<U>(T x, U y); }
public interface IMA<T> { static abstract int M<U>(U[] us, T x); }
public interface IArr<T> { int A(T[] xs); int B<U>(U[] us, T x); }
public interface IDefaultedByDerived : IS { static int IS.Z() => 100; }
public interface ILeft : IS { static int IS.Z() => 10; }
public interface IRight : IS { static int IS.Z() => 20; }
public interface IDefaultedGeneric<T> : IH<T> { static int IH<T>.H(T x) => 200; }
public interface IGenOverload { static abstract int Pick<T, U>(T x); static abstract int Pick<T, U>(U x); }
public interface IDefaultedFirstOverload : IGenOverload { static int IGenOverload.Pick<T, U>(T x) => 300; }
public class MultiConstraint<T, U> where T : System.IComparable<T>, System.IComparable<U> { public static int Touch(T? x) => 0; }
public interface IAsync<T> { static abstract System.Threading.Tasks.Task<T> Load(T x); }
public interface IValueAsync<T> { static abstract System.Threading.Tasks.ValueTask<T> Load(T x); }
public interface IAsyncTask { static abstract System.Threading.Tasks.Task Run(); }
public interface IOp { static abstract int operator +(IOp a, int b); }
public unsafe interface IFnPtrOverload<T> {
    static abstract int Call(delegate*<int, int> p, T x);
    static abstract int Call(delegate* unmanaged[Cdecl]<int, int> p, T x);
    static abstract int Call(delegate* unmanaged[Cdecl, SuppressGCTransition]<int, int> p, T x);
}
public unsafe interface IFnPtrOverloadDefaultedAll<T> : IFnPtrOverload<T> {
    static int IFnPtrOverload<T>.Call(delegate*<int, int> p, T x) => 50;
    static int IFnPtrOverload<T>.Call(delegate* unmanaged[Cdecl]<int, int> p, T x) => 51;
    static int IFnPtrOverload<T>.Call(delegate* unmanaged[Cdecl, SuppressGCTransition]<int, int> p, T x) => 52;
}
public unsafe interface IFnPtrOverloadDefaultedManagedOnly<T> : IFnPtrOverload<T> {
    static int IFnPtrOverload<T>.Call(delegate*<int, int> p, T x) => 50;
}

public interface IAs<T> { System.Threading.Tasks.Task<T> Make(); }
public interface IAsVt<T> { System.Threading.Tasks.ValueTask<T> MakeVt(); }
public interface IFactory<TResult> { TResult Create(); }
public interface ISAs<T> { static abstract System.Threading.Tasks.Task<T> MakeS(); }
public interface ISAsVt<T> { static abstract System.Threading.Tasks.ValueTask<T> MakeSVt(); }
public interface IAsyncStream<T> { System.Collections.Generic.IAsyncEnumerable<T> Stream(T seed); }
public interface ITup<T> {
    int M((T, int) v);
    (T, int) Make(T v);
    (T, U) Pair<U>(T x, (U, int) y);
}
public interface ISTup<T> {
    static abstract (T, int) Pair { get; }
    static abstract int Take((T, int) v);
}
public interface ILongTup<T> {
    int Sum((int, int, int, int, int, int, int, int, T) v);
}
public interface NativeRows<T> where T : class {
    (T Value, int Code) Required(T value);
}
public interface ITupProp<T> {
    (T, int) Current { get; }
    int this[(T, int) key] { get; }
}
public interface ITupFieldProp<T> {
    (T, int) Current { get; }
}
public interface IFn<T> {
    int Apply(System.Func<T, int> f);
    void Run(System.Action<T> a);
    string Combine<U>(T x, U y, System.Func<T, (U, int), string> f);
}
public interface ISFn<T> {
    static abstract int ApplyS(System.Func<T, int> f);
}
public delegate int NominalDel<T>(T x);
public interface INominalDel<T> {
    int Apply(NominalDel<T> f);
}
public unsafe interface IPtr<T> where T : unmanaged {
    int Read(T* p);
    static abstract int ReadS(T* p);
}
public unsafe interface IMixedPtr<T> {
    int Read(T x, int* p);
}
public interface INullableNested<T> {
    int ReadPair((T, int?) v);
}
public interface IMapAndSeq<T> {
    int CountMap(System.Collections.Generic.Dictionary<T, int> m);
    int CountSeq(System.Collections.Generic.IEnumerable<T> s);
    static abstract System.Collections.Generic.Dictionary<T, int> MakeMap(T key, int value);
}
public interface IListConsumer<T> {
    int Consume(System.Collections.Generic.List<T> items);
}
public interface IRefTup<T> {
    int M(System.Tuple<T, int> v);
    int Concrete(System.Tuple<int, int> v);
    static abstract System.Tuple<T, int> MakeS(T x);
}
public interface IRefTupBase<T, U> {
    int M((T, U) v);
}
public interface IRefTupDerived<T> : IRefTupBase<T, System.Tuple<int, int>> { }

public static class Probe
{
    public static int Z<T>() where T : IS => T.Z();
    public static int V<T>() where T : ISV => T.V();
    public static int P<T>() where T : IP => T.P;
    public static int PV<T>() where T : IPV => T.P;
    public static int SetThenGet<T>(int value) where T : IPS { T.Q = value; return T.Q; }
    public static int Count<T>() where T : IGen => T.Count<string>("abc");
    public static void Hook<T>(System.Action a) where T : IEv => T.Changed += a;
    public static int N<T, U>(IInst<T> i, T x, U y) => i.N(x, y);
    public static int A<T>(IArr<T> i, T[] xs) => i.A(xs);
    public static int B<T, U>(IArr<T> i, U[] us, T x) => i.B(us, x);
    public static T Load<T, TImpl>(T x) where TImpl : IAsync<T> => TImpl.Load(x).GetAwaiter().GetResult();
    public static unsafe int CallFnPtrDefault<T, TImpl>(T x) where TImpl : IFnPtrOverload<T> =>
        TImpl.Call((delegate*<int, int>)null, x) + TImpl.Call((delegate* unmanaged[Cdecl]<int, int>)null, x) + TImpl.Call((delegate* unmanaged[Cdecl, SuppressGCTransition]<int, int>)null, x);
    public static T CallMake<T>(IAs<T> i) => i.Make().GetAwaiter().GetResult();
    public static T CallMakeVt<T>(IAsVt<T> i) => i.MakeVt().GetAwaiter().GetResult();
    public static T CallFactoryTask<T>(IFactory<System.Threading.Tasks.Task<T>> f) => f.Create().GetAwaiter().GetResult();
    public static int CallTupM<T>(ITup<T> i, (T, int) v) => i.M(v);
    public static (T, int) CallTupMake<T>(ITup<T> i, T v) => i.Make(v);
    public static (T, U) CallTupPair<T, U>(ITup<T> i, T x, (U, int) y) => i.Pair(x, y);
    public static int CallLongTup<T>(ILongTup<T> i, T x) => i.Sum((1, 2, 3, 4, 5, 6, 7, 8, x));
    public static (T Value, int Code) CallNativeRows<T>(NativeRows<T> r, T v) where T : class => r.Required(v);
    public static (T, int) CallTupPropCurrent<T>(ITupProp<T> p) => p.Current;
    public static int CallTupPropIndex<T>(ITupProp<T> p, (T, int) k) => p[k];
    public static (T, int) CallTupFieldPropCurrent<T>(ITupFieldProp<T> p) => p.Current;
    public static int CallFnApply<T>(IFn<T> i, System.Func<T, int> f) => i.Apply(f);
    public static void CallFnRun<T>(IFn<T> i, System.Action<T> a) => i.Run(a);
    public static string CallFnCombine<T, U>(IFn<T> i, T x, U y, System.Func<T, (U, int), string> f) => i.Combine(x, y, f);
    public static int CallNominalDel<T>(INominalDel<T> i, NominalDel<T> f) => i.Apply(f);
    public static unsafe int CallMixedPtr<T>(IMixedPtr<T> i, T x, int v) => i.Read(x, &v);
    public static int CallNullablePair<T>(INullableNested<T> i, (T, int?) v) => i.ReadPair(v);
    public static int CallMapAndSeq<T, TImpl>(IMapAndSeq<T> i, T key, int val) where TImpl : IMapAndSeq<T> {
        var m = TImpl.MakeMap(key, val);
        return i.CountMap(m) * 100 + i.CountSeq(m.Keys);
    }
    public static int CallRefTup<T, TImpl>(IRefTup<T> i, T x) where TImpl : IRefTup<T> =>
        i.M(TImpl.MakeS(x)) + i.Concrete(System.Tuple.Create(3, 4));
    public static System.Tuple<int, int> MakeRefTupPair(int a, int b) => System.Tuple.Create(a, b);
    public static int CallRefTupDerived<T>(IRefTupDerived<T> i, T x) =>
        i.M((x, MakeRefTupPair(5, 6)));
}`

        /// Shapes that failed to load or bound the wrong member before the fix.
        /// @returns Case name, G# source, expected stdout lines.
        func UnboundSlotCases() sequence[[]object] {
            yield[]object{"direct-struct", `package P
import System
import Clib

struct SD : IS {
    shared {
        func Z() int32 { return 7 }
    }
}

Console.WriteLine(Probe.Z[SD]())`, []string{"7"}}
            yield[]object{"direct-class", `package P
import System
import Clib

class CD : IS {
    shared {
        func Z() int32 { return 8 }
    }
}

Console.WriteLine(Probe.Z[CD]())`, []string{"8"}}
            // The issue's TypeLoadException shape: the slot is inherited through
            // the declared interface's base.
            yield[]object{"inherited-through-a-base-interface", `package P
import System
import Clib

struct SZ : IS2 {
    shared {
        func Z() int32 { return 7 }
    }
}

Console.WriteLine(Probe.Z[SZ]())`, []string{"7"}}
            // The issue's silent shape: the imported base already implements the
            // slot, and the base's member ran instead of the derived one.
            yield[]object{"derived-over-an-imported-base", `package P
import System
import Clib

class DZ : BaseS, IS2 {
    shared {
        func Z() int32 { return 6 }
    }
}

Console.WriteLine(Probe.Z[DZ]())`, []string{"6"}}
            // A defaulted static virtual the type overrides silently kept the
            // interface's default.
            yield[]object{"static-virtual-default-overridden", `package P
import System
import Clib

struct VD : ISV {
    shared {
        func V() int32 { return 5 }
    }
}

Console.WriteLine(Probe.V[VD]())`, []string{"5"}}
            // A static abstract get/set property: both accessors bind (the setter
            // through its own MethodImpl).
            yield[]object{"static-abstract-get-set-property", `package P
import System
import Clib

struct QS : IPS {
    shared {
        var store int32 = 0
        prop Q int32 {
            get { return store }
            set { store = value * 2 }
        }
    }
}

Console.WriteLine(Probe.SetThenGet[QS](21))`, []string{"42"}}
            // A get-only property overrides just the getter of a defaulted get/set
            // static virtual property; csc binds the getter independently too.
            yield[]object{"get-only-override-of-a-defaulted-get-set-property", `package P
import System
import Clib

struct PG : IPV {
    shared {
        prop P int32 { get { return 5 } }
    }
}

Console.WriteLine(Probe.PV[PG]())`, []string{"5"}}
            yield[]object{"generic-static-method-slot", `package P
import System
import Clib

struct GC : IGen {
    shared {
        func Count[U](u U) int32 { return 42 }
    }
}

Console.WriteLine(Probe.Count[GC]())`, []string{"42"}}
            yield[]object{"static-abstract-property", `package P
import System
import Clib

struct PP : IP {
    shared {
        prop P int32 { get { return 9 } }
    }
}
struct PP2 : IP2 {
    shared {
        prop P int32 { get { return 10 } }
    }
}

Console.WriteLine(Probe.P[PP]())
Console.WriteLine(Probe.P[PP2]())`, []string{"9", "10"}}
            // A slot generic at both the interface and the method level, over a G#
            // type: the method-owned `U` is matched against the candidate's own
            // type parameter, never against the interface's `Shape`. The instance
            // counterpart shares the matcher (it reported GS0187 before).
            yield[]object{"symbolic-interface-with-a-generic-method", (`package P
import System
import System.Linq
import Clib

class Shape { }
struct GM : IM2[Shape] {
    shared {
        func M[U](x Shape, y U) int32 { return 77 }
    }
}
class GI : IInst[Shape] {
    func N[U](x Shape, y U) int32 { return 88 }
}

let iface = typeof(GM).GetInterfaces().Where((i Type) -> i.Name == "IM2` + "`" + `1").First()
let target = typeof(GM).GetInterfaceMap(iface).TargetMethods[0].MakeGenericMethod(typeof(string))
Console.WriteLine(target.Invoke(nil, []object?{Shape(), "s"}))
Console.WriteLine(Probe.N[Shape, string](GI(), Shape(), "s"))`), []string{"77", "88"}}
            // Array positions that mention a generic parameter, at the interface
            // level (`T[]`) and the method level (`U[]`), over a G# type: matched
            // element-wise (both reported GS0187 before for the instance shape).
            yield[]object{"symbolic-array-positions", (`package P
import System
import System.Linq
import Clib

class Shape { }
class AR : IArr[Shape] {
    func A(xs []Shape) int32 { return xs.Length }
    func B[U](us []U, x Shape) int32 { return us.Length * 10 }
}
struct MA : IMA[Shape] {
    shared {
        func M[U](us []U, x Shape) int32 { return us.Length * 100 }
    }
}

Console.WriteLine(Probe.A[Shape](AR(), []Shape{Shape(), Shape()}))
Console.WriteLine(Probe.B[Shape, string](AR(), []string{"a", "b", "c"}, Shape()))
let iface = typeof(MA).GetInterfaces().Where((i Type) -> i.Name == "IMA` + "`" + `1").First()
let target = typeof(MA).GetInterfaceMap(iface).TargetMethods[0].MakeGenericMethod(typeof(string))
Console.WriteLine(target.Invoke(nil, []object?{[]string{"a"}, Shape()}))`), []string{"2", "30", "100"}}
            // A static abstract event binds through its accessors: custom accessors
            // through a base interface, and a field-like event directly.
            yield[]object{"static-abstract-event", `package P
import System
import Clib

struct EV : IEv2 {
    shared {
        var hooked int32 = 0
        event Changed Action? {
            add { hooked = hooked + 1 }
            remove { }
        }
    }
}
struct EF : IEv {
    shared {
        event Changed Action?
    }
}

Probe.Hook[EV](() -> {})
Console.WriteLine(EV.hooked)
Probe.Hook[EF](() -> {})
Console.WriteLine("hooked")`, []string{"1", "hooked"}}
            // A generic interface closed over a G# type: the slot's declaration is
            // a MemberRef on the symbolic `IH<Shape>` TypeSpec. Read through the
            // runtime's interface map, which only loads when the slot is bound.
            yield[]object{"symbolic-generic-interface", (`package P
import System
import System.Linq
import Clib

class Shape {
    prop N int32 { get { return 4 } }
}
struct HS : IH[Shape] {
    shared {
        func H(x Shape) int32 { return x.N * 10 }
    }
}
struct HS2 : IH2[Shape] {
    shared {
        func H(x Shape) int32 { return 11 }
    }
}

func Invoke(t Type) object? {
    let iface = t.GetInterfaces().Where((i Type) -> i.Name == "IH` + "`" + `1").First()
    return t.GetInterfaceMap(iface).TargetMethods[0].Invoke(nil, []object?{Shape()})
}

Console.WriteLine(Invoke(typeof(HS)))
Console.WriteLine(Invoke(typeof(HS2)))`), []string{"40", "11"}}
        }

        /// An explicit-interface-clause member (`func (IMine) Z()`) keeps the
        /// plain name `Z` but implements only the interface its clause
        /// names; the name-based match must skip it, whatever the declaration
        /// order. The G#-declared-interface path had the same hole.
        /// @returns Case name, G# source, expected stdout lines.
        func ExplicitClauseCases() sequence[[]object] {
            yield[]object{"explicit-member-of-another-interface-is-not-the-imported-slot", `package P
import System
import Clib

interface IMine {
    shared {
        func Z() int32;
    }
}
struct EX : IS, IMine {
    shared {
        func (IMine) Z() int32 { return 4 }
        func Z() int32 { return 5 }
    }
}

Console.WriteLine(Probe.Z[EX]())`, []string{"5"}}
            yield[]object{"explicit-property-of-another-interface-is-not-the-imported-slot", `package P
import System
import Clib

interface IMineP {
    shared {
        prop P int32 { get }
    }
}
struct EP : IP, IMineP {
    shared {
        prop (IMineP) P int32 { get { return 4 } }
        prop P int32 { get { return 5 } }
    }
}

Console.WriteLine(Probe.P[EP]())`, []string{"5"}}
            // The same rule for two G#-declared interfaces, read through the
            // runtime's interface map.
            yield[]object{"explicit-member-of-another-gsharp-interface", `package P
import System

interface IA {
    shared {
        func Z() int32;
    }
}
interface IB {
    shared {
        func Z() int32;
    }
}
struct W : IA, IB {
    shared {
        func (IB) Z() int32 { return 4 }
        func Z() int32 { return 5 }
    }
}

Console.WriteLine(typeof(W).GetInterfaceMap(typeof(IA)).TargetMethods[0].Invoke(nil, []object?{}))
Console.WriteLine(typeof(W).GetInterfaceMap(typeof(IB)).TargetMethods[0].Invoke(nil, []object?{}))`, []string{"5", "4"}}
        }

        /// Shapes whose binding was already right and must stay so.
        /// @returns Case name, G# source, expected stdout lines.
        func GreenNeighbours() sequence[[]object] {
            // The negative control: no static member, so no row, and the imported
            // base's implementation still applies.
            yield[]object{"no-member-keeps-the-base-implementation", `package P
import System
import Clib

class NoZ : BaseS, IS2 {
}

Console.WriteLine(Probe.Z[NoZ]())`, []string{"1"}}
            // No member for a defaulted static virtual: the default still applies.
            yield[]object{"no-member-keeps-the-default", `package P
import System
import Clib

struct VN : ISV2 {
}

Console.WriteLine(Probe.V[VN]())`, []string{"100"}}
            // A derived CLR interface that supplies an explicit default for an
            // abstract base slot (`static int IS.Z() => 100;`) leaves the slot
            // defaulted for implementers of the derived interface.
            yield[]object{"defaulted-in-derived-clr-interface", `package P
import System
import Clib

struct SDefault : IDefaultedByDerived {
}

Console.WriteLine(Probe.Z[SDefault]())`, []string{"100"}}
            yield[]object{"defaulted-in-symbolic-derived-clr-interface", (`package P
import System
import System.Linq
import Clib

class Shape { }
struct SDefaultSym : IDefaultedGeneric[Shape] {
}

let iface = typeof(SDefaultSym).GetInterfaces().Where((i Type) -> i.Name == "IH` + "`" + `1").First()
Console.WriteLine(typeof(SDefaultSym).GetInterfaceMap(iface).TargetMethods[0].Invoke(nil, []object?{Shape()}))`), []string{
                    "200"
                }}
            yield[]object{"defaulted-function-pointer-overloads-in-derived-clr-interface", `package P
import System
import Clib

struct SFnPtr : IFnPtrOverloadDefaultedAll[int32] {
}

Console.WriteLine(Probe.CallFnPtrDefault[int32, SFnPtr](0))`, []string{"153"}}
        }

        /// Issue #4620: static methods, properties and events inherited from a
        /// G# base class (including generic base classes and multi-hop chains)
        /// bind to static-virtual interface slots via synthesized private static
        /// bridges on the implementing derived class.
        /// @returns Case name, G# source, expected stdout lines.
        func InheritedFromGSharpBaseCases() sequence[[]object] {
            yield[]object{"inherited-static-method-from-gs-base", `package P
import System
import Clib

open class B {
    shared {
        func Z() int32 { return 21 }
    }
}
class D : B, IS {
}
class D2 : B, IS2 {
}

Console.WriteLine(Probe.Z[D]())
Console.WriteLine(Probe.Z[D2]())`, []string{"21", "21"}}
            yield[]object{"inherited-from-generic-gs-base-and-symbolic-interface", (`package P
import System
import System.Linq
import Clib

class Shape {
    prop N int32 { get { return 11 } }
}
open class BGen[T] {
    shared {
        func H(x T) int32 { return 33 }
        func Count[U](u U) int32 { return 44 }
    }
}
class DGen : BGen[Shape], IH2[Shape], IGen {
}

let iface = typeof(DGen).GetInterfaces().Where((i Type) -> i.Name == "IH` + "`" + `1").First()
Console.WriteLine(typeof(DGen).GetInterfaceMap(iface).TargetMethods[0].Invoke(nil, []object?{Shape()}))
Console.WriteLine(Probe.Count[DGen]())`), []string{"33", "44"}}
            yield[]object{"inherited-static-property-and-event-from-gs-base", `package P
import System
import Clib

open class BProp {
    shared {
        var store int32 = 9
        prop P int32 { get { return 19 } }
        prop Q int32 {
            get { return store }
            set { store = value * 3 }
        }
        var hooked int32 = 0
        event Changed Action? {
            add { hooked = hooked + 10 }
            remove { }
        }
    }
}
class DProp : BProp, IP2, IPS, IEv2 {
}

Console.WriteLine(Probe.P[DProp]())
Console.WriteLine(Probe.SetThenGet[DProp](7))
Probe.Hook[DProp](() -> {})
Console.WriteLine(BProp.hooked)`, []string{"19", "21", "10"}}
            yield[]object{"derived-and-mid-level-static-member-precedence", `package P
import System
import Clib

open class B {
    shared {
        func Z() int32 { return 21 }
    }
}
class DOverride : B, IS {
    shared {
        func Z() int32 { return 99 }
    }
}
open class Mid : B {
    shared {
        func Z() int32 { return 55 }
    }
}
class Leaf : Mid, IS2 {
}

Console.WriteLine(Probe.Z[DOverride]())
Console.WriteLine(Probe.Z[Leaf]())`, []string{"99", "55"}}
            yield[]object{"inherited-static-member-for-gsharp-declared-interface", `package P
import System
import Clib

interface IGs {
    shared {
        func Z() int32;
        prop P int32 { get }
    }
}
open class BGs {
    shared {
        func Z() int32 { return 71 }
        prop P int32 { get { return 72 } }
    }
}
class DGs : BGs, IGs {
}

Console.WriteLine(typeof(DGs).GetInterfaceMap(typeof(IGs)).TargetMethods[0].Invoke(nil, []object?{}))
Console.WriteLine(typeof(DGs).GetInterfaceMap(typeof(IGs)).TargetMethods[1].Invoke(nil, []object?{}))`, []string{
                    "71",
                    "72"
                }}
            yield[]object{"inherited-async-static-method-from-generic-gs-base", (`package P
import System
import System.Linq
import System.Threading.Tasks
import Clib

class Shape {
    var Tag int32
}
open class BAsync[T] {
    shared {
        async func Load(x T) T { return x }
    }
}
class DAsync : BAsync[int32], IAsync[int32] {
}
class DAsyncSym : BAsync[Shape], IAsync[Shape] {
}

Console.WriteLine(Probe.Load[int32, DAsync](77))
let iface = typeof(DAsyncSym).GetInterfaces().Where((i Type) -> i.Name == "IAsync` + "`" + `1").First()
let task = cast[Task[Shape]](typeof(DAsyncSym).GetInterfaceMap(iface).TargetMethods[0].Invoke(nil, []object?{Shape{Tag: 88}})!!)
Console.WriteLine(task.GetAwaiter().GetResult().Tag)`), []string{"77", "88"}}
            yield[]object{"inherited-valuetask-async-static-method-from-generic-gs-base", (`package P
import System
import System.Linq
import System.Threading.Tasks
import Clib

class Shape {
    var Tag int32
}
open class BValueAsync[T] {
    shared {
        async func Load(x T) ValueTask[T] { return x }
    }
}
class DValueAsyncSym : BValueAsync[Shape], IValueAsync[Shape] {
}

let iface = typeof(DValueAsyncSym).GetInterfaces().Where((i Type) -> i.Name == "IValueAsync` + "`" + `1").First()
let vt = cast[ValueTask[Shape]](typeof(DValueAsyncSym).GetInterfaceMap(iface).TargetMethods[0].Invoke(nil, []object?{Shape{Tag: 95}})!!)
Console.WriteLine(vt.GetAwaiter().GetResult().Tag)`), []string{"95"}}
            yield[]object{"private-static-on-gs-base-with-unrelated-derived-instance-method", `package P
import System
import Clib

interface IGsPriv {
    shared {
        func Z() int32;
    }
}
open class BGsPriv : IGsPriv {
    shared {
        private func Z() int32 { return 73 }
    }
}
class DGsPriv : BGsPriv, IGsPriv {
    func Z() int32 { return 999 }
}

Console.WriteLine(typeof(DGsPriv).GetInterfaceMap(typeof(IGsPriv)).TargetMethods[0].Invoke(nil, []object?{}))`, []string{
                    "73"
                }}
            yield[]object{"direct-and-inherited-static-abstract-operator", `package P
import System
import Clib

struct SOp : IOp {
    shared {
        func op_Addition(a IOp, b int32) int32 { return b + 7 }
    }
}

open class BOp {
    shared {
        func op_Addition(a IOp, b int32) int32 { return b + 17 }
    }
}

class DOp : BOp, IOp {
}

Console.WriteLine(typeof(SOp).GetInterfaceMap(typeof(IOp)).TargetMethods[0].Invoke(nil, []object?{SOp{}, 10}))
Console.WriteLine(typeof(DOp).GetInterfaceMap(typeof(IOp)).TargetMethods[0].Invoke(nil, []object?{DOp(), 10}))`, []string{
                    "17",
                    "27"
                }}
            yield[]object{"private-static-on-gs-base-that-already-implements-interface", `package P
import System
import Clib

open class BPriv : IS {
    shared {
        private func Z() int32 { return 31 }
    }
}
class DPriv : BPriv, IS {
}
class DPriv2 : BPriv, IS2 {
}

Console.WriteLine(Probe.Z[DPriv]())
Console.WriteLine(Probe.Z[DPriv2]())`, []string{"31", "31"}}
            yield[]object{"generic-static-method-with-renamed-type-parameter-in-slice", `package P
import System
import Clib

interface IGsGenSlice {
    shared {
        func M[T](xs []T) int32;
    }
}
open class BGsGenSlice {
    shared {
        func M[U](xs []U) int32 { return xs.Length }
    }
}
class DGsGenSlice : BGsGenSlice, IGsGenSlice {
}

let m = typeof(DGsGenSlice).GetInterfaceMap(typeof(IGsGenSlice)).TargetMethods[0].MakeGenericMethod(typeof(string))
Console.WriteLine(m.Invoke(nil, []object?{[]string{"a", "b", "c"}}))`, []string{"3"}}
        }

        /// Issue #4618: missing or mismatched implementations of imported
        /// static-abstract members are diagnosed at compile time.
        /// @returns Case name, G# source, expected diagnostic ID, expected message fragment.
        func MissingOrMismatchedClrStaticCases() sequence[[]object] {
            yield[]object{"missing-static-abstract-method", `package P
import System
import Clib

struct SM : IS {
}
Console.WriteLine(Probe.Z[SM]())`, "GS0331", "'Clib.IS.Z'"}
            yield[]object{"missing-inherited-static-abstract-method", `package P
import System
import Clib

struct SM : IS2 {
}
Console.WriteLine(Probe.Z[SM]())`, "GS0331", "'Clib.IS.Z'"}
            yield[]object{"mismatched-return-type-on-static-abstract-method", `package P
import System
import Clib

struct SM : IS {
    shared {
        func Z() int64 { return 1 }
    }
}
Console.WriteLine(Probe.Z[SM]())`, "GS0331", "'Clib.IS.Z'"}
            yield[]object{"instance-method-instead-of-static-abstract-method", `package P
import System
import Clib

struct SM : IS {
    func Z() int32 { return 1 }
}
Console.WriteLine(Probe.Z[SM]())`, "GS0332", "'Clib.IS.Z'"}
            yield[]object{"private-base-static-method-does-not-satisfy-slot", `package P
import System
import Clib

open class B {
    shared {
        private func Z() int32 { return 21 }
    }
}
class D : B, IS {
}
Console.WriteLine(Probe.Z[D]())`, "GS0331", "'Clib.IS.Z'"}
            yield[]object{"missing-symbolic-generic-static-abstract-method", `package P
import System
import Clib

class Shape { }
struct SM : IH2[Shape] {
}
Console.WriteLine("x")`, "GS0331", "'Clib.IH[Shape].H(T)'"}
            yield[]object{"missing-static-abstract-property", `package P
import System
import Clib

struct SM : IP2 {
}
Console.WriteLine(Probe.P[SM]())`, "GS0397", "'Clib.IP.P' (missing static property)"}
            yield[]object{"getter-only-for-get-set-static-abstract-property", `package P
import System
import Clib

struct SM : IPS {
    shared {
        prop Q int32 {
            get { return 1 }
        }
    }
}
Console.WriteLine(Probe.SetThenGet[SM](1))`, "GS0397", "'Clib.IPS.Q' (setter)"}
            yield[]object{"private-base-setter-for-get-set-static-abstract-property", `package P
import System
import Clib

open class B {
    shared {
        prop Q int32 {
            get { return 1 }
            private set { }
        }
    }
}
class D : B, IPS {
}
Console.WriteLine(Probe.SetThenGet[D](1))`, "GS0397", "'Clib.IPS.Q' (setter)"}
            yield[]object{"missing-static-abstract-event", `package P
import System
import Clib

struct SM : IEv2 {
}
Console.WriteLine("x")`, "GS0331", "'Clib.IEv.Changed'"}
            yield[]object{"mismatched-ref-kind-on-gsharp-interface-static-method", `package P
import System
import Clib

interface IGsRef {
    shared {
        func Z(x int32) int32;
    }
}
open class BRef {
    shared {
        func Z(ref x int32) int32 { return x }
    }
}
class DRef : BRef, IGsRef {
}
Console.WriteLine("x")`, "GS0331", "'IGsRef.Z'"}
            yield[]object{"mismatched-return-ref-kind-on-gsharp-interface-static-property", `package P
import System
import Clib

interface IGsPropRef {
    shared {
        prop P int32 { get }
    }
}
open class BPropRef {
    shared {
        var slot int32 = 5
        prop P ref int32 { get { return ref slot } }
    }
}
class DPropRef : BPropRef, IGsPropRef {
}
Console.WriteLine("x")`, "GS0397", "'IGsPropRef.P' (missing static property)"}
            yield[]object{"symbolic-derived-default-does-not-satisfy-distinct-instantiation", `package P
import System
import Clib

class Shape { }
class Other { }
struct S : IDefaultedGeneric[Shape], IH[Other] {
}
Console.WriteLine("x")`, "GS0331", "'Clib.IH[Other].H(T)'"}
            yield[]object{"multi-parameter-derived-default-leaves-second-parameter-abstract", `package P
import System
import Clib

struct S : IDefaultedFirstOverload {
}
let _ = MultiConstraint[int32, int32].Touch(0)
Console.WriteLine("x")`, "GS0331", "'Clib.IGenOverload.Pick(U)'"}
            yield[]object{"missing-static-abstract-operator", `package P
import System
import Clib

struct SM : IOp {
}
Console.WriteLine("x")`, "GS0331", "'Clib.IOp.op_Addition(Clib.IOp, int32)'"}
            yield[]object{"conflicting-sibling-derived-interface-defaults", `package P
import System
import Clib

struct SDiamond : ILeft, IRight {
}
Console.WriteLine("x")`, "GS0331", "'Clib.IS.Z'"}
            yield[]object{"task-async-does-not-satisfy-valuetask-symbolic-slot", `package P
import System
import Clib

class Shape { }
open class BTaskAsync[T] {
    shared {
        async func Load(x T) T { return x }
    }
}
class DWrongAsync : BTaskAsync[Shape], IValueAsync[Shape] {
}
Console.WriteLine("x")`, "GS0331", "'Clib.IValueAsync[Shape].Load(T)'"}
            yield[]object{"async-void-does-not-satisfy-task-slot", `package P
import System
import Clib

struct SAsyncVoid : IAsyncTask {
    shared {
        async func Run() void { }
    }
}
Console.WriteLine("x")`, "GS0331", "'Clib.IAsyncTask.Run"}
            yield[]object{"partial-function-pointer-default-leaves-cdecl-overload-abstract", `package P
import System
import Clib

struct SFnPtrMissing : IFnPtrOverloadDefaultedManagedOnly[int32] {
}
Console.WriteLine("x")`, "GS0331", "'Clib.IFnPtrOverload[int32].Call"}
            yield[]object{"value-nullable-mismatch-in-symbolic-tuple-instance-slot", `package P
import System
import Clib

class Shape { }
class BadTup : ITup[Shape] {
    func M(v (Shape, int32?)) int32 { return 1 }
    func Make(v Shape) (Shape, int32) { return (v, 1) }
    func Pair[U](x Shape, y (U, int32)) (Shape, U) { return (x, y.Item1) }
}
Console.WriteLine("x")`, "GS0187", "'Clib.ITup[Shape].M"}
            yield[]object{"value-nullable-mismatch-in-symbolic-tuple-static-slot", `package P
import System
import Clib

class Shape { }
struct BadSTup : ISTup[Shape] {
    shared {
        prop Pair (Shape, int32) { get { return (Shape(), 1) } }
        func Take(v (Shape, int32?)) int32 { return 1 }
    }
}
Console.WriteLine("x")`, "GS0331", "'Clib.ISTup[Shape].Take"}
            yield[]object{"fixed-array-does-not-satisfy-symbolic-slice-slot", `package P
import System
import Clib

class Shape { }
class BadArr : IArr[Shape] {
    func A(xs [3]Shape) int32 { return 3 }
    func B[U](us []U, x Shape) int32 { return 0 }
}
Console.WriteLine("x")`, "GS0187", "'Clib.IArr[Shape].A"}
            yield[]object{"erased-list-object-does-not-satisfy-symbolic-list-slot", `package P
import System
import System.Collections.Generic
import Clib

class Shape { }
class BadList : IListConsumer[Shape] {
    func Consume(items List[object]) int32 { return items.Count }
}
Console.WriteLine("x")`, "GS0187", "'Clib.IListConsumer[Shape].Consume"}
            yield[]object{"structural-function-type-does-not-satisfy-nominal-delegate-slot", `package P
import System
import Clib

class Shape { }
class BadNominal : INominalDel[Shape] {
    func Apply(f (Shape) -> int32) int32 { return f(Shape()) }
}
Console.WriteLine("x")`, "GS0187", "'Clib.INominalDel[Shape].Apply"}
            yield[]object{"value-tuple-does-not-satisfy-reference-tuple-instance-slot", `package P
import System
import Clib

class Shape { }
class BadRefTup : IRefTup[Shape] {
    func M(v (Shape, int32)) int32 { return 1 }
    func Concrete(v Tuple[int32, int32]) int32 { return 1 }
    shared {
        func MakeS(x Shape) Tuple[Shape, int32] { return Tuple.Create(x, 1) }
    }
}
Console.WriteLine("x")`, "GS0187", "'Clib.IRefTup[Shape].M"}
            yield[]object{"value-tuple-does-not-satisfy-concrete-reference-tuple-slot", `package P
import System
import Clib

class Shape { }
class BadConcreteRefTup : IRefTup[Shape] {
    func M(v Tuple[Shape, int32]) int32 { return 1 }
    func Concrete(v (int32, int32)) int32 { return 1 }
    shared {
        func MakeS(x Shape) Tuple[Shape, int32] { return Tuple.Create(x, 1) }
    }
}
Console.WriteLine("x")`, "GS0187", "'Clib.IRefTup[Shape].Concrete"}
            yield[]object{"value-tuple-does-not-satisfy-reference-tuple-static-slot", `package P
import System
import Clib

class Shape { }
class BadStaticRefTup : IRefTup[Shape] {
    func M(v Tuple[Shape, int32]) int32 { return 1 }
    func Concrete(v Tuple[int32, int32]) int32 { return 1 }
    shared {
        func MakeS(x Shape) (Shape, int32) { return (x, 1) }
    }
}
Console.WriteLine("x")`, "GS0331", "'Clib.IRefTup[Shape].MakeS"}
            yield[]object{"value-tuple-map-does-not-satisfy-reference-tuple-dictionary-slot", `package P
import System
import System.Collections.Generic
import Clib

class BadRefTupMap : IMapAndSeq[Tuple[int32, int32]] {
    func CountMap(m map[(int32, int32), int32]) int32 { return m.Count }
    func CountSeq(s sequence[Tuple[int32, int32]]) int32 { return 0 }
    shared {
        func MakeMap(key Tuple[int32, int32], value int32) map[Tuple[int32, int32], int32] {
            return map[Tuple[int32, int32], int32]{key: value}
        }
    }
}
Console.WriteLine("x")`, "GS0187", "'Clib.IMapAndSeq[System.Tuple[int32, int32]].CountMap"}
            yield[]object{"value-tuple-sequence-does-not-satisfy-reference-tuple-enumerable-slot", `package P
import System
import System.Collections.Generic
import Clib

class BadRefTupSeq : IMapAndSeq[Tuple[int32, int32]] {
    func CountMap(m Dictionary[Tuple[int32, int32], int32]) int32 { return m.Count }
    func CountSeq(s sequence[(int32, int32)]) int32 { return 0 }
    shared {
        func MakeMap(key Tuple[int32, int32], value int32) map[Tuple[int32, int32], int32] {
            return map[Tuple[int32, int32], int32]{key: value}
        }
    }
}
Console.WriteLine("x")`, "GS0187", "'Clib.IMapAndSeq[System.Tuple[int32, int32]].CountSeq"}
            yield[]object{"value-tuple-map-does-not-satisfy-reference-tuple-dictionary-property", `package P
import System
import System.Collections.Generic

interface IRefTupDictProp {
    prop Items Dictionary[Tuple[int32, int32], int32] { get }
}
class BadRefTupDictProp : IRefTupDictProp {
    prop Items map[(int32, int32), int32] { get { return map[(int32, int32), int32]{} } }
}
Console.WriteLine("x")`, "GS0504", "'IRefTupDictProp.Items'"}
            yield[]object{"slice-does-not-satisfy-fixed-array-equatable-slot", `package P
import System

class BadFixedEq : IEquatable[[3]int32] {
    func Equals(other []int32) bool { return true }
}
Console.WriteLine("x")`, "GS0187", "'System.IEquatable[[3]int32].Equals"}
            yield[]object{"wrong-length-fixed-array-does-not-satisfy-fixed-array-equatable-slot", `package P
import System

class BadFixedLenEq : IEquatable[[3]int32] {
    func Equals(other [4]int32) bool { return true }
}
Console.WriteLine("x")`, "GS0187", "'System.IEquatable[[3]int32].Equals"}
            yield[]object{"nested-slice-does-not-satisfy-nested-fixed-array-equatable-slot", `package P
import System
import System.Collections.Generic

class BadNestedFixedEq : IEquatable[List[[3]int32]] {
    func Equals(other List[[]int32]) bool { return true }
}
Console.WriteLine("x")`, "GS0187", "'System.IEquatable[System.Collections.Generic.List[[3]int32]].Equals"}
            yield[]object{"inherited-reference-tuple-slot-rejects-value-tuple", `package P
import System
import Clib

class Shape { }
class BadInheritedRefTup : IRefTupDerived[Shape] {
    func M(v (Shape, (int32, int32))) int32 { return 1 }
}
Console.WriteLine("x")`, "GS0187", "'Clib.IRefTupBase"}
        }

        /// Issue #4626: symbolic CLR interface signature matcher end-to-end cases.
        /// @returns Case name, G# source, expected stdout lines.
        func SymbolicSignatureMatcherCases() sequence[[]object] {
            yield[]object{"symbolic-async-task-valuetask-and-async-sequence", (`package P
import System
import System.Linq
import System.Threading.Tasks
import Clib

class Shape {
    var Tag int32
}

class A1 : IAs[Shape] {
    async func Make() Shape { return Shape{Tag: 10} }
}

struct SA1 : IAs[Shape] {
    async func Make() Shape { return Shape{Tag: 11} }
}

class EA1 : IAs[Shape] {
    async func (IAs[Shape]) Make() Shape { return Shape{Tag: 12} }
}

class AVt1 : IAsVt[Shape] {
    async func MakeVt() ValueTask[Shape] { return Shape{Tag: 13} }
}

class TaskFactoryImpl : IFactory[Task[Shape]] {
    async func Create() Shape { return Shape{Tag: 17} }
}

struct A2 : ISAs[Shape] {
    shared {
        async func MakeS() Shape { return Shape{Tag: 14} }
    }
}

struct AVt2 : ISAsVt[Shape] {
    shared {
        async func MakeSVt() ValueTask[Shape] { return Shape{Tag: 15} }
    }
}

class StreamImpl : IAsyncStream[Shape] {
    async func Stream(seed Shape) async sequence[Shape] {
        yield seed
    }
}

Console.WriteLine(Probe.CallMake[Shape](A1()).Tag)
Console.WriteLine(Probe.CallMake[Shape](SA1{}).Tag)
Console.WriteLine(Probe.CallMake[Shape](EA1()).Tag)
Console.WriteLine(Probe.CallMakeVt[Shape](AVt1()).Tag)
Console.WriteLine(Probe.CallFactoryTask[Shape](TaskFactoryImpl()).Tag)
let ifaceTask = typeof(A2).GetInterfaces().Where((i Type) -> i.Name == "ISAs` + "`" + `1").First()
let taskRes = cast[Task[Shape]](typeof(A2).GetInterfaceMap(ifaceTask).TargetMethods[0].Invoke(nil, []object?{})!!)
Console.WriteLine(taskRes.GetAwaiter().GetResult().Tag)
let ifaceVt = typeof(AVt2).GetInterfaces().Where((i Type) -> i.Name == "ISAsVt` + "`" + `1").First()
let vtRes = cast[ValueTask[Shape]](typeof(AVt2).GetInterfaceMap(ifaceVt).TargetMethods[0].Invoke(nil, []object?{})!!)
Console.WriteLine(vtRes.GetAwaiter().GetResult().Tag)
let streamEnum = StreamImpl().Stream(Shape{Tag: 16}).GetAsyncEnumerator()
if streamEnum.MoveNextAsync().AsTask().GetAwaiter().GetResult() {
    Console.WriteLine(streamEnum.Current.Tag)
}`), []string{"10", "11", "12", "13", "17", "14", "15", "16"}}
            yield[]object{"symbolic-tuples-long-tuples-and-open-generic-rows", (`package P
import System
import System.Linq
import Clib

class Shape {
    var Tag int32
}

class T1 : ITup[Shape] {
    func M(v (Shape, int32)) int32 { return v.Item1.Tag + v.Item2 }
    func Make(v Shape) (Shape, int32) { return (v, v.Tag * 2) }
    func Pair[U](x Shape, y (U, int32)) (Shape, U) { return (x, y.Item1) }
}

struct STup : ISTup[Shape] {
    shared {
        prop Pair (Shape, int32) { get { return (Shape{Tag: 30}, 5) } }
        func Take(v (Shape, int32)) int32 { return v.Item1.Tag + v.Item2 }
    }
}

class LongTup : ILongTup[Shape] {
    func Sum(v (int32, int32, int32, int32, int32, int32, int32, int32, Shape)) int32 {
        return v.Item1 + v.Item8 + v.Item9.Tag
    }
}

class Rows[T class] : NativeRows[T] {
    func Required(value T) (Value T, Code int32) -> (value, 15)
}

class TupPropImpl : ITupProp[Shape] {
    prop Current (Shape, int32) { get { return (Shape{Tag: 40}, 2) } }
    prop this[key (Shape, int32)] int32 { get { return key.Item1.Tag + key.Item2 } }
}

class TupFieldImpl : ITupFieldProp[Shape] {
    var Current (Shape, int32) = (Shape{Tag: 50}, 3)
}

class RefTupImpl : IRefTup[Shape] {
    func M(v Tuple[Shape, int32]) int32 -> v.Item1.Tag + v.Item2
    func Concrete(v Tuple[int32, int32]) int32 -> v.Item1 + v.Item2
    shared {
        func MakeS(x Shape) Tuple[Shape, int32] -> Tuple.Create(x, 10)
    }
}

class InheritedRefTupImpl : IRefTupDerived[Shape] {
    func M(v (Shape, Tuple[int32, int32])) int32 -> v.Item1.Tag + v.Item2.Item1 + v.Item2.Item2
}

let t1 = T1()
Console.WriteLine(Probe.CallTupM[Shape](t1, (Shape{Tag: 20}, 1)))
let made = Probe.CallTupMake[Shape](t1, Shape{Tag: 11})
Console.WriteLine(made.Item1.Tag + made.Item2)
let paired = Probe.CallTupPair[Shape, string](t1, Shape{Tag: 7}, ("ok", 9))
Console.WriteLine("${paired.Item1.Tag}:${paired.Item2}")
let stIface = typeof(STup).GetInterfaces().Where((i Type) -> i.Name == "ISTup` + "`" + `1").First()
let stMethods = typeof(STup).GetInterfaceMap(stIface).TargetMethods
let stProp = cast[(Shape, int32)](stMethods[0].Invoke(nil, []object?{})!!)
let stTake = cast[int32](stMethods[1].Invoke(nil, []object?{stProp})!!)
Console.WriteLine(stTake)
Console.WriteLine(Probe.CallLongTup[Shape](LongTup(), Shape{Tag: 100}))
let rowStr = Probe.CallNativeRows[string](Rows[string](), "ab")
Console.WriteLine("${rowStr.Item1}:${rowStr.Item2}")
let rowShape = Probe.CallNativeRows[Shape](Rows[Shape](), Shape{Tag: 9})
Console.WriteLine(rowShape.Item1.Tag + rowShape.Item2)
let tp = TupPropImpl()
let cur = Probe.CallTupPropCurrent[Shape](tp)
Console.WriteLine(Probe.CallTupPropIndex[Shape](tp, cur))
let tf = Probe.CallTupFieldPropCurrent[Shape](TupFieldImpl())
Console.WriteLine(tf.Item1.Tag + tf.Item2)
Console.WriteLine(Probe.CallRefTup[Shape, RefTupImpl](RefTupImpl(), Shape{Tag: 60}))
let nonGenericTup Tuple[int32, int32] = Probe.MakeRefTupPair(12, 34)
let genericConcreteTup Tuple[int32, int32] = Tuple.Create(1, 2)
Console.WriteLine(Probe.CallRefTupDerived[Shape](InheritedRefTupImpl(), Shape{Tag: 20}) + nonGenericTup.Item1 + nonGenericTup.Item2 + genericConcreteTup.Item2)`), []string{
                    "21",
                    "33",
                    "7:ok",
                    "35",
                    "109",
                    "ab:15",
                    "24",
                    "42",
                    "53",
                    "77",
                    "79"
                }}
            yield[]object{"symbolic-function-delegate-pointer-nullable-map-and-sequence", (`package P
import System
import System.Collections.Generic
import System.Linq
import Clib

class Shape {
    var Tag int32
}

struct Point {
    var X int32
}

class FnImpl : IFn[Shape], ISFn[Shape] {
    var observed int32 = 0
    func Apply(f (Shape) -> int32) int32 -> f(Shape{Tag: 6})
    func Run(a (Shape) -> void) {
        a(Shape{Tag: 8})
    }
    func Combine[U](x Shape, y U, f (Shape, (U, int32)) -> string) string -> f(x, (y, 3))
    shared {
        func ApplyS(f (Shape) -> int32) int32 -> f(Shape{Tag: 9})
    }
}

class NominalImpl : INominalDel[Shape] {
    func Apply(f NominalDel[Shape]) int32 -> f(Shape{Tag: 12})
}

struct PtrImpl : IPtr[Point] {
    unsafe func Read(p *Point) int32 -> 21
    shared {
        unsafe func ReadS(p *Point) int32 -> 30
    }
}

class MixedPtrImpl : IMixedPtr[Shape] {
    unsafe func Read(x Shape, p *int32) int32 -> x.Tag + 36
}

class NullableImpl : INullableNested[Shape] {
    func ReadPair(v (Shape, int32?)) int32 -> v.Item1.Tag + (v.Item2 ?? 5)
}

class MapSeqImpl : IMapAndSeq[Shape] {
    func CountMap(m map[Shape, int32]) int32 -> m.Count
    func CountSeq(s sequence[Shape]) int32 -> s.Count()
    shared {
        func MakeMap(key Shape, value int32) map[Shape, int32] -> map[Shape, int32]{key: value}
    }
}

class RefTupMapSeqImpl : IMapAndSeq[Tuple[int32, int32]] {
    func CountMap(m Dictionary[Tuple[int32, int32], int32]) int32 -> m.Count + 5
    func CountSeq(s IEnumerable[Tuple[int32, int32]]) int32 -> s.Count()
    shared {
        func MakeMap(key Tuple[int32, int32], value int32) Dictionary[Tuple[int32, int32], int32] -> map[Tuple[int32, int32], int32]{key: value}
    }
}

class FixedEqImpl : IEquatable[[3]int32] {
    func Equals(other [3]int32) bool -> other[0] == 7 && other[2] == 9
}

class NestedFixedEqImpl : IEquatable[List[[3]int32]] {
    func Equals(other List[[3]int32]) bool -> other.Count == 1 && other[0][1] == 8
}

let fn = FnImpl()
Console.WriteLine(Probe.CallFnApply[Shape](fn, (s Shape) -> s.Tag * 5))
var seen = 0
Probe.CallFnRun[Shape](fn, (s Shape) -> { seen = s.Tag })
Console.WriteLine(seen)
Console.WriteLine(Probe.CallFnCombine[Shape, string](fn, Shape{Tag: 4}, "k", (s Shape, p (string, int32)) -> "${s.Tag}-${p.Item1}-${p.Item2}"))
let sfnIface = typeof(FnImpl).GetInterfaces().Where((i Type) -> i.Name == "ISFn` + "`" + `1").First()
let sfnDel = cast[Func[Shape, int32]]((s Shape) -> s.Tag + 100)
Console.WriteLine(typeof(FnImpl).GetInterfaceMap(sfnIface).TargetMethods[0].Invoke(nil, []object?{sfnDel}))
Console.WriteLine(Probe.CallNominalDel[Shape](NominalImpl(), NominalDel[Shape]((s Shape) -> s.Tag * 2)))
let ptrIface = typeof(PtrImpl).GetInterfaces().Where((i Type) -> i.Name == "IPtr` + "`" + `1").First()
let ptrMap = typeof(PtrImpl).GetInterfaceMap(ptrIface).TargetMethods
Console.WriteLine(cast[int32](ptrMap[0].Invoke(PtrImpl{}, []object?{nil})!!) + cast[int32](ptrMap[1].Invoke(nil, []object?{nil})!!))
Console.WriteLine(Probe.CallMixedPtr[Shape](MixedPtrImpl(), Shape{Tag: 15}, 36))
Console.WriteLine(Probe.CallNullablePair[Shape](NullableImpl(), (Shape{Tag: 30}, cast[int32?](nil))))
Console.WriteLine(Probe.CallNullablePair[Shape](NullableImpl(), (Shape{Tag: 30}, cast[int32?](7))))
Console.WriteLine(Probe.CallMapAndSeq[Shape, MapSeqImpl](MapSeqImpl(), Shape{Tag: 1}, 99))
Console.WriteLine(Probe.CallMapAndSeq[Tuple[int32, int32], RefTupMapSeqImpl](RefTupMapSeqImpl(), Tuple[int32, int32](3, 4), 77))
let fixedEq IEquatable[[3]int32] = FixedEqImpl()
Console.WriteLine(fixedEq.Equals([3]int32{7, 8, 9}))
let nestedFixedEq IEquatable[List[[3]int32]] = NestedFixedEqImpl()
Console.WriteLine(nestedFixedEq.Equals(List[[3]int32]{[3]int32{7, 8, 9}}))`), []string{
                    "30",
                    "8",
                    "4-k-3",
                    "109",
                    "24",
                    "51",
                    "51",
                    "35",
                    "37",
                    "101",
                    "601",
                    "True",
                    "True"
                }}
        }

        private func CompileVerifyAndRun(name string, source string, expectedLines[]string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_4614_").FullName
            try {
                let libPath = CompileCSharpLibrary(tempDir)
                let appPath = Path.Combine(tempDir, name + ".dll")
                let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
                Assert.DoesNotContain(" error ", log, StringComparison.Ordinal)
                Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$log"))
                IlVerifier.Verify(appPath, []string{libPath})
                let (exit, output) = RunDotnet(appPath)
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

        private func CompileCSharpLibrary(tempDir string) string -> CompileCSharpLibrary(tempDir, "Clib", LibrarySource)

        private func CompileCSharpLibrary(tempDir string, assemblyName string, source string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithAllowUnsafe(true)
                    .WithNullableContextOptions(NullableContextOptions.Enable)
            )
            let libPath = Path.Combine(tempDir, assemblyName + ".dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                "the C# library must compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return libPath
        }

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            return if string.IsNullOrEmpty(tpa) {
                Enumerable.Empty[string]()
            } else {
                tpa!!.Split(Path.PathSeparator).Where(File.Exists)
            }
        }
    }
}
