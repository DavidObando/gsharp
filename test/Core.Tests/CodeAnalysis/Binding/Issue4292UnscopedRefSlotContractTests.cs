// <copyright file="Issue4292UnscopedRefSlotContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
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

/// <summary>Issue #4292: definition-side <c>@UnscopedRef</c> slot contracts.</summary>
public class Issue4292UnscopedRefSlotContractTests
{
    [Theory]
    [InlineData("")]
    [InlineData("private func (IRefSlot) Slot(ref fallback int32) ref int32 { return ref this.Value }")]
    public void AnnotatedInterfaceMethod_AllowsAnnotatedImplementation(string explicitImplementation)
    {
        var implementation = explicitImplementation.Length == 0
            ? "public func Slot(ref fallback int32) ref int32 { return ref this.Value }"
            : explicitImplementation;
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    @UnscopedRef
    func Slot(ref fallback int32) ref int32;
}
struct Buffer : IRefSlot {
    var Value int32

    @UnscopedRef
    " + implementation + @"
}
";

        Assert.Empty(Bind(source));
    }

    [Theory]
    [InlineData("public func Slot(ref fallback int32) ref int32 { return ref this.Value }")]
    [InlineData("private func (IRefSlot) Slot(ref fallback int32) ref int32 { return ref this.Value }")]
    public void UnannotatedInterfaceMethod_RejectsAnnotatedImplementation(string implementation)
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    func Slot(ref fallback int32) ref int32;
}
struct Buffer : IRefSlot {
    var Value int32

