// <copyright file="ReifiedGenericsReflectionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.Loader
import Xunit
import Xunit.Sdk

/// ADR-0087 reflection-based golden suite for the open-generic erasure
/// elimination work. The suite is split into two cohorts:
/// - <b>CurrentBehaviour</b> — assertions that hold under the present type-erased model. These pin the
/// user-visible reflection shape so a future regression that flips an unintended contract is caught
/// locally rather than escaping to a downstream consumer.
/// - <b>ReifiedBehaviour</b> — `[Fact(Skip = ...)]` entries that describe the post-reification shape
/// per ADR-0087 staging phase. When a phase lands, the matching `CurrentBehaviour` test is deleted and
/// the matching `ReifiedBehaviour` test loses its `Skip`.
/// Each test compiles a G# source through `gsc`, IL-verifies the
/// emitted assembly, and loads it in a fresh
/// (cref:AssemblyLoadContext) so the assertion runs against the
/// real CLR (cref:Type) / (cref:FieldInfo) /
/// (cref:MethodInfo) graph rather than an internal symbol view.
open class ReifiedGenericsReflectionTests {
    // -----------------------------------------------------------------
    // ReifiedBehaviour cohort (CurrentBehaviour was deleted as part of
    // R1+R2+R3+R4 landing). Each test below describes the post-R3
    // metadata shape and was previously Skip-tagged; the cohort is
    // now live.
    // -----------------------------------------------------------------
    /// Stability invariant: even under the reified model, the value
    /// round-trips correctly. `Box[int32]{Value: 42}.Value` is
    /// observed as an (cref:int) at runtime (box/unbox.any at
    /// the boundary). This MUST continue to hold after every staging
    /// phase — reification only widens the metadata, never the
    /// runtime semantics.
    @Fact
    func StabilityInvariant_GenericDataStruct_IntValueRoundTrips() {
        let source = `package P
import System
data struct Box[T any] {
    var Value T
}
let b = Box[int32]{Value: 42}
Console.WriteLine(b.Value.GetType().FullName)`
        let stdout = CompileAndRun(source)
        Assert.Contains("System.Int32", stdout)
    }

    /// Stability invariant: a value-typed generic-method return
    /// round-trips through the call boundary as the substituted type,
    /// not as the erased `Object`. This too must hold after every
    /// staging phase.
    @Fact
    func StabilityInvariant_GenericFunction_IntReturnRoundTrips() {
        let source = `package P
import System
func Identity[T any](x T) T { return x }
let y = Identity[int32](7)
Console.WriteLine(y)`
        let stdout = CompileAndRun(source)
        Assert.Equal("7${Environment.NewLine}", stdout)
    }

    // -----------------------------------------------------------------
    // ReifiedBehaviour cohort (skipped)
    //
    // Each test is a faithful description of the post-reification
    // metadata shape. When a staging phase lands, the matching
    // CurrentBehaviour test above is deleted and the Skip below is
    // removed.
    // -----------------------------------------------------------------
    @Fact
    func ReifiedBehaviour_R1_GenericDataStruct_IsGenericTypeDefinition() {
        let source = `package P
data struct Box[T any] {
    var Value T
}`
        let asm = LoadCompiled(source)
        let boxType Type? = FindUserType(asm, "P", "Box`1")
        Assert.NotNull(boxType)
        Assert.True(boxType!!.IsGenericTypeDefinition)
        Assert.Single(boxType!!.GetGenericArguments())
    }

