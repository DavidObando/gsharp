// <copyright file="Adr0208NarrowingConstructTableTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import System
import System.Collections.Generic
import System.Linq
import System.Reflection
import Xunit

/// ADR-0208 section 8 and section 20: the construct table is closed. Every
/// concrete (cref:BoundNode) type of the assembly has an explicit entry, so a
/// new bound node kind cannot be added without choosing its effect on the
/// narrowing state.
open class Adr0208NarrowingConstructTableTests {
    @Fact
    func EveryConcreteBoundNodeType_HasAnExplicitEntry() {
        let kinds = ConcreteBoundNodeTypeNames()
        Assert.NotEmpty(kinds)
        let missing = kinds.Where((name string) -> !NarrowingConstructTable.IsListed(name)).ToArray()
        Assert.True(
            missing.Length == 0,
            "Add these bound node kinds to NarrowingConstructTable (ADR-0208 section 8): " + string.Join(", ", missing)
        )
    }

    @Fact
    func EveryEntry_NamesARealConcreteBoundNodeType() {
        let kinds = HashSet[string](ConcreteBoundNodeTypeNames())
        let listed = NarrowingConstructTable.ListedNames()
        Assert.NotEmpty(listed)
        let stale = listed.Where((name string) -> !kinds.Contains(name)).ToArray()
        Assert.True(stale.Length == 0, "Stale construct table entries: " + string.Join(", ", stale))
    }

    @Fact
    func SelfTest_ASyntheticKindIsReportedAsMissingAndDefaultsToCall() {
        // Guards the test against passing because the enumeration is empty or
        // the lookup swallows every name.
        Assert.False(NarrowingConstructTable.IsListed("BoundSyntheticTestExpression"))
        Assert.Equal(NarrowingEffectClass.Call, NarrowingConstructTable.Lookup("BoundSyntheticTestExpression"))
        let kinds = ConcreteBoundNodeTypeNames().Append("BoundSyntheticTestExpression")
        Assert.Contains(
            "BoundSyntheticTestExpression",
            kinds.Where((name string) -> !NarrowingConstructTable.IsListed(name))
        )
    }

    @Theory
    @InlineData("BoundGotoStatement", NarrowingEffectClass.Jump)
    @InlineData("BoundReturnStatement", NarrowingEffectClass.Jump)
    @InlineData("BoundThrowStatement", NarrowingEffectClass.Jump)
    @InlineData("BoundConditionalGotoStatement", NarrowingEffectClass.ConditionalJump)
    @InlineData("BoundIfStatement", NarrowingEffectClass.Join)
    @InlineData("BoundPatternSwitchStatement", NarrowingEffectClass.Join)
    @InlineData("BoundForInfiniteStatement", NarrowingEffectClass.Region)
    @InlineData("BoundTryStatement", NarrowingEffectClass.Region)
    @InlineData("BoundFunctionLiteralExpression", NarrowingEffectClass.Closure)
    @InlineData("BoundAssignmentExpression", NarrowingEffectClass.RootWrite)
    @InlineData("BoundFieldAssignmentExpression", NarrowingEffectClass.MemberWrite)
    @InlineData("BoundIndirectAssignmentExpression", NarrowingEffectClass.PointerWrite)
    @InlineData("BoundAddressOfExpression", NarrowingEffectClass.Alias)
    @InlineData("BoundCallExpression", NarrowingEffectClass.Call)
    @InlineData("BoundForRangeStatement", NarrowingEffectClass.Call)
    @InlineData("BoundYieldStatement", NarrowingEffectClass.Call)
    @InlineData("BoundAwaitExpression", NarrowingEffectClass.Call)
    @InlineData("BoundLiteralExpression", NarrowingEffectClass.None)
    func AdrRows_HaveTheirDocumentedEffectClass(typeName string, expected NarrowingEffectClass) {
        Assert.Equal(expected, NarrowingConstructTable.Lookup(typeName))
    }

    @Fact
    func OnlyKindsWithOneSuccessor_UseTheJumpClass() {
        // ADR-0208 section 8, conditional-jump row: a kind with a live
        // fall-through successor must not end the current path.
        let jumps = NarrowingConstructTable
            .ListedNames()
            .Where((name string) -> NarrowingConstructTable.Lookup(name) == NarrowingEffectClass.Jump)
            .ToArray()
        Assert.NotEmpty(jumps)
        Assert.DoesNotContain("BoundConditionalGotoStatement", jumps)
        Assert.DoesNotContain("BoundIfStatement", jumps)
        Assert.DoesNotContain("BoundConditionalExpression", jumps)
        Assert.DoesNotContain("BoundConditionalAddressExpression", jumps)
    }

    shared {
        private func ConcreteBoundNodeTypeNames()[]string {
            let root = typeof(BoundNode)
            return root
                .Assembly
                .GetTypes()
                .Where((type Type) -> type.IsClass && !type.IsAbstract && type.IsSubclassOf(root))
                .Select((type Type) -> type.Name)
                .Distinct()
                .OrderBy((name string) -> name, StringComparer.Ordinal)
                .ToArray()
        }
    }
}