    @UnscopedRef
    " + implementation + @"
}
";

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
        Assert.Equal(
            "'@UnscopedRef' cannot be applied because implemented member 'IRefSlot.Slot' does not have @UnscopedRef.",
            diagnostic.Message);
    }

    [Fact]
    public void AnnotatedInterfaceMethod_AllowsImplementationToRemoveContract()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    @UnscopedRef
    func Slot(ref value int32) ref int32;
}
struct Buffer : IRefSlot {
    public func Slot(ref value int32) ref int32 { return ref value }
}
";

        Assert.Empty(Bind(source));
    }

    [Theory]
    [InlineData("public func Get() int32 { return 0 }")]
    [InlineData("private func (IValue) Get() int32 { return 0 }")]
    public void UnannotatedOrdinaryInterfaceMethod_RejectsAnnotatedImplementation(string implementation)
    {
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            interface IValue {
                func Get() int32;
            }
            struct Value : IValue {
                @UnscopedRef
                IMPLEMENTATION
            }
            """.Replace("IMPLEMENTATION", implementation, StringComparison.Ordinal);

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(
            "'@UnscopedRef' cannot be applied because implemented member 'IValue.Get' does not have @UnscopedRef.",
            diagnostic.Message);
    }

    [Fact]
    public void SameSignatureWithoutImplementedInterface_RemainsLegal()
    {
        var source = @"
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
";

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void StructOverride_WithIrrelevantReturn_DoesNotReportPlacementDiagnostic()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
struct Buffer {
    @UnscopedRef
    override func ToString() string { return ""Buffer"" }
}
";

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void PrivateInterfaceHelper_RejectsUnscopedRef()
    {
        const string source = """
            package P
            import System.Diagnostics.CodeAnalysis
            interface IHelpers {
                @UnscopedRef
                private func Helper() int32 { return 0 }
            }
            """;

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
        Assert.Equal(
            "'@UnscopedRef' requires a virtual interface instance member; a private interface helper has no implementation slot.",
            diagnostic.Message);
    }

    [Theory]
    [InlineData("public prop Slot Span[int32] { set { } }")]
    [InlineData("private prop (IRefSlot) Slot Span[int32] { set { } }")]
    public void AnnotatedInterfaceProperty_AllowsAnnotatedImplementation(string implementation)
    {
        var source = @"
package P
import System
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    @UnscopedRef
    prop Slot Span[int32] { set; }
}
ref struct Buffer : IRefSlot {
    @UnscopedRef
    " + implementation + @"
}
";

        Assert.Empty(Bind(source));
    }

    [Theory]
    [InlineData("public prop Slot Span[int32] { set { } }")]
    [InlineData("private prop (IRefSlot) Slot Span[int32] { set { } }")]
    public void UnannotatedInterfaceProperty_RejectsAnnotatedImplementation(string implementation)
    {
        var source = @"
package P
import System
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    prop Slot Span[int32] { set; }
}
ref struct Buffer : IRefSlot {
    @UnscopedRef
    " + implementation + @"
}
";

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
        Assert.Equal(
            "'@UnscopedRef' cannot be applied because implemented property 'IRefSlot.Slot' setter does not have @UnscopedRef.",
            diagnostic.Message);
    }

    [Theory]
    [InlineData("set")]
    [InlineData("init")]
    public void UnannotatedInterfaceProperty_RejectsAnnotatedAutoProperty(string accessor)
    {
        var source = """
            package P
            import System
            import System.Diagnostics.CodeAnalysis
            interface IRefSlot {
                prop Slot Span[int32] { ACCESSOR; }
            }
            ref struct Buffer : IRefSlot {
                @UnscopedRef
                public prop Slot Span[int32] { ACCESSOR; }
            }
            """.Replace("ACCESSOR", accessor, StringComparison.Ordinal);

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Contains("implemented property 'IRefSlot.Slot'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("set", false)]
    [InlineData("set", true)]
    [InlineData("init", false)]
    [InlineData("init", true)]
    public void UnannotatedConstructedSourceProperty_RejectsAnnotatedImplementation(
        string accessor,
        bool explicitImplementation)
    {
        var declaration = explicitImplementation
            ? "private prop (IRefSlot[int32]) Slot"
            : "public prop Slot";
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            interface IRefSlot[T any] {
                prop Slot T { ACCESSOR; }
            }
            struct Buffer : IRefSlot[int32] {
                @UnscopedRef
                DECLARATION int32 { ACCESSOR { } }
            }
            """
            .Replace("ACCESSOR", accessor, StringComparison.Ordinal)
            .Replace("DECLARATION", declaration, StringComparison.Ordinal);

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(
            "'@UnscopedRef' cannot be applied because implemented property 'IRefSlot[int32].Slot' setter does not have @UnscopedRef.",
            diagnostic.Message);
    }

    [Theory]
    [InlineData("public prop Slot int32 { get { return 0 } }")]
    [InlineData("private prop (IValue) Slot int32 { get { return 0 } }")]
    public void UnannotatedOrdinaryInterfaceGetter_RejectsAnnotatedImplementation(string implementation)
    {
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            interface IValue {
                prop Slot int32 { get; }
            }
            struct Value : IValue {
                @UnscopedRef
                IMPLEMENTATION
            }
            """.Replace("IMPLEMENTATION", implementation, StringComparison.Ordinal);

        var diagnostic = Assert.Single(Bind(source), d => d.Id == "GS0590");
        Assert.Equal(
            "'@UnscopedRef' cannot be applied because implemented property 'IValue.Slot' getter does not have @UnscopedRef.",
            diagnostic.Message);
    }

    [Fact]
    public void AnnotatedOrdinaryInterfaceSlots_AllowUnannotatedImplementation()
    {
        var source = """
            package P
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
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Theory]
    [InlineData("set")]
    [InlineData("init")]
    public void ConstructedSourcePropertySetter_RelevanceUsesSubstitutedSlotType(string accessor)
    {
        var source = """
            package P
            interface IRefSlot[T any] {
                prop Slot T { ACCESSOR; }
            }
            """.Replace("ACCESSOR", accessor, StringComparison.Ordinal);
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var globalScope = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            compilation.References);
        var iface = Assert.Single(globalScope.Interfaces);
        var slot = Assert.Single(iface.Properties);
        var typeParameter = Assert.Single(iface.TypeParameters);
        var byRefLikeMap = new Dictionary<TypeParameterSymbol, TypeSymbol>
        {
            [typeParameter] = TypeSymbol.FromClrType(typeof(Span<int>)),
        };
        var ordinaryMap = new Dictionary<TypeParameterSymbol, TypeSymbol>
        {
            [typeParameter] = TypeSymbol.Int32,
        };

        Assert.True(DeclarationBinder.RequiresUnscopedRefPropertyContract(
            slot,
            TypeSymbol.FromClrType(typeof(Span<int>)),
            isSetter: true,
            byRefLikeMap));
        Assert.False(DeclarationBinder.RequiresUnscopedRefPropertyContract(
            slot,
            TypeSymbol.Int32,
            isSetter: true,
            ordinaryMap));
    }

    [Fact]
    public void ConstructedSourceIndexerGetter_RelevanceUsesSubstitutedSlotType()
    {
        var typeParameter = new TypeParameterSymbol(
            "T",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None);
        var byRefLikeMap = new Dictionary<TypeParameterSymbol, TypeSymbol>
        {
            [typeParameter] = TypeSymbol.FromClrType(typeof(Span<int>)),
        };
        var ordinaryMap = new Dictionary<TypeParameterSymbol, TypeSymbol>
        {
            [typeParameter] = TypeSymbol.Int32,
        };
        var indexerSlot = new PropertySymbol(
            "Item",
            typeParameter,
            Accessibility.Public,
            hasGetter: true,
            hasSetter: false,
            isAutoProperty: false,
            isVirtual: false,
            isOverride: false)
        {
            Parameters = ImmutableArray.Create(
                new ParameterSymbol("key", TypeSymbol.Int32, refKind: RefKind.Ref)),
        };
        Assert.True(DeclarationBinder.RequiresUnscopedRefPropertyContract(
            indexerSlot,
            implementationReceiver: null,
            isSetter: false,
            byRefLikeMap));
        Assert.False(DeclarationBinder.RequiresUnscopedRefPropertyContract(
            indexerSlot,
            implementationReceiver: null,
            isSetter: false,
            ordinaryMap));
    }

    [Theory]
    [InlineData(false, RefKind.None, false)]
    [InlineData(true, RefKind.Ref, false)]
    [InlineData(true, RefKind.In, false)]
    [InlineData(true, RefKind.Out, false)]
    [InlineData(true, RefKind.None, true)]
    public void RefReturn_RelevanceRequiresAnAdditionalParameter(
        bool hasParameter,
        RefKind refKind,
        bool parameterIsByRefLike)
    {
        var parameters = hasParameter
            ? ImmutableArray.Create(new ParameterSymbol(
                "value",
                parameterIsByRefLike
                    ? TypeSymbol.FromClrType(typeof(Span<int>))
                    : TypeSymbol.Int32,
                refKind: refKind))
            : ImmutableArray<ParameterSymbol>.Empty;

        Assert.Equal(
            hasParameter,
            DeclarationBinder.RequiresUnscopedRefContract(
                TypeSymbol.Int32,
                RefKind.Ref,
                parameters,
                implementationReceiver: null));
    }

    [Theory]
    [InlineData(RefKind.Ref, false, false, true)]
    [InlineData(RefKind.Ref, true, false, false)]
    [InlineData(RefKind.Out, true, false, true)]
    [InlineData(RefKind.Out, false, false, true)]
    [InlineData(RefKind.Out, false, true, true)]
    public void RefStructParameter_RelevanceMatchesCSharp(
        RefKind refKind,
        bool isScoped,
        bool hasAdditionalParameter,
        bool expected)
    {
        var parameters = ImmutableArray.CreateBuilder<ParameterSymbol>();
        parameters.Add(new ParameterSymbol(
            "view",
            TypeSymbol.FromClrType(typeof(Span<int>)),
            isScoped: isScoped,
            refKind: refKind));
        if (hasAdditionalParameter)
        {
            parameters.Add(new ParameterSymbol("other", TypeSymbol.Int32, refKind: RefKind.In));
        }

        Assert.Equal(
            expected,
            DeclarationBinder.RequiresUnscopedRefContract(
                TypeSymbol.Void,
                RefKind.None,
                parameters.ToImmutable(),
                implementationReceiver: null));
    }

    [Fact]
    public void OneImplementationOfMultipleUnannotatedSlots_ReportsOnce()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IA { func Slot(ref fallback int32) ref int32; }
