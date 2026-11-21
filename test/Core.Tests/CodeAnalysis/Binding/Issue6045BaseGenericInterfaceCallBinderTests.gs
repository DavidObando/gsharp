// <copyright file="Issue6045BaseGenericInterfaceCallBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Linq
import Xunit

/// Issue #6045: constructed generic base-interface member calls substitute the
/// constructed interface type arguments through return types, parameter types,
/// generic method type arguments, properties, and imported CLR interfaces.
open class Issue6045BaseGenericInterfaceCallBinderTests {
    @Fact
    func ConstructedGenericBaseInterface_ExactRepro_SubstitutesReturnType() {
        let source = `
interface IDefault[T] {
    func Read() T { return default(T) }
}

class C : IDefault[int32] {
    func Value() int32 -> base[IDefault[int32]].Read()
}

C().Value()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func ConstructedGenericBaseInterface_ParametersAndOverloads_ConvertAndDisambiguate() {
        let source = `
interface IDefault[T] {
    func Combine(v T) T { return v }
    func Combine(v T, bonus int64) int64 { return bonus }
}

class C : IDefault[int64] {
    // 41 (int32) converts implicitly to T = int64 and selects the single-arg overload.
    func First() int64 -> base[IDefault[int64]].Combine(41) + 1L
    func Second() int64 -> base[IDefault[int64]].Combine(10, 25L)
}

let c = C()
c.First() * 100L + c.Second()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4225L, result.Value)
    }

    @Fact
    func ConstructedGenericBaseInterface_GenericMethods_ExplicitAndInferred_Substitute() {
        let source = `
interface IDefault[T] {
    func Map[U](v T, f (T) -> U) U { return f(v) }
    func Pair[U](v T, u U) (T, U) { return (v, u) }
}

class C : IDefault[int32] {
    func Run() string {
        let mapped = base[IDefault[int32]].Map[string](41, (x int32) -> (x + 1).ToString())
        let (n, label) = base[IDefault[int32]].Pair(7, "ok")
        return "${mapped}:${n}:${label}"
    }
}

C().Run()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("42:7:ok", result.Value)
    }

    @Fact
    func ConstructedGenericBaseInterface_DefaultProperties_ReadAndWriteSubstitute() {
        let source = `
interface IBaseProp[T] {
    prop Tag T {
        get { return default(T) }
    }
}

interface IDefaultProp[T] : IBaseProp[T] {
    prop Value T {
        get { return default(T) }
        set { }
    }
}

class C : IDefaultProp[int32] {
    func Check() int32 {
        base[IDefaultProp[int32]].Value = 12
        return base[IDefaultProp[int32]].Value + base[IBaseProp[int32]].Tag + 9
    }
}

C().Check()
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func ConstructedGenericBaseInterface_StaticAndIndexer_SubstituteIndependently() {
        let source = `
interface IBox[T] {
    shared {
        func Make(v T) T { return v }
    }
    prop this[index T] T {
        get { return index }
    }
}

class C : IBox[int32] {
}

let viaStatic = IBox[int32].Make(15)
let viaIndexer IBox[int32] = C()
viaStatic + viaIndexer[27]
`
        let result = EmittedOracle.Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConstructedGenericBaseInterface_MismatchedTypeArgument_ReportsGS0338() {
        let source = `
interface IDefault[T] {
    func Read() T { return default(T) }
}

class C : IDefault[int32] {
    func Value() string -> base[IDefault[string]].Read()
}
`
        let diagnostics = Compile(source)
        let diag = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0338")
        Assert.Contains("IDefault[string]", diag.Message, StringComparison.Ordinal)
    }

    @Fact
    func ConstructedGenericBaseInterface_InvalidTargetType_ReportsGS0338() {
        let source = `
interface IDefault[T] {
    func Read() T { return default(T) }
}

class C : IDefault[int32] {
    func Value() int32 -> base[int32].Read()
}
`
        let diagnostics = Compile(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0338")
    }

    @Fact
    func ConstructedGenericBaseInterface_WrongArgumentType_ReportsGS0154() {
        let source = `
interface IDefault[T] {
    func Echo(v T) T { return v }
}

class C : IDefault[int32] {
    func Value() int32 -> base[IDefault[int32]].Echo("bad")
}
`
        let diagnostics = Compile(source)
        let diag = Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0154")
        Assert.Contains("int32", diag.Message, StringComparison.Ordinal)
    }

    @Fact
    func ConstructedGenericBaseInterface_AbstractMethodAndProperty_ReportGS0340() {
        let source = `
interface IDefault[T] {
    func MissingBody() T;
    prop AbstractProp T { get; }
}

class C : IDefault[int32] {
    func MissingBody() int32 -> 1
    prop AbstractProp int32 -> 2
    func CallMethod() int32 -> base[IDefault[int32]].MissingBody()
    func CallProp() int32 -> base[IDefault[int32]].AbstractProp
}
`
        let diagnostics = Compile(source)
        let gs0340 = diagnostics.Where((d Diagnostic) -> d.Id == "GS0340").ToList()
        Assert.Equal(2, gs0340.Count)
    }

    @Fact
    func ConstructedGenericBaseInterface_StaticMethodViaBase_ReportsGS0339() {
        let source = `
interface IDefault[T] {
    shared {
        func Make(v T) T { return v }
    }
}

class C : IDefault[int32] {
    func Bad() int32 -> base[IDefault[int32]].Make(1)
}
`
        let diagnostics = Compile(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0339")
    }

    @Fact
    func ConstructedGenericBaseInterface_PrivateHelper_ReportsGS0341() {
        let source = `
interface IDefault[T] {
    func Read() T { return Helper() }
    private func Helper() T { return default(T) }
}

class C : IDefault[int32] {
    func Bad() int32 -> base[IDefault[int32]].Helper()
}
`
        let diagnostics = Compile(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0341")
    }

    @Fact
    func ConstructedGenericBaseInterface_ImportedClrInterface_BindsAndRejectsControls() {
        let csharp = `using System;
namespace ProbeClr {
    public interface IClrDefault<T> {
        T Read() => default!;
        T Echo(T value) => value;
        T Abs();
    }
}`
        using let fixture = CSharpFixture(csharp)
        let refs = fixture.RuntimeReferences()
        let accepted = `package App
import ProbeClr

class C : IClrDefault[int32] {
    func Abs() int32 -> 99
    func Run() int32 -> base[IClrDefault[int32]].Echo(41) + 1 + base[IClrDefault[int32]].Read()
}
`
        Assert.Empty(Compile(accepted, refs))

        let badArg = `package App
import ProbeClr

class C : IClrDefault[int32] {
    func Abs() int32 -> 99
    func Bad() int32 -> base[IClrDefault[int32]].Echo("wrong")
}
`
        Assert.NotEmpty(Compile(badArg, refs))

        let badSelector = `package App
import ProbeClr

class C : IClrDefault[int32] {
    func Abs() int32 -> 99
    func Bad() string -> base[IClrDefault[string]].Read()
}
`
        Assert.Contains(Compile(badSelector, refs), (d Diagnostic) -> d.Id == "GS0338")

        let abstractMember = `package App
import ProbeClr

class C : IClrDefault[int32] {
    func Abs() int32 -> base[IClrDefault[int32]].Abs()
}
`
        Assert.Contains(Compile(abstractMember, refs), (d Diagnostic) -> d.Id == "GS0340")
    }

    @Fact
    func InheritedGenericBaseInterface_DependentMethodConstraint_EnforcesBound() {
        let accepted = `
open class Animal {
}
class Dog : Animal {
}
interface IBase[T] {
    func Accept[U T](u U) U { return u }
    func Accept[U T](u U, tag string) U { return u }
}
interface IDerived[T] : IBase[T] {
}
class Handler : IDerived[Animal] {
    func Run(d Dog) Dog {
        let fn = () -> base[IDerived[Animal]].Accept[Dog](d)
        return fn()
    }
}
`
        Assert.Empty(Compile(accepted))

        let rejected = `
open class Animal {
}
interface IBase[T] {
    func Accept[U T](u U) U { return u }
    func Accept[U T](u U, tag string) U { return u }
}
interface IDerived[T] : IBase[T] {
}
class Handler : IDerived[Animal] {
    func Bad() string -> base[IDerived[Animal]].Accept[string]("bad")
}
`
        let diagnostics = Compile(rejected)
        Assert.NotEmpty(diagnostics)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func ImportedClrInterface_IndexerInitOnlyAndRefProperty_EnforceContracts() {
        let csharp = `using System;
namespace ProbeClr {
    public static class Store {
        public static int Value = 41;
    }
    public interface IClrProps<T> {
        T this[int index] => default!;
        T InitProp { get => default!; init { } }
        ref int RefVal => ref Store.Value;
    }
}`
        using let fixture = CSharpFixture(csharp)
        let refs = fixture.RuntimeReferences()

        let indexerAsProp = `package App
import ProbeClr

class C : IClrProps[int32] {
    func ReadItem() int32 -> base[IClrProps[int32]].Item
    func WriteItem() { base[IClrProps[int32]].Item = 1 }
}
`
        let indexerDiags = Compile(indexerAsProp, refs)
        Assert.Equal(2, indexerDiags.Where((d Diagnostic) -> d.Id == "GS0339").Count())

        let initOnlyOutsideCtor = `package App
import ProbeClr

class C : IClrProps[int32] {
    func WriteInit() { base[IClrProps[int32]].InitProp = 7 }
}
`
        let initDiags = Compile(initOnlyOutsideCtor, refs)
        Assert.Contains(initDiags, (d Diagnostic) -> d.Id == "GS0372")

        let refPropRead = `package App
import ProbeClr

class C : IClrProps[int32] {
    func ReadRefPlusOne() int32 -> base[IClrProps[int32]].RefVal + 1
}
`
        Assert.Empty(Compile(refPropRead, refs))
    }

    @Fact
    func ConstructedGenericBaseInterface_PropertyRhsTargetTypeAndInitOnly_AreEnforced() {
        let validSource = `
interface IDefault[T] {
    prop Transform (T) -> T {
        get { return (x T) -> x }
        set { }
    }
    prop InitVal T {
        get { return default(T) }
        init { }
    }
}

class C : IDefault[int32] {
    init() {
        base[IDefault[int32]].InitVal = 5
    }
    func Configure() {
        base[IDefault[int32]].Transform = (x) -> x + 1
    }
}
`
        Assert.Empty(Compile(validSource))

        let invalidInitSource = `
interface IDefault[T] {
    prop InitVal T {
        get { return default(T) }
        init { }
    }
}

class C : IDefault[int32] {
    func Bad() {
        base[IDefault[int32]].InitVal = 5
    }
}
`
        Assert.Contains(Compile(invalidInitSource), (d Diagnostic) -> d.Id == "GS0372")
    }

    @Fact
    func ConstructedGenericBaseInterface_AsyncMethod_PreservesTaskReturnType() {
        let source = `
import System.Threading.Tasks

interface IAsyncDefault[T] {
    func ReadAsync() Task[T] {
        return Task.FromResult(default(T))
    }
    func StreamAsync() async sequence[T] {
        await Task.Yield()
        yield default(T)
    }
}

class C : IAsyncDefault[int32] {
    async func UseAsync() Task[int32] {
        var total = (await base[IAsyncDefault[int32]].ReadAsync()) + 42
        await for item in base[IAsyncDefault[int32]].StreamAsync() {
            total += item
        }
        return total
    }
}
`
        Assert.Empty(Compile(source))
    }

    @Fact
    func RefStruct_BaseInterfaceCallAndProperty_ReportGS0219() {
        let sourceUser = `
interface IDefault[T] {
    func Echo(v T) T { return v }
    prop Value T {
        get { return default(T) }
        set { }
    }
}

ref struct R : IDefault[int32] {
    func Echo(v int32) int32 -> v
    func BadMethod() int32 -> base[IDefault[int32]].Echo(1)
    func BadPropRead() int32 -> base[IDefault[int32]].Value
    func BadPropWrite() { base[IDefault[int32]].Value = 2 }
}
`
        let userDiags = Compile(sourceUser)
        Assert.Equal(3, userDiags.Where((d Diagnostic) -> d.Id == "GS0219").Count())

        let csharp = `using System;
namespace ProbeClr {
    public interface IClrDefault<T> {
        T Echo(T value) => value;
        T Prop { get => default!; set { } }
    }
}`
        using let fixture = CSharpFixture(csharp)
        let sourceClr = `package App
import ProbeClr

ref struct R : IClrDefault[int32] {
    func BadClrMethod() int32 -> base[IClrDefault[int32]].Echo(1)
    func BadClrPropRead() int32 -> base[IClrDefault[int32]].Prop
    func BadClrPropWrite() { base[IClrDefault[int32]].Prop = 2 }
}
`
        let clrDiags = Compile(sourceClr, fixture.RuntimeReferences())
        Assert.Equal(3, clrDiags.Where((d Diagnostic) -> d.Id == "GS0219").Count())
    }

    @Fact
    func BaseInterfaceProperty_SemanticModel_PreservesPropertySymbolAndMemberGroup() {
        let csharp = `namespace ProbeClr {
    public interface IClrProps<T> {
        T ClrProp { get => default!; set { } }
    }
}`
        using let fixture = CSharpFixture(csharp)
        let source = `package App
import ProbeClr

interface IDefaultProp[T] {
    prop GsProp T {
        get { return default(T) }
        set { }
    }
}

class C : IDefaultProp[int32], IClrProps[int32] {
    func Test() int32 {
        base[IDefaultProp[int32]].GsProp = 10
        let a = base[IDefaultProp[int32]].GsProp
        base[IClrProps[int32]].ClrProp = 20
        let b = base[IClrProps[int32]].ClrProp
        return a + b
    }
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(fixture.RuntimeReferences(), tree)
        compilation.RecordMemberGroups = true
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        let model = compilation.GetSemanticModel(tree)
        let calls = tree.Root.DescendantNodes().OfType[BaseInterfaceCallExpressionSyntax]().ToArray()
        Assert.Equal(4, calls.Length)

        let gsWriteProp = Assert.IsType[PropertySymbol](model.GetSymbolInfo(calls[0]).Symbol)
        Assert.Equal("GsProp", gsWriteProp.Name)
        Assert.Equal("int32", gsWriteProp.Type.Name)
        let gsWriteGroup = model.GetMemberGroup(calls[0])
        Assert.Equal("GsProp", Assert.Single(gsWriteGroup).Name)

        let gsReadProp = Assert.IsType[PropertySymbol](model.GetSymbolInfo(calls[1]).Symbol)
        Assert.Equal("GsProp", gsReadProp.Name)
        Assert.Equal("int32", gsReadProp.Type.Name)
        let gsReadGroup = model.GetMemberGroup(calls[1])
        Assert.Equal("GsProp", Assert.Single(gsReadGroup).Name)

        let clrWriteProp = Assert.IsType[PropertySymbol](model.GetSymbolInfo(calls[2]).Symbol)
        Assert.Equal("ClrProp", clrWriteProp.Name)
        Assert.Equal("int32", clrWriteProp.Type.Name)
        let clrWriteGroup = model.GetMemberGroup(calls[2])
        Assert.Equal("ClrProp", Assert.Single(clrWriteGroup).Name)

        let clrReadProp = Assert.IsType[PropertySymbol](model.GetSymbolInfo(calls[3]).Symbol)
        Assert.Equal("ClrProp", clrReadProp.Name)
        Assert.Equal("int32", clrReadProp.Type.Name)
        let clrReadGroup = model.GetMemberGroup(calls[3])
        Assert.Equal("ClrProp", Assert.Single(clrReadGroup).Name)
    }

    shared {
        private func Compile(source string, references ReferenceResolver? = nil) System
            .Collections
            .Generic
            .IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(references, tree)
            return compilation
                .GlobalScope
                .Diagnostics
                .Concat(compilation.GetDeclarationDiagnostics())
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToList()
        }
    }
}
