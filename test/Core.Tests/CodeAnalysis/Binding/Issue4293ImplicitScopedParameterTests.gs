// <copyright file="Issue4293ImplicitScopedParameterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import GSharp.Tests
import Xunit
import GSharp.Core.Tests
import System.Reflection

/// Issue #4293: C# implicit parameter ref scopes.
class Issue4293ImplicitScopedParameterTests {
    @Fact
    func OutParameter_CannotBeReturnedByReference() {
        const source = `package P
func Bad(out value int32) ref int32 {
    value = 42
    return ref value
}`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0254")
        Assert.Equal(source.LastIndexOf("value", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Contains("scoped parameter", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func RefStructOutParameter_CannotBeReturnedByReference() {
        const source = `package P
ref struct Acc { var Value int32 }
func Bad(out value Acc) ref Acc {
    value = Acc{}
    return ref value
}`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0254")
        Assert.Equal(source.LastIndexOf("value", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Fact
    func UnscopedRefOutParameter_CanBeReturnedByReference() {
        let diagnostics = Bind(`package P
import System.Diagnostics.CodeAnalysis
func Pass(@UnscopedRef out value int32) ref int32 {
    value = 42
    return ref value
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func OutArgument_DoesNotConstrainRefReturningCall() {
        let diagnostics = Bind(`package P
func Pick(out scratch int32, ref stable int32) ref int32 {
    scratch = 0
    return ref stable
}
func Forward(ref stable int32) ref int32 {
    var scratch int32
    return ref Pick(out scratch, ref stable)
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ConstrainedSourceStaticOutArgument_DoesNotConstrainRefReturningCall() {
        let result = EmittedOracle.Evaluate(`package P
interface IPick {
    shared {
        func Pick(out scratch int32) ref int32;
    }
}
class Picker : IPick {
    shared {
        var stored int32 = 41
        func Pick(out scratch int32) ref int32 {
            scratch = 0
            return ref stored
        }
        func Read() int32 -> stored
    }
}
func Forward[T IPick]() ref int32 {
    var scratch int32
    return ref T.Pick(&scratch)
}
func Run() int32 {
    var ref value = Forward[Picker]()
    value = 42
    return Picker.Read()
}
Run()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
    }

    @Fact
    func ConstrainedImportedStaticOutArgument_IsExcludedFromEscapeSources() {
        using let contracts = Issue4563RefSafetyRulesContracts()
        let method = contracts.LoadUpdated().GetType("Issue4563.Updated.IStaticContract")!!.GetMethod("Pick")!!
        let scratch = BoundVariableExpression(nil, LocalVariableSymbol("scratch", isReadOnly: false, TypeSymbol.Int32))
        let call = BoundConstrainedStaticCallExpression(
            nil,
            TypeParameterSymbol("T", ordinal: 0, TypeParameterConstraint.Any, TypeParameterVariance.None),
            method,
            ImmutableArray.Create[BoundExpression](scratch),
            ImmutableArray.Create(RefKind.Out),
            TypeSymbol.Int32,
            TypeSymbol.FromClrType(method.DeclaringType!!)
        )
        Assert.True(RefCapabilities.IsNativeRefReturningCall(call))
        Assert.True(
            RefCapabilities.TryGetRefReturnEscapeSources(
                call,
                out var receiver,
                out var byRefArguments,
                out var byValueByRefLikeArguments
            )
        )
        Assert.Null(receiver)
        Assert.Empty(byRefArguments)
        Assert.Empty(byValueByRefLikeArguments)
    }

    @Fact
    func RefSafetyRulesFixture_DisposesLegacyFixtureWhenUpdatedConstructionFails() {
        var legacyDirectory = string.Empty
        Assert.Throws[InvalidOperationException](
            func () object? {
                return Issue4563RefSafetyRulesContracts(
                    (path string) -> {
                        legacyDirectory = path
                        throw InvalidOperationException("injected updated-fixture failure")
                    }
                )
            }
        )
        Assert.NotEmpty(legacyDirectory)
        Assert.False(Directory.Exists(legacyDirectory))
    }

    @Fact
    func ImportedAdapter_RejectsLegacySourceForUpdatedContract() {
        using let contracts = Issue4563RefSafetyRulesContracts()
        const source = `package P
import Issue4563.Legacy
import Issue4563.Updated
func Bad(value LegacySource) IUpdatedContract {
    return adapt[IUpdatedContract](value)
}`
        let diagnostic = Assert.Single(
            BindWithReferences(source, contracts.LegacyPath, contracts.UpdatedPath),
            (candidate Diagnostic) -> candidate.Id == "GS0606"
        )
        Assert.Equal(source.IndexOf("adapt", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Fact
    func ImportedAdapter_AcceptsUpdatedSourceForUpdatedContract() {
        using let contracts = Issue4563RefSafetyRulesContracts()
        let diagnostics = BindWithReferences(`package P
import Issue4563.Updated
func Good(value UpdatedSource) IUpdatedContract {
    return adapt[IUpdatedContract](value)
}`, contracts.UpdatedPath)
        Assert.Empty(diagnostics)
    }

    @Theory
    @InlineData("ScopedSource", "IPlainContract")
    @InlineData("PlainSource", "IScopedContract")
    func ImportedAdapter_AcceptsEquivalentEffectiveOutContracts(sourceType string, targetType string) {
        using let contracts = Issue4563RefSafetyRulesContracts()
        let assembly = contracts.LoadEquivalent()
        let sourceParameter = assembly.GetType("Issue4563.Equivalent.$sourceType")!!.GetMethod(
            "Pick"
        )!!.GetParameters()[0]
        let targetParameter = assembly.GetType("Issue4563.Equivalent.$targetType")!!.GetMethod(
            "Pick"
        )!!.GetParameters()[0]
        let sourceSymbol = RefCapabilities.CreateParameterSymbol(sourceParameter, TypeSymbol.Int32, "source")
        let targetSymbol = RefCapabilities.CreateParameterSymbol(targetParameter, TypeSymbol.Int32, "target")
        Assert.Equal(RefKind.Out, sourceSymbol.RefKind)
        Assert.Equal(RefKind.Out, targetSymbol.RefKind)
        Assert.Equal(ParameterRefScope.FunctionLocal, sourceSymbol.GetEffectiveRefScope())
        Assert.Equal(ParameterRefScope.FunctionLocal, targetSymbol.GetEffectiveRefScope())
        Assert.NotEqual(sourceSymbol.GetEffectiveValueScope(), targetSymbol.GetEffectiveValueScope())
        Assert.True(targetSymbol.HasSameRefContract(sourceSymbol))
        Assert.True(
            RefCapabilities.ImportedParameterContractsMatch(
                targetParameter,
                TypeSymbol.Int32,
                sourceParameter,
                TypeSymbol.Int32
            )
        )
        let diagnostics = BindWithReferences((`package P
import Issue4563.Equivalent
func Good(value ` + "$sourceType" + `) ` + "$targetType" + ` {
    return adapt[` + "$targetType" + `](value)
}`), contracts.EquivalentPath)
        Assert.Empty(diagnostics)
    }

    @Fact
    func LookalikeRefSafetyRulesMarker_DoesNotEnableUpdatedRules() {
        using let contracts = Issue4563RefSafetyRulesContracts()
        let parameter = contracts.LoadLookalike().GetType("Issue4563.Lookalike.Contract")!!.GetMethod(
            "Pick"
        )!!.GetParameters()[0]
        Assert.Contains(
            parameter.Member.Module.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Runtime.CompilerServices.RefSafetyRulesAttribute"
        )
        Assert.False(RefCapabilities.UsesUpdatedEscapeRules(parameter))
        Assert.Equal(
            ParameterRefScope.Caller,
            RefCapabilities.CreateParameterSymbol(parameter, TypeSymbol.Int32, "value").GetEffectiveRefScope()
        )
    }

    @Fact
    func UnscopedRefOutArgument_ConstrainsRefReturningCall() {
        let diagnostics = Bind(`package P
import System.Diagnostics.CodeAnalysis
func Pick(@UnscopedRef out scratch int32, ref stable int32) ref int32 {
    scratch = 0
    return ref stable
}
func Bad(ref stable int32) ref int32 {
    var scratch int32
    return ref Pick(out scratch, ref stable)
}`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0254")
    }

    @Fact
    func NestedGenericRichMember_PreservesUnscopedRefOutContractWhenBindingBody() {
        let diagnostics = Bind(`package P
import System.Diagnostics.CodeAnalysis
func Make[T](seed T) {
    let box = object {
        func Pass(@UnscopedRef out value T) ref T {
            value = seed
            return ref value
        }
    }
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func ConstructedGenericInterface_PreservesUnscopedRefOutCallEscape() {
        const source = `package P
import System.Diagnostics.CodeAnalysis
interface I[T] {
    func Pick(@UnscopedRef out value T) ref T;
}
func Bad(source I[int32]) ref int32 {
    var value int32
    return ref source.Pick(out value)
}`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0254")
        Assert.Equal(source.LastIndexOf("source.Pick", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Fact
    func ConstructedGenericDelegate_PreservesUnscopedRefOutContract() {
        const source = `package P
import System.Diagnostics.CodeAnalysis
delegate Picker[T](@UnscopedRef out value T);`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        let _ = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References)
        Assert.Empty(tree.Diagnostics.Concat(compilation.GlobalScope.Diagnostics))
        let definition = Assert.Single(compilation.GlobalScope.Delegates)
        let constructed = Assert.IsType[DelegateTypeSymbol](
            DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        )
        Assert.Equal(ParameterRefScope.ReturnOnly, Assert.Single(constructed.Parameters).GetEffectiveRefScope())
    }

    @Fact
    func RefStructRefParameter_CanStillBeReturnedByReference() {
        let diagnostics = Bind(`package P
ref struct Acc { var Value int32 }
func Pass(ref value Acc) ref Acc {
    return ref value
}`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func RefStructRefParameter_CannotBeReturnedByValue() {
        const source = `package P
ref struct Acc { var Value int32 }
func Bad(ref value Acc) Acc {
    return value
}`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0219")
        Assert.Equal(source.LastIndexOf("value", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Contains("function-local safe-to-escape scope", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func RefStructRefParameter_ValueScopePropagatesThroughLocal() {
        const source = `package P
ref struct Acc { var Value int32 }
func Bad(ref value Acc) Acc {
    let copy = value
    return copy
}`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0219")
        Assert.Equal(source.LastIndexOf("copy", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Fact
    func UnscopedRefRefStructParameter_CanBeReturnedByValue() {
        let diagnostics = Bind(`package P
import System.Diagnostics.CodeAnalysis
ref struct Acc { var Value int32 }
func Pass(@UnscopedRef ref value Acc) Acc {
    return value
}`)
        Assert.Empty(diagnostics)
    }

    @Theory
    @InlineData(RefKind(1))
    @InlineData(RefKind(3))
    func RefAndInParameters_HaveTypeIndependentReturnOnlyRefScope(refKind RefKind) {
        let parameter = ParameterSymbol("value", TypeSymbol.Int32, refKind: refKind)
        Assert.Equal(ParameterRefScope.ReturnOnly, parameter.GetEffectiveRefScope())
    }

    @Theory
    @InlineData("@UnscopedRef value int32", "requires a 'ref', 'out', or 'in' parameter")
    @InlineData("@UnscopedRef scoped value int32", "requires a 'ref', 'out', or 'in' parameter")
    @InlineData("@UnscopedRef scoped ref value int32", "explicit 'scoped' modifier")
    func UnscopedRef_InvalidParameterPlacement_ReportsGS0590(parameter string, expectedReason string) {
        let source = (`package P
import System.Diagnostics.CodeAnalysis
func Bad(` + "$parameter" + `) { }`)
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
        Assert.Contains(expectedReason, diagnostic.Message, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(`struct Holder {
    func Bad(@UnscopedRef value int32) { }
}`)
    @InlineData(`interface I {
    func Bad(@UnscopedRef value int32);
}`)
    func UnscopedRef_InvalidMemberOrInterfaceParameter_ReportsAtAttribute(declaration string) {
        let source = "package P\nimport System.Diagnostics.CodeAnalysis" + Environment.NewLine + declaration
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Fact
    func UnscopedRefOutRefStructParameter_IsValidOnInterfaceAndMember() {
        let diagnostics = Bind(`package P
import System.Diagnostics.CodeAnalysis
ref struct Acc { var Value int32 }
interface I {
    func Store(@UnscopedRef out value Acc);
}
struct Implementation : I {
    public func Store(@UnscopedRef out value Acc) { value = Acc{} }
}`)
        Assert.Empty(diagnostics)
    }

    @Theory
    @InlineData("let f = (@UnscopedRef value int32) -> value")
    @InlineData("let f = func(@UnscopedRef value int32) int32 { return value }")
    func UnscopedRef_InvalidLambdaParameter_ReportsAtAttribute(declaration string) {
        let source = `package P
import System.Diagnostics.CodeAnalysis
func Test() {
    DECLARATION
}`.Replace("DECLARATION", declaration, StringComparison.Ordinal)
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Fact
    func PlainOutRefStructSlot_RejectsUnscopedRefOverrideAtAttribute() {
        const source = `package P
import System.Diagnostics.CodeAnalysis
ref struct Acc { var Value int32 }
interface I {
    func Store(out value Acc);
}
struct Implementation : I {
    @UnscopedRef
    public func Store(out value Acc) { value = Acc() }
}`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0590")
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start)
    }

    @Fact
    func SubstitutionClone_PreservesUnscopedRefOutContract() {
        let source = ParameterSymbol("value", TypeSymbol.Int32, refKind: RefKind.Out)
        source.MarkUnscopedRef()
        let substituted = ParameterSymbol(source, TypeSymbol.FromClrType(typeof(Span[int32])))
        Assert.Equal(ParameterRefScope.ReturnOnly, substituted.GetEffectiveRefScope())
        Assert.False(
            DeclarationBinder.RequiresUnscopedRefContract(
                TypeSymbol.Void,
                RefKind.None,
                ImmutableArray.Create(substituted),
                implementationReceiver: nil
            )
        )
    }

    @Fact
    func StructuralContracts_DistinguishPlainAndUnscopedOutParameters() {
        let plain = ParameterSymbol("value", TypeSymbol.Int32, refKind: RefKind.Out)
        let unscoped = ParameterSymbol("value", TypeSymbol.Int32, refKind: RefKind.Out)
        unscoped.MarkUnscopedRef()
        Assert.False(plain.HasSameRefContract(unscoped))
        Assert.True(unscoped.HasSameRefContract(ParameterSymbol(unscoped, TypeSymbol.Int32)))
    }

    @Fact
    func StructuralPropertyConversion_RejectsDifferentEffectiveOutContracts() {
        let plain = CreateIndexer(ParameterSymbol("value", TypeSymbol.Int32, refKind: RefKind.Out))
        let unscopedParameter = ParameterSymbol("value", TypeSymbol.Int32, refKind: RefKind.Out)
        unscopedParameter.MarkUnscopedRef()
        let unscoped = CreateIndexer(unscopedParameter)
        Assert.False(GSharp.Core.CodeAnalysis.Binding.Binder.PropertyContractsMatch(plain, unscoped))
    }

    @Fact
    func ImportedSlot_PreservesUnscopedRefOutContract() {
        using let fixture = CSharpFixture(`using System.Diagnostics.CodeAnalysis;
namespace Issue4293.Contracts;
public ref struct RefValue { }
public static class Contract
{
    public static void Store([UnscopedRef] out RefValue value) => value = default;
}`)
        let assembly = fixture.Load()
        let method = Assert.IsAssignableFrom[MethodInfo](
            assembly.GetType("Issue4293.Contracts.Contract")?.GetMethod("Store")
        )
        let imported = method.GetParameters()[0]
        let pointeeType = Assert.IsAssignableFrom[Type](imported.ParameterType.GetElementType())
        let parameter = RefCapabilities.CreateParameterSymbol(imported, TypeSymbol.FromClrType(pointeeType), "value")
        Assert.Equal(ParameterRefScope.ReturnOnly, parameter.GetEffectiveRefScope())
        Assert.False(
            DeclarationBinder.RequiresUnscopedRefContract(
                TypeSymbol.Void,
                RefKind.None,
                ImmutableArray.Create(parameter),
                implementationReceiver: nil
            )
        )
    }

    @Fact
    func ImportedRefSafetyRulesFixture_PreservesMarkerAndExplicitContracts() {
        using let contracts = Issue4563RefSafetyRulesContracts()
        Assert.False(contracts.LegacyHasVersion11Marker)
        Assert.True(contracts.UpdatedHasVersion11Marker)
        Assert.False(
            RefCapabilities.UsesUpdatedEscapeRules(
                contracts.LoadLegacy().GetType("Issue4563.Legacy.Contract")!!.GetMethod("Pick")!!.GetParameters()[0]
            )
        )
        Assert.True(
            RefCapabilities.UsesUpdatedEscapeRules(
                contracts.LoadUpdated().GetType("Issue4563.Updated.Contract")!!.GetMethod("Pick")!!.GetParameters()[0]
            )
        )
        AssertImportedScope(contracts.LoadLegacy(), "Issue4563.Legacy.Contract", "Pick", ParameterRefScope.Caller)
        AssertImportedScope(
            contracts.LoadLegacy(),
            "Issue4563.Legacy.Contract",
            "PickUnscoped",
            ParameterRefScope.Caller
        )
        AssertImportedScope(
            contracts.LoadLegacy(),
            "Issue4563.Legacy.Contract",
            "PickScoped",
            ParameterRefScope.FunctionLocal
        )
        AssertImportedScope(
            contracts.LoadUpdated(),
            "Issue4563.Updated.Contract",
            "Pick",
            ParameterRefScope.FunctionLocal
        )
        AssertImportedScope(
            contracts.LoadUpdated(),
            "Issue4563.Updated.Contract",
            "PickUnscoped",
            ParameterRefScope.ReturnOnly
        )
        AssertImportedScope(
            contracts.LoadUpdated(),
            "Issue4563.Updated.Contract",
            "PickScoped",
            ParameterRefScope.FunctionLocal
        )
    }

    @Fact
    func ImportedOutParameter_UsesDeclaringModulesRefSafetyRules() {
        using let contracts = Issue4563RefSafetyRulesContracts()
        const legacySource = `package P
import Issue4563.Legacy
func Bad(contract Contract) ref int32 {
    var scratch int32
    return ref contract.Pick(out scratch)
}`
        let legacyDiagnostic = Assert.Single(
            BindWithReferences(legacySource, contracts.LegacyPath),
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0254"
        )
        Assert.Equal(
            legacySource.LastIndexOf("contract.Pick", StringComparison.Ordinal),
            legacyDiagnostic.Location.Span.Start
        )
        let updatedDiagnostics = BindWithReferences(`package P
import Issue4563.Updated
func Good(contract Contract) ref int32 {
    var scratch int32
    return ref contract.Pick(out scratch)
}`, contracts.UpdatedPath)
        Assert.Empty(updatedDiagnostics)
        const updatedUnscopedSource = `package P
import Issue4563.Updated
func Bad(contract Contract) ref int32 {
    var scratch int32
    return ref contract.PickUnscoped(out scratch)
}`
        let updatedUnscopedDiagnostic = Assert.Single(
            BindWithReferences(updatedUnscopedSource, contracts.UpdatedPath),
            (diagnostic Diagnostic) -> diagnostic.Id == "GS0254"
        )
        Assert.Equal(
            updatedUnscopedSource.LastIndexOf("contract.PickUnscoped", StringComparison.Ordinal),
            updatedUnscopedDiagnostic.Location.Span.Start
        )
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] -> BindWithReferences(source)

        private func BindWithReferences(source string, references ...string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            using let resolver = if references.Length == 0 {
                ReferenceResolver.Default()
            } else {
                ReferenceResolver.WithReferences(references)
            }
            let compilation = Compilation(resolver, tree)
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

        private func CreateIndexer(parameter ParameterSymbol) PropertySymbol -> PropertySymbol(
            "Item",
            TypeSymbol.Int32,
            Accessibility.Public,
            hasGetter: true,
            hasSetter: false,
            isAutoProperty: false,
            isVirtual: false,
            isOverride: false
        ){IsIndexer = true, Parameters = ImmutableArray.Create(parameter)}

        private func AssertImportedScope(
            assembly Assembly,
            typeName string,
            methodName string,
            expected ParameterRefScope
        ) {
            let parameter = assembly.GetType(typeName)!!.GetMethod(methodName)!!.GetParameters()[0]
            let symbol = RefCapabilities.CreateParameterSymbol(parameter, TypeSymbol.Int32, "value")
            Assert.Equal(expected, symbol.GetEffectiveRefScope())
        }
    }
}