interface IB { func Slot(ref fallback int32) ref int32; }
struct Buffer : IA, IB {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32) ref int32 { return ref this.Value }
}
";

        Assert.Single(Bind(source), d => d.Id == "GS0590");
    }

    [Fact]
    public void DistinctIncompatibleImplementations_ReportSeparately()
    {
        var source = @"
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
";

        Assert.Equal(2, Bind(source).Count(d => d.Id == "GS0590"));
    }

    [Fact]
    public void ImportedInterfaceContracts_AreReadFromMethodMetadata()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var rejected = BindWithFixtures(@"
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IMethod {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32) ref int32 { return ref this.Value }
}
", contracts);
        Assert.Single(rejected, d => d.Id == "GS0590");

        var accepted = BindWithFixtures(@"
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IAnnotatedMethod {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32) ref int32 { return ref this.Value }
}
", contracts);
        Assert.Empty(accepted);
    }

    [Theory]
    [InlineData("public func Get() int32 { return 0 }")]
    [InlineData("private func (IValueMethod) Get() int32 { return 0 }")]
    public void ImportedOrdinaryMethod_RejectsAddedContract(string implementation)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            struct Buffer : IValueMethod {
                @UnscopedRef
                IMPLEMENTATION
            }
            """.Replace("IMPLEMENTATION", implementation, StringComparison.Ordinal);

        Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
    }

    [Theory]
    [InlineData("public prop Value int32 { get { return 0 } set { } }")]
    [InlineData("private prop (IValueProperty) Value int32 { get { return 0 } set { } }")]
    public void ImportedOrdinaryProperty_RejectsAddedContract(string implementation)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            struct Buffer : IValueProperty {
                @UnscopedRef
                IMPLEMENTATION
            }
            """.Replace("IMPLEMENTATION", implementation, StringComparison.Ordinal);

        Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
    }

    [Fact]
    public void ImportedScopedRef_IdentityDoesNotRelaxInterfaceContract()
    {
        using var contracts = new Issue4292ScopedRefIdentityContracts();
        using (var resolver = ReferenceResolver.WithReferences(contracts.Paths))
        {
            Assert.True(resolver.TryResolveType(
                "Issue4292.ScopedIdentity.IRuntimeScoped",
                out var runtimeScoped));
            var attributeType = Assert.Single(runtimeScoped
                .GetMethod("Store")!
                .GetParameters()[0]
                .GetCustomAttributesData()).AttributeType;
            Assert.True(
                GSharp.Core.CodeAnalysis.Binding.KnownAttributes.IsScopedRef(attributeType),
                attributeType.AssemblyQualifiedName);

            Assert.True(resolver.TryResolveType(
                "Issue4292.ScopedIdentity.ILookalikeScoped",
                out var lookalikeScoped));
            var lookalikeAttributeType = Assert.Single(lookalikeScoped
                .GetMethod("Store")!
                .GetParameters()[0]
                .GetCustomAttributesData()).AttributeType;
            Assert.Equal(
                "System.Runtime.CompilerServices.ScopedRefAttribute",
                lookalikeAttributeType.FullName);
            Assert.False(
                GSharp.Core.CodeAnalysis.Binding.KnownAttributes.IsScopedRef(lookalikeAttributeType),
                lookalikeAttributeType.AssemblyQualifiedName);
        }

        const string implementation = """
            struct Buffer : INTERFACE {
                @UnscopedRef
                public func Store(ref view RefValue) { }
            }
            """;
        const string prefix = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.ScopedIdentity
            """;

        Assert.Single(
            BindWithReferences(
                prefix + Environment.NewLine + implementation.Replace(
                    "INTERFACE",
                    "ILookalikeScoped",
                    StringComparison.Ordinal),
                contracts.Paths),
            d => d.Id == "GS0590");
        Assert.Single(
            BindWithReferences(
                prefix + Environment.NewLine + implementation.Replace(
                    "INTERFACE",
                    "IRuntimeScoped",
                    StringComparison.Ordinal),
                contracts.Paths),
            d => d.Id == "GS0590");
    }

    [Fact]
    public void ScopedRefIdentityFixture_DisposesPartialConstructionOnFailure()
    {
        var lookalikeDirectory = string.Empty;
        var contractsDirectory = string.Empty;
        Assert.Throws<InvalidOperationException>(() =>
            new Issue4292ScopedRefIdentityContracts((lookalike, contracts) =>
            {
                lookalikeDirectory = lookalike;
                contractsDirectory = contracts;
                throw new InvalidOperationException("injected rewrite failure");
            }));

        Assert.NotEmpty(lookalikeDirectory);
        Assert.NotEmpty(contractsDirectory);
        Assert.False(Directory.Exists(lookalikeDirectory));
        Assert.False(Directory.Exists(contractsDirectory));
    }

    [Fact]
    public void ImportedSymbolicGenericInterface_EnforcesContract()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Token { }
struct Buffer : IGenericMethod[Token] {
    var Value int32

    @UnscopedRef
    public func Slot(ref fallback int32, value Token) ref int32 { return ref this.Value }
}
";

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Contains("IGenericMethod", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedUnannotatedRefProperty_RejectsAnnotatedImplementation()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IRefProperty {
    var Value int32

    @UnscopedRef
    public prop Slot ref int32 { get { return ref this.Value } }
}
";

        Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
    }

    [Fact]
    public void ImportedIndexerGetterContract_IsEnforced()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string implementation = """
            ref struct Buffer : $INTERFACE$ {
                var Value int32

                @UnscopedRef
                public prop this[view RefValue] ref int32 {
                    get { return ref this.Value }
                }
            }
            """;
        var prefix = """
            package P
            import System
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            """;

        Assert.Empty(BindWithFixtures(
            prefix + Environment.NewLine + implementation.Replace(
                "$INTERFACE$",
                "IGetterIndexer",
                StringComparison.Ordinal),
            contracts));
        Assert.Single(
            BindWithFixtures(
                prefix + Environment.NewLine + implementation.Replace(
                    "$INTERFACE$",
                    "IUnannotatedIndexer",
                    StringComparison.Ordinal),
                contracts),
            d => d.Id == "GS0590");
    }

    [Fact]
    public void ImportedSetterOnlyContract_IsReadFromSetterMetadata()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
ref struct Buffer : ISetterProperty {
    @UnscopedRef
    public prop Slot RefValue { set { } }
}
";

        Assert.Empty(BindWithFixtures(source, contracts));
    }

    [Fact]
    public void ImportedSetterOnlyContract_IsReadFromPropertyMetadata()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
ref struct Buffer : IPropertyAnnotatedSetter {
    @UnscopedRef
    public prop Slot RefValue { set { } }
}
";

        Assert.Empty(BindWithFixtures(source, contracts));
    }

    [Fact]
    public void InvalidClassPlacement_SuppressesImportedOverrideContractDiagnostic()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
class Derived : Base, IMethod {
    @UnscopedRef
    override func Slot(ref fallback int32) ref int32 { return ref fallback }
}
";

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Contains("requires a struct instance member", diagnostic.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("overridden member", diagnostic.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("implemented member", diagnostic.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedExplicitMethodContract_PrefersLinkedSlotOverPlainMember(bool explicitFirst)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string plain = "public func Slot(ref fallback int32) ref int32 { return ref this.Value }";
        const string explicitMember = """
            @UnscopedRef
            private func (IMethod) Slot(ref fallback int32) ref int32 { return ref this.Value }
            """;
        var members = explicitFirst
            ? explicitMember + Environment.NewLine + plain
            : plain + Environment.NewLine + explicitMember;
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            struct Buffer : IMethod {
                var Value int32

            """ + members + """

            }
            """;

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedExplicitPropertyContract_PrefersLinkedAccessorsOverPlainProperty(bool explicitFirst)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string plain = """
            public prop this[view RefValue] ref int32 {
                get { return ref this.Value }
            }
            """;
        const string explicitMember = """
            @UnscopedRef
            private prop (IUnannotatedIndexer) this[view RefValue] ref int32 {
                get { return ref this.Value }
            }
            """;
        var members = explicitFirst
            ? explicitMember + Environment.NewLine + plain
            : plain + Environment.NewLine + explicitMember;
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            ref struct Buffer : IUnannotatedIndexer {
                var Value int32

            """ + members + """

            }
            """;

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedSymbolicExplicitMethodContract_PrefersLinkedSlotOverPlainMember(bool explicitFirst)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string plain = "public func Slot(ref fallback int32, value Token) ref int32 { return ref this.Value }";
        const string explicitMember = """
            @UnscopedRef
            private func (IGenericMethod[Token]) Slot(ref fallback int32, value Token) ref int32 {
                return ref this.Value
            }
            """;
        var members = explicitFirst
            ? explicitMember + Environment.NewLine + plain
            : plain + Environment.NewLine + explicitMember;
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            class Token { }
            struct Buffer : IGenericMethod[Token] {
                var Value int32

            """ + members + """

            }
            """;

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedSymbolicExplicitPropertyContract_PrefersLinkedAccessorsOverPlainProperty(bool explicitFirst)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string plain = "public prop Slot RefValue { set { } }";
        const string explicitMember = """
            @UnscopedRef
            private prop (IGenericProperty[Token]) Slot RefValue { set { } }
            """;
        var members = explicitFirst
            ? explicitMember + Environment.NewLine + plain
            : plain + Environment.NewLine + explicitMember;
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            class Token { }
            ref struct Buffer : IGenericProperty[Token] {

            """ + members + """

            }
            """;

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Fact]
    public void ImportedSymbolicExplicitProperty_WithTypeArgument_IsLinked()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
            import Issue4292.Contracts
            class Token { }
            struct Buffer : IGenericValueProperty[Token] {
                private prop (IGenericValueProperty[Token]) Value Token {
                    get { return Token() }
                }
            }
            """, contracts);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ImportedConcreteExplicitProperty_WithConstructedResult_IsLinked()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
            import System.Collections.Generic
            import Issue4292.Contracts
            struct Buffer : IGenericCollectionProperty[int32] {
                private prop (IGenericCollectionProperty[int32]) Values ICollection[int32] {
                    get { throw System.NotImplementedException() }
                }
            }
            """, contracts);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void UnscopedRefPropertyCache_OnlyAcceptsPropertyAccessorNames()
    {
        var getter = typeof(string).GetProperty(nameof(string.Length)).GetMethod;
        var explicitGetter = typeof(ExplicitPropertyAccessorProbe)
            .GetProperties(System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)
            .Single()
            .GetMethod;
        var eventAdder = typeof(AppDomain).GetEvent(nameof(AppDomain.AssemblyLoad)).AddMethod;
        var operatorMethod = typeof(decimal).GetMethods()
            .Single(method => method.Name == "op_Addition");

        Assert.True(RefCapabilities.IsPropertyAccessor(getter));
        Assert.True(RefCapabilities.IsPropertyAccessor(explicitGetter));
        Assert.False(RefCapabilities.IsPropertyAccessor(eventAdder));
        Assert.False(RefCapabilities.IsPropertyAccessor(operatorMethod));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedSymbolicIndexer_UsesCompleteSignature(bool explicitFirst)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string plain = "public prop this[key int32] RefValue { set { } }";
        const string explicitMember = """
            @UnscopedRef
            private prop (IGenericOverloadedIndexer[Token]) this[key Token] RefValue { set { } }
            """;
        var members = explicitFirst
            ? explicitMember + Environment.NewLine + plain
            : plain + Environment.NewLine + explicitMember;
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            class Token { }
            ref struct Buffer : IGenericOverloadedIndexer[Token] {

            """ + members + """

            }
            """;

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedSymbolicImplicitIndexer_UsesCompleteSignature(bool annotatedFirst)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string annotated = """
            @UnscopedRef
            public prop this[key Token] RefValue { set { } }
            """;
        const string plain = "public prop this[key int32] RefValue { set { } }";
        var members = annotatedFirst
            ? annotated + Environment.NewLine + plain
            : plain + Environment.NewLine + annotated;
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            class Token { }
            ref struct Buffer : IGenericOverloadedIndexer[Token] {

            """ + members + """

            }
            """;

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Fact]
    public void ImportedIndexer_UsesRefKindInCompleteSignature()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
            import Issue4292.Contracts
            ref struct Buffer : IRefKindIndexer {
                public prop this[key int32] RefValue { set { } }
            }
            """, contracts);

        Assert.Single(diagnostics, d => d.Id == "GS0187");
    }

    [Fact]
    public void InheritedSymbolicSlots_CheckEachConstructedInterface()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
            import Issue4292.Contracts
            class A { }
            class B { }
            struct Buffer : IChild[A], IChild[B] {
                public func Put(value A) { }
            }
            """, contracts);

        Assert.Single(diagnostics, d => d.Id == "GS0187");
    }

    [Fact]
    public void InheritedSwappedSymbolicMethod_UsesProjectedOwnerArguments()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
            import Issue4292.Contracts
            class A { }
            class B { }
            ref struct Buffer : IProjectedChild[A, B] {
                public func Put(first B, second A) { }
                public prop this[first B, second A] RefValue { set { } }
            }
            """, contracts);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void InheritedSwappedSymbolicProperty_UsesProjectedOwnerArguments()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
            import Issue4292.Contracts
            class A { }
            class B { }
            ref struct Buffer : IProjectedChild[A, B] {
                public func Put(first B, second A) { }
                public prop this[first B, second A] RefValue { set { } }
            }
            """, contracts);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void DuplicateInheritedSymbolicSlots_ReportMissingMemberOnce()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
            import Issue4292.Contracts
            class A { }
            struct Buffer : ILeft[A], IRight[A] {
            }
            """, contracts);

        Assert.Single(diagnostics, d => d.Id == "GS0187");
    }

    [Fact]
    public void InheritedGenericExplicitMethod_RequiresExactConstructedOwner()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
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
            }
            """, contracts);

        Assert.Single(diagnostics, d => d.Id == "GS0187");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0590");
    }

    [Fact]
    public void InheritedGenericExplicitProperty_RequiresExactConstructedOwner()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            class A { }
            class B { }
            ref struct Buffer : IDerivedInvariantProperty[A], IDerivedInvariantProperty[B] {
                @UnscopedRef
                private prop (IBaseInvariantProperty[A]) Slot RefValue { set { } }
            }
            """, contracts);

        Assert.Single(diagnostics, d => d.Id == "GS0187");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0590");
    }

    [Fact]
    public void SourceDefaultMethod_IgnoresUnrelatedExplicitImplementation()
    {
        const string source = """
            package P
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
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void SourceDefaultProperty_IgnoresUnrelatedExplicitImplementation()
    {
        const string source = """
            package P
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
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void ImportedDefaultMethod_IgnoresUnrelatedExplicitImplementation()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            struct Buffer : IDefaultMethod, IAnnotatedMethod {
                @UnscopedRef
                private func (IAnnotatedMethod) Slot(ref fallback int32) ref int32 {
                    return ref fallback
                }
            }
            """;

        Assert.Empty(BindWithFixtures(source, contracts));
    }

    [Fact]
    public void ImportedDefaultProperty_IgnoresUnrelatedExplicitImplementation()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            ref struct Buffer : IDefaultProperty, IPropertyAnnotatedSetter {
                @UnscopedRef
                private prop (IPropertyAnnotatedSetter) Slot RefValue { set { } }
            }
            """;

        Assert.Empty(BindWithFixtures(source, contracts));
    }

    [Theory]
    [InlineData("public func Slot(ref fallback int32) ref int32 { return ref this.Value }")]
    [InlineData("private func (IDefaultMethod) Slot(ref fallback int32) ref int32 { return ref this.Value }")]
    public void ImportedDefaultMethod_ValidatesExistingReplacement(string implementation)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
