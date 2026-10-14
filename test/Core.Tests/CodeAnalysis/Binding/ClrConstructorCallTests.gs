// <copyright file="ClrConstructorCallTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import Xunit

/// Phase 4 exit — CLR class instantiation at call sites. Covers both
/// non-generic (`StringBuilder()`) and closed-generic
/// (`List[int]()`, `Dictionary[string, int]()`) imports through
/// the new (cref:BoundClrConstructorCallExpression).
open class ClrConstructorCallTests {
    @Fact
    func StringBuilder_DefaultConstructor_Binds() {
        let source = `
import System.Text

var sb = StringBuilder()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ListInt_DefaultConstructor_Binds() {
        let source = `
import System.Collections.Generic

var lst = List[int32]()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ListInt_WithNestedNonGenericSourceHomonym_BindsImportedGeneric() {
        let source = `
package Demo
import System.Collections.Generic

class DocInline {
    class List {}
}

var lst = List[int32]()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ImportedTopLevelType_WithSameArityNestedSourceHomonym_BindsImportedType() {
        let source = `
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedService {}
}

class Consumer {
    shared {
        func Read() int32 {
            let service = Issue3466ImportedService()
            return service.Value
        }
    }
}

var value = Consumer.Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ImportedGenericType_WithSameArityNestedSourceHomonym_BindsImportedType() {
        let source = `
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedGenericService[T] {
        prop Value T
    }
}

class Consumer {
    shared {
        func Create() Issue3466ImportedGenericService[int32] {
            return Issue3466ImportedGenericService[int32](7)
        }

        func Read() int32 {
            return Create().Value
        }
    }
}

Consumer.Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func NestedGenericSourceHomonym_InContainingScope_TypeAnnotationWinsImportedType() {
        let source = `
package Demo
import System.Collections.Generic

class Holder {
    class List[T] {
        prop SourceValue int32
    }

    shared {
        func Read(value List[int32]) int32 {
            return value.SourceValue
        }
    }
}

0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func EarlierNestedGenericHomonym_DoesNotAffectLexicalLookupAcrossPositions() {
        let source = `
package Demo
import System.Collections.Generic

class Other {
    class List[T] {
        prop OtherValue int32
    }
}

class Holder {
    class List[T] {
        prop SourceValue int32 { get; set; }

        shared {
            prop StaticValue int32 { get; set; }
        }
    }

    shared {
        func Echo(value List[int32]) int32 {
            return value.SourceValue
        }

        func Read() int32 {
            let constructed = List[int32]()
            let initialized = List[int32]{SourceValue: 7}
            List[int32].StaticValue = 5
            List[int32].StaticValue += 1
            return constructed.SourceValue + Echo(initialized) + List[int32].StaticValue
        }
    }
}

Holder.Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(13, result.Value)
    }

    @Fact
    func EarlierNestedHomonym_StaticWriteAndColorColorUseLexicalType() {
        let source = `
package Demo
import System

class Other {
    class Environment {
        shared {
            prop OtherCode int32 { get; set; }
        }
    }
}

class Holder {
    class Environment {
        shared {
            prop Code int32 { get; set; }
        }
    }

    var Environment string = "shadow"

    func Read() int32 {
        Environment.Code = 7
        Environment.Code += 1
        return Environment.Code
    }
}

Holder().Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(8, result.Value)
    }

    @Fact
    func InheritedNestedGenericSourceHomonym_TypeAnnotationWinsImportedType() {
        let source = `
package Demo
import System.Collections.Generic

open class Base[T] {
    protected class List[U] {
        prop SourceValue int32
    }
}

class Derived : Base[int32] {
    func Read(value List[int32]) int32 {
        return value.SourceValue
    }
}

0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func InheritedNestedGenericSourceHomonym_PreservesConstructedBaseSubstitution() {
        let source = `
package Demo
import System.Collections.Generic

open class Base[T] {
    protected class List[U] {
        prop SourceValue T { get; set; }
    }
}

class Derived : Base[int32] {
    func Read(value List[string]) int32 {
        return value.SourceValue
    }

    func Build() int32 {
        let constructed = List[string]()
        constructed.SourceValue = 3
        let initialized = List[string]{SourceValue: 7}
        return Read(constructed) * 10 + Read(initialized)
    }
}

Derived().Build()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(37, result.Value)
    }

    @Fact
    func InaccessibleInheritedNestedGenericSourceHomonym_DoesNotOverrideImportedType() {
        let source = `
package Demo
import System.Collections.Generic

open class Base {
    private class List[T] {
        prop SourceValue int32
    }
}

class Derived : Base {
    func Read(value List[int32]) int32 {
        return value.Count
    }
}

0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TopLevelGenericSourceHomonym_TypeAnnotationWinsImportedType() {
        let source = `
package Demo
import System.Collections.Generic

class List[T] {
    prop SourceValue int32
}

func Read(value List[int32]) int32 {
    return value.SourceValue
}

0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NestedGenericSourceHomonym_OutsideContainingScope_TypeAnnotationBindsImportedType() {
        let source = `
package Demo
import System.Collections.Generic

class Holder {
    class List[T] {
        prop SourceValue int32
    }
}

func Read(value List[int32]) int32 {
    return value.Count
}

0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func WrongArityNestedSourceHomonym_DoesNotBlockImportedGenericTypeOrNestedType() {
        let source = `
package Demo
import System.Collections.Generic

class Holder {
    class List {}

    shared {
        func Count(values List[int32]) int32 {
            return values.Count
        }

        func Current(enumerator List[int32].Enumerator) int32 {
            return enumerator.Current
        }
    }
}

0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ImportedGenericQualifiedType_WithSameArityNestedSourceHomonym_BindsImportedType() {
        let source = `
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedGenericService[T] {
        class Token {
            prop SourceValue int32
        }
    }
}

func Read(value Issue3466ImportedGenericService[int32].Token) int32 {
    return value.ImportedValue
}

0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func NestedGenericQualifiedSourceHomonym_InContainingScope_TypeAnnotationWinsImportedType() {
        let source = `
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedGenericService[T] {
        class Token {
            prop SourceValue int32
        }
    }

    shared {
        func Read(value Issue3466ImportedGenericService[int32].Token) int32 {
            return value.SourceValue
        }
    }
}

0
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ImportedGenericLiteral_WithMatchingNestedMembers_BindsImportedType() {
        let source = `
package Demo
import GSharp.Core.Tests.CodeAnalysis.Binding

class Holder {
    class Issue3466ImportedGenericInitializer[T] {
        prop Value int32 { get; set; }
    }
}

let target = Issue3466ImportedGenericInitializer[string]{Value: 7}
target.Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(107, result.Value)
    }

    @Fact
    func ImportedGenericLiteral_WithWrongArityNestedSourceHomonym_BindsImportedType() {
        let source = `
package Demo
import System.Threading

class Holder {
    class AsyncLocal {
        prop Value int32 { get; set; }
    }

    shared {
        func Read() string {
            let state = AsyncLocal[string]{Value: "ok"}
            return state.Value
        }
    }
}

Holder.Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ok", result.Value)
    }

    @Fact
    func NonGenericStaticReceiver_UsesNestedTypeInsideAndImportedTypeOutside() {
        let source = `
package Demo
import System

class Holder {
    class String {
        shared {
            prop Empty int32 { get { return 7 } }
        }
    }

    shared {
        func ReadNested() int32 {
            return String.Empty
        }
    }
}

Holder.ReadNested() * 100 + String.Empty.Length
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(700, result.Value)
    }

    @Fact
    func ColorColorStaticReceiver_UsesImportedTypeOutsideNestedHomonymContainer() {
        let source = `
package Demo
import System

class Holder {
    class String {
        shared {
            prop Empty int32 { get { return 7 } }
        }
    }
}

class Consumer {
    var String string = "value"

    func Read() string {
        return String.Empty
    }
}

Consumer().Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(string.Empty, result.Value)
    }

    @Fact
    func StaticWrites_UseImportedTypeOutsideNestedHomonymContainer() {
        let source = `
package Demo
import System

class Holder {
    class Environment {
        shared {
            prop ExitCode string { get { return "nested" } }
        }
    }
}

Environment.ExitCode = 0
Environment.ExitCode += 0
Environment.ExitCode
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func ImportedAlias_WithNestedSourceHomonym_BindsImportedTypeAtUnknownArity() {
        let source = `
package Demo
import Service = GSharp.Core.Tests.CodeAnalysis.Binding.Issue3466ImportedService

class Holder {
    class Service {
        prop Value int32
    }
}

func Create() Service {
    return Service()
}

Create().Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func ImportedAliasLiteral_WithMatchingNestedMembers_BindsImportedType() {
        let source = `
package Demo
import Service = GSharp.Core.Tests.CodeAnalysis.Binding.Issue3466ImportedInitializer

class Holder {
    class Service {
        prop Value int32 { get; set; }
    }
}

let target = Service{Value: 7}
target.Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(107, result.Value)
    }

    @Fact
    func NestedSourceHomonym_InContainingScope_TypeAnnotationWinsImportedAlias() {
        let source = NestedAliasScopeSource() + `
func ReadImported(value Service) int32 {
    return value.Value
}

let nested = Holder.Service{Value: 7}
let imported = Service{Value: 7}
Holder.ReadNested(nested) * 1000 + ReadImported(imported)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7107, result.Value)
    }

    @Fact
    func NestedSourceHomonym_InContainingScope_ConstructorWinsImportedAlias() {
        let source = NestedAliasScopeSource() + `
func ConstructImported() int32 {
    let value = Service()
    return value.Value
}

Holder.ConstructNested() * 1000 + ConstructImported()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(100, result.Value)
    }

    @Fact
    func NestedSourceHomonym_InContainingScope_LiteralWinsImportedAlias() {
        let source = NestedAliasScopeSource() + `
func InitializeImported() int32 {
    let value = Service{Value: 7}
    return value.Value
}

Holder.InitializeNested() * 1000 + InitializeImported()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7107, result.Value)
    }

    @Fact
    func NestedSourceHomonym_StaticReadWinsImportedAliasInsideAndAliasWinsOutside() {
        let source = `
package Demo
import Environment = System.Environment

class Holder {
    class Environment {
        shared {
            prop NewLine string { get { return "nested" } }
        }
    }

    shared {
        func ReadNested() string {
            return Environment.NewLine
        }
    }
}

func ReadImported() string {
    return Environment.NewLine
}

Holder.ReadNested() + "|" + ReadImported()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("nested|" + Environment.NewLine, result.Value)
    }

    @Fact
    func TopLevelSourceHomonym_StaticReadWinsImportedAlias() {
        let source = `
package Demo
import Environment = System.Environment

class Environment {
    shared {
        prop NewLine string { get { return "source" } }
    }
}

Environment.NewLine
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("source", result.Value)
    }

    @Fact
    func NestedSourceHomonym_ColorColorStaticReadWinsImportedAlias() {
        let source = `
package Demo
import Environment = System.Environment

class Holder {
    class Environment {
        shared {
            prop NewLine string { get { return "nested" } }
        }
    }

    var Environment string = "shadow"

    func Read() string {
        return Environment.NewLine
    }
}

Holder().Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("nested", result.Value)
    }

    @Fact
    func ExplicitAliasToNestedClrType_WinsOutsideUnrelatedNestedHomonym() {
        let source = `
package Demo
import Folder = GSharp.Core.Tests.CodeAnalysis.Binding.Issue3466ImportedOuter.Folder

class Holder {
    class Folder {
        prop Value int32 { get; set; }

        shared {
            prop Code int32 { get; set; }
        }

        class Child {
            shared {
                const Code int32 = 9
            }
        }
    }

    shared {
        func ReadNested(value Folder) int32 {
            let made = Folder()
            let literal = Folder{Value: 3}
            Folder.Code = 4
            return value.Value + made.Value + literal.Value + Folder.Code + Folder.Child.Code
        }
    }
}

class Consumer {
    var Folder string = "shadow"

    func ReadColorColor() int32 {
        return Folder.Code
    }
}

func ReadImported(value Folder) int32 {
    let made = Folder()
    let literal = Folder{Value: 7}
    Folder.Code = 5
    Folder.Code += 1
    return value.Value + made.Value + literal.Value + Folder.Code + Folder.Child.Code
}

let nested = Holder.Folder{Value: 1}
let imported = Folder{Value: 2}
Holder.ReadNested(nested) * 1000 + ReadImported(imported) + Consumer().ReadColorColor()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(17131, result.Value)
    }

    @Fact
    func ExplicitAliasToSpecialFolder_WinsOutsideUnrelatedNestedEnum() {
        let source = `
package Demo
import Folder = System.Environment.SpecialFolder

class Holder {
    enum Folder {
        Local
    }

    shared {
        func ReadNested() bool {
            return Folder.Local == Folder.Local
        }
    }
}

func ReadImported(value Folder) bool {
    return value == Folder.Desktop
}

Holder.ReadNested() && ReadImported(Folder.Desktop)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func ExplicitAliasToNestedSourceType_WinsOutsideUnrelatedNestedHomonym() {
        let library = `
package Library

class Outer {
    class Target {
        prop Value int32 { get; set; }

        shared {
            prop Code int32 { get; set; }
        }

        class Child {
            shared {
                const Code int32 = 100
            }
        }
    }
}
`
        let consumer = `
package Demo
import Folder = Library.Outer.Target

class Box[T] {
    prop Item T
}

class Holder {
    class Folder {
        prop Value int32 { get; set; }

        shared {
            prop Code int32 { get; set; }
        }
    }

    shared {
        func ReadNested(value Folder) int32 {
            let made = Folder()
            let literal = Folder{Value: 3}
            Folder.Code = 4
            return value.Value + made.Value + literal.Value + Folder.Code
        }
    }
}

class Consumer {
    var Folder string = "shadow"

    func ReadColorColor() int32 {
        return Folder.Code
    }
}

func ReadImported(value Folder) int32 {
    let made = Folder()
    let literal = Folder{Value: 7}
    let boxed Box[Folder] = Box[Folder]{Item: literal}
    Folder.Code = 5
    Folder.Code += 1
    return value.Value + made.Value + boxed.Item.Value + Folder.Code + Folder.Child.Code
}

let nested = Holder.Folder{Value: 1}
let imported = Folder{Value: 2}
Holder.ReadNested(nested) * 1000 + ReadImported(imported) + Consumer().ReadColorColor()
`
        let result = Evaluate(library, consumer)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(8121, result.Value)
    }

    @Fact
    func ExplicitAliasToGlobalSourceType_WinsInsideNestedHomonym() {
        let source = `
import GlobalTarget = Target

class Target {
    init(value int32) {
        Value = value
    }

    prop Value int32 { get; init; }

    shared {
        func Code() int32 -> 4
    }
}

class Holder {
    class Target {
    }

    shared {
        func Make() GlobalTarget {
            return GlobalTarget(3)
        }

        func Read() int32 {
            let value = GlobalTarget(5)
            return value.Value + GlobalTarget.Code()
        }
    }
}

Holder.Read()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(9, result.Value)
    }

    @Fact
    func ExplicitGenericSourceAlias_WinsOutsideUnrelatedNestedHomonym() {
        let library = `
package Library

class Outer {
    class Target[T] {
        prop Value T
    }
}
`
        let consumer = `
package Demo
import Folder = Library.Outer.Target

class Holder {
    class Folder[T] {
        prop Value int32
    }

    shared {
        func ReadNested(value Folder[int32]) int32 {
            let literal = Folder[int32]{Value: 3}
            return value.Value + literal.Value
        }
    }
}

func ReadImported(value Folder[int32]) int32 {
    let literal = Folder[int32]{Value: 7}
    return value.Value + literal.Value
}

let nested = Holder.Folder[int32]{Value: 2}
let imported = Folder[int32]{Value: 1}
Holder.ReadNested(nested) * 100 + ReadImported(imported)
`
        let result = Evaluate(library, consumer)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(508, result.Value)
    }

    @Fact
    func ExplicitGenericClrAlias_WinsOutsideUnrelatedNestedHomonym() {
        let source = `
package Demo
import Folder = System.Collections.Generic.List

class Holder {
    class Folder[T] {
        prop Value int32 { get; set; }
    }

    shared {
        func ReadNested(value Folder[int32]) int32 {
            let made = Folder[int32]()
            let literal = Folder[int32]{Value: 3}
            return value.Value + made.Value + literal.Value
        }
    }
}

func ReadImported(value Folder[int32]) int32 {
    let made = Folder[int32]()
    made.Add(7)
    return value.Count + made[0]
}

let nested = Holder.Folder[int32]{Value: 2}
let imported = Folder[int32]()
imported.Add(1)
Holder.ReadNested(nested) * 100 + ReadImported(imported)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(508, result.Value)
    }

    @Theory
    @InlineData(int32(-1))
    @InlineData(int32(0))
    func ImportedAliasLookup_NonPositiveArity_ResolvesExactNonGenericTarget(preferredArity int32) {
        using let resolver = ReferenceResolver.WithReferences(
            []string{typeof(Issue3466ImportedService).Assembly.Location}
        )
        let scope_ = BoundScope(nil, resolver)
        Assert.True(
            scope_.TryImport(ImportSymbol("Service", typeof(Issue3466ImportedService).FullName!!, declaration: nil))
        )
        Assert.True(scope_.TryLookupImportedClassByArity("Service", preferredArity, declaration: nil, out var imported))
        Assert.Equal(typeof(Issue3466ImportedService).FullName, imported.ClassType.FullName)
    }

    @Theory
    @InlineData(int32(-1))
    @InlineData(int32(0))
    func ImportedGenericAliasLookup_NonPositiveArity_DoesNotResolveOpenType(preferredArity int32) {
        using let resolver = ReferenceResolver.WithReferences(
            []string{typeof(Issue3466ImportedGenericService[_]).Assembly.Location}
        )
        let scope_ = BoundScope(nil, resolver)
        let target = typeof(Issue3466ImportedGenericService[_]).FullName!!.Split('`')[0]
        Assert.True(scope_.TryImport(ImportSymbol("Service", target, declaration: nil)))
        Assert.False(scope_.TryLookupImportedClassByArity("Service", preferredArity, declaration: nil, out _))
        Assert.True(
            scope_.TryLookupImportedClassByArity("Service", preferredArity: 1, declaration: nil, out var imported)
        )
        Assert.True(imported.ClassType.IsGenericTypeDefinition)
    }

    @Fact
    func ImportedGeneric_WithUnknownArity_DoesNotOverrideNestedNonGenericType() {
        let source = `
package Demo
import System.Collections.Generic

class Holder {
    class List {
        prop Value int32 { get; set; }
    }
}

let target = List{Value: 7}
target.Value
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func DictionaryStringInt_DefaultConstructor_Binds() {
        let source = `
import System.Collections.Generic

var d = Dictionary[string, int32]()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func StringBuilder_WithCapacityArgument_Binds() {
        let source = `
import System.Text

var sb = StringBuilder(16)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func StringBuilder_TooManyArguments_Diagnoses() {
        let source = `
import System.Text

var sb = StringBuilder("x", "y", "z")
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func NestedAliasScopeSource() string -> `
package Demo
import Service = GSharp.Core.Tests.CodeAnalysis.Binding.Issue3466ImportedInitializer

class Holder {
    class Service {
        prop Value int32 { get; set; }
    }

    shared {
        func ReadNested(value Service) int32 {
            return value.Value
        }

        func ConstructNested() int32 {
            let value = Service()
            return value.Value
        }

        func InitializeNested() int32 {
            let value = Service{Value: 7}
            return value.Value
        }
    }
}
`

        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Evaluate(sources ...string) EmittedOracleResult {
            return EmittedOracle.Evaluate(sources)
        }
    }
}

class Issue3466ImportedService {
    init() {
        this.Value = 7
    }

    prop Value int32 {
        get;
    }
}

class Issue3466ImportedGenericService[T] {
    init(value T) {
        this.Value = value
    }

    prop Value T {
        get;
    }

    class Token {
        prop ImportedValue int32 -> 11
    }
}

class Issue3466ImportedGenericInitializer[T] {
    private var value int32

    prop Value int32 {
        get -> this.value + 100
        set -> this.value = value
    }
}

class Issue3466ImportedInitializer {
    private var value int32

    prop Value int32 {
        get -> this.value + 100
        set -> this.value = value
    }
}

shared class Issue3466ImportedOuter {
    class Folder {
        init() {
            this.Value = 10
        }

        prop Value int32

        class Child {
            shared {
                prop Code int32 -> 100
            }
        }

        shared {
            prop Code int32
        }
    }
}
