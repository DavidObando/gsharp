// <copyright file="Issue4292UnscopedRefSlotContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.CompilerServices
import Xunit

/// Issue #4292: definition-side `@UnscopedRef` slot contracts.
open class Issue4292UnscopedRefSlotContractTests {
    @Theory
    @InlineData("")
    @InlineData("private func (IRefSlot) Slot(ref fallback int32) ref int32 { return ref this.Value }")
    func AnnotatedInterfaceMethod_AllowsAnnotatedImplementation(explicitImplementation string) {
        let implementation = if explicitImplementation.Length == 0 {
            "public func Slot(ref fallback int32) ref int32 { return ref this.Value }"
        } else {
            explicitImplementation
        }
        let source = `
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    @UnscopedRef
    func Slot(ref fallback int32) ref int32;
}
struct Buffer : IRefSlot {
    var Value int32

    @UnscopedRef
    ` + implementation + `
}
`
        Assert.Empty(Bind(source))
    }

    @Theory
    @InlineData("public func Slot(ref fallback int32) ref int32 { return ref this.Value }")
    @InlineData("private func (IRefSlot) Slot(ref fallback int32) ref int32 { return ref this.Value }")
    func UnannotatedInterfaceMethod_RejectsAnnotatedImplementation(implementation string) {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    func Slot(ref fallback int32) ref int32;
}
struct Buffer : IRefSlot {
    var Value int32

