// <copyright file="RefKindParameterEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// ADR-0060: end-to-end emit tests for user-defined functions with `ref`,
/// `out`, and `in` parameters. Each test compiles a G# program that
/// declares a ref-kind-parameter function and exercises it through the various
/// call-site argument forms (lvalue, `out var`, `out let`, `out _`),
/// then asserts both runtime behaviour and emitted-metadata shape.
open class RefKindParameterEmitTests {
    @Fact
    func RefParameter_Increment_Updates_CallerVariable() {
        const Source = `package RefIncrement
import System

func bump(ref counter int32, by int32) {
    counter = counter + by
}

var n = 5
bump(&n, 10)
Console.WriteLine(n)
`
        let output = CompileAndRun(Source, "RefIncrement")
        Assert.Contains("15", output)
    }

    @Fact
    func OutParameter_AssignedFromBody_FlowsBackToCaller() {
        const Source = `package OutAssign
import System

func setTo42(out result int32) {
    result = 42
}

var r = 0
setTo42(&r)
Console.WriteLine(r)
`
        let output = CompileAndRun(Source, "OutAssign")
        Assert.Contains("42", output)
    }

    @Fact
    func OutVar_InlineDeclaration_ScopedToCallerBody() {
        const Source = `package OutVar
import System

func produce(out value int32) {
    value = 7
}

produce(out var x)
Console.WriteLine(x)
`
        let output = CompileAndRun(Source, "OutVar")
        Assert.Contains("7", output)
    }

    @Fact
    func OutLet_InlineDeclaration_ProducesReadOnlyLocal() {
        const Source = `package OutLet
import System

func produce(out value int32) {
    value = 99
}

produce(out let x)
Console.WriteLine(x)
`
        let output = CompileAndRun(Source, "OutLet")
        Assert.Contains("99", output)
    }

    @Fact
    func OutDiscard_DropsValueWithoutBinding() {
        const Source = `package OutDiscard
import System

func produce(out value int32) {
    value = 123
}

produce(out _)
Console.WriteLine("ok")
`
        let output = CompileAndRun(Source, "OutDiscard")
        Assert.Contains("ok", output)
    }

    @Fact
    func InParameter_ReadFromBody_SeesCallerValue() {
        const Source = `package InRead
import System

func doubleIt(in source int32) int32 {
    return source + source
}

var v = 21
Console.WriteLine(doubleIt(in v))
`
        let output = CompileAndRun(Source, "InRead")
        Assert.Contains("42", output)
    }

    @Fact
    func RefParameter_MetadataShape_IsByRef_NotOutNotIn() {
        const Source = `package RefMeta
import System

func touch(ref x int32) {
    x = 0
}

var n = 0
touch(&n)
`
        let asm = CompileToAssembly(Source, "RefMeta")
        let touch MethodInfo? = FindStatic(asm, "touch")
        let p = touch!!.GetParameters()[0]
        Assert.True(p.ParameterType.IsByRef, "ref parameter must be ByRef")
        Assert.False(p.IsOut, "ref parameter must not be [Out]")
        Assert.False(p.IsIn, "ref parameter must not be [In]")
    }

    @Fact
    func OutParameter_MetadataShape_IsByRef_AndOut() {
        const Source = `package OutMeta
import System

func produce(out x int32) {
    x = 1
}

var n = 0
produce(&n)
`
        let asm = CompileToAssembly(Source, "OutMeta")
        let produce MethodInfo? = FindStatic(asm, "produce")
        let p = produce!!.GetParameters()[0]
        Assert.True(p.ParameterType.IsByRef, "out parameter must be ByRef")
        Assert.True(p.IsOut, "out parameter must carry [Out]")
        Assert.False(p.IsIn, "out parameter must not carry [In]")
    }

