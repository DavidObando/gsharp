// <copyright file="Issue3523FunctionPointerMemberInvocationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.InteropServices
import Xunit

/// Issue #3523: every expression whose value has a function-pointer type is
/// callable, including source fields and properties that previously fell
/// through member-method lookup to GS0159.
open class Issue3523FunctionPointerMemberInvocationTests {
    @Theory
    @InlineData("Cdecl", CallingConvention(2))
    @InlineData("Stdcall", CallingConvention(3))
    @InlineData("Thiscall", CallingConvention(4))
    @InlineData("Fastcall", CallingConvention(5))
    func UnmanagedFieldCall_BindsFieldLoadAndCallingConvention(
        convention string,
        expectedConvention CallingConvention
    ) {
        let source = (`package Issue3523

unsafe struct Dispatch {
    var Apply unmanaged[` + "$convention" + `] (int32) -> int32
}

unsafe func Main() int32 {
    let dispatch = Dispatch{}
    return dispatch.Apply(41)
}`)
        let program = BindWithoutErrors(source)
        let invocation = Assert.Single(CollectInvocations(program))
        let field = Assert.IsType[BoundFieldAccessExpression](invocation.Pointer)
        Assert.Equal("Apply", field.Field.Name)
        Assert.Equal("Dispatch", field.StructType?.Name)
        Assert.False(invocation.FunctionPointerType.IsManaged)
        Assert.Equal(expectedConvention, invocation.FunctionPointerType.CallingConvention)
        Assert.Same(invocation.FunctionPointerType, field.Type)
        Assert.Single(invocation.Arguments)
        Assert.Same(TypeSymbol.Int32, invocation.Arguments[0].Type)
    }

    @Fact
    func ManagedPointer_AllExpressionCalleeForms_BindFunctionPointerInvocations() {
        const source = `package Issue3523Forms

unsafe func increment(value int32) int32 -> value + 1

unsafe struct Dispatch {
    var Apply *func(int32) int32
    prop Handler *func(int32) int32 -> Apply

    func InvokeField(value int32) int32 -> Apply(value)
    func InvokeProperty(value int32) int32 -> Handler(value)

    shared {
        var SharedApply *func(int32) int32
        prop SharedHandler *func(int32) int32 -> SharedApply
    }
}

unsafe func invokeRef(ref pointer *func(int32) int32, value int32) int32 {
    return pointer(value)
}

unsafe func Main() {
    let dispatch = Dispatch{Apply: &increment}
    Dispatch.SharedApply = &increment
    let pointers = []*func(int32) int32{&increment}
    var pointer = &increment

    dispatch.Apply(1)
    dispatch.Handler(2)
    dispatch.InvokeField(3)
    dispatch.InvokeProperty(4)
    Dispatch.SharedApply(5)
    Dispatch.SharedHandler(6)
    pointers[0](7)
    (true ? dispatch.Apply : dispatch.Handler)(8)
    (dispatch.Apply)(9)
    invokeRef(ref pointer, 10)
}`
        let invocations = CollectInvocations(BindWithoutErrors(source))
        Assert.All(
            invocations,
            (invocation BoundFunctionPointerInvocationExpression) -> Assert.True(
                invocation.FunctionPointerType.IsManaged
            )
        )
        Assert.Contains(
            invocations,
            (invocation BoundFunctionPointerInvocationExpression) -> invocation.Pointer is BoundFieldAccessExpression
        )
        Assert.Contains(
            invocations,
            (invocation BoundFunctionPointerInvocationExpression) -> invocation.Pointer is BoundPropertyAccessExpression
        )
        Assert.Contains(
            invocations,
            (invocation BoundFunctionPointerInvocationExpression) -> invocation.Pointer is BoundIndexExpression
        )
        Assert.Contains(
            invocations,
            (invocation BoundFunctionPointerInvocationExpression) -> invocation.Pointer is BoundConditionalExpression
        )
        Assert.Contains(
            invocations,
            (invocation BoundFunctionPointerInvocationExpression) -> invocation.Pointer is BoundVariableExpression
        )
    }

