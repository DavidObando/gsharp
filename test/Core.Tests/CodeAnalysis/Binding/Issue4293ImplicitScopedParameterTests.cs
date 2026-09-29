// <copyright file="Issue4293ImplicitScopedParameterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests.Fixtures;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4293: C# implicit parameter ref scopes.
/// </summary>
public sealed class Issue4293ImplicitScopedParameterTests
{
    [Fact]
    public void OutParameter_CannotBeReturnedByReference()
    {
        const string source = """
            package P
            func Bad(out value int32) ref int32 {
                value = 42
                return ref value
            }
            """;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0254");
        Assert.Equal(source.LastIndexOf("value", StringComparison.Ordinal), diagnostic.Location.Span.Start);
        Assert.Contains("scoped parameter", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefStructOutParameter_CannotBeReturnedByReference()
    {
        const string source = """
            package P
            ref struct Acc { var Value int32 }
            func Bad(out value Acc) ref Acc {
                value = Acc{}
                return ref value
            }
            """;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0254");
        Assert.Equal(source.LastIndexOf("value", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Fact]
    public void UnscopedRefOutParameter_CanBeReturnedByReference()
    {
        var diagnostics = Bind("""
            package P
            import System.Diagnostics.CodeAnalysis
            func Pass(@UnscopedRef out value int32) ref int32 {
                value = 42
                return ref value
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void OutArgument_DoesNotConstrainRefReturningCall()
    {
        var diagnostics = Bind("""
            package P
            func Pick(out scratch int32, ref stable int32) ref int32 {
                scratch = 0
                return ref stable
            }
            func Forward(ref stable int32) ref int32 {
                var scratch int32
                return ref Pick(out scratch, ref stable)
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ConstrainedSourceStaticOutArgument_DoesNotConstrainRefReturningCall()
    {
        var result = EmittedOracle.Evaluate("""
            package P
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
            Run()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void ConstrainedImportedStaticOutArgument_IsExcludedFromEscapeSources()
    {
        using var contracts = new Issue4563RefSafetyRulesContracts();
        var method = contracts.LoadUpdated()
            .GetType("Issue4563.Updated.IStaticContract")!
            .GetMethod("Pick")!;
        var scratch = new BoundVariableExpression(
            null,
            new LocalVariableSymbol("scratch", isReadOnly: false, TypeSymbol.Int32));
        var call = new BoundConstrainedStaticCallExpression(
            null,
            new TypeParameterSymbol(
                "T",
                ordinal: 0,
                TypeParameterConstraint.Any,
                TypeParameterVariance.None),
            method,
            ImmutableArray.Create<BoundExpression>(scratch),
            ImmutableArray.Create(RefKind.Out),
            TypeSymbol.Int32,
            TypeSymbol.FromClrType(method.DeclaringType!));

        Assert.True(RefCapabilities.IsNativeRefReturningCall(call));
        Assert.True(RefCapabilities.TryGetRefReturnEscapeSources(
            call,
            out var receiver,
            out var byRefArguments,
            out var byValueByRefLikeArguments));
        Assert.Null(receiver);
        Assert.Empty(byRefArguments);
        Assert.Empty(byValueByRefLikeArguments);
    }

    [Fact]
    public void RefSafetyRulesFixture_DisposesLegacyFixtureWhenUpdatedConstructionFails()
    {
        var legacyDirectory = string.Empty;
        Assert.Throws<InvalidOperationException>(() =>
            new Issue4563RefSafetyRulesContracts(path =>
            {
                legacyDirectory = path;
                throw new InvalidOperationException("injected updated-fixture failure");
            }));

        Assert.NotEmpty(legacyDirectory);
        Assert.False(Directory.Exists(legacyDirectory));
    }

    [Fact]
    public void ImportedAdapter_RejectsLegacySourceForUpdatedContract()
    {
        using var contracts = new Issue4563RefSafetyRulesContracts();
        const string source = """
            package P
            import Issue4563.Legacy
            import Issue4563.Updated
            func Bad(value LegacySource) IUpdatedContract {
                return adapt[IUpdatedContract](value)
            }
            """;

        var diagnostic = Assert.Single(
            BindWithReferences(source, contracts.LegacyPath, contracts.UpdatedPath),
            candidate => candidate.Id == "GS0606");
        Assert.Equal(source.IndexOf("adapt", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Fact]
    public void ImportedAdapter_AcceptsUpdatedSourceForUpdatedContract()
    {
        using var contracts = new Issue4563RefSafetyRulesContracts();
        var diagnostics = BindWithReferences("""
            package P
            import Issue4563.Updated
            func Good(value UpdatedSource) IUpdatedContract {
                return adapt[IUpdatedContract](value)
            }
            """, contracts.UpdatedPath);

        Assert.Empty(diagnostics);
    }

    [Theory]
    [InlineData("ScopedSource", "IPlainContract")]
    [InlineData("PlainSource", "IScopedContract")]
    public void ImportedAdapter_AcceptsEquivalentEffectiveOutContracts(
        string sourceType,
        string targetType)
    {
        using var contracts = new Issue4563RefSafetyRulesContracts();
        var assembly = contracts.LoadEquivalent();
        var sourceParameter = assembly.GetType($"Issue4563.Equivalent.{sourceType}")!
            .GetMethod("Pick")!
            .GetParameters()[0];
        var targetParameter = assembly.GetType($"Issue4563.Equivalent.{targetType}")!
            .GetMethod("Pick")!
            .GetParameters()[0];
        var sourceSymbol = RefCapabilities.CreateParameterSymbol(
            sourceParameter,
            TypeSymbol.Int32,
            "source");
        var targetSymbol = RefCapabilities.CreateParameterSymbol(
            targetParameter,
            TypeSymbol.Int32,
            "target");
        Assert.Equal(RefKind.Out, sourceSymbol.RefKind);
        Assert.Equal(RefKind.Out, targetSymbol.RefKind);
        Assert.Equal(ParameterRefScope.FunctionLocal, sourceSymbol.GetEffectiveRefScope());
        Assert.Equal(ParameterRefScope.FunctionLocal, targetSymbol.GetEffectiveRefScope());
        Assert.NotEqual(sourceSymbol.GetEffectiveValueScope(), targetSymbol.GetEffectiveValueScope());
        Assert.True(targetSymbol.HasSameRefContract(sourceSymbol));
        Assert.True(RefCapabilities.ImportedParameterContractsMatch(
            targetParameter,
            TypeSymbol.Int32,
            sourceParameter,
            TypeSymbol.Int32));
        var diagnostics = BindWithReferences($$"""
            package P
            import Issue4563.Equivalent
            func Good(value {{sourceType}}) {{targetType}} {
                return adapt[{{targetType}}](value)
            }
            """, contracts.EquivalentPath);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void LookalikeRefSafetyRulesMarker_DoesNotEnableUpdatedRules()
    {
        using var contracts = new Issue4563RefSafetyRulesContracts();
        var parameter = contracts.LoadLookalike()
            .GetType("Issue4563.Lookalike.Contract")!
            .GetMethod("Pick")!
            .GetParameters()[0];

        Assert.Contains(
            parameter.Member.Module.GetCustomAttributesData(),
            attribute => attribute.AttributeType.FullName
                == "System.Runtime.CompilerServices.RefSafetyRulesAttribute");
        Assert.False(RefCapabilities.UsesUpdatedEscapeRules(parameter));
        Assert.Equal(
            ParameterRefScope.Caller,
            RefCapabilities.CreateParameterSymbol(parameter, TypeSymbol.Int32, "value")
                .GetEffectiveRefScope());
    }

    [Fact]
    public void UnscopedRefOutArgument_ConstrainsRefReturningCall()
    {
        var diagnostics = Bind("""
            package P
            import System.Diagnostics.CodeAnalysis
            func Pick(@UnscopedRef out scratch int32, ref stable int32) ref int32 {
                scratch = 0
                return ref stable
            }
            func Bad(ref stable int32) ref int32 {
                var scratch int32
                return ref Pick(out scratch, ref stable)
            }
            """);

        Assert.Contains(diagnostics, d => d.Id == "GS0254");
    }

    [Fact]
    public void NestedGenericRichMember_PreservesUnscopedRefOutContractWhenBindingBody()
    {
        var diagnostics = Bind("""
            package P
            import System.Diagnostics.CodeAnalysis
            func Make[T](seed T) {
                let box = object {
                    func Pass(@UnscopedRef out value T) ref T {
                        value = seed
                        return ref value
                    }
                }
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ConstructedGenericInterface_PreservesUnscopedRefOutCallEscape()
    {
        const string source = """
            package P
            import System.Diagnostics.CodeAnalysis
            interface I[T] {
                func Pick(@UnscopedRef out value T) ref T;
            }
            func Bad(source I[int32]) ref int32 {
                var value int32
                return ref source.Pick(out value)
            }
            """;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0254");
        Assert.Equal(source.LastIndexOf("source.Pick", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Fact]
    public void ConstructedGenericDelegate_PreservesUnscopedRefOutContract()
    {
        const string source = """
            package P
            import System.Diagnostics.CodeAnalysis
            delegate Picker[T](@UnscopedRef out value T);
            """;

        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        _ = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(
            compilation.GlobalScope,
            compilation.References);
        Assert.Empty(tree.Diagnostics.Concat(compilation.GlobalScope.Diagnostics));

        var definition = Assert.Single(compilation.GlobalScope.Delegates);
        var constructed = Assert.IsType<DelegateTypeSymbol>(
            DelegateTypeSymbol.Construct(definition, ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32)));
        Assert.Equal(ParameterRefScope.ReturnOnly, Assert.Single(constructed.Parameters).GetEffectiveRefScope());
    }

    [Fact]
    public void RefStructRefParameter_CanStillBeReturnedByReference()
    {
        var diagnostics = Bind("""
            package P
            ref struct Acc { var Value int32 }
            func Pass(ref value Acc) ref Acc {
                return ref value
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void RefStructRefParameter_CannotBeReturnedByValue()
    {
        const string source = """
            package P
            ref struct Acc { var Value int32 }
            func Bad(ref value Acc) Acc {
                return value
            }
            """;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0219");
        Assert.Equal(source.LastIndexOf("value", StringComparison.Ordinal), diagnostic.Location.Span.Start);
        Assert.Contains("function-local safe-to-escape scope", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RefStructRefParameter_ValueScopePropagatesThroughLocal()
    {
        const string source = """
            package P
            ref struct Acc { var Value int32 }
            func Bad(ref value Acc) Acc {
                let copy = value
                return copy
            }
            """;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0219");
        Assert.Equal(source.LastIndexOf("copy", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Fact]
    public void UnscopedRefRefStructParameter_CanBeReturnedByValue()
    {
        var diagnostics = Bind("""
            package P
            import System.Diagnostics.CodeAnalysis
            ref struct Acc { var Value int32 }
            func Pass(@UnscopedRef ref value Acc) Acc {
                return value
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Theory]
    [InlineData(RefKind.Ref)]
    [InlineData(RefKind.In)]
    public void RefAndInParameters_HaveTypeIndependentReturnOnlyRefScope(RefKind refKind)
    {
        var parameter = new ParameterSymbol("value", TypeSymbol.Int32, refKind: refKind);

        Assert.Equal(ParameterRefScope.ReturnOnly, parameter.GetEffectiveRefScope());
    }

    [Theory]
    [InlineData("@UnscopedRef value int32", "requires a 'ref', 'out', or 'in' parameter")]
    [InlineData("@UnscopedRef scoped value int32", "requires a 'ref', 'out', or 'in' parameter")]
    [InlineData("@UnscopedRef scoped ref value int32", "explicit 'scoped' modifier")]
    public void UnscopedRef_InvalidParameterPlacement_ReportsGS0590(
        string parameter,
        string expectedReason)
    {
        var source = $$"""
            package P
            import System.Diagnostics.CodeAnalysis
            func Bad({{parameter}}) { }
            """;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
        Assert.Contains(expectedReason, diagnostic.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("""
        struct Holder {
            func Bad(@UnscopedRef value int32) { }
        }
        """)]
    [InlineData("""
        interface I {
            func Bad(@UnscopedRef value int32);
        }
        """)]
    public void UnscopedRef_InvalidMemberOrInterfaceParameter_ReportsAtAttribute(string declaration)
    {
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            """ + Environment.NewLine + declaration;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Fact]
    public void UnscopedRefOutRefStructParameter_IsValidOnInterfaceAndMember()
    {
        var diagnostics = Bind("""
            package P
            import System.Diagnostics.CodeAnalysis
            ref struct Acc { var Value int32 }
            interface I {
                func Store(@UnscopedRef out value Acc);
            }
            struct Implementation : I {
                public func Store(@UnscopedRef out value Acc) { value = Acc{} }
            }
            """);

        Assert.Empty(diagnostics);
    }

    [Theory]
    [InlineData("let f = (@UnscopedRef value int32) -> value")]
    [InlineData("let f = func(@UnscopedRef value int32) int32 { return value }")]
    public void UnscopedRef_InvalidLambdaParameter_ReportsAtAttribute(string declaration)
    {
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            func Test() {
                DECLARATION
            }
            """.Replace("DECLARATION", declaration, StringComparison.Ordinal);

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Fact]
    public void PlainOutRefStructSlot_RejectsUnscopedRefOverrideAtAttribute()
    {
        const string source = """
            package P
            import System.Diagnostics.CodeAnalysis
            ref struct Acc { var Value int32 }
            interface I {
                func Store(out value Acc);
            }
            struct Implementation : I {
                @UnscopedRef
                public func Store(out value Acc) { value = Acc() }
            }
            """;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Fact]
    public void SubstitutionClone_PreservesUnscopedRefOutContract()
    {
        var source = new ParameterSymbol("value", TypeSymbol.Int32, refKind: RefKind.Out);
        source.MarkUnscopedRef();
        var substituted = new ParameterSymbol(
            source,
            TypeSymbol.FromClrType(typeof(Span<int>)));

        Assert.Equal(ParameterRefScope.ReturnOnly, substituted.GetEffectiveRefScope());
        Assert.False(DeclarationBinder.RequiresUnscopedRefContract(
            TypeSymbol.Void,
            RefKind.None,
            ImmutableArray.Create(substituted),
            implementationReceiver: null));
    }

    [Fact]
    public void StructuralContracts_DistinguishPlainAndUnscopedOutParameters()
    {
        var plain = new ParameterSymbol("value", TypeSymbol.Int32, refKind: RefKind.Out);
        var unscoped = new ParameterSymbol("value", TypeSymbol.Int32, refKind: RefKind.Out);
        unscoped.MarkUnscopedRef();

        Assert.False(plain.HasSameRefContract(unscoped));
        Assert.True(unscoped.HasSameRefContract(new ParameterSymbol(unscoped, TypeSymbol.Int32)));
    }

    [Fact]
    public void StructuralPropertyConversion_RejectsDifferentEffectiveOutContracts()
    {
        var plain = CreateIndexer(new ParameterSymbol("value", TypeSymbol.Int32, refKind: RefKind.Out));
        var unscopedParameter = new ParameterSymbol("value", TypeSymbol.Int32, refKind: RefKind.Out);
        unscopedParameter.MarkUnscopedRef();
        var unscoped = CreateIndexer(unscopedParameter);

        Assert.False(GSharp.Core.CodeAnalysis.Binding.Binder.PropertyContractsMatch(plain, unscoped));
    }

    [Fact]
    public void ImportedSlot_PreservesUnscopedRefOutContract()
    {
        using var fixture = new CSharpFixture("""
            using System.Diagnostics.CodeAnalysis;
            namespace Issue4293.Contracts;
            public ref struct RefValue { }
            public static class Contract
            {
                public static void Store([UnscopedRef] out RefValue value) => value = default;
            }
            """);
        var assembly = fixture.Load();
        var method = Assert.IsAssignableFrom<System.Reflection.MethodInfo>(
            assembly.GetType("Issue4293.Contracts.Contract")?.GetMethod("Store"));
        var imported = method.GetParameters()[0];
        var pointeeType = Assert.IsAssignableFrom<Type>(imported.ParameterType.GetElementType());
        var parameter = RefCapabilities.CreateParameterSymbol(
            imported,
            TypeSymbol.FromClrType(pointeeType),
            "value");

        Assert.Equal(ParameterRefScope.ReturnOnly, parameter.GetEffectiveRefScope());
        Assert.False(DeclarationBinder.RequiresUnscopedRefContract(
            TypeSymbol.Void,
            RefKind.None,
            ImmutableArray.Create(parameter),
            implementationReceiver: null));
    }

    [Fact]
    public void ImportedRefSafetyRulesFixture_PreservesMarkerAndExplicitContracts()
    {
        using var contracts = new Issue4563RefSafetyRulesContracts();
        Assert.False(contracts.LegacyHasVersion11Marker);
        Assert.True(contracts.UpdatedHasVersion11Marker);
        Assert.False(RefCapabilities.UsesUpdatedEscapeRules(
            contracts.LoadLegacy().GetType("Issue4563.Legacy.Contract")!.GetMethod("Pick")!.GetParameters()[0]));
        Assert.True(RefCapabilities.UsesUpdatedEscapeRules(
            contracts.LoadUpdated().GetType("Issue4563.Updated.Contract")!.GetMethod("Pick")!.GetParameters()[0]));
        AssertImportedScope(
            contracts.LoadLegacy(),
            "Issue4563.Legacy.Contract",
            "Pick",
            ParameterRefScope.Caller);
        AssertImportedScope(
            contracts.LoadLegacy(),
            "Issue4563.Legacy.Contract",
            "PickUnscoped",
            ParameterRefScope.Caller);
        AssertImportedScope(
            contracts.LoadLegacy(),
            "Issue4563.Legacy.Contract",
            "PickScoped",
            ParameterRefScope.FunctionLocal);
        AssertImportedScope(
            contracts.LoadUpdated(),
            "Issue4563.Updated.Contract",
            "Pick",
            ParameterRefScope.FunctionLocal);
        AssertImportedScope(
            contracts.LoadUpdated(),
            "Issue4563.Updated.Contract",
            "PickUnscoped",
            ParameterRefScope.ReturnOnly);
        AssertImportedScope(
            contracts.LoadUpdated(),
            "Issue4563.Updated.Contract",
            "PickScoped",
            ParameterRefScope.FunctionLocal);
    }

    [Fact]
    public void ImportedOutParameter_UsesDeclaringModulesRefSafetyRules()
    {
        using var contracts = new Issue4563RefSafetyRulesContracts();
        const string legacySource = """
            package P
            import Issue4563.Legacy
            func Bad(contract Contract) ref int32 {
                var scratch int32
                return ref contract.Pick(out scratch)
            }
            """;
        var legacyDiagnostic = Assert.Single(
            BindWithReferences(legacySource, contracts.LegacyPath),
            diagnostic => diagnostic.Id == "GS0254");
        Assert.Equal(
            legacySource.LastIndexOf("contract.Pick", StringComparison.Ordinal),
            legacyDiagnostic.Location.Span.Start);

        var updatedDiagnostics = BindWithReferences("""
            package P
            import Issue4563.Updated
            func Good(contract Contract) ref int32 {
                var scratch int32
                return ref contract.Pick(out scratch)
            }
            """, contracts.UpdatedPath);
        Assert.Empty(updatedDiagnostics);

        const string updatedUnscopedSource = """
            package P
            import Issue4563.Updated
            func Bad(contract Contract) ref int32 {
                var scratch int32
                return ref contract.PickUnscoped(out scratch)
            }
            """;
        var updatedUnscopedDiagnostic = Assert.Single(
            BindWithReferences(updatedUnscopedSource, contracts.UpdatedPath),
            diagnostic => diagnostic.Id == "GS0254");
        Assert.Equal(
            updatedUnscopedSource.LastIndexOf("contract.PickUnscoped", StringComparison.Ordinal),
            updatedUnscopedDiagnostic.Location.Span.Start);
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
        => BindWithReferences(source);

    private static ImmutableArray<Diagnostic> BindWithReferences(
        string source,
        params string[] references)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        using var resolver = references.Length == 0
            ? ReferenceResolver.Default()
            : ReferenceResolver.WithReferences(references);
        var compilation = new Compilation(resolver, tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(
            compilation.GlobalScope,
            compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }

    private static PropertySymbol CreateIndexer(ParameterSymbol parameter)
        => new(
            "Item",
            TypeSymbol.Int32,
            Accessibility.Public,
            hasGetter: true,
            hasSetter: false,
            isAutoProperty: false,
            isVirtual: false,
            isOverride: false)
        {
            IsIndexer = true,
            Parameters = ImmutableArray.Create(parameter),
        };

    private static void AssertImportedScope(
        System.Reflection.Assembly assembly,
        string typeName,
        string methodName,
        ParameterRefScope expected)
    {
        var parameter = assembly.GetType(typeName)!.GetMethod(methodName)!.GetParameters()[0];
        var symbol = RefCapabilities.CreateParameterSymbol(parameter, TypeSymbol.Int32, "value");
        Assert.Equal(expected, symbol.GetEffectiveRefScope());
    }

}
