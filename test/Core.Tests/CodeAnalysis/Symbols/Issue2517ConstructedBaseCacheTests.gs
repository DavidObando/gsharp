// <copyright file="Issue2517ConstructedBaseCacheTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable
import System.Threading.Tasks
import Xunit

/// Regression coverage for issue #2517's constructed generic base cache.
class Issue2517ConstructedBaseCacheTests {
    @Fact
    func ConstructionCreatedBeforeBaseBinding_ObservesSubstitutedBaseAfterBinding() {
        let baseType = GenericClass("Base2517", out _)
        let middle = GenericClass("Middle2517", out var middleParameter)
        let constructed = StructSymbol.Construct(middle, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        Assert.Null(constructed.BaseClass)
        middle.SetBaseClass(StructSymbol.Construct(baseType, ImmutableArray.Create[TypeSymbol](middleParameter)))
        let closedBase = Assert.IsType[StructSymbol](constructed.BaseClass)
        Assert.Same(baseType, closedBase.Definition)
        Assert.Same(TypeSymbol.Int32, Assert.Single(closedBase.TypeArguments))
        let secondConstruction = StructSymbol.Construct(middle, ImmutableArray.Create[TypeSymbol](TypeSymbol.String))
        Assert.Same(baseType, secondConstruction.BaseClass!!.Definition)
        Assert.Same(TypeSymbol.String, Assert.Single(secondConstruction.BaseClass!!.TypeArguments))
    }

    @Fact
    func RecursiveConstructedBase_RecomputesWithoutDeadlockOrCrossDefinitionLeakage() {
        let root = GenericClass("Root2517", out _)
        let node = GenericClass("Node2517", out var nodeParameter)
        let sibling = GenericClass("Node2517", out var siblingParameter)
        let closedNode = StructSymbol.Construct(node, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        let closedSibling = StructSymbol.Construct(sibling, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        node.SetBaseClass(
            StructSymbol.Construct(
                root,
                ImmutableArray.Create[TypeSymbol](
                    StructSymbol.Construct(node, ImmutableArray.Create[TypeSymbol](nodeParameter))
                )
            )
        )
        sibling.SetBaseClass(StructSymbol.Construct(root, ImmutableArray.Create[TypeSymbol](siblingParameter)))
        Parallel.For(
            0,
            64,
            (_ int32) -> {
                let recursiveBase StructSymbol? = closedNode.BaseClass
                Assert.Same(root, recursiveBase!!.Definition)
                let recursiveArgument = Assert.IsType[StructSymbol](Assert.Single(recursiveBase!!.TypeArguments))
                Assert.Same(node, recursiveArgument.Definition)
                Assert.Same(TypeSymbol.Int32, Assert.Single(recursiveArgument.TypeArguments))
                Assert.Same(root, closedSibling.BaseClass!!.Definition)
                Assert.Same(TypeSymbol.Int32, Assert.Single(closedSibling.BaseClass!!.TypeArguments))
            }
        )
        Assert.NotSame(closedNode, closedSibling)
        Assert.NotSame(node, sibling)
    }

    @Fact
    func OtherLateBoundConstructedMetadata_RemainsLiveAndSubstituted() {
        let container = GenericClass("Container2517", out var containerParameter)
        let iface = InterfaceSymbol("IValue2517", Accessibility.Public, declaration: nil, packageName: "Issue2517")
        let ifaceParameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        iface.SetTypeParameters(ImmutableArray.Create(ifaceParameter))
        let constructed = StructSymbol.Construct(container, ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32))
        Assert.Empty(constructed.PrimaryConstructorParameters)
        Assert.Empty(constructed.Interfaces)
        Assert.Empty(constructed.Events)
        container.SetInstanceFieldsAndPrimaryConstructorParameters(
            ImmutableArray[FieldSymbol].Empty,
            ImmutableArray.Create(ParameterSymbol("value", containerParameter))
        )
        container.SetInterfaces(
            ImmutableArray.Create(
                InterfaceSymbol.Construct(iface, ImmutableArray.Create[TypeSymbol](containerParameter))
            )
        )
        let changed = EventSymbol(
            "Changed",
            containerParameter,
            Accessibility.Public,
            isFieldLike: true,
            isVirtual: false,
            isOverride: false
        )
        container.SetEvents(ImmutableArray.Create(changed))
        containerParameter.ClassConstraint = GenericClass("Constraint2517", out _)
        Assert.Same(TypeSymbol.Int32, Assert.Single(constructed.PrimaryConstructorParameters).Type)
        let closedInterface = Assert.Single(constructed.Interfaces)
        Assert.Same(iface, closedInterface.Definition)
        Assert.Same(TypeSymbol.Int32, Assert.Single(closedInterface.TypeArguments))
        Assert.Same(changed, Assert.Single(constructed.Events))
        Assert.Same(
            containerParameter.ClassConstraint,
            Assert.Single(constructed.Definition!!.TypeParameters).ClassConstraint
        )
    }

    shared {
        private func GenericClass(name string, out parameter TypeParameterSymbol) StructSymbol {
            parameter = TypeParameterSymbol("T", ordinal: 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
            let type = StructSymbol(
                name,
                ImmutableArray[FieldSymbol].Empty,
                Accessibility.Public,
                declaration: nil,
                packageName: "Issue2517",
                isData: false,
                isInline: false,
                isClass: true
            )
            type.SetTypeParameters(ImmutableArray.Create(parameter))
            return type
        }
    }
}