    @Fact
    func PointerAndDelegateMembers_KeepDistinctBoundNodes() {
        const source = `package Issue3523Distinct

unsafe func increment(value int32) int32 -> value + 1

unsafe struct Mixed {
    var Pointer *func(int32) int32
    var Handler (int32) -> int32
}

unsafe func Main() {
    let mixed = Mixed{
        Pointer: &increment,
        Handler: (value int32) -> value + 2
    }
    mixed.Pointer(1)
    mixed.Handler(1)
}`
        let program = BindWithoutErrors(source)
        Assert.Single(CollectInvocations(program))
        let indirectCalls = Issue3523FunctionPointerMemberInvocationTests.IndirectCallCollector()
        VisitProgram(program, indirectCalls)
        Assert.Single(indirectCalls.Calls)
        Assert.IsType[FunctionTypeSymbol](indirectCalls.Calls[0].Target.Type)
    }

    @Fact
    func InterfacePropertyAndStaticField_BindFunctionPointerLoads() {
        const source = `package Issue3523Interfaces

interface IDispatch {
    prop Apply unmanaged[Cdecl] (int32) -> int32 { get }
}

unsafe struct Dispatch : IDispatch {
    var Pointer unmanaged[Cdecl] (int32) -> int32
    prop Apply unmanaged[Cdecl] (int32) -> int32 -> Pointer
}

interface IStaticDispatch {
    shared {
        var Apply unmanaged[Cdecl] (int32) -> int32
    }
}

unsafe func invoke(dispatch IDispatch) int32 {
    return dispatch.Apply(41)
}

unsafe func invokeStatic() int32 {
    return IStaticDispatch.Apply(41)
}`
        let invocations = CollectInvocations(BindWithoutErrors(source))
        Assert.Equal(2, invocations.Count)
        let property = Assert.IsType[BoundPropertyAccessExpression](
            invocations.Single(
                (
                    invocation BoundFunctionPointerInvocationExpression
                ) -> invocation.Pointer is BoundPropertyAccessExpression
            )
                .Pointer
        )
        Assert.Null(property.StructType)
        Assert.IsType[InterfaceSymbol](property.Receiver?.Type)
        let field = Assert.IsType[BoundFieldAccessExpression](
            invocations.Single(
                (
                    invocation BoundFunctionPointerInvocationExpression
                ) -> invocation.Pointer is BoundFieldAccessExpression
            )
                .Pointer
        )
        Assert.Equal("IStaticDispatch", field.InterfaceType?.Name)
        Assert.Null(field.Receiver)
    }

    @Fact
    func PointerMemberCall_ReportsCallDiagnostics_NotMethodLookup() {
        const source = `package Issue3523Diagnostics

unsafe struct Dispatch {
    var Apply unmanaged[Cdecl] (int32) -> int32
    var Value int32
}

unsafe func Main() {
    let dispatch = Dispatch{}
    dispatch.Apply()
    dispatch.Apply("bad")
    dispatch.Value(41)
}`
        let errors = GetErrors(source)
        Assert.Equal(
            []string{"GS0144", "GS0155", "GS0159"},
            errors.Select((diagnostic Diagnostic) -> diagnostic.Id).ToArray()
        )
    }

    @Fact
    func ManagedPointerMember_StillRequiresUnsafeContext() {
        const source = `package Issue3523Unsafe

struct Dispatch {
    var Apply *func(int32) int32
}`
        let error = Assert.Single(GetErrors(source))
        Assert.Equal("GS0404", error.Id)
    }

    @Fact
    func NullableDelegateMember_KeepsDelegateDiagnostic() {
        const source = `package Issue3523NullableDelegate

struct Mixed {
    var Handler ((int32) -> int32)?
}

func Main() {
    let mixed = Mixed{}
    mixed.Handler(1)
}`
        let error = Assert.Single(GetErrors(source))
        Assert.Equal("GS0503", error.Id)
    }

