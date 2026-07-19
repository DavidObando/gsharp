// <copyright file="Issue2517ConstructedBaseCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Threading.Tasks;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>Regression coverage for issue #2517's constructed generic base cache.</summary>
public sealed class Issue2517ConstructedBaseCacheTests
{
    [Fact]
    public void ConstructionCreatedBeforeBaseBinding_ObservesSubstitutedBaseAfterBinding()
    {
        var baseType = GenericClass("Base2517", out _);
        var middle = GenericClass("Middle2517", out var middleParameter);

        var constructed = StructSymbol.Construct(
            middle,
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        Assert.Null(constructed.BaseClass);

        middle.SetBaseClass(StructSymbol.Construct(
            baseType,
            ImmutableArray.Create<TypeSymbol>(middleParameter)));

        var closedBase = Assert.IsType<StructSymbol>(constructed.BaseClass);
        Assert.Same(baseType, closedBase.Definition);
        Assert.Same(TypeSymbol.Int32, Assert.Single(closedBase.TypeArguments));

        var secondConstruction = StructSymbol.Construct(
            middle,
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.String));
        Assert.Same(baseType, secondConstruction.BaseClass.Definition);
        Assert.Same(TypeSymbol.String, Assert.Single(secondConstruction.BaseClass.TypeArguments));
    }

    [Fact]
    public void RecursiveConstructedBase_RecomputesWithoutDeadlockOrCrossDefinitionLeakage()
    {
        var root = GenericClass("Root2517", out _);
        var node = GenericClass("Node2517", out var nodeParameter);
        var sibling = GenericClass("Node2517", out var siblingParameter);

        var closedNode = StructSymbol.Construct(
            node,
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        var closedSibling = StructSymbol.Construct(
            sibling,
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));

        node.SetBaseClass(StructSymbol.Construct(
            root,
            ImmutableArray.Create<TypeSymbol>(
                StructSymbol.Construct(node, ImmutableArray.Create<TypeSymbol>(nodeParameter)))));
        sibling.SetBaseClass(StructSymbol.Construct(
            root,
            ImmutableArray.Create<TypeSymbol>(siblingParameter)));

        Parallel.For(0, 64, _ =>
        {
            var recursiveBase = closedNode.BaseClass;
            Assert.Same(root, recursiveBase.Definition);
            var recursiveArgument = Assert.IsType<StructSymbol>(Assert.Single(recursiveBase.TypeArguments));
            Assert.Same(node, recursiveArgument.Definition);
            Assert.Same(TypeSymbol.Int32, Assert.Single(recursiveArgument.TypeArguments));

            Assert.Same(root, closedSibling.BaseClass.Definition);
            Assert.Same(TypeSymbol.Int32, Assert.Single(closedSibling.BaseClass.TypeArguments));
        });

        Assert.NotSame(closedNode, closedSibling);
        Assert.NotSame(node, sibling);
    }

    [Fact]
    public void OtherLateBoundConstructedMetadata_RemainsLiveAndSubstituted()
    {
        var container = GenericClass("Container2517", out var containerParameter);
        var iface = new InterfaceSymbol(
            "IValue2517",
            Accessibility.Public,
            declaration: null,
            packageName: "Issue2517");
        var ifaceParameter = new TypeParameterSymbol(
            "T",
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None);
        iface.SetTypeParameters(ImmutableArray.Create(ifaceParameter));

        var constructed = StructSymbol.Construct(
            container,
            ImmutableArray.Create<TypeSymbol>(TypeSymbol.Int32));
        Assert.Empty(constructed.PrimaryConstructorParameters);
        Assert.Empty(constructed.Interfaces);
        Assert.Empty(constructed.Events);

        container.SetInstanceFieldsAndPrimaryConstructorParameters(
            ImmutableArray<FieldSymbol>.Empty,
            ImmutableArray.Create(new ParameterSymbol("value", containerParameter)));
        container.SetInterfaces(ImmutableArray.Create(
            InterfaceSymbol.Construct(
                iface,
                ImmutableArray.Create<TypeSymbol>(containerParameter))));
        var changed = new EventSymbol(
            "Changed",
            containerParameter,
            Accessibility.Public,
            isFieldLike: true,
            isVirtual: false,
            isOverride: false);
        container.SetEvents(ImmutableArray.Create(changed));
        containerParameter.ClassConstraint = GenericClass("Constraint2517", out _);

        Assert.Same(
            TypeSymbol.Int32,
            Assert.Single(constructed.PrimaryConstructorParameters).Type);
        var closedInterface = Assert.Single(constructed.Interfaces);
        Assert.Same(iface, closedInterface.Definition);
        Assert.Same(TypeSymbol.Int32, Assert.Single(closedInterface.TypeArguments));
        Assert.Same(changed, Assert.Single(constructed.Events));
        Assert.Same(
            containerParameter.ClassConstraint,
            Assert.Single(constructed.Definition.TypeParameters).ClassConstraint);
    }

    private static StructSymbol GenericClass(string name, out TypeParameterSymbol parameter)
    {
        parameter = new TypeParameterSymbol(
            "T",
            ordinal: 0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None);
        var type = new StructSymbol(
            name,
            ImmutableArray<FieldSymbol>.Empty,
            Accessibility.Public,
            declaration: null,
            packageName: "Issue2517",
            isData: false,
            isInline: false,
            isClass: true);
        type.SetTypeParameters(ImmutableArray.Create(parameter));
        return type;
    }
}
