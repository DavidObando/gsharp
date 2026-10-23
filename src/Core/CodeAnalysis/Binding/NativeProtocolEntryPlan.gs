// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Generic
import System.Collections.Immutable
import System.Reflection

internal class NativeProtocolWitness(
    slot FunctionSymbol,
    target FunctionSymbol?,
    importedTarget MethodInfo?,
    extension bool
) {
    internal prop Slot FunctionSymbol -> slot
    internal prop Target FunctionSymbol? -> target
    internal prop ImportedTarget MethodInfo? -> importedTarget
    internal prop IsExtension bool -> extension
}

internal class NativeProtocolDecision(
    protocol TypeSymbol,
    positive bool,
    witnesses ImmutableArray[NativeProtocolWitness],
    slots ImmutableArray[FunctionSymbol]
) {
    internal prop Protocol TypeSymbol -> protocol
    internal prop Positive bool -> positive
    internal prop Witnesses ImmutableArray[NativeProtocolWitness] -> witnesses
    internal prop Slots ImmutableArray[FunctionSymbol] -> slots
}

internal class NativeProtocolEntryPlan(
    sourceType TypeSymbol,
    entry StructSymbol,
    sourceField FieldSymbol,
    protocols ImmutableArray[TypeSymbol],
    recover FunctionSymbol
) {
    internal prop SourceType TypeSymbol -> sourceType
    internal prop Entry StructSymbol -> entry
    internal prop SourceField FieldSymbol -> sourceField
    internal prop Protocols ImmutableArray[TypeSymbol] -> protocols
    internal prop Recover FunctionSymbol -> recover
    private let bridges List[NativeProtocolBridge] = List[NativeProtocolBridge]()
    internal prop Bridges List[NativeProtocolBridge] -> bridges
    private let decisions List[NativeProtocolDecision] = List[NativeProtocolDecision]()
    internal prop Decisions List[NativeProtocolDecision] -> decisions
    internal prop BridgeType StructSymbol? {
        get;
        set;
    }
}