struct Buffer : IDefaultMethod {
    var Value int32

    @UnscopedRef
    " + implementation + @"
}
";

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Contains("implemented member", diagnostic.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("public prop Slot RefValue { set { } }")]
    [InlineData("private prop (IDefaultProperty) Slot RefValue { set { } }")]
    public void ImportedDefaultProperty_ValidatesExistingReplacement(string implementation)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
import Issue4292.Contracts
ref struct Buffer : IDefaultProperty {
    @UnscopedRef
    " + implementation + @"
}
";

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Contains("implemented property", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedSymbolicDefaultMethod_ValidatesExistingExplicitReplacement()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            class Token { }
            struct Buffer : IGenericDefaultMethod[Token] {
                var Value int32

                @UnscopedRef
                private func (IGenericDefaultMethod[Token]) Slot(ref fallback int32, value Token) ref int32 {
                    return ref this.Value
                }
            }
            """;

        Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
    }

    [Fact]
    public void ImportedSymbolicDefaultProperty_ValidatesExistingExplicitReplacement()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            class Token { }
            ref struct Buffer : IGenericDefaultProperty[Token] {
                @UnscopedRef
                private prop (IGenericDefaultProperty[Token]) Slot RefValue { set { } }
            }
            """;

        Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
    }

    [Fact]
    public void ImportedDefaultMembers_RemainOptionalWhenNotReplaced()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        Assert.Empty(BindWithFixtures("""
            package P
            import Issue4292.Contracts
            class Token { }
            ref struct Buffer :
                IDefaultMethod,
                IDefaultProperty,
                IGenericDefaultMethod[Token],
                IGenericDefaultProperty[Token],
                IDerivedDefaultProperty,
                IDerivedGenericDefaultProperty[Token] {
            }
            """, contracts));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedInheritedExplicitMethodContract_PrefersLinkedSlotOverPlainMember(bool explicitFirst)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string plain = "public func Slot(ref fallback int32) ref int32 { return ref fallback }";
        const string explicitMember = """
            @UnscopedRef
            private func (IBaseMethod) Slot(ref fallback int32) ref int32 { return ref this.Value }
            """;
        var members = explicitFirst
            ? explicitMember + Environment.NewLine + plain
            : plain + Environment.NewLine + explicitMember;
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            struct Buffer : IDerivedMethod {
                var Value int32

            """ + members + """

            }
            """;

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedInheritedDefaultMethod_ValidatesLinkedReplacement(bool explicitFirst)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string plain = "public func Slot(ref fallback int32) ref int32 { return ref fallback }";
        const string explicitMember = """
            @UnscopedRef
            private func (IBaseDefaultMethod) Slot(ref fallback int32) ref int32 { return ref this.Value }
            """;
        var members = explicitFirst
            ? explicitMember + Environment.NewLine + plain
            : plain + Environment.NewLine + explicitMember;
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            struct Buffer : IDerivedDefaultMethod {
                var Value int32

            """ + members + """

            }
            """;

        Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedInheritedDefaultProperty_ValidatesLinkedReplacement(bool explicitFirst)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string plain = "public prop Slot RefValue { set { } }";
        const string explicitMember = """
            @UnscopedRef
            private prop (IBaseDefaultProperty) Slot RefValue { set { } }
            """;
        var members = explicitFirst
            ? explicitMember + Environment.NewLine + plain
            : plain + Environment.NewLine + explicitMember;
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            ref struct Buffer : IDerivedDefaultProperty {

            """ + members + """

            }
            """;

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Equal(source.IndexOf("@UnscopedRef", StringComparison.Ordinal), diagnostic.Location.Span.Start);
        Assert.Contains("IBaseDefaultProperty.Slot", diagnostic.Message, StringComparison.Ordinal);
        Assert.Contains("setter does not have @UnscopedRef", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedInheritedSymbolicDefaultProperty_ValidatesLinkedReplacement()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            class Token { }
            ref struct Buffer : IDerivedGenericDefaultProperty[Token] {
                public prop Slot RefValue { set { } }

                @UnscopedRef
                private prop (IBaseGenericDefaultProperty[Token]) Slot RefValue { set { } }
            }
            """;

        Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
    }

    [Fact]
    public void ImportedInheritedProperty_UsesPlainPropertyFromBaseClass()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
            import Issue4292.Contracts
            open class Base {
                public prop Value int32 { get { return 1 } }
            }
            class Derived : Base, IDerivedValueProperty { }
            """, contracts);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ImportedInheritedProperty_UsesPublicFieldFromBaseClass()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
            import Issue4292.Contracts
            open class Base {
                public var Value int32
            }
            class Derived : Base, IDerivedValueProperty { }
            """, contracts);

        Assert.Empty(diagnostics);
    }

    [Fact]
    public void ImportedInheritedProperty_PublicFieldFromBaseClass_EmitsAndDispatches()
    {
        var contracts = new Issue4292UnscopedRefContracts();
        try
        {
            AssertInheritedFieldDispatches(contracts.Path);
        }
        finally
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            contracts.Dispose();
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void AssertInheritedFieldDispatches(string contractPath)
    {
        var result = EmittedOracle.Evaluate(
            """
            package P
            import Issue4292.Contracts
            open class Base {
                public var Value int32
            }
            class Derived : Base, IDerivedValueProperty { }
            let value = Derived()
            value.Value = 42
            var contract IDerivedValueProperty = value
            contract.Value
            """,
            new[] { contractPath });

        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(42, result.Value);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedInheritedProperty_PrefersExactExplicitMemberOverPlainProperty(bool explicitFirst)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string plain = "public prop Value int32 { get { return 1 } }";
        const string explicitMember = """
            @UnscopedRef
            private prop (IBaseValueProperty) Value int32 { get { return 2 } }
            """;
        var members = explicitFirst
            ? explicitMember + Environment.NewLine + plain
            : plain + Environment.NewLine + explicitMember;
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            ref struct Derived : IDerivedValueProperty {
            """ + members + """
            }
            """;

        var diagnostic = Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
        Assert.Contains("IBaseValueProperty.Value", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedInheritedProperty_WrongBaseMemberReportsMissingSlot()
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var diagnostics = BindWithFixtures("""
            package P
            import Issue4292.Contracts
            open class Base {
                public prop Value string { get { return ""wrong"" } }
            }
            class Derived : Base, IDerivedValueProperty { }
            """, contracts);

        Assert.Single(diagnostics, d => d.Id == "GS0187");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportedInheritedSymbolicMethodContract_PrefersLinkedSlotOverPlainMember(bool explicitFirst)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        const string plain = "public func Slot(ref fallback int32, value Token) ref int32 { return ref fallback }";
        const string explicitMember = """
            @UnscopedRef
            private func (IBaseGenericMethod[Token]) Slot(ref fallback int32, value Token) ref int32 {
                return ref this.Value
            }
            """;
        var members = explicitFirst
            ? explicitMember + Environment.NewLine + plain
            : plain + Environment.NewLine + explicitMember;
        var source = """
            package P
            import System.Diagnostics.CodeAnalysis
            import Issue4292.Contracts
            class Token { }
            struct Buffer : IDerivedGenericMethod[Token] {
                var Value int32

            """ + members + """

            }
            """;

        Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
    }

    [Theory]
    [InlineData("method")]
    [InlineData("property")]
    [InlineData("indexer")]
    public void SourceInterface_UsesInheritedExactExplicitImplementation(string memberKind)
    {
        var interfaceMember = memberKind switch
        {
            "method" => "func Slot() int32;",
            "property" => "prop Slot int32 { get; }",
            _ => "prop this[key int32] int32 { get; }",
        };
        var implementation = memberKind switch
        {
            "method" => "private func (IContract) Slot() int32 { return 0 }",
            "property" => "private prop (IContract) Slot int32 { get { return 0 } }",
            _ => "private prop (IContract) this[key int32] int32 { get { return key } }",
        };
        var source = """
            package P
            interface IContract {
                INTERFACE_MEMBER
            }
            open class Base : IContract {
                IMPLEMENTATION
            }
            class Derived : Base, IContract { }
            """
            .Replace("INTERFACE_MEMBER", interfaceMember, StringComparison.Ordinal)
            .Replace("IMPLEMENTATION", implementation, StringComparison.Ordinal);

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void UnrelatedInheritedExplicitImplementation_DoesNotSatisfyInterface()
    {
        var source = """
            package P
            interface IA { func Slot() int32; }
            interface IB { func Slot() int32; }
            open class Base : IB {
                private func (IB) Slot() int32 { return 0 }
            }
            class Derived : Base, IA { }
            """;

        Assert.Single(Bind(source), d => d.Id == "GS0187");
    }

    [Theory]
    [InlineData("method")]
    [InlineData("property")]
    [InlineData("indexer")]
    [InlineData("symbolic-method")]
    [InlineData("symbolic-property")]
    public void ImportedInterface_UsesInheritedExactExplicitImplementation(string memberKind)
    {
        using var contracts = new Issue4292UnscopedRefContracts();
        var baseDeclaration = memberKind switch
        {
            "method" => """
                open class Base : IMethod {
                    var Value int32
                    private func (IMethod) Slot(ref fallback int32) ref int32 { return ref this.Value }
                }
                class Derived : Base, IMethod { }
                """,
            "property" => """
                open class Base : ISetterProperty {
                    private prop (ISetterProperty) Slot RefValue { set { } }
                }
                class Derived : Base, ISetterProperty { }
                """,
            "indexer" => """
                open class Base : IUnannotatedIndexer {
                    var Value int32
                    private prop (IUnannotatedIndexer) this[view RefValue] ref int32 {
                        get { return ref this.Value }
                    }
                }
                class Derived : Base, IUnannotatedIndexer { }
                """,
            "symbolic-method" => """
                class Token { }
                open class Base : IGenericMethod[Token] {
                    var Value int32
                    private func (IGenericMethod[Token]) Slot(ref fallback int32, value Token) ref int32 {
                        return ref this.Value
                    }
                }
                class Derived : Base, IGenericMethod[Token] { }
                """,
            _ => """
                class Token { }
                open class Base : IGenericValueProperty[Token] {
                    private prop (IGenericValueProperty[Token]) Value Token {
                        get { return Token() }
                    }
                }
                class Derived : Base, IGenericValueProperty[Token] { }
                """,
        };
        var source = """
            package P
            import Issue4292.Contracts
            """ + Environment.NewLine + baseDeclaration;

        Assert.Empty(BindWithFixtures(source, contracts));
    }

    private interface IPropertyAccessorProbe
    {
        int Value { get; }
    }

    private sealed class ExplicitPropertyAccessorProbe : IPropertyAccessorProbe
    {
        int IPropertyAccessorProbe.Value => 0;
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(compilation.GlobalScope, compilation.References);
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }

    private static ImmutableArray<Diagnostic> BindWithFixtures(
        string source,
        Issue4292UnscopedRefContracts contracts)
        => BindWithReferences(source, new[] { contracts.Path });

    private static ImmutableArray<Diagnostic> BindWithReferences(
        string source,
        string[] references)
    {
        using var resolver = ReferenceResolver.WithReferences(references);
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            resolver);
        var program = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(globalScope, resolver);
        return tree.Diagnostics
            .Concat(globalScope.Diagnostics)
            .Concat(program.Diagnostics)
            .ToImmutableArray();
    }
}