    @Fact
    func ReifiedBehaviour_R2_TTypedField_IsEncodedAsGenericParameter() {
        let source = `package P
data struct Box[T any] {
    var Value T
}`
        let asm = LoadCompiled(source)
        let boxType Type? = FindUserType(asm, "P", "Box`1")
        let field FieldInfo? = boxType!!.GetField("Value", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(field)
        Assert.True(field!!.FieldType.IsGenericParameter)
        Assert.Equal(0, field!!.FieldType.GenericParameterPosition)
    }

    @Fact
    func ReifiedBehaviour_R2_GenericFunction_HasGenericSignature() {
        let source = "package P\nfunc Identity[T any](x T) T { return x }"
        let asm = LoadCompiled(source)
        let program = FindModuleType(asm, "P")
        let method MethodInfo? = program.GetMethod("Identity", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(method)
        Assert.True(method!!.IsGenericMethodDefinition)
        Assert.Single(method!!.GetGenericArguments())
        Assert.True(method!!.ReturnType.IsGenericMethodParameter)
        Assert.True(method!!.GetParameters()[0].ParameterType.IsGenericMethodParameter)
    }

    @Fact
    func ReifiedBehaviour_R3_ConstructedField_RoundTripsThroughReflection() {
        // After R1+R2+R3: typeof(Box<int>) is a closed constructed type
        // whose Value field reads back as Int32, not Object.
        let source = `package P
data struct Box[T any] {
    var Value T
}`
        let asm = LoadCompiled(source)
        let openBox Type? = FindUserType(asm, "P", "Box`1")
        let closedBox = openBox!!.MakeGenericType(typeof(int32))
        let field FieldInfo? = closedBox.GetField("Value", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(field)
        Assert.Equal(typeof(int32), field!!.FieldType)
    }

    @Fact
    func ReifiedBehaviour_R5_ListOfUserGeneric_DispatchesCorrectly() {
        // After R5 the audit's F3 cluster collapses: a List[Box[int32]]
        // resolves Add against the proper closed shape rather than the
        // erased List<object>.
        let source = `package P
import System.Collections.Generic
data struct Box[T any] {
    var Value T
}
let xs = List[Box[int32]]()
xs.Add(Box[int32]{Value: 1})`
        let stdout = CompileAndRun(source)
        Assert.NotNull(stdout)
    }

    // -----------------------------------------------------------------
    // Audit coverage matrix (one method per type-parameter use site
    // discovered in ADR-0087 §2). Each test exercises ONE shape from
    // ONE category. They are spot-checks: they confirm that the shape
    // compiles and runs end-to-end today.
    // -----------------------------------------------------------------
    @Fact
    func AuditCoverage_GenericDataStruct_Compiles() {
        CompileAndRun(`package P
import System
data struct Box[T any] { var Value T }
let b = Box[int32]{Value: 1}
Console.WriteLine(b.Value)`)
    }

    @Fact
    func AuditCoverage_GenericClass_Compiles() {
        CompileAndRun(`package P
import System
class Box[T any](Value T) { }
let b = Box[string]("hi")
Console.WriteLine(b.Value)`)
    }

    @Fact
    func AuditCoverage_GenericFunction_Compiles() {
        CompileAndRun(`package P
import System
func Id[T any](x T) T { return x }
Console.WriteLine(Id[int32](1))`)
    }

    @Fact
    func AuditCoverage_GenericMethod_OnNonGenericType_Compiles() {
        CompileAndRun(`package P
import System
class Holder {
    init() {}
    func Box[T any](v T) T { return v }
}
let h = Holder()
Console.WriteLine(h.Box[int32](42))`)
    }

    @Fact
    func AuditCoverage_GenericInterface_Compiles() {
        CompileAndRun(`package P
import System
interface IBox[T any] {
    func Get() T;
}
class IntBox(value int32) : IBox[int32] {
    func Get() int32 { return value }
}
let b IBox[int32] = IntBox(7)
Console.WriteLine(b.Get())`)
    }

    @Fact
    func AuditCoverage_NestedGenericInstantiation_Compiles() {
        CompileAndRun(`package P
import System
data struct Box[T any] { var Value T }
let nested = Box[Box[int32]]{Value: Box[int32]{Value: 9}}
Console.WriteLine(nested.Value.Value)`)
    }

    @Fact
    func AuditCoverage_RecursiveGenericConstraint_Compiles() {
        // After R5 a generic G# function whose return type is a closed CLR
        // generic over an in-scope type parameter (F3 in the audit) emits
        // with reified `List`1<!!0>`, so the runtime cast at the call site
        // (`MakeList[int32]()` -> `List<int32>`) succeeds.
        CompileAndRun(`package P
import System
import System.Collections.Generic
func MakeList[T any]() List[T] { return List[T]() }
let xs = MakeList[int32]()
xs.Add(1)
Console.WriteLine(xs.Count)`)
    }

    // -----------------------------------------------------------------
    // ADR-0087 R5 additional coverage (issue #765): closed CLR generic
    // over a user-declared generic type, plus the new "lazy interface
    // member substitution" + "constructed-interface emit" support that
    // the audit lists alongside R5. Each test compiles, IL-verifies, and
    // runs end-to-end to keep the F2/F3/F5 surface honest.
    // -----------------------------------------------------------------
    @Fact
    func R5_ListOfUserStruct_AddRoundTrips() {
        let stdout = CompileAndRun(`package P
import System
import System.Collections.Generic
data struct Box[T any] { var Value T }
let xs = List[Box[int32]]()
xs.Add(Box[int32]{Value: 7})
xs.Add(Box[int32]{Value: 42})
Console.WriteLine(xs.Count)`)
        Assert.Equal("2", stdout.Trim())
    }

    @Fact
    func R5_DictionaryOfStringToUserStruct_AddRoundTrips() {
        let stdout = CompileAndRun(`package P
import System
import System.Collections.Generic
data struct Box[T any] { var Value T }
let d = Dictionary[string, Box[int32]]()
d.Add("a", Box[int32]{Value: 7})
d.Add("b", Box[int32]{Value: 42})
Console.WriteLine(d.Count)`)
        Assert.Equal("2", stdout.Trim())
    }

    @Fact
    func R5_UserStructWrappingClrGeneric_RoundTrips() {
        // Box[List[int32]] — a user-defined generic struct whose argument
        // is itself a closed CLR generic. The member access `b.Value.Add`
        // dispatches through the CLR generic's concrete shape.
        let stdout = CompileAndRun(`package P
import System
import System.Collections.Generic
data struct Box[T any] { var Value T }
let b = Box[List[int32]]{Value: List[int32]()}
b.Value.Add(7)
b.Value.Add(11)
Console.WriteLine(b.Value.Count)`)
        Assert.Equal("2", stdout.Trim())
    }

    @Fact
    func R5_TripleNestedUserStruct_RoundTrips() {
        // Box[Box[Box[int32]]] — deep recursive nesting of the same user
        // generic type. Every level encodes as a reified
        // `GENERICINST<Box`1><…>` so field-access chains down to the
        // primitive payload without erasure-induced casts.
        let stdout = CompileAndRun(`package P
import System
data struct Box[T any] { var Value T }
let b = Box[Box[Box[int32]]]{Value: Box[Box[int32]]{Value: Box[int32]{Value: 9}}}
Console.WriteLine(b.Value.Value.Value)`)
        Assert.Equal("9", stdout.Trim())
    }

    @Fact
    func R5_GenericMethodOverClrListOfUserStruct_RoundTrips() {
        // `func Process[T any](xs List[Box[T]]) int32` — a G# generic
        // method whose parameter is a closed CLR generic over the
        // method's open type parameter wrapped in a user generic.
        // After R5 the method-spec for Process[int32] resolves to the
        // proper closed shape and the call site dispatches without an
        // erasure-induced cast.
        let stdout = CompileAndRun(`package P
import System
import System.Collections.Generic
data struct Box[T any] { var Value T }
func Process[T any](xs List[Box[T]]) int32 {
    return xs.Count
}
let xs = List[Box[int32]]()
xs.Add(Box[int32]{Value: 1})
xs.Add(Box[int32]{Value: 2})
xs.Add(Box[int32]{Value: 3})
Console.WriteLine(Process[int32](xs))`)
        Assert.Equal("3", stdout.Trim())
    }

    @Fact
    func R5_GenericInterfaceImpl_DispatchesAcrossClosedClass() {
        // ADR-0087 R5 interface counterpart: a user-defined generic
        // interface `IBox[T]` implemented by `IntBox : IBox[int32]`,
        // accessed through a type-annotated `let b IBox[int32] = …`.
        // Validates that:
        //   * the InterfaceImpl row references the constructed TypeSpec
        //     (so `IntBox` actually implements `IBox`1<int32>`);
        //   * `b.Get()` dispatches through a MemberRef parented at the
        //     constructed TypeSpec rather than the bare TypeDef.
        let stdout = CompileAndRun(`package P
import System
interface IBox[T any] {
    func Get() T;
}
class IntBox(value int32) : IBox[int32] {
    func Get() int32 { return value }
}
let b IBox[int32] = IntBox(99)
Console.WriteLine(b.Get())`)
        Assert.Equal("99", stdout.Trim())
    }

    // -----------------------------------------------------------------
    // ADR-0087 §3 R6: lambda-adapter retirement
    //
    // Before R6, a delegate over a type-parameter (e.g. `func(T) U`)
    // was emitted as `System.Func<object, object>` and dispatched via
    // `System.Delegate.DynamicInvoke`, with binder-side
    // `<lambda_erasedN>` adapters boxing arguments / unboxing returns.
    // After R6 the encoder emits a reified
    // `GENERICINST<Func`N><...>` with `Var(idx)` / `MVar(idx)` slots,
    // delegate ctors / Invoke dispatch route through MemberRefs
    // parented at that TypeSpec, and `DynamicInvoke` no longer appears
    // in emitted user IL for generic-over-T lambda call sites.
    // -----------------------------------------------------------------
    /// ADR-0087 §3 R6: the parameter type of a generic method whose
    /// signature carries a delegate over a type parameter
    /// (`func Apply[T,U](x T, f (T) -> U) U`) round-trips as a
    /// constructed `System.Func`2<!!0, !!1>` through
    /// reflection — both type arguments report
    /// (cref:Type.IsGenericMethodParameter). Previously the
    /// parameter erased to `System.Func`2<object, object>`.
    @Fact
    func R6_GenericMethod_DelegateParam_HasReifiedFuncShape() {
        let source = `package P
import System
func Apply[T any, U any](x T, f (T) -> U) U {
    return f(x)
}`
        let asm = LoadCompiled(source)
        let moduleType = FindModuleType(asm, "P")
        let apply = moduleType.GetMethods(BindingFlags.Public | BindingFlags.Static).First(
            (m MethodInfo) -> m.Name == "Apply"
        )
        let fParam = apply.GetParameters()[1].ParameterType
        Assert.True(fParam.IsGenericType, "delegate parameter must be a constructed generic type")
        Assert.False(fParam.IsGenericTypeDefinition)
        let def = fParam.GetGenericTypeDefinition()
        Assert.Equal("System.Func`2", def.FullName)
        let args = fParam.GetGenericArguments()
        Assert.Equal(2, args.Length)
        Assert.True(args[0].IsGenericMethodParameter, "Func arg 0 must be method-generic Var")
        Assert.True(args[1].IsGenericMethodParameter, "Func arg 1 must be method-generic Var")
        Assert.NotEqual(typeof(object), args[0])
        Assert.NotEqual(typeof(object), args[1])
    }

    /// ADR-0087 §3 R6: a generic `class Box[TItem]` with a
    /// `func Map[TResult](f (TItem) -> TResult) TResult` exposes
    /// `f` as `System.Func`2<!0, !!0>` — class-generic
    /// `Var(0)` for `TItem`, method-generic `MVar(0)`
    /// for `TResult`. Pre-R6 both slots were (cref:object).
    @Fact
    func R6_GenericClass_GenericMethod_MixedSlots_RoundTrip() {
        let source = `package P
import System
class Box[TItem] {
    var Value TItem
    func Map[TResult](f (TItem) -> TResult) TResult { return f(this.Value) }
}`
        let asm = LoadCompiled(source)
        let box Type? = FindUserType(asm, "P", "Box`1")
        Assert.NotNull(box)
        Assert.True(box!!.IsGenericTypeDefinition)
        let map_ = box!!.GetMethods(BindingFlags.Public | BindingFlags.Instance).First(
            (m MethodInfo) -> m.Name == "Map"
        )
        let fParam = map_.GetParameters().Single().ParameterType
        Assert.Equal("System.Func`2", fParam.GetGenericTypeDefinition().FullName)
        let args = fParam.GetGenericArguments()
        Assert.True(args[0].IsGenericTypeParameter, "TItem must be class-generic Var")
        Assert.True(args[1].IsGenericMethodParameter, "TResult must be method-generic MVar")
    }

    /// ADR-0087 §3 R6: emitted user IL for a generic-over-T lambda
    /// call site contains no `System.Delegate::DynamicInvoke`
    /// MemberRef and no `callvirt System.Delegate::DynamicInvoke`
    /// instruction. Dispatch goes through a normal
    /// `callvirt Func`N::Invoke` on the reified TypeSpec.
    @Fact
    func R6_EmittedIL_HasNoDynamicInvokeForGenericLambdaSites() {
        let source = `package P
import System
class Box[TItem] {
    var Value TItem
    func Map[TResult](f (TItem) -> TResult) TResult { return f(this.Value) }
}
var b = Box[int32]{Value: 7}
Console.WriteLine(b.Map[int32](func(x int32) int32 { return x + 1 }))`
        let dllPath = CompileToDll(source, asExe: true)
        using let pe = PEReader(MemoryStream(File.ReadAllBytes(dllPath), writable: false))
        let md = pe.GetMetadataReader()
        for handle in md.MemberReferences {
            let mr = md.GetMemberReference(handle)
            let name = md.GetString(mr.Name)
            if !string.Equals(name, "DynamicInvoke", StringComparison.Ordinal) {
                continue
            }
            var parentName string
            switch mr.Parent.Kind {
                case HandleKind.TypeReference {
                    let tr = md.GetTypeReference(TypeReferenceHandle(mr.Parent))
                    parentName = md.GetString(tr.Namespace) + "." + md.GetString(tr.Name)
                }
                default {
                    parentName = mr.Parent.Kind.ToString()
                }
            }
            Assert.Fail("R6: emitted assembly still references $parentName::$name")
        }
    }

    /// ADR-0087 §3 R6 end-to-end: a generic `Map` passes its
    /// typed lambda to a second generic helper `Pipe`. Pre-R6
    /// this routed both delegate slots through `DynamicInvoke`;
    /// post-R6 it is two `callvirt Func`2::Invoke` dispatches.
    @Fact
    func R6_EndToEnd_GenericMethodForwardsLambdaToAnotherGeneric() {
        let stdout = CompileAndRun(`package P
import System
func Pipe[A any, B any](x A, f (A) -> B) B { return f(x) }
func Map[T any, U any](x T, f (T) -> U) U {
    return Pipe[T, U](x, f)
}
Console.WriteLine(Map[int32, int32](21, func(n int32) int32 { return n * 2 }))
Console.WriteLine(Map[int32, string](7, func(n int32) string { return "n=" }))`)
        Assert.Equal("42${Environment.NewLine}n=${Environment.NewLine}", stdout)
    }

    /// ADR-0087 §3 R6 end-to-end: an open-generic delegate flows
    /// through a CLR (cref:System.Collections.Generic.List{T})
    /// and is invoked at the indexer site. Pre-R6 each invocation
    /// boxed/`DynamicInvoke`d; post-R6 it is a normal
    /// `callvirt Func`2::Invoke` on the constructed TypeSpec.
    @Fact
    func R6_EndToEnd_OpenGenericDelegateInList() {
        let stdout = CompileAndRun(`package P
import System
import System.Collections.Generic
func ApplyThree[T any](fs List[(T) -> T], seed T) T {
    let a = fs[0]
    let b = fs[1]
    let c = fs[2]
    return c(b(a(seed)))
}
var fs = List[(int32) -> int32]()
fs.Add(func(x int32) int32 { return x + 1 })
fs.Add(func(x int32) int32 { return x * 2 })
fs.Add(func(x int32) int32 { return x - 3 })
Console.WriteLine(ApplyThree[int32](fs, 10))`)
        Assert.Equal("19", stdout.Trim())
    }

    /// ADR-0087 §3 R6: mixed value-type and reference-type T through
    /// the same generic delegate site. Sanity-checks both runtime
    /// resolution paths off the same TypeSpec'd Invoke MemberRef.
    @Fact
    func R6_EndToEnd_MixedValueAndReferenceTypeArgs() {
        let stdout = CompileAndRun(`package P
import System
func Twice[T any](x T, f (T) -> T) T { return f(f(x)) }
Console.WriteLine(Twice[int32](2, func(n int32) int32 { return n + n }))
Console.WriteLine(Twice[string]("a", func(s string) string { return s + s }))`)
        Assert.Equal("8${Environment.NewLine}aaaa${Environment.NewLine}", stdout)
    }

    shared {
        // -----------------------------------------------------------------
        // Helpers
        // -----------------------------------------------------------------
        private func CompileToDll(source string, asExe bool) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_reified_il_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(
                tempDir,
                if asExe {
                    "test.exe"
                } else {
                    "test.dll"
                }
            )
            File.WriteAllText(srcPath, source)
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
                        "/target:" +
                            (
                            if asExe {
                                "exe"
                            } else {
                                "library"
                            }
                        ),
                        "/targetframework:net10.0",
                        srcPath
                    }
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func LoadCompiled(source string) Assembly {
            let tempDir = Directory.CreateTempSubdirectory("gs_reified_reflect_").FullName
            let srcPath = Path.Combine(tempDir, "test.gs")
            let outPath = Path.Combine(tempDir, "test.dll")
            File.WriteAllText(srcPath, source)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(
                    []string{"/out:" + outPath, "/target:library", "/targetframework:net10.0", srcPath}
                )
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, "compile failed ($compileExit): $compileOut$compileErr")
            IlVerifier.Verify(outPath)
            // Load in a fresh, collectible AssemblyLoadContext so each test
            // sees a fresh metadata graph. The context is not Dispose-able
            // on the runtime targeted here, so we explicitly Unload() and
            // rely on the test harness's per-test isolation.
            let ctx = AssemblyLoadContext(name: "gs_reified_reflect_" + Guid.NewGuid().ToString(), isCollectible: true)
            return ctx.LoadFromAssemblyPath(outPath)
        }

        private func FindUserType(asm Assembly, ns string, name string) Type? {
            let full = ns + "." + name
            let t Type? = asm.GetType(full, throwOnError: false)
            if t != nil {
                return t
            }
            // Fall back to a scan in case the namespace/name shape differs.
            return asm.GetTypes().FirstOrDefault(
                (x Type) -> string.Equals(x.Namespace, ns, StringComparison.Ordinal) && string.Equals(
                    x.Name,
                    name,
                    StringComparison.Ordinal
                )
            )
        }

        private func FindModuleType(asm Assembly, ns string) Type {
            // G# top-level statements / package-level functions land on a
            // synthesised type named after the package's <Program> module
            // (or similar). Find any type in the namespace that hosts at
            // least one public static method.
            return asm.GetTypes().FirstOrDefault(
                (t Type) -> string.Equals(t.Namespace, ns, StringComparison.Ordinal) && t.GetMethods(
                    BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly
                )
                    .Length > 0
            ) ??
                throw InvalidOperationException("no module type found under namespace '$ns'")
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_reified_run_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    compileExit = Program.Main(
                        []string{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
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
                } catch { }
            }
        }
    }
}
