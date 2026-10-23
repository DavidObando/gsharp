// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text

internal class NativeProtocolQuery(
    source TypeSymbol,
    target TypeSymbol,
    positive bool,
    location TextLocation,
    recovery bool = false
) {
    internal prop Source TypeSymbol -> source
    internal prop Target TypeSymbol -> target
    internal prop RequirePositive bool -> positive
    internal prop Location TextLocation -> location
    internal prop IsPayloadRecovery bool -> recovery
}