    @Fact
    func InParameter_MetadataShape_IsByRef_AndIn_AndIsReadOnlyModreq() {
        const Source = `package InMeta
import System

func consume(in x int32) int32 {
    return x
}

var n = 5
Console.WriteLine(consume(in n))
`
        let asm = CompileToAssembly(Source, "InMeta")
        let consume MethodInfo? = FindStatic(asm, "consume")
        let p = consume!!.GetParameters()[0]
        Assert.True(p.ParameterType.IsByRef, "in parameter must be ByRef")
        Assert.True(p.IsIn, "in parameter must carry [In]")
        Assert.False(p.IsOut, "in parameter must not carry [Out]")
        // ADR-0060 §6 / Roslyn parity: `in` parameters carry a
        // modreq(System.Runtime.CompilerServices.IsReadOnlyAttribute) on the
        // by-ref signature element. GetRequiredCustomModifiers surfaces it.
        let modreqs = p.GetRequiredCustomModifiers()
        Assert.Contains(modreqs, (t Type) -> t.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute")
    }

    @Fact
    func RefAndOut_Compose_With_PlainParameters_InSameSignature() {
        const Source = `package Mixed
import System

func compute(a int32, ref b int32, out c int32, d int32) {
    c = a + b + d
    b = b * 2
}

var bIn = 3
var cOut = 0
compute(1, &bIn, &cOut, 5)
Console.WriteLine(bIn)
Console.WriteLine(cOut)
`
        let output = CompileAndRun(Source, "Mixed")
        Assert.Contains("6", output)
        Assert.Contains("9", output)
    }

    // ----------------------------------------------------------------------
    // ADR-0060 deferred-item #1 / #2: emit-time tests for ref-kind parameters
    // on struct instance methods, class instance methods, class static methods,
    // class constructors, and named-delegate type Invoke signatures.
    // ----------------------------------------------------------------------
    @Fact
    func StructInstanceMethod_RefParameter_EmitsByRefSignature_AndRoundTrips() {
        const Source = `package StructRefMethod
import System

struct Counter {
    var Value int32

    func Bump(ref delta int32) {
        delta = delta + 1
    }
}

var d = 10
var c = Counter{Value: 0}
c.Bump(&d)
Console.WriteLine(d)
`
        let output = CompileAndRun(Source, "StructRefMethod")
        Assert.Contains("11", output)
        let asm = CompileToAssembly(Source, "StructRefMethod_Meta")
        let counter = asm.GetTypes().Single((t Type) -> t.Name == "Counter")
        let bump MethodInfo? = counter.GetMethod(
            "Bump",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(bump)
        let p = bump!!.GetParameters()[0]
        Assert.True(p.ParameterType.IsByRef, "struct method ref parameter must be ByRef")
        Assert.False(p.IsOut)
        Assert.False(p.IsIn)
    }

    @Fact
    func ClassInstanceMethod_OutParameter_EmitsByRef_AndOutFlag() {
        const Source = `package ClassOutMethod
import System

class Producer {
    init() {
    }
    func MakeFortyTwo(out result int32) bool {
        result = 42
        return true
    }
}

var p = Producer()
var v = 0
p.MakeFortyTwo(&v)
Console.WriteLine(v)
`
        let output = CompileAndRun(Source, "ClassOutMethod")
        Assert.Contains("42", output)
        let asm = CompileToAssembly(Source, "ClassOutMethod_Meta")
        let prod = asm.GetTypes().Single((t Type) -> t.Name == "Producer")
        let make MethodInfo? = prod.GetMethod(
            "MakeFortyTwo",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
        Assert.NotNull(make)
        let p2 = make!!.GetParameters()[0]
        Assert.True(p2.ParameterType.IsByRef, "out parameter must be ByRef")
        Assert.True(p2.IsOut, "out parameter must carry [Out]")
        Assert.False(p2.IsIn)
    }

    @Fact
    func ClassStaticMethod_InParameter_EmitsByRef_AndIn_AndIsReadOnlyModreq() {
        const Source = `package ClassInStatic
import System

class Helper {
    shared {
        func DoubleIt(in source int32) int32 {
            return source + source
        }
    }
}

var n = 21
Console.WriteLine(Helper.DoubleIt(in n))
`
        let output = CompileAndRun(Source, "ClassInStatic")
        Assert.Contains("42", output)
        let asm = CompileToAssembly(Source, "ClassInStatic_Meta")
        let helper = asm.GetTypes().Single((t Type) -> t.Name == "Helper")
        let doubleIt MethodInfo? = helper.GetMethod(
            "DoubleIt",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        )
        Assert.NotNull(doubleIt)
        let p = doubleIt!!.GetParameters()[0]
        Assert.True(p.ParameterType.IsByRef)
        Assert.True(p.IsIn)
        Assert.False(p.IsOut)
        let modreqs = p.GetRequiredCustomModifiers()
        Assert.Contains(modreqs, (t Type) -> t.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute")
    }

    @Fact
    func ClassConstructor_RefParameter_EmitsByRef() {
        const Source = `package ClassCtorRef
import System

class Box {
    var Value int32

    init(ref delta int32) {
        delta = delta + 1
        Value = delta
    }
}

var d = 4
var b = Box(&d)
Console.WriteLine(d)
Console.WriteLine(b.Value)
`
        let output = CompileAndRun(Source, "ClassCtorRef")
        Assert.Contains("5", output)
        let asm = CompileToAssembly(Source, "ClassCtorRef_Meta")
        let box = asm.GetTypes().Single((t Type) -> t.Name == "Box")
        let ctor = box.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).Single()
        let p = ctor.GetParameters()[0]
        Assert.True(p.ParameterType.IsByRef, "ctor ref parameter must be ByRef")
        Assert.False(p.IsOut)
        Assert.False(p.IsIn)
    }

    @Fact
    func NamedDelegate_RefParameter_InvokeSignatureIsByRef_AndRoundTrips() {
        const Source = `package DelegateRef
import System

delegate IntRefAction(ref counter int32, by int32);
`
        let asm = CompileToAssembly(Source, "DelegateRef_Meta")
        let del = asm.GetTypes().Single((t Type) -> t.Name == "IntRefAction")
        let invoke MethodInfo? = del.GetMethod("Invoke", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(invoke)
        let ps = invoke!!.GetParameters()
        Assert.Equal(2, ps.Length)
        Assert.True(ps[0].ParameterType.IsByRef, "ref delegate parameter must be ByRef")
        Assert.False(ps[0].IsOut)
        Assert.False(ps[0].IsIn)
        Assert.False(ps[1].ParameterType.IsByRef, "non-ref delegate parameter must be by value")
    }

    @Fact
    func NamedDelegate_OutParameter_InvokeHasOutFlag() {
        const Source = `package DelegateOut
import System

delegate IntOutPredicate(out result int32) bool;
`
        let asm = CompileToAssembly(Source, "DelegateOut_Meta")
        let del = asm.GetTypes().Single((t Type) -> t.Name == "IntOutPredicate")
        let invoke MethodInfo? = del.GetMethod("Invoke", BindingFlags.Public | BindingFlags.Instance)
        let p = invoke!!.GetParameters()[0]
        Assert.True(p.ParameterType.IsByRef)
        Assert.True(p.IsOut)
        Assert.False(p.IsIn)
    }

    @Fact
    func NamedDelegate_InParameter_InvokeHasIn_AndIsReadOnlyModreq() {
        const Source = `package DelegateIn
import System

delegate IntInObserver(in value int32);
`
        let asm = CompileToAssembly(Source, "DelegateIn_Meta")
        let del = asm.GetTypes().Single((t Type) -> t.Name == "IntInObserver")
        let invoke MethodInfo? = del.GetMethod("Invoke", BindingFlags.Public | BindingFlags.Instance)
        let p = invoke!!.GetParameters()[0]
        Assert.True(p.ParameterType.IsByRef)
        Assert.True(p.IsIn)
        Assert.False(p.IsOut)
        let modreqs = p.GetRequiredCustomModifiers()
        Assert.Contains(modreqs, (t Type) -> t.FullName == "System.Runtime.CompilerServices.IsReadOnlyAttribute")
    }

    @Fact
    func NamedDelegate_RefOutInInvocations_CompileAndRun() {
        const Source = `package DelegateByRefInvoke
import System

delegate RefAction(ref value int32);
delegate OutAction(out value int32);
delegate InPredicate(in value int32) bool;

var refAction RefAction = (ref value int32) -> { value = value + 2 }
var outAction OutAction = (out value int32) -> { value = 42 }
var inPredicate InPredicate = (in value int32) -> value == 42

var value = 40
refAction(ref value)
Console.WriteLine(value)
outAction.Invoke(out value)
Console.WriteLine(value)
Console.WriteLine(inPredicate(in value))
Console.WriteLine(inPredicate.Invoke(in value))
`
        Assert.Equal(
            "42${Environment.NewLine}42${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(Source, "DelegateByRefInvoke")
        )
    }

    @Fact
    func GenericNamedDelegate_RefOutInInvocations_CompileAndRun() {
        const Source = `package GenericDelegateByRefInvoke
import System

delegate RefAction[T](ref value T);
delegate OutAction[T](out value T);
delegate InPredicate[T](in value T) bool;

func Apply[T](action RefAction[T], ref value T) {
    action(ref value)
}

func Read[T](action OutAction[T], ref value T) {
    action.Invoke(out value)
}

func Test[T](predicate InPredicate[T], in value T) bool {
    return predicate(in value) && predicate.Invoke(in value)
}

var refAction RefAction[int32] = (ref value int32) -> { value = value + 2 }
var outAction OutAction[int32] = (out value int32) -> { value = 42 }
var inPredicate InPredicate[int32] = (in value int32) -> value == 42

var value = 40
Apply[int32](refAction, ref value)
Console.WriteLine(value)
Read[int32](outAction, ref value)
Console.WriteLine(value)
Console.WriteLine(Test[int32](inPredicate, in value))
`
        Assert.Equal(
            "42${Environment.NewLine}42${Environment.NewLine}True${Environment.NewLine}",
            CompileAndRun(Source, "GenericDelegateByRefInvoke")
        )
    }

    shared {
        private func CompileAndRun(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }

        private func CompileToAssembly(source string, contextName string) Assembly {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            return loadContext.LoadFromStream(peStream)
        }

        private func FindStatic(asm Assembly, name string) MethodInfo? {
            for t in asm.GetTypes() {
                let m MethodInfo? = t.GetMethod(
                    name,
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
                )
                if m != nil {
                    return m
                }
            }
            throw InvalidOperationException("No static method named '$name' in emitted assembly.")
        }
    }
}