    @UnscopedRef
    ` + implementation + `
}
`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Equal(
            "'@UnscopedRef' cannot be applied because implemented member 'IRefSlot.Slot' does not have @UnscopedRef.",
            diagnostic.Message
        )
    }

    @Fact
    func AnnotatedInterfaceMethod_AllowsImplementationToRemoveContract() {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    @UnscopedRef
    func Slot(ref value int32) ref int32;
}
struct Buffer : IRefSlot {
    public func Slot(ref value int32) ref int32 { return ref value }
}
`
        Assert.Empty(Bind(source))
    }

    @Theory
    @InlineData("public func Get() int32 { return 0 }")
    @InlineData("private func (IValue) Get() int32 { return 0 }")
    func UnannotatedOrdinaryInterfaceMethod_RejectsAnnotatedImplementation(implementation string) {
        let source = `package P
import System.Diagnostics.CodeAnalysis
interface IValue {
    func Get() int32;
}
struct Value : IValue {
    @UnscopedRef
    IMPLEMENTATION
}`.Replace("IMPLEMENTATION", implementation, StringComparison.Ordinal)
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(
            "'@UnscopedRef' cannot be applied because implemented member 'IValue.Get' does not have @UnscopedRef.",
            diagnostic.Message
        )
    }

    @Fact
    func SameSignatureWithoutImplementedInterface_RemainsLegal() {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    func Slot(ref fallback int32) ref int32;
}
struct Buffer {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32) ref int32 { return ref this.Value }
}
`
        Assert.Empty(Bind(source))
    }

    @Fact
    func StructOverride_WithIrrelevantReturn_DoesNotReportPlacementDiagnostic() {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
struct Buffer {
    @UnscopedRef
    override func ToString() string { return "Buffer" }
}
`
        Assert.Empty(Bind(source))
    }

    @Fact
    func PrivateInterfaceHelper_RejectsUnscopedRef() {
        const source = `package P
import System.Diagnostics.CodeAnalysis
interface IHelpers {
    @UnscopedRef
    private func Helper() int32 { return 0 }
}`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Equal(
            "'@UnscopedRef' requires a virtual interface instance member; a private interface helper has no implementation slot.",
            diagnostic.Message
        )
    }

    @Theory
    @InlineData("public prop Slot Span[int32] { set { } }")
    @InlineData("private prop (IRefSlot) Slot Span[int32] { set { } }")
    func AnnotatedInterfaceProperty_AllowsAnnotatedImplementation(implementation string) {
        let source = `
package P
import System
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    @UnscopedRef
    prop Slot Span[int32] { set; }
}
ref struct Buffer : IRefSlot {
    @UnscopedRef
    ` + implementation + `
}
`
        Assert.Empty(Bind(source))
    }

    @Theory
    @InlineData("public prop Slot Span[int32] { set { } }")
    @InlineData("private prop (IRefSlot) Slot Span[int32] { set { } }")
    func UnannotatedInterfaceProperty_RejectsAnnotatedImplementation(implementation string) {
        let source = `
package P
import System
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    prop Slot Span[int32] { set; }
}
ref struct Buffer : IRefSlot {
    @UnscopedRef
    ` + implementation + `
}
`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Equal(
            "'@UnscopedRef' cannot be applied because implemented property 'IRefSlot.Slot' setter does not have @UnscopedRef.",
            diagnostic.Message
        )
    }

    @Theory
    @InlineData("set")
    @InlineData("init")
    func UnannotatedInterfaceProperty_RejectsAnnotatedAutoProperty(accessor string) {
        let source = `package P
import System
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    prop Slot Span[int32] { ACCESSOR; }
}
ref struct Buffer : IRefSlot {
    @UnscopedRef
    public prop Slot Span[int32] { ACCESSOR; }
}`.Replace("ACCESSOR", accessor, StringComparison.Ordinal)
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Contains("implemented property 'IRefSlot.Slot'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("set", false)
    @InlineData("set", true)
    @InlineData("init", false)
    @InlineData("init", true)
    func UnannotatedConstructedSourceProperty_RejectsAnnotatedImplementation(
        accessor string,
        explicitImplementation bool
    ) {
        let declaration = if explicitImplementation {
            "private prop (IRefSlot[int32]) Slot"
        } else {
            "public prop Slot"
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot[T any] {
    prop Slot T { ACCESSOR; }
}
struct Buffer : IRefSlot[int32] {
    @UnscopedRef
    DECLARATION int32 { ACCESSOR { } }
}`.Replace("ACCESSOR", accessor, StringComparison.Ordinal).Replace("DECLARATION", declaration, StringComparison.Ordinal)
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(
            "'@UnscopedRef' cannot be applied because implemented property 'IRefSlot[int32].Slot' setter does not have @UnscopedRef.",
            diagnostic.Message
        )
    }

    @Theory
    @InlineData("public prop Slot int32 { get { return 0 } }")
    @InlineData("private prop (IValue) Slot int32 { get { return 0 } }")
    func UnannotatedOrdinaryInterfaceGetter_RejectsAnnotatedImplementation(implementation string) {
        let source = `package P
import System.Diagnostics.CodeAnalysis
interface IValue {
    prop Slot int32 { get; }
}
struct Value : IValue {
    @UnscopedRef
    IMPLEMENTATION
}`.Replace("IMPLEMENTATION", implementation, StringComparison.Ordinal)
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(
            "'@UnscopedRef' cannot be applied because implemented property 'IValue.Slot' getter does not have @UnscopedRef.",
            diagnostic.Message
        )
    }

    @Fact
    func AnnotatedOrdinaryInterfaceSlots_AllowUnannotatedImplementation() {
        let source = `package P
import System.Diagnostics.CodeAnalysis
interface IValue {
    @UnscopedRef
    func Get() int32;

    @UnscopedRef
    prop Slot int32 { get; set; }
}
struct Value : IValue {
    public func Get() int32 { return 0 }
    public prop Slot int32 { get { return 0 } set { } }
}`
        Assert.Empty(Bind(source))
    }

    @Theory
    @InlineData("set")
    @InlineData("init")
    func ConstructedSourcePropertySetter_RelevanceUsesSubstitutedSlotType(accessor string) {
        let source = `package P
interface IRefSlot[T any] {
    prop Slot T { ACCESSOR; }
}`.Replace("ACCESSOR", accessor, StringComparison.Ordinal)
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let globalScope = GSharp
            .Core
            .CodeAnalysis
            .Binding
            .Binder
            .BindGlobalScope(previous: nil, ImmutableArray.Create(tree), compilation.References)
        let iface = Assert.Single(globalScope.Interfaces)
        let slot = Assert.Single(iface.Properties)
        let typeParameter = Assert.Single(iface.TypeParameters)
        let byRefLikeMap = Dictionary[TypeParameterSymbol, TypeSymbol]{
            [typeParameter] = TypeSymbol.FromClrType(typeof(Span[int32]))
        }
        let ordinaryMap = Dictionary[TypeParameterSymbol, TypeSymbol]{[typeParameter] = TypeSymbol.Int32}
        Assert.True(
            DeclarationBinder.RequiresUnscopedRefPropertyContract(
                slot,
                TypeSymbol.FromClrType(typeof(Span[int32])),
                isSetter: true,
                byRefLikeMap
            )
        )
        Assert.False(
            DeclarationBinder.RequiresUnscopedRefPropertyContract(slot, TypeSymbol.Int32, isSetter: true, ordinaryMap)
        )
    }

    @Fact
    func ConstructedSourceIndexerGetter_RelevanceUsesSubstitutedSlotType() {
        let typeParameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let byRefLikeMap = Dictionary[TypeParameterSymbol, TypeSymbol]{
            [typeParameter] = TypeSymbol.FromClrType(typeof(Span[int32]))
        }
        let ordinaryMap = Dictionary[TypeParameterSymbol, TypeSymbol]{[typeParameter] = TypeSymbol.Int32}
        let indexerSlot = PropertySymbol(
            "Item",
            typeParameter,
            Accessibility.Public,
            hasGetter: true,
            hasSetter: false,
            isAutoProperty: false,
            isVirtual: false,
            isOverride: false
        ){Parameters = ImmutableArray.Create(ParameterSymbol("key", TypeSymbol.Int32, refKind: RefKind.Ref))}
        Assert.True(
            DeclarationBinder.RequiresUnscopedRefPropertyContract(
                indexerSlot,
                implementationReceiver: nil,
                isSetter: false,
                byRefLikeMap
            )
        )
        Assert.False(
            DeclarationBinder.RequiresUnscopedRefPropertyContract(
                indexerSlot,
                implementationReceiver: nil,
                isSetter: false,
                ordinaryMap
            )
        )
    }

    @Theory
    @InlineData(false, RefKind(0), false)
    @InlineData(true, RefKind(1), false)
    @InlineData(true, RefKind(3), false)
    @InlineData(true, RefKind(2), false)
    @InlineData(true, RefKind(0), true)
    func RefReturn_RelevanceRequiresAnAdditionalParameter(
        hasParameter bool,
        refKind RefKind,
        parameterIsByRefLike bool
    ) {
        let parameters = if hasParameter {
            ImmutableArray.Create(
                ParameterSymbol(
                    "value",
                    if parameterIsByRefLike {
                        TypeSymbol.FromClrType(typeof(Span[int32]))
                    } else {
                        TypeSymbol.Int32
                    },
                    refKind: refKind
                )
            )
        } else {
            ImmutableArray[ParameterSymbol].Empty
        }
        Assert.Equal(
            hasParameter,
            DeclarationBinder.RequiresUnscopedRefContract(
                TypeSymbol.Int32,
                RefKind.Ref,
                parameters,
                implementationReceiver: nil
            )
        )
    }

    @Theory
    @InlineData(RefKind(1), false, false, true)
    @InlineData(RefKind(1), true, false, false)
    @InlineData(RefKind(2), true, false, true)
    @InlineData(RefKind(2), false, false, true)
    @InlineData(RefKind(2), false, true, true)
    func RefStructParameter_RelevanceMatchesCSharp(
        refKind RefKind,
        isScoped bool,
        hasAdditionalParameter bool,
        expected bool
    ) {
        let parameters = ImmutableArray.CreateBuilder[ParameterSymbol]()
        parameters.Add(
            ParameterSymbol("view", TypeSymbol.FromClrType(typeof(Span[int32])), isScoped: isScoped, refKind: refKind)
        )
        if hasAdditionalParameter {
            parameters.Add(ParameterSymbol("other", TypeSymbol.Int32, refKind: RefKind.In))
        }
        Assert.Equal(
            expected,
            DeclarationBinder.RequiresUnscopedRefContract(
                TypeSymbol.Void,
                RefKind.None,
                parameters.ToImmutable(),
                implementationReceiver: nil
            )
        )
    }

    @Fact
    func OneImplementationOfMultipleUnannotatedSlots_ReportsOnce() {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
interface IA { func Slot(ref fallback int32) ref int32; }
interface IB { func Slot(ref fallback int32) ref int32; }
struct Buffer : IA, IB {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32) ref int32 { return ref this.Value }
}
`
        Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
    }

    @Fact
    func DistinctIncompatibleImplementations_ReportSeparately() {
        let source = `
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlots {
    func First(ref fallback int32) ref int32;
    func Second(ref fallback int32) ref int32;
}
struct Buffer : IRefSlots {
    var Value int32

    @UnscopedRef
    public func First(ref fallback int32) ref int32 { return ref this.Value }

    @UnscopedRef
    public func Second(ref fallback int32) ref int32 { return ref this.Value }
}
`
        Assert.Equal(2, Bind(source).Count((d Diagnostic) -> d.Id == "GS0590"))
    }

    @Fact
    func ImportedInterfaceContracts_AreReadFromMethodMetadata() {
        using let contracts = Issue4292UnscopedRefContracts()
        let rejected = BindWithFixtures(`
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IMethod {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32) ref int32 { return ref this.Value }
}
`, contracts)
        Assert.Single(rejected, (d Diagnostic) -> d.Id == "GS0590")
        let accepted = BindWithFixtures(`
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IAnnotatedMethod {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32) ref int32 { return ref this.Value }
}
`, contracts)
        Assert.Empty(accepted)
    }

    @Theory
    @InlineData("public func Get() int32 { return 0 }")
    @InlineData("private func (IValueMethod) Get() int32 { return 0 }")
    func ImportedOrdinaryMethod_RejectsAddedContract(implementation string) {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IValueMethod {
    @UnscopedRef
    IMPLEMENTATION
}`.Replace("IMPLEMENTATION", implementation, StringComparison.Ordinal)
        Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
    }

    @Theory
    @InlineData("public prop Value int32 { get { return 0 } set { } }")
    @InlineData("private prop (IValueProperty) Value int32 { get { return 0 } set { } }")
    func ImportedOrdinaryProperty_RejectsAddedContract(implementation string) {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IValueProperty {
    @UnscopedRef
    IMPLEMENTATION
}`.Replace("IMPLEMENTATION", implementation, StringComparison.Ordinal)
        Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
    }

    @Fact
    func ImportedScopedRef_IdentityDoesNotRelaxInterfaceContract() {
        using let contracts = Issue4292ScopedRefIdentityContracts()
        {
            using let resolver = ReferenceResolver.WithReferences(contracts.Paths)
            Assert.True(resolver.TryResolveType("Issue4292.ScopedIdentity.IRuntimeScoped", out var runtimeScoped))
            let attributeType Type? = Assert.Single(
                runtimeScoped.GetMethod("Store")!!.GetParameters()[0].GetCustomAttributesData()
            )
                .AttributeType
            Assert.True(KnownAttributes.IsScopedRef(attributeType), attributeType!!.AssemblyQualifiedName)
            Assert.True(resolver.TryResolveType("Issue4292.ScopedIdentity.ILookalikeScoped", out var lookalikeScoped))
            let lookalikeAttributeType Type? = Assert.Single(
                lookalikeScoped.GetMethod("Store")!!.GetParameters()[0].GetCustomAttributesData()
            )
                .AttributeType
            Assert.Equal("System.Runtime.CompilerServices.ScopedRefAttribute", lookalikeAttributeType!!.FullName)
            Assert.False(
                KnownAttributes.IsScopedRef(lookalikeAttributeType),
                lookalikeAttributeType!!.AssemblyQualifiedName
            )
        }
        const implementation = `struct Buffer : INTERFACE {
    @UnscopedRef
    public func Store(ref view RefValue) { }
}`
        const prefix = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.ScopedIdentity`
        Assert.Single(
            BindWithReferences(
                prefix + Environment.NewLine + implementation.Replace(
                    "INTERFACE",
                    "ILookalikeScoped",
                    StringComparison.Ordinal
                ),
                contracts.Paths
            ),
            (d Diagnostic) -> d.Id == "GS0590"
        )
        Assert.Single(
            BindWithReferences(
                prefix + Environment.NewLine + implementation.Replace(
                    "INTERFACE",
                    "IRuntimeScoped",
                    StringComparison.Ordinal
                ),
                contracts.Paths
            ),
            (d Diagnostic) -> d.Id == "GS0590"
        )
    }

    @Fact
    func ScopedRefIdentityFixture_DisposesPartialConstructionOnFailure() {
        var lookalikeDirectory = string.Empty
        var contractsDirectory = string.Empty
        Assert.Throws[InvalidOperationException](
            func () object? {
                return Issue4292ScopedRefIdentityContracts(
                    (lookalike string, contracts string) -> {
                        lookalikeDirectory = lookalike
                        contractsDirectory = contracts
                        throw InvalidOperationException("injected rewrite failure")
                    }
                )
            }
        )
        Assert.NotEmpty(lookalikeDirectory)
        Assert.NotEmpty(contractsDirectory)
        Assert.False(Directory.Exists(lookalikeDirectory))
        Assert.False(Directory.Exists(contractsDirectory))
    }

    @Fact
    func ImportedSymbolicGenericInterface_EnforcesContract() {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Token { }
struct Buffer : IGenericMethod[Token] {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32, value Token) ref int32 { return ref this.Value }
}
`
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Contains("IGenericMethod", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func ImportedUnannotatedRefProperty_RejectsAnnotatedImplementation() {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IRefProperty {
    var Value int32

    @UnscopedRef
    public prop Slot ref int32 { get { return ref this.Value } }
}
`
        Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
    }

    @Fact
    func ImportedIndexerGetterContract_IsEnforced() {
        using let contracts = Issue4292UnscopedRefContracts()
        const implementation = `ref struct Buffer : $INTERFACE$ {
    var Value int32

    @UnscopedRef
    public prop this[view RefValue] ref int32 {
        get { return ref this.Value }
    }
}`
        let prefix = `package P
import System
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts`
        Assert.Empty(
            BindWithFixtures(
                prefix + Environment.NewLine + implementation.Replace(
                    "$$INTERFACE$$",
                    "IGetterIndexer",
                    StringComparison.Ordinal
                ),
                contracts
            )
        )
        Assert.Single(
            BindWithFixtures(
                prefix + Environment.NewLine + implementation.Replace(
                    "$$INTERFACE$$",
                    "IUnannotatedIndexer",
                    StringComparison.Ordinal
                ),
                contracts
            ),
            (d Diagnostic) -> d.Id == "GS0590"
        )
    }

    @Fact
    func ImportedSetterOnlyContract_IsReadFromSetterMetadata() {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
ref struct Buffer : ISetterProperty {
    @UnscopedRef
    public prop Slot RefValue { set { } }
}
`
        Assert.Empty(BindWithFixtures(source, contracts))
    }

    @Fact
    func ImportedSetterOnlyContract_IsReadFromPropertyMetadata() {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
ref struct Buffer : IPropertyAnnotatedSetter {
    @UnscopedRef
    public prop Slot RefValue { set { } }
}
`
        Assert.Empty(BindWithFixtures(source, contracts))
    }

    @Fact
    func InvalidClassPlacement_SuppressesImportedOverrideContractDiagnostic() {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Derived : Base, IMethod {
    @UnscopedRef
    override func Slot(ref fallback int32) ref int32 { return ref fallback }
}
`
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Contains("requires a struct instance member", diagnostic.Message, StringComparison.Ordinal)
        Assert.DoesNotContain("overridden member", diagnostic.Message, StringComparison.Ordinal)
        Assert.DoesNotContain("implemented member", diagnostic.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedExplicitMethodContract_PrefersLinkedSlotOverPlainMember(explicitFirst bool) {
        using let contracts = Issue4292UnscopedRefContracts()
        const plain = "public func Slot(ref fallback int32) ref int32 { return ref this.Value }"
        const explicitMember = "@UnscopedRef\nprivate func (IMethod) Slot(ref fallback int32) ref int32 { return ref this.Value }"
        let members = if explicitFirst {
            explicitMember + Environment.NewLine + plain
        } else {
            plain + Environment.NewLine + explicitMember
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IMethod {
    var Value int32
` + members + "\n}"
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedExplicitPropertyContract_PrefersLinkedAccessorsOverPlainProperty(explicitFirst bool) {
        using let contracts = Issue4292UnscopedRefContracts()
        const plain = `public prop this[view RefValue] ref int32 {
    get { return ref this.Value }
}`
        const explicitMember = `@UnscopedRef
private prop (IUnannotatedIndexer) this[view RefValue] ref int32 {
    get { return ref this.Value }
}`
        let members = if explicitFirst {
            explicitMember + Environment.NewLine + plain
        } else {
            plain + Environment.NewLine + explicitMember
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
ref struct Buffer : IUnannotatedIndexer {
    var Value int32
` + members + "\n}"
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedSymbolicExplicitMethodContract_PrefersLinkedSlotOverPlainMember(explicitFirst bool) {
        using let contracts = Issue4292UnscopedRefContracts()
        const plain = "public func Slot(ref fallback int32, value Token) ref int32 { return ref this.Value }"
        const explicitMember = `@UnscopedRef
private func (IGenericMethod[Token]) Slot(ref fallback int32, value Token) ref int32 {
    return ref this.Value
}`
        let members = if explicitFirst {
            explicitMember + Environment.NewLine + plain
        } else {
            plain + Environment.NewLine + explicitMember
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Token { }
struct Buffer : IGenericMethod[Token] {
    var Value int32
` + members + "\n}"
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedSymbolicExplicitPropertyContract_PrefersLinkedAccessorsOverPlainProperty(explicitFirst bool) {
        using let contracts = Issue4292UnscopedRefContracts()
        const plain = "public prop Slot RefValue { set { } }"
        const explicitMember = "@UnscopedRef\nprivate prop (IGenericProperty[Token]) Slot RefValue { set { } }"
        let members = if explicitFirst {
            explicitMember + Environment.NewLine + plain
        } else {
            plain + Environment.NewLine + explicitMember
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Token { }
ref struct Buffer : IGenericProperty[Token] {
` + members + "\n}"
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Fact
    func ImportedSymbolicExplicitProperty_WithTypeArgument_IsLinked() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import Issue4292.Contracts
class Token { }
struct Buffer : IGenericValueProperty[Token] {
    private prop (IGenericValueProperty[Token]) Value Token {
        get { return Token() }
    }
}`, contracts)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ImportedConcreteExplicitProperty_WithConstructedResult_IsLinked() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import System.Collections.Generic
import Issue4292.Contracts
struct Buffer : IGenericCollectionProperty[int32] {
    private prop (IGenericCollectionProperty[int32]) Values ICollection[int32] {
        get { throw System.NotImplementedException() }
    }
}`, contracts)
        Assert.Empty(diagnostics)
    }

    @Fact
    func UnscopedRefPropertyCache_OnlyAcceptsPropertyAccessorNames() {
        let getter MethodInfo? = typeof(string).GetProperty("Length")!!.GetMethod
        let explicitGetter MethodInfo? = typeof(ExplicitPropertyAccessorProbe)
            .GetProperties(BindingFlags.NonPublic | BindingFlags.Instance)
            .Single()
            .GetMethod
        let eventAdder MethodInfo? = typeof(AppDomain).GetEvent("AssemblyLoad")!!.AddMethod
        let operatorMethod = typeof(decimal).GetMethods().Single((method MethodInfo) -> method.Name == "op_Addition")
        Assert.True(RefCapabilities.IsPropertyAccessor(getter!!))
        Assert.True(RefCapabilities.IsPropertyAccessor(explicitGetter!!))
        Assert.False(RefCapabilities.IsPropertyAccessor(eventAdder!!))
        Assert.False(RefCapabilities.IsPropertyAccessor(operatorMethod))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedSymbolicIndexer_UsesCompleteSignature(explicitFirst bool) {
        using let contracts = Issue4292UnscopedRefContracts()
        const plain = "public prop this[key int32] RefValue { set { } }"
        const explicitMember = "@UnscopedRef\nprivate prop (IGenericOverloadedIndexer[Token]) this[key Token] RefValue { set { } }"
        let members = if explicitFirst {
            explicitMember + Environment.NewLine + plain
        } else {
            plain + Environment.NewLine + explicitMember
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Token { }
ref struct Buffer : IGenericOverloadedIndexer[Token] {
` + members + "\n}"
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedSymbolicImplicitIndexer_UsesCompleteSignature(annotatedFirst bool) {
        using let contracts = Issue4292UnscopedRefContracts()
        const annotated = "@UnscopedRef\npublic prop this[key Token] RefValue { set { } }"
        const plain = "public prop this[key int32] RefValue { set { } }"
        let members = if annotatedFirst {
            annotated + Environment.NewLine + plain
        } else {
            plain + Environment.NewLine + annotated
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Token { }
ref struct Buffer : IGenericOverloadedIndexer[Token] {
` + members + "\n}"
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Fact
    func ImportedIndexer_UsesRefKindInCompleteSignature() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import Issue4292.Contracts
ref struct Buffer : IRefKindIndexer {
    public prop this[key int32] RefValue { set { } }
}`, contracts)
        Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0187")
    }

    @Fact
    func InheritedSymbolicSlots_CheckEachConstructedInterface() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import Issue4292.Contracts
class A { }
class B { }
struct Buffer : IChild[A], IChild[B] {
    public func Put(value A) { }
}`, contracts)
        Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0187")
    }

    @Fact
    func InheritedSwappedSymbolicMethod_UsesProjectedOwnerArguments() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import Issue4292.Contracts
class A { }
class B { }
ref struct Buffer : IProjectedChild[A, B] {
    public func Put(first B, second A) { }
    public prop this[first B, second A] RefValue { set { } }
}`, contracts)
        Assert.Empty(diagnostics)
    }

    @Fact
    func InheritedSwappedSymbolicProperty_UsesProjectedOwnerArguments() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import Issue4292.Contracts
class A { }
class B { }
ref struct Buffer : IProjectedChild[A, B] {
    public func Put(first B, second A) { }
    public prop this[first B, second A] RefValue { set { } }
}`, contracts)
        Assert.Empty(diagnostics)
    }

    @Fact
    func DuplicateInheritedSymbolicSlots_ReportMissingMemberOnce() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import Issue4292.Contracts
class A { }
struct Buffer : ILeft[A], IRight[A] {
}`, contracts)
        Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0187")
    }

    @Fact
    func InheritedGenericExplicitMethod_RequiresExactConstructedOwner() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class A { }
class B { }
struct Buffer : IDerivedInvariantMethod[A], IDerivedInvariantMethod[B] {
    var Value int32

    @UnscopedRef
    private func (IBaseInvariantMethod[A]) Slot(ref fallback int32) ref int32 {
        return ref this.Value
    }
}`, contracts)
        Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0187")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0590")
    }

    @Fact
    func InheritedGenericExplicitProperty_RequiresExactConstructedOwner() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class A { }
class B { }
ref struct Buffer : IDerivedInvariantProperty[A], IDerivedInvariantProperty[B] {
    @UnscopedRef
    private prop (IBaseInvariantProperty[A]) Slot RefValue { set { } }
}`, contracts)
        Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0187")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0590")
    }

    @Fact
    func SourceDefaultMethod_IgnoresUnrelatedExplicitImplementation() {
        const source = `package P
import System.Diagnostics.CodeAnalysis
interface IA {
    func Slot(ref fallback int32) ref int32 { return ref fallback }
}
interface IB {
    @UnscopedRef
    func Slot(ref fallback int32) ref int32;
}
struct Buffer : IA, IB {
    @UnscopedRef
    private func (IB) Slot(ref fallback int32) ref int32 { return ref fallback }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func SourceDefaultProperty_IgnoresUnrelatedExplicitImplementation() {
        const source = `package P
import System
import System.Diagnostics.CodeAnalysis
interface IA {
    prop Slot Span[int32] { set { } }
}
interface IB {
    @UnscopedRef
    prop Slot Span[int32] { set; }
}
ref struct Buffer : IA, IB {
    @UnscopedRef
    private prop (IB) Slot Span[int32] { set { } }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ImportedDefaultMethod_IgnoresUnrelatedExplicitImplementation() {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IDefaultMethod, IAnnotatedMethod {
    @UnscopedRef
    private func (IAnnotatedMethod) Slot(ref fallback int32) ref int32 {
        return ref fallback
    }
}`
        Assert.Empty(BindWithFixtures(source, contracts))
    }

    @Fact
    func ImportedDefaultProperty_IgnoresUnrelatedExplicitImplementation() {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
ref struct Buffer : IDefaultProperty, IPropertyAnnotatedSetter {
    @UnscopedRef
    private prop (IPropertyAnnotatedSetter) Slot RefValue { set { } }
}`
        Assert.Empty(BindWithFixtures(source, contracts))
    }

    @Theory
    @InlineData("public func Slot(ref fallback int32) ref int32 { return ref this.Value }")
    @InlineData("private func (IDefaultMethod) Slot(ref fallback int32) ref int32 { return ref this.Value }")
    func ImportedDefaultMethod_ValidatesExistingReplacement(implementation string) {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IDefaultMethod {
    var Value int32

    @UnscopedRef
    ` + implementation + `
}
`
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Contains("implemented member", diagnostic.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("public prop Slot RefValue { set { } }")
    @InlineData("private prop (IDefaultProperty) Slot RefValue { set { } }")
    func ImportedDefaultProperty_ValidatesExistingReplacement(implementation string) {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
ref struct Buffer : IDefaultProperty {
    @UnscopedRef
    ` + implementation + `
}
`
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Contains("implemented property", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func ImportedSymbolicDefaultMethod_ValidatesExistingExplicitReplacement() {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Token { }
struct Buffer : IGenericDefaultMethod[Token] {
    var Value int32

    @UnscopedRef
    private func (IGenericDefaultMethod[Token]) Slot(ref fallback int32, value Token) ref int32 {
        return ref this.Value
    }
}`
        Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
    }

    @Fact
    func ImportedSymbolicDefaultProperty_ValidatesExistingExplicitReplacement() {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Token { }
ref struct Buffer : IGenericDefaultProperty[Token] {
    @UnscopedRef
    private prop (IGenericDefaultProperty[Token]) Slot RefValue { set { } }
}`
        Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
    }

    @Fact
    func ImportedDefaultMembers_RemainOptionalWhenNotReplaced() {
        using let contracts = Issue4292UnscopedRefContracts()
        Assert.Empty(BindWithFixtures(`package P
import Issue4292.Contracts
class Token { }
ref struct Buffer :
    IDefaultMethod,
    IDefaultProperty,
    IGenericDefaultMethod[Token],
    IGenericDefaultProperty[Token],
    IDerivedDefaultProperty,
    IDerivedGenericDefaultProperty[Token] {
}`, contracts))
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedInheritedExplicitMethodContract_PrefersLinkedSlotOverPlainMember(explicitFirst bool) {
        using let contracts = Issue4292UnscopedRefContracts()
        const plain = "public func Slot(ref fallback int32) ref int32 { return ref fallback }"
        const explicitMember = "@UnscopedRef\nprivate func (IBaseMethod) Slot(ref fallback int32) ref int32 { return ref this.Value }"
        let members = if explicitFirst {
            explicitMember + Environment.NewLine + plain
        } else {
            plain + Environment.NewLine + explicitMember
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IDerivedMethod {
    var Value int32
` + members + "\n}"
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedInheritedDefaultMethod_ValidatesLinkedReplacement(explicitFirst bool) {
        using let contracts = Issue4292UnscopedRefContracts()
        const plain = "public func Slot(ref fallback int32) ref int32 { return ref fallback }"
        const explicitMember = "@UnscopedRef\nprivate func (IBaseDefaultMethod) Slot(ref fallback int32) ref int32 { return ref this.Value }"
        let members = if explicitFirst {
            explicitMember + Environment.NewLine + plain
        } else {
            plain + Environment.NewLine + explicitMember
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IDerivedDefaultMethod {
    var Value int32
` + members + "\n}"
        Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedInheritedDefaultProperty_ValidatesLinkedReplacement(explicitFirst bool) {
        using let contracts = Issue4292UnscopedRefContracts()
        const plain = "public prop Slot RefValue { set { } }"
        const explicitMember = "@UnscopedRef\nprivate prop (IBaseDefaultProperty) Slot RefValue { set { } }"
        let members = if explicitFirst {
            explicitMember + Environment.NewLine + plain
        } else {
            plain + Environment.NewLine + explicitMember
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
ref struct Buffer : IDerivedDefaultProperty {
` + members + "\n}"
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Contains("IBaseDefaultProperty.Slot", diagnostic.Message, StringComparison.Ordinal)
        Assert.Contains("setter does not have @UnscopedRef", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func ImportedInheritedSymbolicDefaultProperty_ValidatesLinkedReplacement() {
        using let contracts = Issue4292UnscopedRefContracts()
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Token { }
ref struct Buffer : IDerivedGenericDefaultProperty[Token] {
    public prop Slot RefValue { set { } }

    @UnscopedRef
    private prop (IBaseGenericDefaultProperty[Token]) Slot RefValue { set { } }
}`
        Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
    }

    @Fact
    func ImportedInheritedProperty_UsesPlainPropertyFromBaseClass() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import Issue4292.Contracts
open class Base {
    public prop Value int32 { get { return 1 } }
}
class Derived : Base, IDerivedValueProperty { }`, contracts)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ImportedInheritedProperty_UsesPublicFieldFromBaseClass() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import Issue4292.Contracts
open class Base {
    public var Value int32
}
class Derived : Base, IDerivedValueProperty { }`, contracts)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ImportedInheritedProperty_PublicFieldFromBaseClass_EmitsAndDispatches() {
        let contracts = Issue4292UnscopedRefContracts()
        try {
            AssertInheritedFieldDispatches(contracts.Path)
        } finally {
            GC.Collect()
            GC.WaitForPendingFinalizers()
            GC.Collect()
            contracts.Dispose()
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedInheritedProperty_PrefersExactExplicitMemberOverPlainProperty(explicitFirst bool) {
        using let contracts = Issue4292UnscopedRefContracts()
        const plain = "public prop Value int32 { get { return 1 } }"
        const explicitMember = "@UnscopedRef\nprivate prop (IBaseValueProperty) Value int32 { get { return 2 } }"
        let members = if explicitFirst {
            explicitMember + Environment.NewLine + plain
        } else {
            plain + Environment.NewLine + explicitMember
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
ref struct Derived : IDerivedValueProperty {` + members + "}"
        let diagnostic = Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Contains("IBaseValueProperty.Value", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func ImportedInheritedProperty_WrongBaseMemberReportsMissingSlot() {
        using let contracts = Issue4292UnscopedRefContracts()
        let diagnostics = BindWithFixtures(`package P
import Issue4292.Contracts
open class Base {
    public prop Value string { get { return ""wrong"" } }
}
class Derived : Base, IDerivedValueProperty { }`, contracts)
        Assert.Single(diagnostics, (d Diagnostic) -> d.Id == "GS0187")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func ImportedInheritedSymbolicMethodContract_PrefersLinkedSlotOverPlainMember(explicitFirst bool) {
        using let contracts = Issue4292UnscopedRefContracts()
        const plain = "public func Slot(ref fallback int32, value Token) ref int32 { return ref fallback }"
        const explicitMember = `@UnscopedRef
private func (IBaseGenericMethod[Token]) Slot(ref fallback int32, value Token) ref int32 {
    return ref this.Value
}`
        let members = if explicitFirst {
            explicitMember + Environment.NewLine + plain
        } else {
            plain + Environment.NewLine + explicitMember
        }
        let source = `package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Token { }
struct Buffer : IDerivedGenericMethod[Token] {
    var Value int32
` + members + "\n}"
        Assert.Single(BindWithFixtures(source, contracts), (d Diagnostic) -> d.Id == "GS0590")
    }

    @Theory
    @InlineData("method")
    @InlineData("property")
    @InlineData("indexer")
    func SourceInterface_UsesInheritedExactExplicitImplementation(memberKind string) {
        let interfaceMember = switch memberKind {
            case "method": "func Slot() int32;"
            case "property": "prop Slot int32 { get; }"
            default: "prop this[key int32] int32 { get; }"
        }
        let implementation = switch memberKind {
            case "method": "private func (IContract) Slot() int32 { return 0 }"
            case "property": "private prop (IContract) Slot int32 { get { return 0 } }"
            default: "private prop (IContract) this[key int32] int32 { get { return key } }"
        }
        let source = `package P
interface IContract {
    INTERFACE_MEMBER
}
open class Base : IContract {
    IMPLEMENTATION
}
class Derived : Base, IContract { }`.Replace("INTERFACE_MEMBER", interfaceMember, StringComparison.Ordinal).Replace(
            "IMPLEMENTATION",
            implementation,
            StringComparison.Ordinal
        )
        Assert.Empty(Bind(source))
    }

    @Fact
    func UnrelatedInheritedExplicitImplementation_DoesNotSatisfyInterface() {
        let source = `package P
interface IA { func Slot() int32; }
interface IB { func Slot() int32; }
open class Base : IB {
    private func (IB) Slot() int32 { return 0 }
}
class Derived : Base, IA { }`
        Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0187")
    }

    @Theory
    @InlineData("method")
    @InlineData("property")
    @InlineData("indexer")
    @InlineData("symbolic-method")
    @InlineData("symbolic-property")
    func ImportedInterface_UsesInheritedExactExplicitImplementation(memberKind string) {
        using let contracts = Issue4292UnscopedRefContracts()
        let baseDeclaration = switch memberKind {
            case "method": `open class Base : IMethod {
    var Value int32
    private func (IMethod) Slot(ref fallback int32) ref int32 { return ref this.Value }
}
class Derived : Base, IMethod { }`
            case "property": `open class Base : ISetterProperty {
    private prop (ISetterProperty) Slot RefValue { set { } }
}
class Derived : Base, ISetterProperty { }`
            case "indexer": `open class Base : IUnannotatedIndexer {
    var Value int32
    private prop (IUnannotatedIndexer) this[view RefValue] ref int32 {
        get { return ref this.Value }
    }
}
class Derived : Base, IUnannotatedIndexer { }`
            case "symbolic-method": `class Token { }
open class Base : IGenericMethod[Token] {
    var Value int32
    private func (IGenericMethod[Token]) Slot(ref fallback int32, value Token) ref int32 {
        return ref this.Value
    }
}
class Derived : Base, IGenericMethod[Token] { }`
            default: `class Token { }
open class Base : IGenericValueProperty[Token] {
    private prop (IGenericValueProperty[Token]) Value Token {
        get { return Token() }
    }
}
class Derived : Base, IGenericValueProperty[Token] { }`
        }
        let source = "package P\nimport Issue4292.Contracts" + Environment.NewLine + baseDeclaration
        Assert.Empty(BindWithFixtures(source, contracts))
    }

    private interface IPropertyAccessorProbe {
        prop Value int32 {
            get;
        }
    }

    private class ExplicitPropertyAccessorProbe : IPropertyAccessorProbe {
        private prop(IPropertyAccessorProbe) Value int32 -> 0
    }

    shared {
        @MethodImpl(MethodImplOptions.NoInlining)
        private func AssertInheritedFieldDispatches(contractPath string) {
            let result = EmittedOracle.Evaluate(`package P
import Issue4292.Contracts
open class Base {
    public var Value int32
}
class Derived : Base, IDerivedValueProperty { }
let value = Derived()
value.Value = 42
var contract IDerivedValueProperty = value
contract.Value`, []string{contractPath})
            Assert.Empty(result.Diagnostics)
            Assert.Null(result.UnhandledException)
            Assert.Equal(42, result.Value)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let program = GSharp
                .Core
                .CodeAnalysis
                .Binding
                .Binder
                .BindProgram(compilation.GlobalScope, compilation.References)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .ToImmutableArray()
        }

        private func BindWithFixtures(source string, contracts Issue4292UnscopedRefContracts) ImmutableArray[
            Diagnostic
        ] -> BindWithReferences(source, []string{contracts.Path})

        private func BindWithReferences(source string, references[]string) ImmutableArray[Diagnostic] {
            using let resolver = ReferenceResolver.WithReferences(references)
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = GSharp
                .Core
                .CodeAnalysis
                .Binding
                .Binder
                .BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
            let program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(globalScope, resolver)
            return tree.Diagnostics.Concat(globalScope.Diagnostics).Concat(program.Diagnostics).ToImmutableArray()
        }
    }
}
