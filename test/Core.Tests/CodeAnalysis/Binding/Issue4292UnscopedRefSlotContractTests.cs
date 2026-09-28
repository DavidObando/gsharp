// <copyright file="Issue4292UnscopedRefSlotContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests.Fixtures;
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

    [Fact]
    public void UnannotatedInterfaceMethod_WithValueReturnAndNoAdditionalParameter_IsIrrelevant()
    {
        var source = @"
package P
import System.Diagnostics.CodeAnalysis
interface IValue {
    func Get() int32;
}
struct Value : IValue {
    @UnscopedRef
    public func Get() int32 { return 0 }
}
";

        Assert.Empty(Bind(source));
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
    [InlineData("", "", false)]
    [InlineData("ref other int32", "", true)]
    [InlineData("in other int32", "", true)]
    [InlineData("out other int32", "other = 0", true)]
    [InlineData("view Span[int32]", "", true)]
    public void RefReturn_RelevanceRequiresAnAdditionalParameter(
        string parameters,
        string bodyPrefix,
        bool expectContractDiagnostic)
    {
        var source = @"
package P
import System
import System.Diagnostics.CodeAnalysis
interface IRefSlot {
    func Slot(" + parameters + @") ref int32;
}
struct Buffer : IRefSlot {
    var Value int32

    @UnscopedRef
    public func Slot(" + parameters + @") ref int32 {
        " + bodyPrefix + @"
        return ref this.Value
    }
}
";

        Assert.Equal(expectContractDiagnostic, Bind(source).Any(d => d.Id == "GS0590"));
    }

    [Theory]
    [InlineData("ref view Span[int32]", "", true)]
    [InlineData("scoped ref view Span[int32]", "", false)]
    [InlineData("scoped out view Span[int32]", "view = default(Span[int32])", true)]
    [InlineData("out view Span[int32]", "view = default(Span[int32])", false)]
    [InlineData("out view Span[int32], in other int32", "view = default(Span[int32])", true)]
    public void RefStructParameter_RelevanceMatchesCSharp(
        string parameters,
        string body,
        bool expectContractDiagnostic)
    {
        var source = @"
package P
import System
import System.Diagnostics.CodeAnalysis
interface IStore {
    func Store(" + parameters + @");
}
struct Buffer : IStore {
    @UnscopedRef
    public func Store(" + parameters + @") {
        " + body + @"
    }
}
";

        Assert.Equal(expectContractDiagnostic, Bind(source).Any(d => d.Id == "GS0590"));
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

    [Fact]
    public void ImportedScopedRef_RequiresRuntimeAttributeIdentity()
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
        Assert.Empty(BindWithReferences(
            prefix + Environment.NewLine + implementation.Replace(
                "INTERFACE",
                "IRuntimeScoped",
                StringComparison.Ordinal),
            contracts.Paths));
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
    public void ImportedRefProperty_WithoutAdditionalParameter_IsIrrelevant()
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

        Assert.Empty(BindWithFixtures(source, contracts));
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

        Assert.Single(BindWithFixtures(source, contracts), d => d.Id == "GS0590");
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
