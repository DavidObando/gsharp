// <copyright file="PrinterExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests.Coverage

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Tests
import System
import System.Collections.Generic
import System.Linq
import System.Threading.Tasks
import Xunit

/// Printer exhaustiveness contract: every concrete (cref:GNode)
/// subclass has a (cref:GNodeSamples) entry, and every sample prints
/// without throwing and re-parses cleanly with the real G# parser. Adding a
/// node type without printer support (or without a sample) fails here instead
/// of surfacing as an (cref:ArgumentException) in production.
open class PrinterExhaustivenessTests {
    @Fact
    func EveryConcreteGNodeTypeHasASample() {
        let concrete = ConcreteGNodeTypes()
        let missing = concrete
            .Where((t Type) -> !GNodeSamples.All.ContainsKey(t))
            .Select((t Type) -> t.FullName!!)
            .OrderBy((n string) -> n, StringComparer.Ordinal)
            .ToList()
        Assert.True(
            missing.Count == 0,
            "Concrete GNode subclasses without a GNodeSamples entry:\n" + string.Join("\n", missing) +
                "\nAdd printer coverage plus a minimal sample in GNodeSamples, " +
                "then regenerate code-model-surface.golden.txt."
        )
        let stale = GNodeSamples
            .All
            .Keys
            .Where((t Type) -> !concrete.Contains(t))
            .Select((t Type) -> t.FullName!!)
            .OrderBy((n string) -> n, StringComparer.Ordinal)
            .ToList()
        Assert.True(
            stale.Count == 0,
            "GNodeSamples entries that are no longer concrete GNode subclasses:\n" + string.Join("\n", stale)
        )
    }

    @Fact
    func ConcreteNodeClassification_UsesSealedLeafSemantics() {
        Assert.False(GNodeSamples.IsConcreteNodeType(typeof(MigratedAbstractRoot)))
        Assert.True(GNodeSamples.IsConcreteNodeType(typeof(MigratedConcreteNode)))
    }

    /// Issue #4661: judged on the compiled CodeModel assembly, which is the same
    /// property whether its source is C# or G#. (It used to bind the C# project
    /// with Roslyn, which cannot read a G# tree.)
    @Fact
    func EverySourceConcreteGNodeTypeIsSealed() {
        let exported IReadOnlyList[Type] = typeof(GNode).Assembly.GetExportedTypes()
        Assert.Contains(typeof(GNode), exported)
        Assert.True(exported.Any(GNodeSamples.IsConcreteNodeType), "no concrete GNode types were found")
        let unsealed = UnsealedConcreteNodeTypes(exported).Select((type Type) -> type.FullName!!).ToList()
        Assert.True(
            unsealed.Count == 0,
            "Concrete GNode subclasses must be sealed so migrated reflection can distinguish them from abstract roots:\n" +
                string.Join("\n", unsealed)
        )
    }

    @Fact
    func UnsealedConcreteNodeDetection_FlagsAnOpenConcreteSubclass() {
        let types[]Type = []Type{
            typeof(MigratedAbstractNode),
            typeof(MigratedConcreteNode),
            typeof(MigratedOpenConcreteNode)
        }
        Assert.Equal([]Type{typeof(MigratedOpenConcreteNode)}, UnsealedConcreteNodeTypes(types).ToArray())
    }

    @Fact
    func KnownRoundTripGapsOnlyListSampleTypes() {
        let unknown = KnownRoundTripGaps
            .Keys
            .Where((t Type) -> !GNodeSamples.All.ContainsKey(t))
            .Select((t Type) -> t.FullName!!)
            .OrderBy((n string) -> n, StringComparer.Ordinal)
            .ToList()
        Assert.True(
            unknown.Count == 0,
            "KnownRoundTripGaps entries without a GNodeSamples entry:\n" + string.Join("\n", unknown)
        )
    }

    @Theory
    @MemberData("SampleTypeNames")
    func SamplePrintsAndRoundTrips(typeName string) {
        let type = GNodeSamples.All.Keys.Single((t Type) -> t.Name == typeName)
        let unit = GNodeSamples.All[type]()
        // Printing must not throw (the printer's `default:` cases throw
        // ArgumentException for unsupported nodes).
        let printed = GSharpPrinter.Print(unit)
        let result = TranslationTestValidation.ValidateRoundTripOnly(
            printed,
            "Printer exhaustiveness samples are minimal syntax fixtures, not complete bindable programs."
        )
        if KnownRoundTripGaps.TryGetValue(type, out var reason) {
            Assert.False(
                result.Success,
                "$typeName is listed in KnownRoundTripGaps (\"$reason\") but now round-trips cleanly. " + (`The gap is fixed: remove it from the list.
Printed G#:
` + "$printed")
            )
            return
        }
        Assert.True(result.Success, ("$typeName" + ` sample printed but failed to re-parse.
Printed G#:
` + "$printed" + `
Parse errors:
`) + string.Join("\n", result.Errors))
    }

    private open class MigratedAbstractRoot : GNode { }

    private class MigratedConcreteNode : MigratedAbstractRoot { }

    private abstract class MigratedAbstractNode : GNode { }

    // Concrete and unsealed. It needs a subclass: cs2gs infers `open` from one,
    // and a leaf class migrates to a sealed G# class.
    private open class MigratedOpenConcreteNode : MigratedAbstractNode { }

    private class MigratedOpenConcreteLeaf : MigratedOpenConcreteNode { }

    shared {
        /// Samples that print but are EXPECTED to fail G# round-trip parsing
        /// because of a real printer/parser gap (not a malformed sample). Each
        /// entry is asserted to still fail: fixing the gap flips the test and
        /// forces removal from this list. Keep this list as small as possible.
        private let KnownRoundTripGaps IReadOnlyDictionary[Type, string] = Dictionary[Type, string]()

        /// MemberData source: the simple name of every registered sample type,
        /// in deterministic ordinal order.
        /// @returns One row per concrete (cref:GNode) subclass.
        func SampleTypeNames() IEnumerable[[]object] -> GNodeSamples
            .All
            .Keys
            .OrderBy((t Type) -> t.Name, StringComparer.Ordinal)
            .Select((t Type) -> []object{t.Name})

        private func UnsealedConcreteNodeTypes(types IEnumerable[Type]) IEnumerable[Type] -> types.Where(
            (type Type) -> type.IsClass && typeof(GNode).IsAssignableFrom(type) && !type.IsAbstract && !type.IsSealed
        )

        private func ConcreteGNodeTypes() IReadOnlyList[Type] -> typeof(GNode)
            .Assembly
            .GetExportedTypes()
            .Where(GNodeSamples.IsConcreteNodeType)
            .ToList()
    }
}