    @Fact
    func ManagedPointerCallsOutsideUnsafe_ReportAtEveryCallee() {
        const source = `package Issue3523UnsafeCalls

unsafe struct Dispatch {
    var Apply *func(int32) int32
    prop Handler *func(int32) int32 -> Apply
    var Pointers []*func(int32) int32
    shared { var SharedApply *func(int32) int32 }
}

open unsafe class Base {
    protected var Apply *func(int32) int32
}

class Derived : Base {
    func Invoke() { Apply(1) }
}

func Main() {
    let dispatch = Dispatch{}
    dispatch.Apply(1)
    dispatch.Handler(2)
    (dispatch.Apply)(3)
    dispatch.Pointers[0](4)
    Dispatch.SharedApply(5)
}`
        let errors = GetErrors(source)
        Assert.Equal(6, errors.Length)
        Assert.All(errors, (diagnostic Diagnostic) -> Assert.Equal("GS0404", diagnostic.Id))
        Assert.Equal(
            []string{"Apply", "Apply", "Handler", "(dispatch.Apply)", "dispatch.Pointers[0]", "SharedApply"},
            errors.Select((diagnostic Diagnostic) -> diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        )
    }

    @Fact
    func UnmanagedPointerCalls_DoNotRequireUnsafeContext() {
        const source = `package Issue3523UnmanagedCalls

struct Dispatch {
    var Apply unmanaged[Cdecl] (int32) -> int32
    prop Handler unmanaged[Cdecl] (int32) -> int32 -> Apply
    shared { var SharedApply unmanaged[Cdecl] (int32) -> int32 }
}

func Main() {
    let dispatch = Dispatch{}
    dispatch.Apply(1)
    dispatch.Handler(2)
    (dispatch.Apply)(3)
    Dispatch.SharedApply(4)
}`
        let _ = BindWithoutErrors(source)
    }

    @Fact
    func GenericStructClassAndMethodPointerSignatures_Close() {
        const source = `package Issue3523GenericOwners

unsafe func identity(value int32) int32 -> value
unsafe func choose[T](pointer *func(T) T) *func(T) T -> pointer

unsafe struct Dispatch[T] {
    var Apply *func(T) T
    prop Handler *func(T) T -> Apply
    shared { var SharedApply *func(T) T }
}

unsafe class Holder[T] {
    let Apply *func(T) T
    init(apply *func(T) T) { Apply = apply }
}

unsafe func Main() {
    let dispatch = Dispatch[int32]{Apply: &identity}
    Dispatch[int32].SharedApply = &identity
    let holder = Holder[int32](&identity)
    let selected *func(int32) int32 = choose[int32](&identity)
    let a int32 = dispatch.Apply(41)
    let b int32 = dispatch.Handler(42)
    let c int32 = Dispatch[int32].SharedApply(43)
    let d int32 = holder.Apply(44)
    let e int32 = selected(45)
}`
        let invocations = CollectInvocations(BindWithoutErrors(source))
        Assert.Equal(5, invocations.Count)
        Assert.All(
            invocations,
            (invocation BoundFunctionPointerInvocationExpression) -> {
                Assert.True(invocation.FunctionPointerType.IsManaged)
                Assert.Same(TypeSymbol.Int32, Assert.Single(invocation.FunctionPointerType.ParameterTypes))
                Assert.Same(TypeSymbol.Int32, invocation.FunctionPointerType.ReturnType)
            }
        )
    }

    @Fact
    func GenericInterfaceInstanceAndStaticPointerSignatures_Close() {
        const source = `package Issue3523GenericInterface

interface IDispatch[T] {
    prop Apply unmanaged[Cdecl] (T) -> T { get }
    shared { var SharedApply unmanaged[Cdecl] (T) -> T }
}

struct Dispatch[T] : IDispatch[T] {
    var Pointer unmanaged[Cdecl] (T) -> T
    prop Apply unmanaged[Cdecl] (T) -> T -> Pointer
}

func invoke(dispatch IDispatch[int32]) int32 {
    let first int32 = dispatch.Apply(41)
    let second int32 = IDispatch[int32].SharedApply(42)
    return first + second
}`
        let invocations = CollectInvocations(BindWithoutErrors(source))
        Assert.Equal(2, invocations.Count)
        Assert.All(
            invocations,
            (invocation BoundFunctionPointerInvocationExpression) -> {
                Assert.False(invocation.FunctionPointerType.IsManaged)
                Assert.Equal(CallingConvention.Cdecl, invocation.FunctionPointerType.CallingConvention)
                Assert.Same(TypeSymbol.Int32, Assert.Single(invocation.FunctionPointerType.ParameterTypes))
                Assert.Same(TypeSymbol.Int32, invocation.FunctionPointerType.ReturnType)
            }
        )
    }

    @Fact
    func GenericInterfaceMemberTypes_AreSubstitutedWithoutFlowNarrowing() {
        const source = `package Issue3523GenericInterfaceMemberTypes

interface IBox[T] {
    prop Value T { get; set; }
    shared { var Shared T }
}

interface IDerivedBox[T] : IBox[T] { }

class IntBox : IDerivedBox[int32] {
    prop Value int32 { get; set; }
}

open class Animal { }
class Dog : Animal { func Bark() string -> "woof" }
class SmartBox { prop Pet Animal { get; init; } }

func getBox(box IDerivedBox[int32]) IDerivedBox[int32] -> box

func read(box IDerivedBox[int32], smart SmartBox) {
    box.Value = 1
    getBox(box).Value += 2
    let value int32 = box.Value
    IBox[int32].Shared = 4
    IBox[int32].Shared += 1
    let shared int32 = IBox[int32].Shared
    if smart.Pet is Dog {
        smart.Pet.Bark()
    }
}`
        let program = BindWithoutErrors(source)
        let collector = MemberAccessCollector()
        VisitProgram(program, collector)
        let genericProperties = collector
            .Properties
            .Where(
            (access BoundPropertyAccessExpression) -> access
                .Property
                .Name == "Value" &&
                access
                .Receiver
                ?.Type is InterfaceSymbol
        )
            .ToArray()
        Assert.Equal(2, genericProperties.Length)
        Assert.All(
            genericProperties,
            (genericProperty BoundPropertyAccessExpression) -> {
                Assert.Same(TypeSymbol.Int32, genericProperty.SubstitutedType)
                Assert.Null(genericProperty.NarrowedType)
                Assert.Same(TypeSymbol.Int32, genericProperty.Type)
            }
        )
        let genericAssignments = collector
            .Assignments
            .Where((assignment BoundPropertyAssignmentExpression) -> assignment.Property.Name == "Value")
            .ToArray()
        Assert.Equal(2, genericAssignments.Length)
        Assert.All(
            genericAssignments,
            (assignment BoundPropertyAssignmentExpression) -> {
                Assert.Same(TypeSymbol.Int32, assignment.SubstitutedType)
                Assert.Equal("IBox[int32]", assignment.InterfaceType?.Name)
                Assert.Same(TypeSymbol.Int32, assignment.Value.Type)
                Assert.Same(TypeSymbol.Int32, assignment.Type)
            }
        )
        let genericFields = collector
            .Fields
            .Where((access BoundFieldAccessExpression) -> access.Field.Name == "Shared" && access.InterfaceType != nil)
            .ToArray()
        Assert.Equal(2, genericFields.Length)
        Assert.All(
            genericFields,
            (genericField BoundFieldAccessExpression) -> {
                Assert.Same(TypeSymbol.Int32, genericField.SubstitutedType)
                Assert.Null(genericField.NarrowedType)
                Assert.Same(TypeSymbol.Int32, genericField.Type)
            }
        )
        let genericFieldAssignments = collector
            .FieldAssignments
            .Where((assignment BoundFieldAssignmentExpression) -> assignment.Field.Name == "Shared")
            .ToArray()
        Assert.Equal(2, genericFieldAssignments.Length)
        Assert.All(
            genericFieldAssignments,
            (assignment BoundFieldAssignmentExpression) -> {
                Assert.Equal("IBox[int32]", assignment.InterfaceType?.Name)
                Assert.Same(TypeSymbol.Int32, assignment.ResultType)
                Assert.Same(TypeSymbol.Int32, assignment.Value.Type)
                Assert.Same(TypeSymbol.Int32, assignment.Type)
            }
        )
        let narrowedProperty = Assert.Single(
            collector.Properties,
            (access BoundPropertyAccessExpression) -> access
                .Property
                .Name == "Pet" &&
                (access.NarrowedType is StructSymbol and {Name: "Dog"})
        )
        Assert.Null(narrowedProperty.SubstitutedType)
    }

    @Fact
    func GenericInterfaceWrites_BindValuesAgainstClosedTypes() {
        const source = `package Issue3523GenericInterfaceWriteDiagnostics

interface IBox[T] {
    prop Value T { get; set; }
    shared { var Shared T }
}

func bad(box IBox[int32]) {
    box.Value = "bad"
    IBox[int32].Shared = "bad"
}`
        let errors = GetErrors(source)
        Assert.Equal(2, errors.Length)
        Assert.All(
            errors,
            (diagnostic Diagnostic) -> {
                Assert.Equal("GS0155", diagnostic.Id)
                Assert.Contains("string", diagnostic.Message)
                Assert.Contains("int32", diagnostic.Message)
            }
        )
    }

    @Fact
    func ClosedGenericPointerMembers_RejectWrongArgumentTypes() {
        const source = `package Issue3523GenericDiagnostics

unsafe func identity(value int32) int32 -> value

unsafe struct Dispatch[T] {
    var Apply *func(T) T
    prop Handler *func(T) T -> Apply
    shared { var SharedApply *func(T) T }
}

interface IDispatch[T] {
    prop Apply unmanaged[Cdecl] (T) -> T { get }
    shared { var SharedApply unmanaged[Cdecl] (T) -> T }
}

unsafe func bad(dispatch Dispatch[int32], iface IDispatch[int32]) {
    dispatch.Apply("bad")
    dispatch.Handler("bad")
    Dispatch[int32].SharedApply("bad")
    iface.Apply("bad")
    IDispatch[int32].SharedApply("bad")
}`
        let errors = GetErrors(source)
        Assert.Equal(5, errors.Length)
        Assert.All(
            errors,
            (diagnostic Diagnostic) -> {
                Assert.Equal("GS0155", diagnostic.Id)
                Assert.Contains("string", diagnostic.Message)
                Assert.Contains("int32", diagnostic.Message)
            }
        )
    }

    @Fact
    func PointerSubstitution_PreservesAbiAndByRefShapes() {
        let parameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let substitution = Dictionary[TypeParameterSymbol, TypeSymbol]{[parameter] = TypeSymbol.Int32}
        let parameterTypes = ImmutableArray.Create[TypeSymbol](ByRefTypeSymbol.Get(parameter))
        let managed = FunctionPointerTypeSymbol.GetManaged(parameterTypes, PointerTypeSymbol.Get(parameter))
        let unmanaged = FunctionPointerTypeSymbol.Get(
            CallingConvention.StdCall,
            parameterTypes,
            PointerTypeSymbol.Get(parameter)
        )
        let closedManaged = Assert.IsType[FunctionPointerTypeSymbol](Binder.SubstituteType(managed, substitution))
        let closedUnmanaged = Assert.IsType[FunctionPointerTypeSymbol](Binder.SubstituteType(unmanaged, substitution))
        Assert.True(closedManaged.IsManaged)
        Assert.False(closedUnmanaged.IsManaged)
        Assert.Equal(CallingConvention.StdCall, closedUnmanaged.CallingConvention)
        for pointer in[]FunctionPointerTypeSymbol{closedManaged, closedUnmanaged} {
            let byRef = Assert.IsType[ByRefTypeSymbol](Assert.Single(pointer.ParameterTypes))
            Assert.Same(TypeSymbol.Int32, byRef.PointeeType)
            let returnPointer = Assert.IsType[PointerTypeSymbol](pointer.ReturnType)
            Assert.Same(TypeSymbol.Int32, returnPointer.PointeeType)
        }
    }

    @Fact
    func PointerSubstitution_RecursesThroughEveryCompositeWrapper() {
        let parameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let substitution = Dictionary[TypeParameterSymbol, TypeSymbol]{[parameter] = TypeSymbol.Int32}
        let openPointer = FunctionPointerTypeSymbol.GetManaged(
            ImmutableArray.Create[TypeSymbol](
                MapTypeSymbol.Get(TypeSymbol.String, parameter),
                TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](parameter, TypeSymbol.String)),
                SequenceTypeSymbol.Get(parameter),
                AsyncSequenceTypeSymbol.Get(parameter),
                ChannelTypeSymbol.Get(parameter),
                SliceTypeSymbol.Get(parameter),
                ArrayTypeSymbol.Get(parameter, 3),
                FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](parameter), parameter),
                PointerTypeSymbol.Get(parameter)
            ),
            NullableTypeSymbol.Get(parameter)
        )
        let closedPointer = Assert.IsType[FunctionPointerTypeSymbol](Binder.SubstituteType(openPointer, substitution))
        Assert.True(closedPointer.IsManaged)
        Assert.False(
            TypeSymbol.AnyTypeParameter(
                closedPointer,
                (candidate TypeParameterSymbol) -> object.ReferenceEquals(candidate, parameter)
            )
        )
        Assert.IsType[MapTypeSymbol](closedPointer.ParameterTypes[0])
        Assert.IsType[TupleTypeSymbol](closedPointer.ParameterTypes[1])
        Assert.IsType[SequenceTypeSymbol](closedPointer.ParameterTypes[2])
        Assert.IsType[AsyncSequenceTypeSymbol](closedPointer.ParameterTypes[3])
        Assert.IsType[ChannelTypeSymbol](closedPointer.ParameterTypes[4])
        Assert.IsType[SliceTypeSymbol](closedPointer.ParameterTypes[5])
        Assert.IsType[ArrayTypeSymbol](closedPointer.ParameterTypes[6])
        Assert.IsType[FunctionTypeSymbol](closedPointer.ParameterTypes[7])
        Assert.IsType[PointerTypeSymbol](closedPointer.ParameterTypes[8])
        let nullableReturn = Assert.IsType[NullableTypeSymbol](closedPointer.ReturnType)
        Assert.Same(TypeSymbol.Int32, nullableReturn.UnderlyingType)
    }

    @Fact
    func CompositeGenericPointerSignatures_CloseAcrossStructAndInterface() {
        const source = `package Issue3523CompositePointers

unsafe func combine(
    values map[string,int32],
    pair (int32, string),
    items sequence[int32],
    asyncItems async sequence[int32]) int32 -> 1

async func getAsyncItems() async sequence[int32] { yield 4 }

unsafe struct Dispatch[T] {
    var Apply *func(map[string,T], (T, string), sequence[T], async sequence[T]) T
}

interface IDispatch[T] {
    prop Apply unmanaged[Cdecl] (map[string,T], (T, string), sequence[T], async sequence[T]) -> T { get }
    shared {
        var SharedApply unmanaged[Cdecl] (map[string,T], (T, string), sequence[T], async sequence[T]) -> T
    }
}

unsafe func invoke(dispatch Dispatch[int32], iface IDispatch[int32]) {
    let values = map[string,int32]{"x": 1}
    let pair = (2, "two")
    let items = []int32{3}
    let asyncItems = getAsyncItems()
    dispatch.Apply(values, pair, items, asyncItems)
    iface.Apply(values, pair, items, asyncItems)
    IDispatch[int32].SharedApply(values, pair, items, asyncItems)
}`
        let invocations = CollectInvocations(BindWithoutErrors(source))
        Assert.Equal(3, invocations.Count)
        Assert.All(
            invocations,
            (invocation BoundFunctionPointerInvocationExpression) -> {
                Assert.Same(TypeSymbol.Int32, invocation.FunctionPointerType.ReturnType)
                Assert.Equal(4, invocation.FunctionPointerType.ParameterTypes.Length)
                let map_ = Assert.IsType[MapTypeSymbol](invocation.FunctionPointerType.ParameterTypes[0])
                Assert.Same(TypeSymbol.String, map_.KeyType)
                Assert.Same(TypeSymbol.Int32, map_.ValueType)
                let tuple = Assert.IsType[TupleTypeSymbol](invocation.FunctionPointerType.ParameterTypes[1])
                Assert.Same(TypeSymbol.Int32, tuple.ElementTypes[0])
                Assert.Same(TypeSymbol.String, tuple.ElementTypes[1])
                let sequence_ = Assert.IsType[SequenceTypeSymbol](invocation.FunctionPointerType.ParameterTypes[2])
                Assert.Same(TypeSymbol.Int32, sequence_.ElementType)
                let asyncSequence = Assert.IsType[AsyncSequenceTypeSymbol](
                    invocation.FunctionPointerType.ParameterTypes[3]
                )
                Assert.Same(TypeSymbol.Int32, asyncSequence.ElementType)
            }
        )
    }

    @Fact
    func CompositeGenericPointerCall_RejectsOpenOwnerTypesAfterConstruction() {
        const source = `package Issue3523CompositePointerDiagnostics

unsafe struct Dispatch[T] {
    var Apply *func(map[string,T], (T, string), sequence[T], async sequence[T]) T
}

async func badAsyncItems() async sequence[string] { yield "bad" }

unsafe func bad(dispatch Dispatch[int32]) {
    dispatch.Apply(
        map[string,string]{"x": "bad"},
        ("bad", "pair"),
        []string{"bad"},
        badAsyncItems())
}`
        let errors = GetErrors(source)
        Assert.Equal(4, errors.Length)
        Assert.Equal(
            []string{"GS0155", "GS0155", "GS0155", "GS0156"},
            errors.Select((diagnostic Diagnostic) -> diagnostic.Id)
        )
        Assert.All(errors, (diagnostic Diagnostic) -> Assert.Contains("int32", diagnostic.Message))
    }

    @Fact
    func CallableMembers_ApplyFieldAndGetterAccessibility() {
        const source = `package Issue3523Accessibility

open class Owner {
    private var PrivateField unmanaged[Cdecl] (int32) -> int32
    protected var ProtectedField unmanaged[Cdecl] (int32) -> int32
    internal var InternalField unmanaged[Cdecl] (int32) -> int32
    private var PrivateDelegate (int32) -> int32

    prop Restricted unmanaged[Cdecl] (int32) -> int32 {
        private get -> PrivateField
    }

    func Allowed() {
        PrivateField(1)
        Restricted(2)
        PrivateDelegate(3)
    }
}

class Derived : Owner {
    // Issue #4453: a protected instance member is reachable from a
    // derived class only through a receiver of that class (C# CS1540).
    func AllowedDerived(owner Derived) {
        owner.ProtectedField(1)
        owner.InternalField(2)
    }
}

class Unrelated {
    func Denied(owner Owner) {
        owner.PrivateField(1)
        owner.ProtectedField(2)
        owner.Restricted(3)
        owner.PrivateDelegate(4)
        owner.InternalField(5)
    }
}

interface IStatic {
    shared {
        private var Hidden unmanaged[Cdecl] (int32) -> int32
        internal var Internal unmanaged[Cdecl] (int32) -> int32
        private func Allowed() { IStatic.Hidden(1) }
    }
}

func DeniedStatic() {
    IStatic.Hidden(1)
    (IStatic.Hidden)(2)
    IStatic.Internal(3)
}`
        let errors = GetErrors(source)
        Assert.Equal(
            []string{"GS0472", "GS0379", "GS0472", "GS0472", "GS0472", "GS0472"},
            errors.Select((diagnostic Diagnostic) -> diagnostic.Id)
        )
        Assert.Contains(errors, (diagnostic Diagnostic) -> diagnostic.Message.Contains("Owner.Restricted"))
        Assert.Contains(errors, (diagnostic Diagnostic) -> diagnostic.Message.Contains("Owner.PrivateDelegate"))
        Assert.Equal(2, errors.Count((diagnostic Diagnostic) -> diagnostic.Message.Contains("IStatic.Hidden")))
    }

    @Fact
    func BareCallableMembers_ApplyFieldAndGetterAccessibilityOnce() {
        const source = `package Issue3523BareAccessibility

open class Base {
    private var PrivatePointer unmanaged[Cdecl] (int32) -> int32
    private var PrivateDelegate (int32) -> int32
    private var PrivateNullable ((int32) -> int32)?
    protected var ProtectedPointer unmanaged[Cdecl] (int32) -> int32
    internal var InternalPointer unmanaged[Cdecl] (int32) -> int32

    prop Restricted unmanaged[Cdecl] (int32) -> int32 {
        private get -> PrivatePointer
    }

    prop RestrictedDelegate (int32) -> int32 {
        private get -> PrivateDelegate
    }

    prop Settable unmanaged[Cdecl] (int32) -> int32 {
        private get -> PrivatePointer
        set(value) { PrivatePointer = value }
    }

    func Allowed() {
        PrivatePointer(1)
        PrivateDelegate(2)
        Restricted(3)
        RestrictedDelegate(4)
    }
}

class Derived : Base {
    func Rejected() {
        PrivatePointer(1)
        PrivateDelegate(2)
        PrivateNullable(3)
        Restricted(4)
        RestrictedDelegate(5)
        (PrivatePointer)(6)
        (Restricted)(7)

        ProtectedPointer(8)
        InternalPointer(9)
        Settable = nil
    }
}`
        let errors = GetErrors(source)
        Assert.Equal(7, errors.Length)
        Assert.All(errors, (diagnostic Diagnostic) -> Assert.Equal("GS0472", diagnostic.Id))
        Assert.Equal(
            []string{
                "PrivatePointer",
                "PrivateDelegate",
                "PrivateNullable",
                "Restricted",
                "RestrictedDelegate",
                "PrivatePointer",
                "Restricted"
            },
            errors.Select((diagnostic Diagnostic) -> diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
        )
    }

    private class FunctionPointerInvocationCollector : BoundTreeWalker {
        init() {
            Invocations = List[BoundFunctionPointerInvocationExpression]()
        }

        prop Invocations List[BoundFunctionPointerInvocationExpression] {
            get;
        }

        protected override func VisitFunctionPointerInvocationExpression(
            node BoundFunctionPointerInvocationExpression
        ) {
            Invocations.Add(node)
            base.VisitFunctionPointerInvocationExpression(node)
        }
    }

    private class IndirectCallCollector : BoundTreeWalker {
        init() {
            Calls = List[BoundIndirectCallExpression]()
        }

        prop Calls List[BoundIndirectCallExpression] {
            get;
        }

        protected override func VisitIndirectCallExpression(node BoundIndirectCallExpression) {
            Calls.Add(node)
            base.VisitIndirectCallExpression(node)
        }
    }

    private class MemberAccessCollector : BoundTreeWalker {
        init() {
            Fields = List[BoundFieldAccessExpression]()
            FieldAssignments = List[BoundFieldAssignmentExpression]()
            Properties = List[BoundPropertyAccessExpression]()
            Assignments = List[BoundPropertyAssignmentExpression]()
        }

        prop Fields List[BoundFieldAccessExpression] {
            get;
        }

        prop FieldAssignments List[BoundFieldAssignmentExpression] {
            get;
        }

        prop Properties List[BoundPropertyAccessExpression] {
            get;
        }

        prop Assignments List[BoundPropertyAssignmentExpression] {
            get;
        }

        protected override func VisitFieldAccessExpression(node BoundFieldAccessExpression) {
            Fields.Add(node)
            base.VisitFieldAccessExpression(node)
        }

        protected override func VisitFieldAssignmentExpression(node BoundFieldAssignmentExpression) {
            FieldAssignments.Add(node)
            base.VisitFieldAssignmentExpression(node)
        }

        protected override func VisitPropertyAccessExpression(node BoundPropertyAccessExpression) {
            Properties.Add(node)
            base.VisitPropertyAccessExpression(node)
        }

        protected override func VisitPropertyAssignmentExpression(node BoundPropertyAssignmentExpression) {
            Assignments.Add(node)
            base.VisitPropertyAssignmentExpression(node)
        }
    }

    shared {
        private func BindWithoutErrors(source string) BoundProgram {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let program = compilation.BoundProgram
            let errors = tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .Where((diagnostic Diagnostic) -> diagnostic.IsError)
                .ToArray()
            Assert.True(errors.Length == 0, string.Join("; ", errors.Select((error Diagnostic) -> error.Message)))
            return program
        }

        private func GetErrors(source string)[]Diagnostic {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let program = compilation.BoundProgram
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .Where((diagnostic Diagnostic) -> diagnostic.IsError)
                .GroupBy(
                (diagnostic Diagnostic) -> AnonymousType3_14238997B8C7C6A2(
                    diagnostic.Id,
                    diagnostic.Location.Span.Start,
                    diagnostic.Location.Span.Length
                )
            )
                .Select((group IGrouping[AnonymousType3_14238997B8C7C6A2, Diagnostic]) -> group.First())
                .OrderBy((diagnostic Diagnostic) -> diagnostic.Location.Span.Start)
                .ToArray()
        }

        private func CollectInvocations(program BoundProgram) List[BoundFunctionPointerInvocationExpression] {
            let collector = FunctionPointerInvocationCollector()
            VisitProgram(program, collector)
            return collector.Invocations
        }

        private func VisitProgram(program BoundProgram, walker BoundTreeWalker) {
            for body in program.Functions.Values {
                walker.Visit(body)
            }
            walker.Visit(program.Statement)
        }
    }
}

internal data class AnonymousType3_14238997B8C7C6A2(Id string, Start int32, Length int32) { }
